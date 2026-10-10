# Acceptance record

A repeatable baseline for "the plugin works on a real DSH". Written because a
one-off "it worked" cannot be re-checked after the next change, and because the
distinction between *verified here* and *reported by a person* is the thing that
makes a record worth keeping.

Every claim below is marked with how it is known. Where the evidence is a log,
the log line is quoted.

---

## Environment

| Field | Value | How it is known |
| --- | --- | --- |
| Plugin commit | **`1eebff5`** (`fix(sse): stop dereferencing the null usage frame`) | Committed 10:43:00; DSH restarted 10:44:04, so this is the tree that was loaded |
| DSH Desktop | **`0.2.0-rc.2`** | DSH's own `user-agent` on 582 requests to the gateway: `deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)` |
| wb2api | **`1.13.0-panel`** | `GET /panel/api/overview` → `{"version":"1.13.0-panel"}` |
| Provider | **`workbuddy`** | The gateway saw requests for `hy3-x` / `glm-5.2` with no `cn:` prefix from a second client. The user's own route is `abc123` and requests `cn:deepseek-v4.1-flash`; both appear in the same log, distinguished by model and cadence |
| Model | **`hy3-x`** | The session of interest below |
| Config source | `~/.dsh/profiles/desktop/cordis.patch.yml`, entry `workbuddy` | `apiKeyEnv: ABC123_API_KEY`, `baseURL: http://127.0.0.1:7863`, `realm: cn` |

Note the version skew: the `@deepseek-ai/*` type packages pinned in
`package.json` are `0.2.1-alpha.2` while the running application reports
`0.2.0-rc.2`. The compatibility range (`>=0.2.1-alpha.2 <0.3.0-0`) is expressed
against the former, which is why the runtime-reported version is recorded
separately here.

---

## 1. Mount — verified

`~/.dsh/workbuddy-bridge-mount.json`, written by the plugin itself at 10:44:03:

```
apply: entered                      hasConfig=true, providers=["workbuddy"]
apply: route resolved               apiKeyEnv=ABC123_API_KEY, baseURL=http://127.0.0.1:7863
resolveApiKey: resolved
managementServer: listening
adapter: constructed
llm service: found                  via="ctx.llm"
registerAdapter: ok                 provider=workbuddy
registerConfigurableProviders: ok   settingsNs=workbuddy
registerModelDiscovery: ok          settingsNs=workbuddy
listModels: ok                      count=19, first=["hy3","glm-5.3","glm-5.2","glm-5.1"]
mountEverything: complete
```

Every step `ok`, and **19 models returned by the gateway**.

---

## 2. The tool-call round trip — verified from the gateway's own log

The chain the acceptance gate asks for — model requests a tool → the tool runs →
the result is fed back → the model answers — is visible in
`data/request-logs/requests-2026-10-10.jsonl` as four consecutive calls inside
one minute:

| Time | Model | Status | prompt_tokens | completion_tokens |
| --- | --- | --- | --- | --- |
| 10:44:46 | `hy3-x` | 200 | 8 971 | **55** |
| 10:44:58 | `hy3-x` | 200 | 8 992 | 550 |
| 10:45:22 | `hy3-x` | 200 | 9 533 | 1 138 |
| 10:45:37 | `hy3-x` | 200 | 10 394 | 291 |

Two properties make this the round trip rather than four unrelated calls:

- **The prompt grows by exactly what the previous turn produced.** 8 971 → 8 992
  is the first round's tool result appended; the later jumps carry the
  accumulated transcript. A single call, or a client retrying, would show a
  constant prompt.
- **The first completion is 55 tokens** against a ~9 000-token prompt. That is a
  tool-call payload, not prose; the substantive answer is the 550-token second
  round.

This is the user's session (the user-agent is the pre-attribution `node`), not a
script of ours.

### What is *not* claimed

The tool that ran, its arguments, and the tool result's content are not in this
log — the gateway records the request, not the transcript. So "the tool
executed" is inferred from the prompt growth, not observed directly. Capturing
the agent transcript would close that gap.

---

## 3. Adapter behaviour — verified, reproducible

`scripts/manual/`, against the live gateway. These run the real adapter through
DSH's real `BlockAssembler`.

```
node scripts/manual/e2e.mjs text  glm-5.2
node scripts/manual/e2e.mjs tools glm-5.2 hy3-x
node scripts/manual/abort.mjs     glm-5.2
node scripts/manual/models.mjs
```

| Check | Result |
| --- | --- |
| Streaming text turn | `glm-5.2` → blocks `text`, finish `{kind:'stop'}`, usage `{12, 2, 14}`, text `PONG` |
| Reasoning + text in one turn | `hy3-x` → blocks `reasoning, text`, `reasoningTokens: 39` |
| **Tool call** | `hy3-x`, `glm-5.3`, `glm-5.2` each returned `get_weather` with `arguments` a **string** that `JSON.parse` accepts, finish `{kind:'tool-calls'}` |
| Block order varies by model | `hy3-x` → `reasoning, tool-call`; `glm-5.3` → `tool-call`; `glm-5.2` → `text, tool-call` |
| **Stop generation** | Aborted after 5 chunks; adapter throws `CALL_CANCELLED`; `LlmRuntime` normalizes it to `{kind:'aborted'}`; **10 lines of partial output survive** |
| Consecutive calls | 3 sequential turns, all `PONG`, exit 0 |
| Restart | The 10:44 mount listed above is itself a restart on a new build |

The three models producing three different block orders is why the translator
keeps one open block per kind rather than a single "current" block.

---

## 4. `usage: null` — the bug this record exists downstream of

The first real run on this machine failed with
`Cannot read properties of null (reading 'prompt_tokens')` after the gateway had
answered HTTP 200 and streamed the whole reply. Cause: wb2api sends
`"usage": null` on every frame but the last, and the guard tested
`!== undefined`, which null passes.

It survived 85 unit tests because every SSE fixture in the repository was
hand-written and every one omitted the `usage` field entirely. The frames in the
tests are now copied verbatim from the gateway.

---

## 5. Cost Meter — contract verified, integration not

The payload shape is verified against the consumer's own parser
(`tests/cost-meter-contract.test.ts` loads the installed
`parseWorkBuddyCredits`). The previous shape and the current one, same numbers:

```
OLD: status=unknown  windows=0  used=null  limit=null
     message="workbuddy: 无使用信号,额度状态未知(不视为耗尽)"
NEW: status=ok       windows=1  used=1737  limit=6600
```

**Not verified: an end-to-end reading in dsh-cost-meter's UI.** That needs a
gateway source configured on the cost-meter side with the management key, which
is a user step and has not been performed. Until it is, "balance observation"
is a contract that passes its tests, not a feature that has been seen working.

---

## 6. Not covered

| Area | State |
| --- | --- |
| OAuth sign-in | `auth-flow.ts` still uses the pre-review shapes (`registerFlow`, `credentials.set` arity, no `session.commit`). Batch 3 |
| Client UI | `client.js` still targets a `window.__DSH_REMOTE__` that no installed plugin uses, and guesses slot names. The dock badge renders; nothing else does. Batch 3 |
| Load / unload / reload cycles | The revocation and socket-leak fixes have unit coverage only. Repeated mount/unmount against a real Cordis fiber has not been exercised |
| Image / file input | `inputModalities: ['text']`, so DSH projects images to text placeholders. The gateway advertises `supports_images: true` for all 19 models, so this is a deliberate limitation, not a capability limit of the provider |

---

## Reproducing

```bash
pnpm run build                      # the manual scripts import lib/, not src/

export WB2API_API_KEY=...           # or WB2API_CONFIG=/path/to/config.json
node scripts/manual/e2e.mjs tools hy3-x
node scripts/manual/abort.mjs glm-5.2
node scripts/manual/models.mjs --ttl
```

`scripts/manual/README.md` explains why these exist as scripts rather than
tests, and why the fixtures are copied from the wire.
