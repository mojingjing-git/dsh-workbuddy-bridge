# dsh-workbuddy-bridge

DSH plugin that brings the WorkBuddy / CodeBuddy OAuth account flow into
DeepSeek Harness (DSH) as a first-class experience: authentication, model
selection, balance observation, and an optionally self-managed gateway.

> **Status: Batch 2 in progress.** The plugin builds, type-checks and passes
> 83 tests, but it has **not** been through its acceptance gate — a real DSH
> desktop Agent completing a tool call. Until that run happens, treat every
> claim below as "covered by a test", not "observed working". See
> [Verification](#verification) for exactly what is and is not proven.

## What this is

`dsh-workbuddy-bridge` lets a DSH user:

1. pick models from a local WorkBuddy2API gateway by their canonical names
   (bare ids — no `cn:` prefix in the picker);
2. route Agent calls, including tool calls, through those models;
3. see the balance and cooldown state of every gateway account on the DSH
   sidebar, via `dsh-cost-meter`'s plugin-management transport;
4. add a Tencent CodeBuddy / WorkBuddy OAuth account without leaving DSH.

The plugin is MIT-licensed and ships **no** prebuilt gateway binaries. The user
is always the one who installs or upgrades the gateway.

## What this is not

- **Not** an official Tencent product or integration. The upstream gateway
  [`linguo2625469/workbuddy2api-panel`](https://github.com/linguo2625469/workbuddy2api-panel)
  is a third-party bridge; this plugin is an independent DSH-side layer.
- **Not** a redistribution of WorkBuddy2API. No upstream Go source or binaries
  are embedded.
- **Not** an account farm, sharing platform, or commercial relayer. The
  upstream README's usage terms forbid such uses and the plugin has no facility
  for them.

## Requirements

| Component | Version |
| --- | --- |
| DSH | `>=0.2.1-alpha.2 <0.3.0-0` |
| Node | `>=20` |
| WorkBuddy2API gateway | `v1.13.0` (the version the contracts were probed against) |

The DSH pin is exact on purpose. `0.0.1-rc.1` — what npm's `latest` tag
resolves to — has a different `TokenUsage` (no `totalTokens`) and a different
`FinishReason`, and nothing in the plugin works against it.

## Install

```bash
# in the plugin checkout
pnpm install
pnpm run build
pnpm run build:client
```

Then add it to your DSH profile so the loader mounts it, and set the gateway
key:

```powershell
# <gateway-url> defaults to http://127.0.0.1:7863
setx WB2API_API_KEY "<api_key from the gateway's config.json>"
```

Restart DSH desktop. The plugin's `cordis.patch.yml` is read at startup, so a
page refresh is not enough.

## Architecture

```
DSH agent loop
   │  GenerateOptions { provider, model, messages, tools, … }
   ▼
ctx.llm  (LlmRuntime, provided by the DSH base bundle)
   │  content projection, route resolution, chunk normalization
   ▼
WorkbuddyLlmAdapter            ← this plugin
   │  OpenAI Chat Completions over SSE
   ▼
wb2api gateway (:7863)  →  Tencent WorkBuddy / CodeBuddy
```

### How the plugin attaches to DSH

| Seam | What the plugin does |
| --- | --- |
| `ctx.llm.registerAdapter(['workbuddy'], adapter)` | Registers the route. `providerInfo().id` must equal the route name. |
| `ctx.llm.registerConfigurableProviders([…])` | Makes the route appear on the Models page. |
| `ctx.llm.registerModelDiscovery(ns, fn)` | Answers "discover models" from the gateway's own list. |
| `ctx.credentials` / `ctx.authorization` | OAuth flow and key storage. **Batch 3 — still the v0.1 shape.** |
| Management HTTP server on `127.0.0.1:0` | Serves the credits payload `dsh-cost-meter` polls. |

### DSH contracts this plugin depends on

These were read from the installed `@deepseek-ai/dsh-llm@0.2.1-alpha.2` rather
than assumed, and several of them changed the implementation:

- **Messages always carry `content: readonly ContentBlock[]`** — never a
  string. Serializing by role and text alone loses the tool correlation: an
  assistant turn needs `tool_calls` built from its `tool-call` blocks, and a
  tool result needs `tool_call_id` from `ToolResultMessage.toolCallId`.
- **`ToolCallBlock.arguments` is a raw JSON string**, not a parsed object. The
  runtime's own `BlockAssembler` builds the same field by concatenating
  `tool-call-delta.argumentsDelta`, and a `block-end` block is adopted
  verbatim, so both paths must produce a string.
- **`FinishReason` is an object union** (`{ kind: 'stop' }`, …), not a string
  union.
- **`BlockAssembler` keys blocks by index and supports interleaved deltas.** A
  response can carry reasoning, text and tool calls as three concurrent blocks,
  so the translator keeps one open block per kind rather than a single
  "current" block.
- **The runtime projects content before dispatch.** File blocks become handle
  text for every route, and image blocks become placeholders for a route whose
  `inputModalities` omits `image`. The adapter declares `inputModalities:
  ['text']` precisely so that projection runs; "absent means unknown", so
  omitting it would deliver raw `ImageBlock`s the adapter cannot render.
- **Usage must precede the terminal `finish`.** With
  `stream_options.include_usage` the usage frame arrives *after* the frame
  carrying `finish_reason`, so the adapter defers its `finish` until the stream
  ends rather than emitting it on sight.

### Module boundaries

The built output imports nothing from `@deepseek-ai/*` at runtime — every such
import is `import type` and is erased by `tsc`. The only runtime import is
`zod`, a declared dependency. This matters because DSH provides those packages
through `ctx`; importing them would load a second copy beside the bundle's own.

`@deepseek-ai/cordis` is the single `peerDependency`, because the plugin must
share the host's instance.

## Verification

### What is proven

- **83 tests pass** (`pnpm test`), and `tsc --noEmit` is clean **including the
  tests** — the tests were previously outside the type check, which let several
  calls violate the official types while passing.
- **`tests/message-serialization.test.ts`** asserts the complete `messages`
  array the adapter puts on the wire, for user text, the system prompt, the
  full assistant-tool_calls / tool-tool_call_id round trip, parallel tool
  calls, and the blocks that must not reach the provider.
- **`tests/simulated-e2e.test.ts`** drives the adapter through the DSH
  runtime's own consumers — `BlockAssembler`, `createUserMessage`,
  `createToolResultMessage` — rather than through mocks of the plugin's own
  making. It covers a text turn, a tool-call turn, a full two-turn round trip,
  parallel tool calls, max-token truncation, a `global:` rejection, and an
  interrupted stream.
- The build imports nothing from `@deepseek-ai/*` at runtime.

### What is not proven

- **The acceptance gate.** No real DSH desktop run has happened. Nothing below
  is covered by a test:
  - that DSH loads the plugin and `ctx.llm` is reachable;
  - that the user's chosen model supports tool calls at all (the gateway
    advertises 19 models and they are not equivalent);
  - that a real tool executes and its result lands back in the model context.
- **The simulated E2E is not a substitute.** It uses the runtime's real
  assembly and message code, which is much stronger than a hand-written mock,
  but it cannot exercise plugin loading or a live gateway.
- **Nothing about a real gateway response** beyond the P0 probes recorded in
  `docs/probe/`.

Run the desktop acceptance test with
[`docs/probe/BATCH2-E2E-RUNBOOK.md`](./docs/probe/BATCH2-E2E-RUNBOOK.md).

## Development

```bash
pnpm install
pnpm test          # vitest run
pnpm run lint      # tsc --noEmit, src + tests
pnpm run build     # tsc -p tsconfig.build.json -> lib/
pnpm run build:client
```

Evidence from the P0 probes — real gateway responses, DSH type sources, and the
tables the contracts were derived from — lives in
[`docs/probe/`](./docs/probe/).

## Known limitations

- **OAuth, credentials, the client surface and the cost-meter payload are still
  the v0.1 implementations.** They were written against guessed contracts;
  rewriting them is Batch 3. In particular the credential calls use
  `set({ name, value })` where DSH's signature is `set(ref, value)`.
- **No realm routing.** The global realm is refused at all three entry points
  (model discovery, resolution, dispatch) rather than stripped, because wb2api
  routes a bare id to CN and the request would silently answer from the wrong
  realm. The probe gateway had zero global accounts.
- **The adapter is text-only.** It declares `inputModalities: ['text']`, so
  image content reaches it as a placeholder rather than as image input.
- **Not published to npm.**

## License

MIT — see [`LICENSE`](./LICENSE). The upstream gateway is a separate project
under its own license.
