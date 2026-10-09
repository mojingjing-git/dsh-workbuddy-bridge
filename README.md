# dsh-workbuddy-bridge

> **Status: planning** — this repository is currently in the planning phase.
> The next concrete step is **P0 探针** per `plan v2.2.1`. No code has been
> written yet; only the planning artifacts are committed.

DSH plugin that brings the WorkBuddy / CodeBuddy OAuth account flow into
DeepSeek Harness (DSH) as a first-class experience: authentication, model
selection, balance observation, optional self-managed gateway.

## What this is (in one paragraph)

`dsh-workbuddy-bridge` lets a DSH user:

1. add a Tencent CodeBuddy / WorkBuddy OAuth account without leaving the DSH UI;
2. pick models from the WorkBuddy gateway by their canonical names (no `cn:`
   prefix noise);
3. see balance / cooldown state of every account on the DSH sidebar;
4. optionally let the plugin own a self-built WorkBuddy2API process so they
   never have to install wb2api separately.

The plugin stays MIT-licensed and does not bundle or ship prebuilt wb2api
binaries; the user is always the one driving installs / upgrades.

## What this is not

- **Not** an official Tencent product, plugin, or integration. The upstream
  gateway `linguo2625469/workbuddy2api-panel` is the third-party
  reverse-engineered bridge that the plugin talks to; the plugin is an
  independent DSH-side layer.
- **Not** a redistribution of WorkBuddy2API. The plugin never embeds the
  upstream Go source / binaries. When self-build is requested, the user
  fetches the source directly from the upstream repository.
- **Not** an account farm, sharing platform, or commercial relayer. The
  upstream `README` §使用声明 explicitly forbids such uses, and the plugin
  has no facility for them.

## Current state

| Stage | Status |
| --- | --- |
| Planning (V1 / V2 / V2.1 / V2.2 / V2.2.1) | ✅ complete |
| P0 探针 (real DSH / real wb2api handshake) | ⏳ next |
| P1 Attach MVP (real OAuth + Agent tool-call) | — |
| P2 Managed (self-build + lifecycle) | — |
| P3 Update + Publish | — |

The full V2.2.1 plan (`dsh-workbuddy-bridge-plan-v2.2.1.md`) and the change
log against the previous iteration
(`REVIEW-CHANGELOG-v2.2-to-v2.2.1.md`) live in this repository.

## License

MIT — see [`LICENSE`](./LICENSE).
