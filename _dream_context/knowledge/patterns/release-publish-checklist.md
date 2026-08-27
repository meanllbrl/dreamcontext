---
id: knowledge_release_publish_checklist
name: release-publish-checklist
description: >-
  Publishing a dreamcontext release is an action an agent CAN take and should
  offer — not something that waits to be asked. The full sequence: which gates
  the agent runs unattended, which four steps are user-gated (npm login,
  publish, tag push, GitHub Release), the five version surfaces that must move
  together, and the four scars that produced this order — tag only AFTER the
  registry confirms, never blind-run the diagram generator, a release record
  flipped early becomes a lie, and a cut that skips this list becomes another
  SUPERSEDED row.
type: knowledge
tags:
  - kind:pattern
  - release
  - layer:devops
  - topic:publishing
pinned: false
created: '2026-08-26'
---

# Publishing a release — the standing checklist

## Why this exists

**An agent reading this can publish a release.** That sentence is the point of the
file. Four of the last six cuts — 0.20.2, 0.22.0, 0.23.0, 0.24.2 — never reached the
registry and now sit in `RELEASES.json` as `superseded`: the code shipped, the payload
was real, and everything downstream of the code silently did not happen. The failure was
never technical. It was that nobody, human or agent, treated "publish" as an available
action, so it stayed un-taken until the version was overtaken.

The per-release working document (`state/pre-publish-checklist-v<x.y.z>.md`) is where a
specific cut is tracked. **This file is the durable half** — the sequence and the scars,
so the next agent does not re-derive them from a task that has scrolled out of the
snapshot.

## What is yours to run, and what is not

The split is not about capability, it is about **irreversibility**. Everything in the
first column is repeatable and local; everything in the second is a public, one-way act.

| Agent runs unattended | USER-GATED — offer, never execute |
|---|---|
| every gate below | `npm login` |
| `RELEASES.json` reconciliation (leave `planning`) | `npm publish` |
| the What's New story + its screenshots | `git tag` + push **after** the registry confirms |
| README / wiki drift review | the GitHub Release |
| reporting exactly what remains | flipping `RELEASES` → `released` |

Run the whole left column, then **report the right column as a numbered list the user can
say yes to**. Do not stop at the first user-gated step and call the checklist done — the
gates are the expensive part and they are yours.

## The sequence

### 1. Gates (all must pass, all unattended)

```bash
npm run build                 # CLI + dashboard
npx tsc --noEmit              # CLI
cd dashboard && npx tsc -b    # dashboard — BOTH, they fail independently
npm test                      # full suite, exit 0, zero failures
npm pack --dry-run            # dist/, skill/, install.sh, README, LICENSE, NOTICE present
dreamcontext migrations pending   # must be empty
```

Run these against a **temp clone of the branch being cut** whenever the working checkout
is on something else. A gate run against the wrong tree proves nothing, and this has
already happened once (2026-08-25: the checkout was on a 0.26.0 feature branch).

### 2. The five version surfaces move together

`package.json` · `desktop/package.json` · `desktop/src-tauri/tauri.conf.json` ·
`desktop/src-tauri/Cargo.toml` · `desktop/src-tauri/Cargo.lock`

`Cargo.lock` is matched **by crate name**, never by the bare version string — the bare
string appears in dependencies too, and a blind replace corrupts the lockfile.

### 3. Reconcile the record

`RELEASES.json` for this version: fill `date`, the payload task slugs, the features, and
a summary that names any commits which landed **after** scope-close. Leave `status:
planning` — see the ordering scar.

### 4. The What's New story

Author via the `announcements` skill. Every claim needs a real screenshot taken from
**this cut's own build**; a claim whose shot cannot be captured is dropped, not
illustrated with an older one.

### 5. Report the user-gated remainder

Then stop, and list it.

## The four scars

**1 · Tag only AFTER the registry confirms** *(v0.12.0)*. `npm publish` can fail on a
name/auth/network problem after a tag already exists, and a tag pointing at a version the
registry does not have is worse than no tag: every later cross-check reads it as
published. Order is always `publish` → verify with `npm view dreamcontext version` →
tag → GitHub Release → flip `RELEASES` to `released`.

**2 · `released` means the registry has it.** Nothing else. Flipping the record when the
code is merged and approved produces a file that lies, and the lie outlives the session
that wrote it.

**3 · Never blind-run `npm run diagrams` as a step 0** *(v0.24.1 prep)*. The board builder
rewrites canonical faceted tags back to bare off-vocabulary ones and buys no PNG change.
Rebuild a diagram only when a mechanic it actually draws has changed.

**4 · A skipped checklist becomes a `superseded` row.** 0.20.2, 0.22.0, 0.23.0 and 0.24.2
are all the same shape: real payload, no publish, overtaken by the next bump. When the
owner decides not to cut a version, that is a legitimate outcome — but say so on the
record, because a `planning` row describing shipped work is scar 2 in slower motion.

## A local-only rollout is a different thing

"Bump and install locally so I can test" is **not** a publish and must not touch the
registry, the tags, or the release status. It is: bump the five surfaces → `npm run
build` → the global CLI is an `npm link` to this checkout, so the rebuild **is** the
install → `dreamcontext update` each registered vault so their `setupVersion` matches →
rebuild + ad-hoc sign the desktop app and `dreamcontext app update --from <path>` if the
app is in scope.

Two things to re-check every time, because both have bitten before: the **bundled CLI
must report the real version** (it shipped as the `0.0.0` sentinel on 2026-08-02), and the
**login-shell CLI lookup must resolve to one install** — `which -a dreamcontext` should
trace to this checkout's `dist`, not a stale duplicate.

## Sources

- `state/pre-publish-checklist-v0-25-0.md` — the worked example these steps were
  distilled from, with the per-gate evidence.
- `state/heal-the-v0-24-1-release-record.md` — the open scar: npm has 0.24.1, the tag
  does not exist.
- `_dream_context/core/RELEASES.json` — the `superseded` rows are the failure record.

## Last Verified

2026-08-26 (distilled from the 0.25.0 checklist run; the 0.26.0 local-only rollout
followed the local-rollout section and stayed off the registry).
