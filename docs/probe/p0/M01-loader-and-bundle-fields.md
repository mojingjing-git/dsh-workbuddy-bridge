# P0 / M01 — DSH `cordis.patch.yml` Loader 真实字段

> Date: 2026-10-10
> Source: `https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration` (commit on `master`)
> Local evidence files: `M01-decoration-cordis-patch.yml`, `M01-decoration-index.js`, `M01-decoration-client.js`, `M01-decoration-package.json`

## Findings (each item = one Probe item from V2.2.1 §3.2)

### Loader root operations

```yaml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

- **Only `insert:` is demonstrated by the official template.** No
  `replace:` / `extend:` examples in the official `cordis-plugin-development`
  template set (sibling `mcp/` template not yet fetched in this round).
- Each insert entry **must** have:
  - `id` (shared between host and client, used for Slot matching)
  - `name` (npm-style package name)
- The list is multi-entry; a single plugin can declare multiple
  `insert:` rows in one file.

### `index.js` (host side)

```js
export function apply() {}
```

- Default export is `function apply(ctx?)`; the empty template does
  nothing because decoration plugins are client-side-only.
- Real Host plugins (e.g. `@deepseek-ai/dsh-llm-pi-ai`,
  `@deepseek-ai/dsh-cost-meter`) are expected to register services
  in `apply()` via the host's Cordis context.

### `client.js` (client side)

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    …
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({…}, Decoration));
      },
    };
  },
});
```

- The client module is loaded via the **DSh runtime module loader**
  (`window.__ModuleLoader__`).
- Returned object has **two** top-level keys:
  - `inject: string[]` — names of other DSH client modules this module
    needs (becomes the `require` argument in `factory(require)`)
  - `apply(ctx) { … }` — receives the DSH client context (here
    `ctx.slots`)
- `ctx.slots.inject(slot, registerFn)` is the **declarative** way to
  register a Slot entry.

### `package.json` — `dsh` block (definitive shape)

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

- `dsh.bundle.patch` — relative path from package root to the
  `cordis.patch.yml` file. The DSH host/bundle loader reads this to
  apply Cordis patches.
- `dsh.client` — DSH client-side plugin descriptor:
  - `platform: "web"` — only Web client supported in this template.
  - `immediately: true` — load on client boot, not lazy.
  - `inject: string[]` — **list of DSH client packages this plugin
    depends on at runtime**, NOT a list of entry files. The client
    module loader is the one that loads `exports["./client"]` for
    this package automatically once the platform matches and
    `inject` is satisfied.
- `exports` map **must** include:
  - `"."` (host entry, served to the host)
  - `"./client"` (client entry)
  - `"./locale/*.json"` (translations)
  - `"./icon"` (icon asset)

### `files` whitelist

```json
"files": [
  "index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"
]
```

- The plugin tarball that DSH installs from npm is **only** the files
  listed in `files[]` (or at least, this is what the template
  author considers safe to ship). **This is the natural place to
  ensure no Go source / no prebuilt binaries leak into the npm
  package.**

## Remaining open questions (NOT in this template — must look elsewhere)

- A **Host plugin template** that does work in `apply(ctx)` (e.g. a
  provider registration, a server route, a Settings service). The
  `decoration` template is purely a Slot decoration and its `apply`
  is empty. V2.2.1 §3.2 P0 probe item 5 — "is there a Server or
  Service template" — is therefore still open.
- Whether `cordis.patch.yml` supports a top-level `replace:` /
  `extend:` operation in addition to `insert:`. (Sibling `mcp/`
  template in the same directory is the most likely place to find
  this.)
- The exact `ctx` shape on the host side (services available, ctx
  extension mechanism). Must be probed from a real Host plugin
  such as `@deepseek-ai/dsh-llm-pi-ai` or `@deepseek-ai/dsh-cost-meter`.

## Implications for `dsh-workbuddy-bridge` v1 package.json

- Must have `cordis.patch.yml` declaring one insert row:
  `id: "workbuddy"`, `name: "dsh-workbuddy-bridge"` (matching `package.json#name`).
- `index.js` must `export function apply(ctx)`; this is where the
  LLM provider is registered and the workbuddy service is exposed
  for the client half to call.
- `client.js` must use `window.__ModuleLoader__.load({...})` and
  return `{inject, apply(ctx)}` registering all needed Slots.
- `dsh.client.inject` will include `@deepseek-ai/dsh-cost-meter`
  and any DSH client packages the sidebar / settings page needs
  (still to be enumerated when we look at the real Host-plugin
  template and at `dsh-cost-meter` for the cost-meter slot names).
