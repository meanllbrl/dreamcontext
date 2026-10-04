---
id: "feat_2VVWqCVG"
type: "feature"
name: "hands-free-cloud-mode"
description: >-
  Hands-free mode moves the active project to a GitHub Codespace, the phone
  drives it over a link and a passphrase while the laptop's roots are locked,
  and Return brings every commit, diff, stash and session home with a receipt.
pinned: false
date: "2026-10-03"
status: "in_progress"
created: "2026-10-03"
updated: "2026-10-04"
released_version: null
tags:
  - 'topic:mobile'
  - 'topic:agents'
  - 'topic:github'
  - 'topic:cloud'
  - 'domain:security'
  - 'domain:infrastructure'
  - 'kind:architecture'
  - 'layer:backend'
  - 'layer:frontend'
related_tasks:
  - >-
    hands-free-mode-moves-the-active-project-to-a-cloud-machine-the-phone-drives-it-through-a-link-and-password-and-return-brings-every-diff-and-session-back-to-the-laptop
---

## Why

Owner, 2026-10-02: *"Laptoptayım ama mobil olmak istiyorum. Eller serbest moduna basayım, bilgisayarın kopyası sanal bir yerde eşlensin, telefondan link + şifreyle web app olarak kullanayım; bilgisayara dönünce dön desin ve tüm diff'ler, sessionlar ve içerikleri dahil, buraya taşınsın."*

Today's phone path is laptop-bound: the tailnet gate hangs off the laptop's own
server, so closing the lid or dropping the socket kills the turn. Giving an agent
a job and putting the phone in a pocket does not work. Hands-free makes the run
belong to a cloud machine instead, with the laptop deliberately locked while the
work is away so the two sides can never both write.

## User Stories

- [ ] As the owner, I press Hands-free, scan a QR, and keep driving the same project from my phone while the laptop sleeps.
- [ ] As the owner, I set this up with nothing but a GitHub login — no card, no CLI, no provider account.
- [ ] As the owner, I come back to the laptop, press Return, and find every commit, branch, tag, stash entry, staged and unstaged change, untracked file, brain state and chat session exactly where the cloud left it — with a receipt that names what landed and what conflicted.
- [ ] As the owner, I am never charged by surprise: the machine stops itself when idle, warns me before the quota or the 30-day retention would bite, and Abandon never deletes cloud work.
- [ ] As the owner, nothing can write my laptop's copy while I am away, so there is no divergence to reconcile by hand.

## Acceptance Criteria

The canonical list is **AC1-AC24 in the task** `hands-free-mode-moves-the-active-project-to-a-cloud-machine-…`; they are too fine-grained to mirror here and this PRD must not fork them. The shape they prove:

- [ ] **Setup** needs only a GitHub device-flow login (`repo` + `codespace`), is idempotent, and leaves a stopped codespace with port 8080 public (AC1).
- [ ] **go** reaches per-checkout parity: equal HEAD, refs, stash list (shas AND messages), indexTree, worktreeTree and `git status --porcelain=v2` on both sides, with allow-listed non-git files sha256-equal and the excluded trees absent in the cloud (AC2).
- [ ] **The phone** signs in with a generated passphrase, stays signed in 30 days, survives stop/start and a revoke-all, and a sealed cloud serves only the sealed page (AC3).
- [ ] **The public forwarded port is never trusted**: loopback means nothing in cloud mode, unauthenticated `/api/*` and WS upgrades are refused even from inside the codespace, transfer routes and device cookies cannot reach each other, and on the laptop every `/api/handsfree/*` route is desktop + loopback + same-site only (AC4).
- [ ] **Sessions travel both ways** with their history and titles (AC5), and **the laptop is locked** while away — every spawn chokepoint and every mutating request scoped to a locked vault refused, automations and syncs skipped, a banner on every page (AC6).
- [ ] **Return** lands everything or parks the repo, wipes the secret class from the cloud, seals it, stops the machine and shows the receipt (AC7) — and **deletes no laptop non-git file** (D20), reporting what the phone deleted instead; the receipt names every changed auto-executing config file with its diff (AC20) and every secret-class name the cloud overwrote (D16).
- [ ] **Build parity** by uploading the laptop's own tarball to a root install loop, never a container rebuild (AC18); **isolation** between `dcserver`, `dcuser` and the `codespace` user holds (AC19).
- [ ] **Quota, retention and ownership** cannot wedge the owner: refusal with a reason and an Abandon path, day-20 warnings, and a double-confirmed `--take-over` that recovers a live trip from a lost laptop (AC22-AC24).
- [ ] **Validation:** `npm test`, `scripts/verify/handsfree-roundtrip.mjs`, `scripts/verify/chat-reconnect.mjs`, a real-Codespaces smoke run, and the owner's real-phone checklist (the agent never ticks that one).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

The full D1-D20 decision record, the residual-risk statement and the out-of-scope
list live in the task. The load-bearing ones:

- **[2026-10-04] D20 — Return NEVER deletes a laptop non-git file.** The same loss class failed W1 reviews 3, 4 and 5: a laptop file disappearing at Return because the cloud happened not to have the path. A non-git path (Transport 2, transcripts included) present at trip start and absent in the cloud is listed in the receipt as "deleted on the phone, kept here" and the owner deletes it by hand; git-tracked deletions still land through Transport 1's non-tolerant snapshots. A cloud path the worker cannot read is refused and listed, never silently dropped; a tolerant (recovery) snapshot is never applied to a laptop working tree. Go (laptop → cloud) still mirrors deletions into the cloud.
- **[2026-10-03/04] D18/D19 — a link that cannot travel never leaves, and is never deleted.** An incoming symlink target is accepted only in canonical relative form (`.` segments anywhere are ignored, since they never climb). A link whose target fails that rule is left out of Transport 2's walk and listed "stays on the laptop", and the go git preflight refuses a repo whose indexTree/worktreeTree holds such a `120000` entry, naming the file — exactly like a submodule. **D19 amended (2026-10-04, after review round 4 found the exclusion also running in the cloud and deleting the laptop's own link):** the exclusion and the physical check run ONLY on the laptop (go, and the laptop's own Return manifest); the cloud sends every link and its git checks are lexical only; the laptop's apply refuses a bad incoming link and keeps its own copy; and a path the cloud could not send is never planned as a deletion. **D19 wins over D16:** a path that stayed home is never overwritten by the cloud's version — it goes to conflicts.
- **[2026-10-03] D16 — a secret-class file edited IN THE CLOUD comes home.** "The cloud is a copy of the same computer", so on Return the cloud's version overwrites the laptop's even when the laptop's copy also changed; the laptop's copy is backed up to `trips/<trip>/backup/` first (Roll back restores it) and the receipt lists file NAMES, never contents; then the class is wiped from the cloud as before. A secret-class file absent in the cloud never deletes the laptop's copy (absence usually means "wiped") and is listed "not returned". dreamcontext's own credential files (`.secrets.json`, lab credentials) never travel and are refused on Return.
- **[2026-10-03] D17 — a continuous phone session longer than 4 h is cut by GitHub, accepted as is.** Since GitHub's idle clock resets only on a start or an ssh/editor connection, `idle_timeout_minutes=240` means real continuous use past 4 h after the last start is stopped mid-use: the phone shows the asleep page with Wake, the running turn is cut and stays resumable, and no self-ssh workaround is built.
- **[2026-10-03] D15 — the cloud stops ITSELF.** W0 proved Codespaces' idle clock resets only on a start or an ssh/editor connection: pty writes and forwarded-port traffic, even self-requests, do not count, so **no keepalive exists**. A helper running as the `codespace` user (launched by `postStartCommand`) uses GitHub's own in-codespace token for one call — `gh codespace stop` on its own codespace — and that token never reaches `dcserver` or `dcuser`. `idle_timeout_minutes=240` is only a backstop; residual: a failed self-stop burns up to 4 h of quota.
- **[2026-10-03] D14 — what "idle" means.** With no turn running the machine sleeps 15 min after the later of the last turn's end and the owner's last *real* action (send, steer, open a session); pings, polling, an open tab and a locked phone never count. A running turn holds it awake, at most 2 h.
- **[2026-10-03] D13 — cloud Claude accounts sign in FRESH** inside the codespace with the CLI's own `claude auth login` into each sandbox config dir. No credential, keychain OAuth or setup-token ever travels: copying the refresh token would sign the laptop out.
- **[2026-10-02] D1 — GitHub Codespaces only**, chosen over Fly.io, Hetzner, Daytona, E2B and Railway because every user sets this up themselves and Codespaces needs only a GitHub account, no card (the $0 spending limit makes GitHub block at the quota instead of billing). **No fallback provider:** if the W0 gate fails, the feature waits.
- **[2026-10-02] D3 — the laptop LOCKS the in-scope roots while away.** The design buys its correctness by making divergence impossible rather than merging it.
- **[2026-10-02] Git state travels git-native**, never as `.git` files: snapshots of refs/stash/trees, bundles with prerequisites, and a shared path guard used by both transports. The cloud's `.git/config`, `hooks/` and `info/` are GENERATED on every transfer.
- **[2026-10-02] D11 — auto-executing config changed in the cloud is APPLIED on return** and only flagged in the receipt with its diff. The owner accepted this risk explicitly after it was raised twice.
- **[2026-10-02] D7/D12 — secrets travel, are wiped from the cloud on return and listed in a receipt; Abandon never deletes cloud work** (the next `go` recovers it first). Refined by D16 above: on Return the cloud's copy wins, after a backup.
- **[2026-10-02]** Plan reviewed in three rounds under critic, pragmatist, edge-cases and security lenses before any code.

## Technical Details

**Status: in build, waves 1-2 of 4, nothing committed and nothing shipped.** W0 (the
provider gate) is closed and produced D15/D17; W1 (the transports and the shared path
guard) is built and has been through five review rounds — rounds 3, 4 and 5 all found
the same loss class and produced D18, D19, the D19 amendment and D20; W2 (cloud server,
laptop orchestration, lock consumers) is built and its first review round failed with
four major findings (a forged permission entry in the cloud, a stuck `returning` phase,
Roll back only undoing the last round, and auto-sleep/automations in OTHER processes not
being waited on at a dashboard-driven go). No acceptance criterion is ticked. The task
file carries the authoritative code-fact map, the wave map and the per-transport
algorithms. The shape:

- **One codespace per owner** from the private repo `<owner>/dreamcontext-handsfree` (devcontainer with Node, git, the `claude` CLI and the users `dcserver` / `dcuser` in group `dcwork`).
- **The mirror root is the laptop's own absolute path** (`/Users/<name>` = cloud HOME, a bind mount of `/workspaces/dc-home`, never a symlink), so transcript directory encodings, `--resume`, the session roster and worktree paths stay valid with zero rewriting.
- **Phases:** laptop `home | going | away | returning` in `~/.dreamcontext/handsfree/state.json`; cloud `sealed | active | quiescing` on the persistent disk. Only `active` serves the phone and allows spawns; transitions only through bearer routes.
- **Transport 1 (git-native):** per-repo snapshot of refs, the ordered stash list and per-checkout `HEAD` / `indexTree` / `worktreeTree`, shipped as filtered bundles, received with `transfer.fsckObjects`, backed up under `refs/handsfree/backup/<trip>/*`, applied through `git checkout-index` so the receiver's own eol and smudge rules run.
- **Transport 2 (non-git):** an lstat-only manifest (never follows symlinks) and a framed gzip pack for the ignored brain/`.claude` content and the secret class, applied temp+fsync+rename with sha256 verification. dreamcontext's own credential files never travel and are refused on Return.
- **One shared path guard** (`src/lib/handsfree/paths.ts`) for both transports: no `..`, no absolute paths, no `.git` segment at any depth after NFC + case-fold, `.` segments ignored anywhere, collision checks against differently-spelled existing paths, and a symlink target accepted only in canonical relative form resolving inside the root (written last). A link that fails the rule **stays on the laptop** — excluded from the walk and listed, with the go git preflight refusing a repo that carries such a `120000` entry (D18/D19). That exclusion and the physical check are **laptop-side only**: the cloud sends every link and checks lexically (D19 amended).
- **Return is conservative, and it never deletes:** any divergence in refs, HEAD, the stash list or the index parks the repo into `refs/handsfree/<trip>/*` and `trips/<trip>/conflicts/` instead of guessing; every overwritten laptop file is copied to `trips/<trip>/backup/` first so Roll back is real. **No laptop non-git file is ever deleted by a Return** (D20) — an absent cloud path is reported, not applied — a path the cloud could not send is never planned as a deletion, a stayed-home path is never overwritten (D19 over D16, it goes to conflicts), and a tolerant recovery snapshot is never applied to a working tree.
- **Session state** merges per entry by id with the cloud winning — **except** `chatPermissionMode` and every other permission field, which always keep the laptop's value, and cloud-only roster entries, which land with `bypass: false`.
- **A `CloudProvider` interface with exactly one implementation** (Codespaces) plus the fake the verify script needs.

## Notes

- This PRD is deliberately a map, not a mirror: the task holds AC1-AC24, D1-D20, the residual-risk statement, the out-of-scope list and the wave map. Reconcile this file when a wave lands; do not re-type the criteria here.
- The one pattern this build keeps re-teaching: **a sync that can delete is a sync that will delete the wrong thing.** Three consecutive W1 review rounds found the same class (a laptop file or link lost because the cloud lacked its path), and the answer each time was to narrow deletion out of the design (D19, D19 amended, D20) rather than to fix the condition that triggered it.
- W0 item 1 (a pty keepalive) **failed** and produced D15 — the clearest evidence in the project that a provider's idle clock is a provider fact to be measured, not assumed.
- Out of scope v1 (abridged): any other provider, pushing to GitHub from the cloud, web push, cloud automations, more than one trip at a time, desktop-only surfaces (PTY, voice, Assistant, OS reveal), Git LFS, submodules, custom filter drivers, shallow/partial clones.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-04 - Reconciled with the locked decisions D16-D20 (still mid-build, nothing ticked)

- The decision record was stale at D15 while the owner had locked five more: **D16** (a cloud-edited secret-class file comes home over the laptop's, after a backup, names only in the receipt), **D17** (a >4 h continuous phone session is cut by GitHub's own idle clock — accepted, no self-ssh workaround), **D18/D19** (a symlink that cannot travel never leaves and is never deleted; canonical relative targets only, `.` segments ignored; go's git preflight refuses such a repo like a submodule) with the **D19 amendment** (the exclusion and the physical check are laptop-side only, the cloud sends every link, a path the cloud could not send is never a deletion, D19 wins over D16 into conflicts), and **D20** (Return NEVER deletes a laptop non-git file; unreadable cloud paths are refused and listed; a tolerant recovery snapshot never touches a working tree).
- Contradictions fixed, not appended: the path-guard and Return bullets in Technical Details said symlinks were simply "resolved inside the root" and described Return as parking-on-divergence with no non-deletion rule; "D1-D15" in two places became D1-D20; the D7/D12 line now points at D16 for the Return direction.
- Build status corrected: "W0 nearly closed, W1 briefed" → W0 closed, W1 built through five review rounds (rounds 3-5 all found the same loss class, which is what produced D18-D20), W2 built with its first review round failed on four majors. **Nothing committed, nothing shipped, no acceptance criterion ticked**; `status` stays `in_progress` and `released_version` stays `null`.
- Noted as the recurring lesson of this build: a sync that can delete will delete the wrong thing, so deletion was narrowed out of the design three times rather than conditioned.

### 2026-10-03 - Created from the reviewed plan and the W0 findings
- PRD created for a feature already in build: the task existed with AC1-AC24, a three-round-reviewed plan and a running W0 gate, but `related_feature` was `null` and nothing in `knowledge/features/` named it.
- Recorded from the task: the five owner stories, a criteria MAP pointing at the canonical AC1-AC24, the load-bearing decisions (D1 Codespaces-only, D3 laptop lock, D7/D12 secrets and Abandon, D11 config applied + flagged, D13 fresh cloud logins, D14 idle definition, **D15 the cloud stops itself after W0 disproved every keepalive**), and the two-transport architecture.
- `status: in_progress` (W0 nearly closed, W1 briefed, nothing shipped), `released_version: null`.
