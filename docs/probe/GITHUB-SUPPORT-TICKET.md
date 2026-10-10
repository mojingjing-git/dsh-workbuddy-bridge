# GitHub Support — Sensitive Data Removal Request (TEMPLATE)

> **This file is a redacted template, not the submitted ticket.**
>
> It deliberately contains **no commit SHAs and no account identifiers**. An
> earlier revision of this file listed the exact SHAs that still resolve to
> the leaked data, together with `curl` commands for them. Publishing that
> list made the leak easier to find, not harder: those objects are not
> indexed by GitHub code search and are reachable only by knowing the exact
> SHA, so the file was functioning as a directory of where to look.
>
> The filled-in version — SHAs, redacted values, and reproduction commands —
> is kept **outside this repository**.

## Why this request exists

A branch that has been force-pushed leaves its previous commits in GitHub's
object store. They stop appearing in `git log` and in clones, but
`raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>` still serves their
contents. Only GitHub can remove them.

The data involved was captured from a local development environment while
writing contract fixtures. It included account display identifiers, exact
credit and token counters, an ephemeral device-flow `state`, and — in a later
commit — a credential string that is also used as a password elsewhere. That
credential has since been changed by its owner.

## What has already been done locally

1. The working tree was cleaned: every real value replaced with an obvious
   synthetic placeholder, preserving field names and structural shape so the
   fixtures still serve their purpose.
2. The branch history was rewritten so that no reachable commit contains any
   real value. The rewrite was verified with a per-commit scan
   (`git grep <value> <sha>` across every commit), not by inspecting only the
   working tree.
3. The rewritten branch was force-pushed. All live refs — `refs/heads/*` and
   `refs/pull/*/head` — now point at clean commits.
4. The local object store was pruned; the pre-rewrite commits no longer exist
   locally, and `git fsck` reports no dangling objects.

## What we are asking GitHub to do

Purge the un-referenced objects created by the force-pushes, so the old SHAs
stop resolving. A blanket purge of unreferenced objects in this repository is
the preferred outcome; the specific SHAs are supplied in the submitted
version of this ticket rather than here.

## Acknowledged limitations

- GitHub Support may decline.
- Third-party mirrors, CDN caches, search-engine caches, or clones made before
  the purge may still hold copies. We cannot enumerate or contact those.
- **The single reliable remedy is changing the credential**, which the owner
  has done. Removing mirror copies is defence in depth: it stops the value
  from being rediscovered, and it stops an old value from becoming valid again
  if a change is later reverted.

## Note on repository deletion

Deleting and recreating the repository would also make the old SHAs stop
resolving, and it is the only self-service route that does so. This project
has so far chosen against it because it destroys the pull-request review
history, the issue history, and every inbound link, and because it does not
recall copies that already exist. It is recorded here as a considered
alternative rather than an oversight.
