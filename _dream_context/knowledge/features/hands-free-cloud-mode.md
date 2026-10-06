---
id: feat_2VVWqCVG
type: feature
name: hands-free-cloud-mode
description: >-
  Hands-free mode moves the active project to a GitHub Codespace, the phone
  drives it over a link and a passphrase while the laptop's roots are locked,
  and Return brings every commit, diff, stash and session home with a receipt.
pinned: false
date: '2026-10-03'
status: in_progress
created: '2026-10-03'
updated: '2026-10-06'
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

The full D1-D23 decision record, the residual-risk statement and the out-of-scope
list live in the task. The load-bearing ones:

- **[2026-10-04] D23 — one guarded phase transition, and an offline-first Return.** The Return-state class failed W2 reviews 1, 2 and 3. One transition function owns every laptop phase change and refuses `returning → away` (or anything that would offer Abandon) once a return write has started; after any write the only exits are home or Roll back. Once the payload is downloaded, finishing the local journal (Resume included) never needs the cloud or GitHub; wipe-secrets, seal and stop are attempted after and queued with the tripId when unreachable. A fault-injection test injects a crash, a network failure, a quota refusal and a stopped codespace at every journal op and every cloud/provider call of go and of single- and multi-pass Return (75 generated points, 208 cases) and asserts Resume reaches home or Roll back, never `away` after a write, and a byte-for-byte rollback.
- **[2026-10-04] D22 — running work is found by the process tree, not by registries.** Go and Return wait for and cut every process whose cwd is inside a scope root (claude, every descendant, hooks), whether or not the server spawned it, except the server itself; registries only label what the scan finds. A cut signals each process group with SIGTERM, then SIGKILL after the grace even when the leader exited, and waits until all are gone; the cloud does the same over `dcuser` processes via `/proc` cwd.
- **[2026-10-04] D21 — finalization is closed structurally.** A sealed cloud never holds the secret class (every seal, the self-seal included, wipes first); wipe-secrets, seal and stop are idempotent ensure-operations keyed by `sealedEpoch`; on any non-success the laptop reads `/api/health` and decides from the observed state instead of wedging; queued steps carry their tripId; and the test fake implements the real phase/epoch rules, held to it by a shared contract test.

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

**Status (2026-10-06): the code is on `main` and inside the published 0.30.0 / 0.30.1 packages, deliberately UNANNOUNCED — the UI is gated on local setup and the CLI command is hidden from `--help`. Every known bug from the first real-phone and real-Codespaces runs is fixed, but the phone path has still never worked end to end, so no acceptance criterion is ticked.** The last ship-gate is a 0.30.2 publish: the phone-chat fix lives in cloud code that the codespace only ever installs from npm, so it cannot reach a phone before it is on the registry. After that publish the never-yet-run steps are, in order: give a job from the phone and have it commit; lock the screen for 10 minutes and come back to a finished turn; let the machine sleep and wake it from the phone's Wake page (never passed since W0); and a Return that brings the phone's commit and session home.
W0 (the provider gate) closed and produced D15/D17. W1 (transports + shared path guard)
closed after seven review rounds that produced D18-D20. W2 (cloud server, laptop
orchestration, lock consumers) closed after five rounds that produced D21-D23. The
W0-W2 code and the first W3 build are in `55c6ff92`; the W3 review fixes are still
uncommitted in the working tree. W3 review round 1 passed the laptop UI lane. It failed the
phone lane (a revoked device's open chat socket survived; now every cloud chat socket is
tagged with its device hash and closed 4401 with its child cut on revoke-all, a password
change or logout, and re-checked per frame) and the harness lane (a lost trip marker
sealed the cloud without a snapshot; now `trip_lost` runs the full D12 recovery, snapshot
before seal, and a mirror with its folders gone answers `mirror_absent` and is never
sealed). The fixes are re-review pending. The user-facing reference is
`skill/references/hands-free.md`; the security model and the recovery procedure are in
[[dashboard-server-security]] § 6 "Cloud mode (hands-free)". The task file carries the code-fact map and the wave
map. W3 and W4 then closed too: the feature shipped hidden in 0.30.0 (`993a1866`), came
back on `main` after each publish (`ba6334e1`, `9a06c4ac`), and the real-Codespaces smoke
runs plus the owner's first phone session produced the fixes listed under "What the real
machine taught" below. The shape, as built:

- **One codespace per owner** from the private repo `<owner>/dreamcontext-handsfree` (devcontainer with Node, git, the `claude` CLI and the users `dcserver` / `dcuser` in group `dcwork`).
- **The mirror root is the laptop's own absolute path** (`/Users/<name>` = cloud HOME, a bind mount of `/workspaces/dc-home`, never a symlink), so transcript directory encodings, `--resume`, the session roster and worktree paths stay valid with zero rewriting.
- **Phases:** laptop `home | going | away | returning` in `~/.dreamcontext/handsfree/state.json`; cloud `sealed | active | quiescing` on the persistent disk. Only `active` serves the phone and allows spawns; transitions only through bearer routes.
- **Transport 1 (git-native):** per-repo snapshot of refs, the ordered stash list and per-checkout `HEAD` / `indexTree` / `worktreeTree`, shipped as filtered bundles, received with `transfer.fsckObjects`, backed up under `refs/handsfree/backup/<trip>/*`, applied through `git checkout-index` so the receiver's own eol and smudge rules run.
- **Transport 2 (non-git):** an lstat-only manifest (never follows symlinks) and a framed gzip pack for the ignored brain/`.claude` content and the secret class, applied temp+fsync+rename with sha256 verification. dreamcontext's own credential files never travel and are refused on Return.
- **One shared path guard** (`src/lib/handsfree/paths.ts`) for both transports: no `..`, no absolute paths, no `.git` segment at any depth after NFC + case-fold, `.` segments ignored anywhere, collision checks against differently-spelled existing paths, and a symlink target accepted only in canonical relative form resolving inside the root (written last). A link that fails the rule **stays on the laptop** — excluded from the walk and listed, with the go git preflight refusing a repo that carries such a `120000` entry (D18/D19). That exclusion and the physical check are **laptop-side only**: the cloud sends every link and checks lexically (D19 amended).
- **Return is conservative, and it never deletes:** any divergence in refs, HEAD, the stash list or the index parks the repo into `refs/handsfree/<trip>/*` and `trips/<trip>/conflicts/` instead of guessing; every overwritten laptop file is copied to `trips/<trip>/backup/` first so Roll back is real. **No laptop non-git file is ever deleted by a Return** (D20) — an absent cloud path is reported, not applied — a path the cloud could not send is never planned as a deletion, a stayed-home path is never overwritten (D19 over D16, it goes to conflicts), and a tolerant recovery snapshot is never applied to a working tree.
- **Session state** merges per entry by id with the cloud winning — **except** `chatPermissionMode` and every other permission field, which always keep the laptop's value, and cloud-only roster entries, which land with `bypass: false`.
- **A `CloudProvider` interface with exactly one implementation** (Codespaces, `src/lib/handsfree/codespaces.ts`) plus the fake the verify script needs (`provider.ts`). Codespaces are created with `idle_timeout_minutes=240` and `retention_period_minutes=43200`. GitHub's REST does not expose the remaining quota (`remainingQuotaCoreMinutes()` returns null), so the laptop counts its own uptime against a 120 core-hour budget (`local-store.ts`).
- **The journal (AC11, D23).** `src/lib/handsfree/journal.ts` plus `orchestrator.ts`. A per-trip run lock (`acquireTripRunLock`) makes go/return single-flight across the app and the CLI. Each direction snapshots once and persists `trips/<trip>/<direction>-journal.json` before any write. Return downloads its whole payload into `trips/<trip>/return-<pass>/` before the first write, so Resume is offline-first. ONE guarded `transition()` owns every laptop phase change and refuses `returning → away` (and Abandon) once any pass wrote. Cloud finalization (`ensureCloudSealed`: wipe-secrets → seal, then stop) is idempotent per epoch; when the cloud cannot be reached it is queued in `config.json` with the trip id (`runQueued`). A cloud the phone moved past the snapshot gets a delta pass (at most 3, `MAX_RETURN_PASSES`), and past that the next go recovers it. Roll back (`rollbackTrip`) undoes every pass's own ops, newest first, and returns to `away`.
- **Cloud server mode** (`DREAMCONTEXT_CLOUD=1`, `isCloud()`; `dreamcontext cloud serve`, hidden, started by `cloud/supervisor.mjs`). One listener on 8080 behind GitHub's public forwarded port. `cloudGate()` (`middleware.ts`) replaces the laptop gate chain: loopback is never trusted, a static allow-list (`cloud-mode.ts` `CLOUD_PUBLIC_ROUTES` / `CLOUD_DEVICE_API_ROUTES`) is the only reachable API, and everything else gets 403 `cloud_unavailable`. Cloud phases are `sealed | active | quiescing` with an epoch per quiesce and `sealedEpoch` (`cloud-state.ts`). The transfer routes live under `/api/handsfree/cloud/*` (`routes/handsfree-cloud.ts`). Every git, pack and agent process runs as `dcuser` through `spawnAsWorker` / `cloud worker <op>` (`cloud-worker.ts`).
- **Phone auth** (`src/server/handsfree-auth.ts`, `handsfree-login.ts`). A generated 6-word EFF passphrase; only its scrypt hash (N=2^15) leaves the laptop, pushed over the HMAC transfer channel with a generation that only goes up. The device cookie `__Host-dc_hf_session` (HttpOnly, Secure, SameSite=Lax, 30 days) stores the sha256 of a 256-bit id. A persisted login limiter is checked before scrypt: per client 5 free failures, then 60 s doubling to 1 h; a global progressive delay past 30 failures per hour, never a lockout; at most 2 concurrent scrypt. Revoke-all, a password change and a logout close the device's open chat sockets (4401) and cut their children.
- **Service worker and Wake** (`src/server/handsfree-sw.ts`). It intercepts only same-origin navigations, re-issues them with `X-Tunnel-Skip-AntiPhishing-Page: true`, and shows the cached offline page with a Wake link (the codespace's github.com page) only for a 404/502/503/504 or a network error without `X-Dreamcontext-Cloud`. It unregisters on the sealed page and on a revoked login.
- **Sleep (D14/D15)** (`src/server/cloud-idle.ts` `computeStopAt`). The stop time is 15 min after the later of boot, the last real action and the last turn's end. A running turn defers it (≤ 2 h from its start), and so do a transfer (2 min grace), an install (≤ 2 h) and going/quiescing (≤ 2 h). The stop request goes to `/workspaces/dc-server-pub/stop-request` with the boot id; `cloud/stop-helper.sh` (the `codespace` user) runs `gh codespace stop`. A served quiesce with no laptop progress self-seals after 2 h (wiping first); an unserved one reverts to active after 30 min (`quiescingVerdict`).
- **CLI** (`src/cli/commands/handsfree.ts`): `setup [--machine]`, `account-login [id] [--all] [--print]`, `password`, `go [--cut-running] [--take-over]`, `status [--json]`, `return [--cut-running]`, `resume`, `rollback`, `abandon`, `devices list`, `devices revoke --all`, `teardown [--discard-abandoned-work]`. The laptop routes (`src/server/routes/handsfree.ts`) call the same functions behind `laptopRouteRefusal()`. The desktop UI is in `dashboard/src/components/handsfree/`, and the phone's chip and quiesce overlay in `.../handsfree/phone/`.

### What the real machine taught (2026-10-05/06)

Every item here was found by a real Codespace or a real phone, not by a reviewer or a test.

- **The cloud installs the exact bytes the laptop published** (`ba5b914a`, with `61ba8b8a`). `prepack` derives `npm-shrinkwrap.json` from `package-lock.json` (a lock out of sync with `package.json` fails the pack), `postpack` removes it, and the root entry is gitignored so a failed publish can never leave it to be committed. The cloud's root supervisor **refuses a tarball without `npm-shrinkwrap.json`**, validates it in memory (regular files and dirs under `package/` only), extracts as root and installs with `npm ci`, so there is no "it works on my laptop" dependency drift. The same commit hardened the root path: only its own checkout (plain dir, owner 0/1000, inode re-checked), never follows a link, masks setuid/setgid off, removes other-write from `/workspaces`, and runs npm with an isolated config and cache.
- **Two listeners on 8080 answered nothing** (`c98f028e`). The supervisor kept a listening `net.Server` while also handing its fd to the server, so both accepted and every connection the supervisor won was dropped — which is what the forwarder's 504s in smoke #4 actually were. The entrypoint now binds 8080 in a short python step and `exec`s the supervisor with the socket as fd 3; the supervisor never creates a server. Boot and runtime logs persist under `/workspaces` so a cold start can still be diagnosed after `/tmp` is wiped.
- **A stopped codespace is not ready when `POST /start` returns** (`7e4508b0`). The container can take minutes to exist while the 5-minute health clock was already running. `ensureRunning` now polls GitHub's own state to `Available` (up to 15 min, one progress line a minute), judges only readings taken *after* the start, and fails immediately only on `Failed`, `Deleted` or a vanished machine; the health clock starts after that.
- **The privilege split broke the chat child** (`424e2f27`). In the cloud the chat child runs as `dcuser` and could not open the 0600 files the server wrote, so every phone chat died with `EACCES` on the settings file. Settings, the mode note and the surface briefing now go **inline** (single-quoted) and the deferred prompt is created exclusively in the `dcuser` work dir; bash's job-control noise no longer reaches the error card. This is the fix that needs 0.30.2 to reach a phone.
- **The phone landed in the launcher, not in its chat** (`b23184e9`, found on a real phone). A CLI `go` now registers the project under an ASCII, header-safe name and the cloud fills a missing registry entry, so login opens the trip's chat. A successful login, the trip's activation and a *cancelled* Return all count as the owner's action on the idle clock. The login page registers the offline service worker, so a stopped machine shows Wake instead of a browser error, and the login request times out after 30 s. The uptime count closes on GitHub's own state change and counts runs the laptop did not start.
- **The away banner is per project, not per window** (`1fd43c6d`). The status answer now says whether the project the window asks about is in the trip (the same lock check the server uses) and names the away project; only that project renders the banner, while other projects and the launcher get the window-bar chip (Return + Show link). A project switch during a status read always re-reads for the project on screen.

### Known residuals (stated, not fixed)

- **Same-uid exposure across sibling agent children (AC19).** Every agent child runs as the one `dcuser` uid, so a lingering agent process can read a sibling child's environment through `/proc/<pid>/environ`. Every account's cloud credentials file lives in a dcuser-owned sandbox the CLI must read and refresh, so any agent can read any cloud account's login. The `dcserver` dir, `/proc/<server>/environ`, `/workspaces/.codespaces` and `/home/codespace` stay unreadable to dcuser.
- **The cloud is one trust domain:** whoever has the passphrase effectively has a shell there. A transcript that once printed a secret keeps it on the cloud disk after Return. The build fingerprint is computed inside the container, so a fully compromised container could misreport it. No disk snapshots: a codespace GitHub deletes takes unreturned work with it.
- **Carried minors** (W3 Handoff "Decisions" line, not fixed): the Return roster merge writes the tracked `.gitignore` outside the journal (`agent-sessions.ts:328`); `DREAMCONTEXT_PARENT_PID` is inherited by child servers and kills verify servers launched from an app session (`lifecycle.ts:208`); AC18 parity and AC24 second-laptop ownership are not covered by the round-trip harness (left to the W4 real-Codespaces smoke); the first ~50 ms of the notch opening drop frames. Lane E's open risks from the same round: the cloud's idle self-seal does not go through the `snapshot_first` guard of a lost-marker trip, and a missing transcripts-only root is not counted.
- **Plan vs code, recorded for reconciliation:** the task's "an untracked file over 100 MB needs an explicit `handsfree.include` or is skipped" has no code behind it (no size cap in `src/lib/handsfree/`). The login limiter keys on the whole `X-Forwarded-For` value (`loginClientKey`), not its rightmost entry, because W0 found GitHub's forwarder replaces the header with one IP. A process inside the codespace can still set any XFF, so only the global delay bounds it.

## Notes

- This PRD is deliberately a map, not a mirror: the task holds AC1-AC24, D1-D23, the residual-risk statement, the out-of-scope list and the wave map. Reconcile this file when a wave lands; do not re-type the criteria here.
- The one pattern this build keeps re-teaching: **a sync that can delete is a sync that will delete the wrong thing.** Three consecutive W1 review rounds found the same class (a laptop file or link lost because the cloud lacked its path), and the answer each time was to narrow deletion out of the design (D19, D19 amended, D20) rather than to fix the condition that triggered it.
- W0 item 1 (a pty keepalive) **failed** and produced D15 — the clearest evidence in the project that a provider's idle clock is a provider fact to be measured, not assumed.
- Out of scope v1 (abridged): any other provider, pushing to GitHub from the cloud, web push, cloud automations, more than one trip at a time, desktop-only surfaces (PTY, voice, Assistant, OS reveal), Git LFS, submodules, custom filter drivers, shallow/partial clones.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-06 - Shipped hidden in 0.30.0/0.30.1; the real machine found six bugs, the phone path still unproven

- **Status replaced, not appended.** The old "nothing shipped, W4 in progress" line was wrong: the code is on `main` and inside the published 0.30.0 and 0.30.1 packages, unannounced — the UI gated on local setup, the CLI command hidden from `--help`, the docs kept out of the package. Still **no criterion ticked**, because the phone path has never worked end to end.
- **A new Technical Details section, "What the real machine taught"**, records the six fixes real Codespaces and a real phone produced: the shrinkwrapped install the cloud refuses to do without (`61ba8b8a` + `ba5b914a`, with the `/workspaces` lockdown), two listeners on 8080 that answered nothing and were the smoke-#4 504s (`c98f028e`), a start that was judged before the container existed (`7e4508b0`), the `dcuser` chat child hitting `EACCES` on the server's 0600 files (`424e2f27`), the phone landing in the launcher instead of its chat plus the Wake service worker and the idle-clock actions (`b23184e9`), and an away banner that showed in every project instead of the one that is away (`1fd43c6d`).
- **The remaining gate is named:** 0.30.2 must be published before the phone-chat fix can reach a phone at all (the cloud installs only from the registry), and four steps have still never run — a job given and committed from the phone, a 10-minute locked screen, a sleep + Wake (never passed since W0), and a Return that brings the phone's commit and session home.
- `status` stays `in_progress`, `released_version` stays `null`: the package carrying hidden code is not a release of this feature.

### 2026-10-04 - Update
- W4 docs lockstep (AC21): the PRD now describes the built code, not the plan. The status was replaced (built through W3, review fixes uncommitted and re-review pending, W4 in progress) and Technical Details gained the journal, cloud server mode, phone auth, the service worker and Wake, sleep, the CLI surface and a Known residuals block: AC19 same-uid /proc exposure, one trust domain, the carried minors from the W3 Handoff, and two plan-vs-code mismatches (no 100 MB untracked cap in code; the limiter keys on the whole X-Forwarded-For value). New companions: skill/references/hands-free.md (agent-facing), the README 'Hands-free Mode' section, dashboard-server-security § 6 (cloud mode + recovery procedure) and the 6.system_flow hands-free flow. Nothing ticked; status stays in_progress.
### 2026-10-04 (later) - W2 closed on D21-D23, the code is committed, W3 is in review

- Three more owner decisions recorded from the task: **D21** (structural finalization: wipe before every seal, idempotent epoch-keyed ensure-ops, decide from observed health), **D22** (find and cut running work by the process tree), **D23** (one guarded phase transition, offline-first Return, exhaustive fault injection).
- Build status replaced, not appended: W1 and W2 closed, W0-W2 and the first W3 build committed in `55c6ff92`, W3 review round 1 found an open device socket surviving revoke (fixed) and a lost-marker seal without a snapshot (in fix).
- The recurring lesson grows a second shape: three classes (finalization, invisible running turns, Return state) each failed review twice or three times before the owner closed them **structurally** rather than case by case. Nothing ticked: every criterion waits on W3 UI or the W4 real-Codespaces proof. `status` stays `in_progress`.

### 2026-10-04 - Reconciled with the locked decisions D16-D20 (still mid-build, nothing ticked)

- The decision record was stale at D15 while the owner had locked five more: **D16** (a cloud-edited secret-class file comes home over the laptop's, after a backup, names only in the receipt), **D17** (a >4 h continuous phone session is cut by GitHub's own idle clock — accepted, no self-ssh workaround), **D18/D19** (a symlink that cannot travel never leaves and is never deleted; canonical relative targets only, `.` segments ignored; go's git preflight refuses such a repo like a submodule) with the **D19 amendment** (the exclusion and the physical check are laptop-side only, the cloud sends every link, a path the cloud could not send is never a deletion, D19 wins over D16 into conflicts), and **D20** (Return NEVER deletes a laptop non-git file; unreadable cloud paths are refused and listed; a tolerant recovery snapshot never touches a working tree).
- Contradictions fixed, not appended: the path-guard and Return bullets in Technical Details said symlinks were simply "resolved inside the root" and described Return as parking-on-divergence with no non-deletion rule; "D1-D15" in two places became D1-D20; the D7/D12 line now points at D16 for the Return direction.
- Build status corrected: "W0 nearly closed, W1 briefed" → W0 closed, W1 built through five review rounds (rounds 3-5 all found the same loss class, which is what produced D18-D20), W2 built with its first review round failed on four majors. **Nothing committed, nothing shipped, no acceptance criterion ticked**; `status` stays `in_progress` and `released_version` stays `null`.
- Noted as the recurring lesson of this build: a sync that can delete will delete the wrong thing, so deletion was narrowed out of the design three times rather than conditioned.

### 2026-10-03 - Created from the reviewed plan and the W0 findings
- PRD created for a feature already in build: the task existed with AC1-AC24, a three-round-reviewed plan and a running W0 gate, but `related_feature` was `null` and nothing in `knowledge/features/` named it.
- Recorded from the task: the five owner stories, a criteria MAP pointing at the canonical AC1-AC24, the load-bearing decisions (D1 Codespaces-only, D3 laptop lock, D7/D12 secrets and Abandon, D11 config applied + flagged, D13 fresh cloud logins, D14 idle definition, **D15 the cloud stops itself after W0 disproved every keepalive**), and the two-transport architecture.
- `status: in_progress` (W0 nearly closed, W1 briefed, nothing shipped), `released_version: null`.
