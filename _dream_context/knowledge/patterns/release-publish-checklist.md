---
id: knowledge_release_publish_checklist
name: release-publish-checklist
description: >-
  Publishing a dreamcontext release is an action an agent CAN take and should
  offer. The sequence: the gates the agent runs unattended, the four user-gated
  steps (npm login, publish, tag push, GitHub Release), the five version
  surfaces that move together, the four scars behind the order (tag only after
  the registry confirms; `released` means the registry has it; never blind-run
  the diagram generator; a skipped list becomes a SUPERSEDED row), and three
  non-code gates: the SKILL.md byte ceiling, a polluted Chat-tab shell, and
  announcement shots from a synthetic vault. The desktop release is signed
  with ONE fixed self-signed certificate so macOS keeps users' permissions
  across updates; never ship it ad-hoc, never rotate that certificate.
type: knowledge
tags:
  - 'kind:pattern'
  - 'topic:release'
  - 'layer:devops'
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

## Three gates that are not about the code (0.30.0)

**A feature cut can fail on skill SIZE.** `skill/SKILL.md` has a hard **46,080-byte ceiling**, phrase-pinning tests that require specific sentences to be present, and a `.claude` mirror that must be **byte-identical**. A wave that documents itself (0.30.0's Insights v2 rows) pushes past the ceiling, and the gate that fails is a skill test, not a build. Budget the doc bytes with the feature, and re-run the mirror check after any SKILL.md edit.

**Run the gates from a plain shell, not from inside a Chat tab.** A desktop Chat tab exports `DREAMCONTEXT_CHAT_TAB`, which the hook tests inherit — they then assert against a marker nobody set in the test. The variable is now scrubbed in the test setup, but the habit stands: a gate run inside an app surface is a gate run in a polluted environment.

**Announcement shots need a synthetic vault, and some surfaces cannot be shot at all.** The 0.30.0 story was captured from the fictional **"orbit"** demo vault (`marketing/build-demo-vault-v2.sh`) plus a funnel fixture (`scripts/verify/fixtures/funnel-explorer-demo.mjs`), driven by `e2e/announce-shots-0-30.mjs`. The exception worth remembering: **agents-channel posts cannot be shot in an isolated home**, because `automations post` needs a real run behind it — plan a real-vault capture for those, or drop the claim per the step-4 rule.

## The desktop app's signature is part of the release (2026-10-04)

**Every published `.app` must carry the same certificate.** An ad-hoc signature's
designated requirement is the bundle's `cdhash`, so each release is a new app to macOS
TCC and every user is asked for file, microphone and automation access again after every
update — the owner hit exactly this. `desktop-release.yml` now signs with the one
self-signed **"dreamcontext Release Signing"** certificate, which turns the requirement
into `identifier "com.dreamcontext.beta" and certificate leaf = H"<sha1>"`, shared by
every release, so grants survive.

- **One-time setup (owner, already a user-gated step):** `scripts/release-signing-cert.sh`
  creates the certificate, backs it up under `~/.dreamcontext/release-signing/`, and sets
  secrets `MACOS_SIGNING_P12`, `MACOS_SIGNING_P12_PASSWORD` + variable
  `MACOS_SIGNING_CERT_SHA1` via `gh` in the **`release` environment, deployable only from
  `v*` tags** — the repo is public, so no branch workflow or fork PR may read the key.
  Re-running reuses the backup. A manual `workflow_dispatch` must run from a tag ref.
- **The key is the app's identity on users' machines.** Whoever holds it can sign a binary
  macOS treats as dreamcontext-beta and inherit its file/microphone grants. Keep it only in
  the environment and the backup; every action in that job is pinned to a commit SHA, and
  the temp keychain is deleted before the third-party release action runs.
- **The workflow fails rather than falls back.** Missing secrets fail the sign step, and
  both the sign step and the artifact check assert the requirement names the pinned SHA-1.
  An ad-hoc release would silently cost every user their permissions again.
- **Never rotate the certificate casually.** A new one is a new identity: every user
  re-grants once. Lose the backup folder and that is the price.
- **On the owner's machine** `app install|update` re-signs with the local
  **"dreamcontext Local Signing"** identity (`dreamcontext app sign-setup`, done
  2026-10-04), so local `--from` builds keep grants too. `app status` shows which.
- **Not covered:** no Developer ID, no notarization — a browser-downloaded copy still
  meets Gatekeeper. Delivery stays CLI-driven (`curl`/`ditto`, no quarantine).

## A local-only rollout is a different thing

"Bump and install locally so I can test" is **not** a publish and must not touch the
registry, the tags, or the release status. It is: bump the five surfaces → `npm run
build` → the global CLI is an `npm link` to this checkout, so the rebuild **is** the
install → `dreamcontext update` each registered vault so their `setupVersion` matches →
rebuild the desktop app and `dreamcontext app update --from <path>` if the app is in
scope — the install re-signs it with the local identity, so the owner's macOS
permissions survive the rebuild (if `app status` says `ad-hoc`, run
`dreamcontext app sign-setup` once).

Two things to re-check every time, because both have bitten before: the **bundled CLI
must report the real version** (it shipped as the `0.0.0` sentinel on 2026-08-02), and the
**login-shell CLI lookup must resolve to one install** — `which -a dreamcontext` should
trace to this checkout's `dist`, not a stale duplicate.

## Sources

- `state/pre-publish-checklist-v0-25-0.md` — the worked example these steps were
  distilled from, with the per-gate evidence.
- `state/heal-the-v0-24-1-release-record.md` — the historical scar from the 0.24.1
  cut, whose tag was never pushed. RESOLVED as of 2026-08-29: the registry now
  serves **0.26.2** (verified independently by two sleep specialists). The live gap
  is one patch — 0.26.3 is cut locally and unpublished.
- `_dream_context/core/RELEASES.json` — the `superseded` rows are the failure record.

## Last Verified

2026-10-05 (0.30.0 published end to end: npm from gitHead 02fa749a, ~9.5 min before the registry served it while the local `npm view` cache still said 0.28.0, so verify against registry.npmjs.org; tag pushed only after that; the release-certificate CI path ran on a tag for the first time and passed, and the downloaded asset's requirement names `certificate leaf = H"8fcf5eee…"`. An unannounced feature can ship hidden for testing: one revertable commit gates its UI on local setup, hides the CLI command from --help, and moves its docs out of the package; revert it on main right after the tag). 2026-10-04 (desktop signing section: local identity verified on the installed app —
`designated => identifier "com.dreamcontext.beta" and certificate leaf = H"8a17…"`; the
CI release-certificate path is written but has not run on a tag yet). 2026-10-02 (the 0.30.0 cut followed this list: five version surfaces + both lockfiles moved
together, `RELEASES.json` reconciled and left at `planning`, the What's New story authored
from this build's own shots. The npm publish is the open user-gated step). Distilled
originally from the 0.25.0 checklist run; the 0.26.0 local-only rollout stayed off the
registry.
