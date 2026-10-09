# GitHub Support Ticket — Sensitive Data Removal Request (TEMPLATE)

> Date: 2026-10-10
> Repo: `mojingjing-git/dsh-workbuddy-bridge`
> Branch: `p0-probe`
> Requester: @mojingjing-git
>
> **This file is a template, not the submitted ticket.**
>
> It deliberately contains placeholders instead of the actual account
> identifiers. The filled-in version is produced locally at submission time
> and sent to GitHub Support through their private contact form — it is never
> committed here. Committing the real values would recreate, in a new commit,
> exactly the exposure this ticket exists to remove.

## Summary

Old commit `REDACTED-SHA` on the `p0-probe` branch of
`mojingjing-git/dsh-workbuddy-bridge` contains three evidence JSON files with
personal account identifiers captured from a local development environment
during a contract test. The local branch was force-pushed to drop the commit
from the active history, but the commit objects are still reachable on the
GitHub mirror by SHA, since GitHub does not garbage-collect dangling objects
on its own. We are requesting that GitHub purge the corresponding objects from
the public mirror cache so they are no longer reachable from outside the repo.

## URLs that resolve to PII at the time of writing

Each of these returns HTTP 200 with a non-scrubbed payload. The commit SHA is
already public in the branch history and is not itself sensitive; the payloads
are.

```
https://raw.githubusercontent.com/mojingjing-git/dsh-workbuddy-bridge/REDACTED-SHA/docs/probe/p0/M06-status.json
https://raw.githubusercontent.com/mojingjing-git/dsh-workbuddy-bridge/REDACTED-SHA/docs/probe/p0/M03-login-start-cn.json
https://raw.githubusercontent.com/mojingjing-git/dsh-workbuddy-bridge/REDACTED-SHA/docs/probe/p0/M03-login-start-global.json
```

The PII in those responses (category list; **actual values redacted here and
supplied only in the submitted ticket**):

- two wb2api `uid` UUIDs → `<UID_1>`, `<UID_2>`
- two wb2api `nickname` strings → `<NICKNAME_1>`, `<NICKNAME_2>`
- per-account credit and token counters → `<CREDITS_REMAINING>`,
  `<CREDITS_TOTAL>`, `<TOTAL_TOKENS>`
- two device-flow OAuth `state` UUIDs → `<OAUTH_STATE_1>`, `<OAUTH_STATE_2>`
- two authorization URLs (Tencent `copilot.tencent.com` and `workbuddy.ai`)
  carrying the `state` values above

These are not active API keys, refresh tokens, or other credentials that would
grant access to anything — they are account display identifiers plus a
device-flow `state` that expires 30 minutes after issuance — but they are
still account data, and they should not be on the public mirror.

## What we already did

1. Identified the offending commit (`REDACTED-SHA`) via PR review.
2. Replaced the three files' content in the working tree with scrubbed fixtures that preserve field names, types, and structural shape but replace every PII value with a `scrubbed-*` placeholder.
3. Created a brand new `p0-probe` branch starting from the clean `main` HEAD (`REDACTED-SHA`) and added a single new commit (`REDACTED-SHA`) that contains the scrubbed files plus the rest of the Batch 1 contract base. The new commit graph does not contain `REDACTED-SHA` in any reachable path.
4. Force-pushed `p0-probe` to overwrite the previous remote ref. The new remote `refs/heads/p0-probe` is `REDACTED-SHA`.
5. PR #1 was updated; its `headRefOid` now points to `REDACTED-SHA` and the commit list does not include `REDACTED-SHA`.
6. Local `git gc --prune=now --aggressive` removed the `REDACTED-SHA`, `REDACTED-SHA`, and `REDACTED-SHA` objects from the local `.git`.

## What we are asking GitHub to do

Purge the following object SHAs from the public mirror's object store (and from any cache, CDN, or fork that has a copy).

**Generation 1 — account identifiers only** (superseded by the second rewrite but still reachable by SHA):

| SHA | Why |
|---|---|
| `REDACTED-SHA` (commit) | Contains `docs/probe/p0/M06-status.json` and the two `M03-login-start-*.json` files with real `uid`, `nickname`, credit counters, token counters and OAuth `state` values. |
| `REDACTED-SHA` (commit) | Descendant of the above. |
| `REDACTED-SHA` (commit) | Descendant of the above. |
| `REDACTED-SHA...` through `REDACTED-SHA...` (six commits, see the branch reflog before the 2026-10-10 rewrite) | Second-generation branch. Its prose files restated the same account identifiers. |

**Generation 2 — a live API key.** This is the more serious one:

| SHA | Why |
|---|---|
| `REDACTED-SHA` (commit) | Introduced `docs/probe/BATCH2-E2E-RUNBOOK.md`, which printed the user's wb2api API key verbatim in two places. The key is a Bearer credential for the gateway, not merely an identifier. |
| `REDACTED-SHA` (commit) | The branch HEAD that carried the same file. **Verified still reachable at the time of writing**: `https://raw.githubusercontent.com/mojingjing-git/dsh-workbuddy-bridge/REDACTED-SHA/docs/probe/BATCH2-E2E-RUNBOOK.md` returns HTTP 200 with the key in lines 12 and 62. |

The current `p0-probe` HEAD is `REDACTED-SHA`, whose working tree contains no real value of any kind.

**Note on the API key**: the user has been told to rotate it in the gateway. Rotation is the only remedy that actually invalidates the leaked value; purging the mirror only removes one copy of it. The purge request is still being filed because the key should not remain readable after rotation either — an old key can reveal the gateway's shape, and a rotation that is later reverted would re-expose it.

The tree and blob SHAs those commits contain are the things actually being requested — commit SHAs are listed for context so the corresponding tree / blob SHAs can be derived by inspecting each commit's tree.

If a broader removal is possible (e.g. purging all objects un-referenced after the force-pushes), that is the preferred outcome.

## Why we cannot solve this locally

A force-push on a git remote does not delete the previous commit objects. The objects remain reachable from the mirror for as long as the mirror keeps them, which is controlled by GitHub's object lifecycle, not ours. Local `git gc --prune=now` only prunes the local object store; the mirror is unaffected. GitHub's public documentation acknowledges this and routes the workaround through Support.

## Why we are not deleting the repo and recreating

We considered that path. The reasons we did not take it:

- Deleting the repo does not purge the dangling objects from the mirror either; a recreated repo can still be reached at the same SHA.
- It destroys the issue history, the existing PR review chain, the watcher / star history, and the package name itself (since GitHub releases cannot reuse a name once it is freed).
- The new commit on `p0-probe` already contains a fully scrubbed working tree, so anyone who clones the branch going forward does not see the PII. The exposure is to direct-SHA lookups only, not to `git log` or to clone.

## Acknowledged limitations of this request

- GitHub Support may decline on the grounds that the data is non-sensitive account display info without an active credential, password, or API key. We are filing the request to make the path explicit and so the decision is recorded; we will accept a decline.
- Even if the dangling objects are purged, any third-party mirror, CDN edge, search-engine cache, or local clone made before the purge will still contain them. We have no way to enumerate or contact those.
- The user has been informed that this is "reducing exposure" rather than "fully eliminating it", and the project plan reflects that as a known limitation.

## Reproduction steps for GitHub Support to confirm

Generation 2 (the API key — start here, it is the higher-severity one):

1. `curl -sS https://raw.githubusercontent.com/mojingjing-git/dsh-workbuddy-bridge/REDACTED-SHA/docs/probe/BATCH2-E2E-RUNBOOK.md`
2. Confirm HTTP 200 and that lines 12 and 62 contain a literal API key.
3. Compare with the current HEAD (`REDACTED-SHA`) at the same path: it reads `api_key` from the reader's own `config.json` and prints `<WB2API_API_KEY_VALUE>`.

Generation 1 (account identifiers):

4. `curl -sS https://raw.githubusercontent.com/mojingjing-git/dsh-workbuddy-bridge/REDACTED-SHA/docs/probe/p0/M06-status.json`
5. Confirm HTTP 200 with real-looking account identifiers and exact counters.
6. Compare with the current HEAD at the same path: same shape, `_scrubbed: true`, `scrubbed-*` placeholders and round synthetic counters.
7. Confirm that `git log` on the current `p0-probe` branch lists neither `REDACTED-SHA` nor `REDACTED-SHA`.

## Contact

GitHub user: @mojingjing-git
Email: registered on the GitHub account
Repository: https://github.com/mojingjing-git/dsh-workbuddy-bridge
