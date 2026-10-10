# M11 — DSH official types evidence (P1 v0.2 contract base)

> Date: 2026-10-10
> Reason: P1 v0.1's types were guessed from M01/M02/M10 probes. v0.2 replaces those
> guesses with **verbatim** slices of the official DSH source so every plugin
> interface has a real type to import against.

## Why this batch exists

The PR #1 review identified four P0 contract bugs all of the same shape:
the plugin's host code defined its own `WorkbuddyStreamOptions`,
`WorkbuddyStreamChunk`, `WorkbuddyAdapterError`, `AuthorizationSession`,
`CredentialsService` types, and then shipped 41 mock-based unit tests that
matched those self-defined types. The result: the unit tests passed but the
code could not talk to the real DSH desktop, because the actual type shapes
are different.

This batch pins the **real** DSH types to disk so:

1. The plugin's `tsc` build actually fails when a hypothetical future
   refactor drifts from the official types.
2. The reviewer (and the next maintainer) can read what DSH really
   expects without leaving this repository.
3. The unit / contract tests can import the same type that DSH ships.

## Files in this directory

| File | Source URL | Why it matters |
|---|---|---|
| `M11-dsh-llm-types.ts` | `packages/llm/llm/src/types.ts` | Defines `GenerateOptions`, `StreamChunk` (`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`), `LlmProviderInfo`, `LlmModelInfo`, `LlmResolvedModelInfo`, `ContentBlock`, `ToolSchema`, etc. — the whole wire vocabulary a `LlmAdapter.stream()` implementation must produce. |
| `M11-llm-core-index-FULL.ts` | `packages/llm/llm/src/index.ts` | The full source for `LlmRuntime` (the `ctx.llm` service). Defines `registerAdapter`, `registerConfigurableProviders`, `registerModelDiscovery`, and the strict validation rules those calls enforce (e.g. `providerInfo().id` must equal the route name). |
| `M11-stream-protocol.ts` | `packages/api/gateway/src/stream-protocol.ts` | The wire serialization DSH uses between host and renderer. Not used by the host plugin directly, but it shows the canonical chunk shape that the renderer expects. |
| `M11-dsh-authorization-index.ts` | `packages/credentials/authorization/src/index.ts` | Defines `AuthorizationService.registerFlow()`, `AuthorizationFlow`, `AuthorizationSession` (with `commit(record)`), and the **commit contract**: a flow that resolves without `session.commit()` is reported as `NOT_COMMITTED`. |
| `M11-dsh-authorization-types.ts` | `packages/credentials/authorization/src/types.ts` | Defines `AuthorizationMethod` (`id: string`, not a literal union), `AuthorizationNotice` (`message` / `url?` / `code?`), `AuthorizationPrompt` (the discriminated union of `text` / `secret` / `select` kinds), and the outcome / settlement types. |
| `M11-dsh-credentials-index.ts` | `packages/credentials/credentials/src/index.ts` | Defines the `CredentialsService` class with **single-argument** `resolve(ref)`, **two-argument** `set(ref, value)`, plus the `credentialRef(name)`, `credentialKey(scope, id)`, `parseCredentialKey`, `credentialKeyScope`, `credentialKeyId` helpers. The key/scope grammar is enforced at construction: `^[A-Za-z_][A-Za-z0-9_]*$` for ref, `^[a-z][a-z0-9-]*$` for each key segment. |
| `M11-cordis-host-runner-README.md` | `packages/extensions/cordis-host-runner/README.md` | The dynamic plugin lifecycle (define / run / stop, `cordis/request-run` approvals). The plugin is loaded by `@deepseek-ai/cordis-plugin-loader` reading `cordis.patch.yml` at DSH startup; the patch's `id`/`name` must match the package's identity. |

## Types the plugin MUST import from (in v0.2)

| Used in plugin module | Imported from | Notes |
|---|---|---|
| `LlmAdapter`, `GenerateOptions`, `StreamChunk`, `LlmConfigurableProvider`, `LlmModelInfo`, `LlmResolvedModelInfo` | `@deepseek-ai/dsh-llm` | `import type` only — DSH desktop bundle provides the runtime instance. |
| `Context`, `Service`, `Fiber` | `@deepseek-ai/cordis` | The plugin's `apply()` is typed as `(ctx: WorkbuddyPluginContext) => void` where `WorkbuddyPluginContext` is the plugin's own structural type for the subset of `Context` it uses. The full `Context` is the parent type. |
| `AuthorizationService`, `AuthorizationFlow`, `AuthorizationSession`, `AuthorizationMethod`, `AuthorizationNotice`, `AuthorizationPrompt`, `AuthorizationDeclinedError`, `CredentialKey`, `CredentialRecord` | `@deepseek-ai/dsh-authorization` | `import type` only. |
| `credentialRef`, `credentialKey`, `parseCredentialKey`, `CredentialsService` | `@deepseek-ai/dsh-credentials` | The helpers are pure functions — they can be `import { ... }` (not type-only) once DSH desktop bundle puts them on disk. In v0.2 we may keep them as `import type` and re-implement the literal-grammar check locally. |

## How v0.1 failed this check

| v0.1 symbol | v0.1 shape | Official shape | Failure mode |
|---|---|---|---|
| `WorkbuddyStreamOptions` | `{ apiKey, model, body, signal? }` | `GenerateOptions = { provider, model, messages, system?, tools?, toolHistory?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }` — **no `apiKey`, no `body`** | A real `GenerateOptions` value sent in by the runtime would not match v0.1's type. The v0.1 mock sent `apiKey` and `body` because that is what the plugin's code read; in production those keys are absent. |
| `WorkbuddyStreamChunk` | `{ type: 'text' \| 'reasoning' \| 'usage' \| 'finish' \| 'error', text?, reasoning?, usage?, finishReason?, error? }` | `StreamChunk = { type: 'block-start' } \| { type: 'text-delta' } \| { type: 'reasoning-delta' } \| { type: 'tool-call-delta' } \| { type: 'block-end' } \| { type: 'usage' } \| { type: 'finish' }` | v0.1 emitted chunks in a shape the runtime does not know; DSH would drop them silently. |
| `WorkbuddyAdapterError` | thrown with `code` field only | `LlmError` is the right base — has a code, is mapped to terminal `error` chunk by `LlmRuntime.stream()` | v0.1's error path produced an `error` chunk only because the type also called it that — but with the wrong inner shape. |
| `AuthorizationSession` | `{ method, signal, notify, prompt }` | `AuthorizationSession = { method: string, signal: AbortSignal, commit(record), notify(notice), prompt(prompt) }` — **`commit()` is required** | v0.1's flow returned without committing, which DSH's `LlmRuntime`-equivalent for authorization turns into a `NOT_COMMITTED` failure. |
| `credentials.set({ name, value })` | single object | `credentials.set(ref, value)` — **two positional arguments** | The credential service never wrote the value; v0.1 silently fell through to the env-var fallback and the user-entered API key was lost. |
| `credentials.resolve({ name, value: '' })` | single object | `credentials.resolve(ref)` — **one positional argument** | The credential service threw or returned `undefined`; v0.1's "old env var" fallback masked the real failure. |

## What v0.2 will do differently

1. `src/host/llm-adapter.ts` will be rewritten so the stream signature
   accepts `GenerateOptions` and yields `StreamChunk`. Two routes are
   being considered (see Batch 2 of the three-batch plan):

   - **Route A — reuse dsh-llm-pi-ai**: ship no stream code at all;
     declare a `cordis.patch.yml` row whose `name` is the dsh-llm-pi-ai
     package and whose `config.providers.workbuddy` describes the wb2api
     baseURL / apiKeyEnv / 19 models. This needs `@deepseek-ai/dsh-llm-pi-ai`
     to actually be present in the user's DSH desktop `node_modules`,
     which the current install does not include.
   - **Route B — custom adapter extending `LlmAdapter`**: import the
     class from `@deepseek-ai/dsh-llm` (type-only), implement the five
     methods with the official signatures, and write the SSE→`StreamChunk`
     mapping directly. This works without any extra package on disk but
     has to maintain the wire contract itself.

   The decision is deferred to Batch 2 because it requires inspecting
   whether `dsh-llm-pi-ai` is reachable from `ctx.inject(['llm-pi-ai'])` in
   the user's real DSH desktop runtime, which the next batch will probe.

2. `src/host/auth-flow.ts` will use `session.commit(record)` and the
   `credentialKey('workbuddy', 'oauth')` shape. The flow's `run(session)`
   MUST end with a `commit()` call or DSH raises `NOT_COMMITTED`.

3. `src/host/credentials.ts` will be added; it wraps `ctx.credentials`
   and exposes `resolveApiKey(route)` and `markWorkbuddyBound()` as
   methods that take the typed `CredentialsService` and call
   `resolve(ref)` / `set(ref, value)` with positional arguments.

4. `src/shared/credits-schema.ts` will be re-shaped so the response
   from `/v0/management/plugins/workbuddy/credits` matches the
   dsh-cost-meter parser exactly (`auth_index` snake-case in, `total_used`
   / `total_remain` / `total_size` / `fetched_at` / `packages[].name` /
   `used` / `remain` / `size`). The contract test will **import the
   real `parseWorkBuddyCredits` from dsh-cost-meter** rather than
   re-derive it.

5. `src/client/client.js` will be the last file rewritten, only after
   Batch 2 demonstrates a working host so the client's remote handle
   has a real method to call.

## What this batch does NOT change

- **The v0.1 implementation in `src/host/*` and `src/client/*`** is
  not deleted in this batch. It is left in place as a reference for
  the v0.2 rewrite. Once v0.2 has its first green test, v0.1 will
  be removed in a single follow-up commit so the diff is clear.

- **The `cordis.patch.yml` row** stays the same (`id: workbuddy`,
  `name: dsh-workbuddy-bridge`). If Route A is chosen in Batch 2, an
  *additional* patch row for dsh-llm-pi-ai will be appended; the
  current row is not changed.

- **The package.json dependencies** are not touched in this batch.
  Batch 2 is where `peerDependencies` / `devDependencies` are decided
  based on which route is selected.
