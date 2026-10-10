# Manual checks against a live gateway

These scripts talk to a **running** wb2api. They are not part of `pnpm test`:
they need a gateway, a key, and a built `lib/`.

They exist because unit tests here have a blind spot that has already cost a
debugging round. Every SSE fixture in `tests/` was written by hand, and every
one of them omitted the `usage` field entirely — so nothing exercised the
`"usage": null` that the gateway actually sends on every frame. 85 tests passed
while the adapter crashed on the first real reply. A test that invents its own
fixture cannot find a bug that lives in the difference between that fixture and
the real wire.

These scripts run the real adapter against the real gateway instead.

## Setup

```bash
pnpm run build          # these import from lib/, not src/
```

Then either export the key, or point at a wb2api config file:

```bash
export WB2API_API_KEY=...              # used as-is
export WB2API_BASEURL=http://127.0.0.1:7863   # optional, this is the default
export WB2API_CONFIG=/path/to/config.json     # fallback: reads its api_key
```

The scripts never print the key. `WB2API_CONFIG` defaults to the local wb2api
install; override it rather than editing the scripts.

## `e2e.mjs` — does a real call produce a usable answer

```bash
node scripts/manual/e2e.mjs text  glm-5.2
node scripts/manual/e2e.mjs tools glm-5.2 hy3-x
```

`text` streams one turn and prints the assembled blocks, finish reason and
usage. `tools` sends a real tool schema and checks that the model returns a
`tool-call` block whose `arguments` is a **string that `JSON.parse` accepts** —
which is what DSH's dispatcher does with it.

Exit codes: `0` pass, `1` the adapter threw, `2` the model answered in prose
instead of calling the tool, `3` the arguments did not parse.

A model answering in prose is exit `2`, not a failure of the adapter: of the 19
advertised models, not all support tool calls. Try another before concluding
anything.

## `models.mjs` — what the gateway actually advertises

```bash
node scripts/manual/models.mjs
node scripts/manual/models.mjs --ttl
```

Prints the raw `/v1/models` metadata, a census of which fields appear on every
entry versus only some, the `credits` values **verbatim**, a preview of the
credits parser and the resulting cheapest-first order, and what the adapter
currently returns.

`--ttl` additionally measures the model cache by counting real HTTP hits: an
immediate second call should not hit the gateway, and a call after 62 s should.

The verbatim dump is the point. The `credits` field is not uniform — some
entries spell it `"x0.79"` and others `"x0.08 credits"`, and at least one entry
omits it entirely — so a parser written against a guessed shape would produce a
silently wrong sort rather than an error.
