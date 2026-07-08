---
id: feat_Sx4EmLgP
status: in_progress
created: '2026-07-04'
updated: '2026-07-08'
released_version: v0.14.1
tags:
  - 'topic:github'
  - 'topic:cli'
  - 'topic:desktop'
  - 'topic:lab'
  - architecture
  - backend
related_tasks:
  - github-cloud-collaboration-brain-repo-sync
  - >-
    brain-portability-dashboard-controls-platform-layer-lab-credentials-example-sync-refresh-button-recall-mode-settings
  - cloud-sync-origin-setup-create-attach-github-repo-ui
type: feature
name: brain-repo-sync
description: ''
pinned: false
date: '2026-07-04'
---

## Why

Today `_dream_context/` lives inside the same repo as the code it documents, so
sharing a brain across a team means sharing the code repo — and a single-user brain
never leaves the local disk. Teams want to collaborate on the SAME brain (tasks,
knowledge, features, sleep state) the way they already collaborate on code: push,
pull, merge, review — without forcing the brain to live inside the code repo, and
without giving up dreamcontext's local-first identity (the brain is still plain
markdown/JSON files on disk; git is the sync transport, not a new database).

This is a distinct concept from the parked `feat-web-hosted-dreamcontext-com`
task/idea: that one is a **hosted website** that reads an existing code repo's
`_dream_context/` via the GitHub API for browser viewing (no local git repo for the
brain). This feature is the opposite direction — the brain becomes **its own git
repo**, synced automatically by the CLI/desktop app itself, viewed with the
existing local dashboard. The two could coexist later but ship independently.

## User Stories

- [x] As a user, I can point my project's brain at a dedicated GitHub repo (separate
  from my code repo), so my team can collaborate on tasks/knowledge/features the
  way they already collaborate on code. *(M1 shipped: `dreamcontext brain init`)*
- [x] As a user, every `dreamcontext sleep done` automatically fetches, merges (via
  a semantic merge agent on conflict), commits, and pushes the brain repo, so my
  teammates' consolidated context reaches me (and mine reaches them) without a
  manual step. *(M1 shipped: autoSync integration)*
- [x] As a user, I can run a manual sync skill (`/dream-sync`-style) at any time to
  pull/push the brain repo outside of a sleep cycle. *(M1 shipped: `/dream-sync` skill + `brain sync` CLI)*
- [x] As a user, I can log into GitHub from the desktop Launcher (OAuth device flow,
  or a PAT as fallback) and see which of my accessible repos are brain repos (via a
  topic/marker), so connecting a project doesn't require hand-typing a repo URL. *(M2 shipped: device-flow login + discover endpoint; manual validation pending)*
- [x] As a user, on a new machine, the Launcher guides me to clone or locate the
  brain repo for a project (the brain repo stores a pointer back to its code repo),
  so setting up a second machine doesn't mean re-deriving which repo goes with
  which. *(M2 shipped: attach flow + create from UI; manual validation pending)*
- [x] As a user, every machine builds its OWN local index/cache over the shared
  brain (recall index, embeddings, etc.) that is NEVER pushed, so per-machine
  derived state never pollutes the shared repo or causes merge noise. *(M1 shipped: `.brain-local.json` gitignored)*
- [x] As a user, my personal notes/attributions ride the existing multi-people
  awareness (`user.md` `## People`, `person:<slug>` tags, changelog authors) rather
  than a new per-person file namespace, so the brain doesn't fragment into
  per-person copies. *(M1 shipped: reuses existing multi-people model)*
- [x] As a user, nothing containing secrets or absolute local paths is ever
  auto-pushed — a scrub gate runs before every push and blocks/redacts violations. *(M1 shipped: scrub gate + GIT_ASKPASS)*
- [ ] As a user, issue-linked tasks (GitHub Issues task backend) keep working when
  the brain also lives in its own repo — issue mapping is reused, not
  reimplemented. *(M3 pending)*

## Acceptance Criteria

- [ ] _To be defined in detail as each phase implements — the phase list below is
  the agreed scope; concrete testable ACs land per-phase as code ships. Captured
  now so the next session doesn't relitigate the design:_
- [ ] **Phase P1 (read-only):** GitHub login (device flow or PAT) + list accessible
  brain repos (topic/marker-based discovery) + guided clone/locate on a new machine
  + local index build (never pushed).
- [ ] **Phase P2 (one-way push):** post-sleep push of the brain repo with the
  secrets/absolute-path scrub gate; stop-and-surface (not silently overwrite) on a
  detected conflict.
- [ ] **Phase P3 (full sync):** fetch → semantic merge agent on conflict → commit →
  push as a standing post-sleep step, plus issue-sync onboarding for teams already
  using the GitHub Issues task backend.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-08]** **`separate` mode is REMOVED — `full-repo` is the only pushing mode; `in-tree`
  is the OFF baseline.** For dreamcontext to work across a team, `.claude/` AND `_dream_context/`
  must be shared together. `separate` synced only `_dream_context/` into its own dedicated repo and
  needed the `platform` symlink hack to drag `.claude`/`CLAUDE.md` along — architecturally wrong and
  confusing. The 3-mode model collapses to 2: `full-repo` (whole project → its own `origin`, current
  branch) when cloud sync is ON, `in-tree` (commit-only, never pushes) when OFF. Deleted:
  `platform-layer.ts` + `brain platform`, `detach.ts` + `brain detach`, `brain init`/`brain attach`/
  `brain discover`, the dedicated-brain-repo create/attach/discover/scope/disconnect server routes +
  dashboard `BrainRepoSetup` + the two-card scope chooser, and the `brainRepo.remote`/`codeRepoUrl`/
  `marker` config fields. The master cloud-sync toggle now IS the on/off: enabling requires a GitHub
  `origin` (400 `no_origin` otherwise) and sets `full-repo`; disabling reverts to `in-tree`.
  No migration path — a stale `mode:'separate'` config silently resolves to `in-tree`. GitHub auth
  (device-flow + PAT), the scrub gate, the semantic merge agent, and `GIT_ASKPASS` credential supply
  are all KEPT — `full-repo` still pushes to GitHub over HTTPS with a token.
- **[2026-07-07]** **Gitignore-first discipline is mandatory for any brain-content migration.** A platform-only gitignore stub (containing only platform excludes, no canonical brain excludes) defeats `bootstrapBrainRepo`'s `!existsSync` guard: the stub satisfies "file exists" but doesn't actually exclude local-only state, so `state/.brain-merge/.lock`, `state/.secrets.json`, and other machine-local artifacts would sync to the team. The fix: `setupPlatformLayer` writes the FULL canonical gitignore FIRST (via `ensureLocalOnlyArtifacts`), then appends platform-specific entries. This is the same discipline `writeCredential` uses and now applies everywhere. Caught by a new two-clone e2e test (clone A syncs local merge lock → clone B detects it as incoming diff → fail). Same root cause as the original `writeCredential` gitignore-first rationale.
- **[2026-07-04]** **Brain repo is separate from the code repo.** `_dream_context/`
  becomes its own git repository (own remote, own history) rather than a folder
  committed inside the code repo. The brain repo stores a pointer to its associated
  code repo so a new machine can be guided to the right code checkout too.
- **[2026-07-04]** **Post-sleep sync is automatic from day 0 (D0 scope), not
  opt-in-later.** Every `dreamcontext sleep done` runs fetch → merge-on-conflict →
  commit → push against the brain repo. A manual `/dream-sync`-style skill exists
  for on-demand sync outside a sleep cycle.
- **[2026-07-04]** **Conflict resolution is a semantic merge AGENT, wanted from day
  0 — not deferred to a later phase.** Plain git merge/rebase is not sufficient for
  markdown+frontmatter task/knowledge files (concurrent edits to the same task's
  changelog, e.g.); a merge agent reconciles semantically. This is called out
  explicitly even though P1/P2 ship read-only/one-way first — the agent is being
  designed for from the start so P3 isn't a rewrite.
- **[2026-07-04]** **Local indexes are per-machine and NEVER pushed.** Recall
  indexes, embeddings, and other derived caches are rebuilt locally after every
  clone/pull. This keeps the shared repo to source-of-truth markdown/JSON and
  avoids merge noise on binary/derived artifacts.
- **[2026-07-04]** **No per-person file namespacing.** Personal attribution rides
  the already-shipped multi-people awareness (`1.user.md` `## People` section,
  `person:<slug>` tags, changelog `created_by`/authors) — the brain stays one
  shared set of files, not `task-alice.md` / `task-bob.md` forks.
- **[2026-07-04]** **A secrets/absolute-path scrub gate is mandatory before any
  auto-push.** Non-negotiable, ships with P2 (the first phase that can write to a
  remote). Never bypassed even for a manual sync.
- **[2026-07-04]** **Issue mapping reuses `src/lib/task-backend/github.ts`**, not a
  parallel implementation — the GitHub Issues task-backend plumbing (OAuth/token
  handling, `ApiAdapter`) already exists (see
  `[[decisions/decision-github-task-backend]]`) and is the base P3's issue-sync
  onboarding builds on.
- **[2026-07-04]** **This is NOT the parked hosted-website concept.** The
  `feat-web-hosted-dreamcontext-com…` task describes a browser-hosted viewer that
  reads a code repo's `_dream_context/` over the GitHub API with no local git repo
  for the brain. This feature makes the brain itself a git-synced artifact used by
  the existing local CLI/dashboard/desktop app. They are compatible future
  directions, not the same feature — do not merge these PRDs.

## Technical Details

**M1 SHIPPED (commit d351cc8, 2026-07-04).** CLI core is live: brain init/sync/enable/disable, GIT_ASKPASS credential supply, scrub gate, semantic merge, pull-only content delivery, `/dream-sync` skill, sleep-done autoSync integration, session-start background pull, master switch (GitHub-connected default-on). Authoritative merge semantics live in **`skill-sync/references/merge-rules.md`** (shipped reference) — the full state machine, tracked-vs-local table, deterministic merge rules, credential supply, scrub gate, pull-only handoff loop.

**M2 SHIPPED (commit 7498307, 2026-07-05).** Launcher/Dashboard/Desktop integration: device-flow OAuth login (POST device-poll with `sessionId` UUID, `slow_down` honored, token lands in `~/.dreamcontext/.secrets.json` 0600), discover endpoint (lists `dreamcontext-brain` topic repos), create-from-UI (one-click private repo + scrubbed first push), attach flow (S6 trust warning + diff preview + confirmed refusal), team-updates badge (cache-only endpoint + background fetch), Settings Cloud sync toggle (master switch M2 tier). 36 M2-only files (+3403/-48). **Manual UI walkthrough pending** (automated validation PASS: 57/57 backend tests green, dashboard builds clean, 77 i18n keys). Remaining before M2 fully complete: human walkthrough in packaged app + OQ-1 (register GitHub OAuth App `client_id` — PAT fallback works now). M3 pending.

**Validated design (plan v3.2, 2026-07-04) — 3 reviewers SOLID over 5 iterations, 21 findings resolved.** The task (`github-cloud-collaboration-brain-repo-sync`) is the authoritative implementation spec with 30 acceptance criteria across M1/M2/M3 milestones. This PRD carries product intent + validated architecture summary.

**Architecture (compact form — full detail in the task + shipped skill reference):**

**Modes (post-removal of `separate`, commit b45abd4):** `full-repo` (the WHOLE project folder — code + `_dream_context/` + `.claude/` — is the synced unit, pushed to the project's OWN `origin` on the CURRENT branch) vs `in-tree` (brain nested in code repo; commit-only, NEVER auto-pushes; the safe default). Scrub gate applies to both. `full-repo` requires a project-root gitignore that excludes machine-local brain state + secrets under `_dream_context/` (`ensureFullRepoGitignore`, run gitignore-first before every whole-project stage) — without it `git add -A` at the root would commit-and-push the sync lock (poisoning clones with a foreign live PID → "locked") and, worse, secrets. The DEPRECATED `separate` mode (brain-only in its own GitHub repo + remote, rooted at `_dream_context/`) was REMOVED in commit b45abd4 — it required the `platform` symlink hack to drag `.claude/` along and was architecturally wrong. A stale `mode:'separate'` config silently resolves to `in-tree`.

**Credential supply:** Token NEVER embedded in remote URL (S1 — would persist in `.git/config` plaintext). Every git network call runs via `GIT_ASKPASS` + 0600-at-create tmp token file (path in env, token never in env/argv); `-c credential.helper=` disables persisted helpers; tmp file unlinked in `finally`. Resolves per-project `.secrets.json` → global `~/.dreamcontext/.secrets.json` (0600) → env (M1 is secrets-first; M2 inserts global tier). The reversed priority from `resolveGitHubToken` (env-first) is intentional — a distinct resolver, never reused.

**Scrub gate:** Runs before EVERY brain commit (in-tree S2, `brain init` first push S3, `brain detach` S4, post-merge results). WARN-tier hits block ONLY in headless pull-only (effective-`--strict` — no human eye on the auto-commit); foreground modes keep WARN non-blocking. BLOCK-tier hits abort loudly everywhere. A staged file containing `ghp_`+36 chars → BLOCK.

**Pull-only content delivery:** With clone A ahead by a knowledge edit, clone B's `brain sync --pull-only` on a clean tree merges the edit into B's working tree (`pulled`, `pulledUpdates>0`) — not just counted — and pushes nothing. Dirty tracked tree → auto-commit first (scrubbed, message `chore(brain): auto-checkpoint local edits before team merge`, M1 author tiering) under effective-`--strict` scrub (any hit refuses the headless auto-commit); clean merge delivers content. Agent-class conflict → write report + base/ours/theirs snapshots, `abortMerge` back to a clean committed tree, set `pendingAgentMerge:true`.

**Handoff loop (`--resume` / `--continue`):** Pull-only agent-class conflict writes the report, aborts to clean committed tree, sets `pendingAgentMerge:true`. Plain `brain sync` then returns `already-awaiting-agent`. `brain sync --resume` (ATTENDED only — unattended callers never resume) re-fetches/re-merges into a FRESH `awaiting-agent` with real `MERGE_HEAD`; re-defer leaves real `MERGE_HEAD` + FRESH report; clean resolve completes alone. Agent resolves. `brain sync --continue` commits the in-progress merge, re-scrubs, pushes → report + snapshots gone, `pendingAgentMerge:false`. If remote moved on, `--resume` alone completes with no agent step. Flag misuse (e.g., `--continue` w/o `MERGE_HEAD`) returns `invalid-flag` + guiding `note`.

**Concurrency + liveness:** PID-liveness lock via `verifyPidLiveness` opt-in on `acquireFileLock` — a second `runBrainSync` while a live holder owns the lock returns `locked`; a lock left by a dead PID past the staleness window is reclaimed; lock held by alive PID is NOT reclaimed even past window.

**Private-by-default + attach trust gate:** Brain repos default PRIVATE (S5 — public requires `--public` flag/toggle + loud interactive confirm). `brain attach` / dashboard attach is a TRUST decision (S6 — a brain repo is a prompt-injection channel); prints loud trust warning + incoming diff preview and refuses without confirmation.

**M1/M2/M3 milestones:** M1 (CLI core, no launcher required) SHIPPED = brain init (REMOVED in b45abd4), git wrapper + GIT_ASKPASS credentials, resolveBrainSyncToken tiering, brain sync CLI, scrub gate BLOCKS on both commit paths, commit author tiering (git identity or `dreamcontext-sync <noreply@dreamcontext.local>` fallback), semantic merge (task changelog set-union + furthest status wins; knowledge conflict discard remote-wins + awaiting-agent), conflict-report lifecycle, pull-only content delivery + dirty-tree auto-checkpoint + headless effective-strict scrub, dream-sync skill loop (defer/resume/resolve/continue), reentrancy guard, brain lock, sleep done autoSync integration (sync failure never fails sleep), in-tree mode (commit-only, still scrubbed), session-start background pull (non-blocking PATH-safe detached spawn). M2 (Launcher/Dashboard/Desktop) SHIPPED-THEN-REDUCED (b45abd4) = device-flow login (POST device-poll, `sessionId` UUID, token to global `~/.dreamcontext/.secrets.json` 0600), scope disclosure + fine-grained PAT recommendation, ~~discover `dreamcontext-brain` topic repos~~ (REMOVED), ~~create from UI~~ (REMOVED), ~~attach~~ (REMOVED), ~~team-updates badge~~ (REMOVED), Settings Cloud sync toggle (master switch M2 tier, now only `full-repo` on enable / `in-tree` on disable). Removed in b45abd4: `brain init`/`attach`/`discover`/`detach`/`platform`, the create/attach/discover/disconnect/scope server routes, dashboard `BrainRepoSetup` + scope chooser, `brainRepo.remote`/`codeRepoUrl`/`marker` config. Kept: GitHub auth (device-flow + PAT), scrub gate, semantic merge agent, `/dream-sync`, `GitHubLogin`/`TeamUpdatesBadge`/`BrainSyncControl`. M3 (Polish) PENDING = `taskBackend=github` task md gitignored + issues source of truth + doctor check, post-pull task-mirror refresh via `getTaskBackend sync`, GitHub login maps to person slug commit author.

**Phase 3 semantic merge agent is wanted from D0** (user-explicit) — not deferred to a "later phase". Phase boundaries (1 read-only → 2 one-way push + scrub + stop-on-conflict → 3 full semantic-merge sync + issue-sync onboarding) are M1 validation gates, not deferral of the merge-agent design work. The agent is being designed for from the start.

## Notes

- Originated from a 2026-07-04 product discussion (Turkish) converging on the
  phased design above; parked here as the durable record so the next session
  builds from this instead of re-deriving it.
- A discovery/exploration pass was dispatched in the same sleep cycle to map the
  concrete integration points (sleep-done hook, existing GitHub auth, skill
  distribution, hook pipeline) ahead of P1 implementation — fold its findings into
  Technical Details once it reports.
- Open question: private vs public brain repos, and whether a GitHub App
  (least-privilege) is preferable to a plain OAuth App/PAT for repo access.
- Open question: exact shape of the "topic/marker" used to identify a repo as a
  brain repo for discovery (a GitHub topic tag? a marker file at the repo root?).
- Related task: expect a task (created by `sleep-tasks` this same cycle) to carry
  the working implementation plan — link it here via `related_tasks` once it
  exists.
- Related but distinct: `_dream_context/state/feat-web-hosted-dreamcontext-com-github-oauth-collaboration-layer-over-the-brain.md`
  (parked, hosted-website direction — see Constraints & Decisions above for why
  these are separate).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-09 - Origin setup UI: create/attach a GitHub repo when the project has none

**Re-added the create/attach affordance b45abd4 removed — but retargeted to the project's `origin`, not a
separate brain repo.** After the `separate`-mode removal, enabling Cloud sync on a project with no GitHub
`origin` dead-ended at a bare `400 no_origin` ("run `git remote add origin …` by hand"). The Settings →
Cloud sync panel now offers, when signed in AND the project has no origin: **Create new** (a fresh
PRIVATE-by-default GitHub repo → wired as `origin`) or **Connect existing** (an existing repo URL →
`origin`), then it enables `full-repo` + lays the gitignore-first excludes + runs the first auto-sync to
bootstrap+push. This is NOT the old dedicated brain repo — no `dreamcontext-brain` topic, no marker file,
rooted at the PROJECT root.

New: `src/lib/git-sync/origin-setup.ts` (`createProjectOrigin` → `POST /user/repos` private-default +
S5 public-confirm guard; `attachProjectOrigin` → canonical HTTPS origin from https/ssh/`owner/repo`;
`previewOrigin` read-only reachability; `setProjectOrigin` git-init + add/set). Routes:
`POST /api/brain/origin/{create,preview,attach}` (desktop-gated; `401 no_token` / `409 origin_exists` /
`400 unreachable` guards). `handleBrainSync` refactored to a shared `runSyncPayload`. Dashboard:
`OriginSetup.tsx` (Create/Connect tabs) + `useCreateOrigin`/`useAttachOrigin`/`usePreviewOrigin` hooks +
17 i18n keys. Coverage: +15 lib units, +7 route-guard units (adjacent brain/git-sync suites still green);
tsc + dashboard prod build clean; GUI walkthrough on a scratch vault (fake token) confirmed the panel
renders, Connect surfaces a GitHub 401 safely, and no origin is wired on failure. Task:
`cloud-sync-origin-setup-create-attach-github-repo-ui`.

### 2026-07-08 - BREAKING: Removed `separate` mode — whole-project (`full-repo`) is the only cloud-sync option (commit b45abd4)

**Pivoted the feature per user direction:** `.claude/` and `_dream_context/` must be shared *together*
for dreamcontext to work across a team, so the "brain-only" (`separate`) mode — which synced only
`_dream_context/` into its own repo and needed the `platform` symlink hack for the Claude Code
layer — is REMOVED. Cloud sync is now one model: **`full-repo`** (whole project → its own `origin` on
the current branch) when ON, **`in-tree`** (commit-only) when OFF.

Removed: `platform-layer.ts` + `brain platform`, `detach.ts` + `brain detach`, `brain init` /
`brain attach` / `brain discover` CLI subcommands, the `bootstrapBrainRepo`/`createBrainRepo`/
`discoverBrainRepos`/`attachBrainRepo`/`previewAttach`/`isOwnRepoRoot` lib functions, the
`/api/brain/{create,attach,attach-preview,discover,disconnect,scope}` server routes, dashboard
`BrainRepoSetup` + the Settings two-card "Sync scope" chooser + the discover/create/attach/
disconnect/scope hooks + their i18n keys, and the `brainRepo.remote`/`codeRepoUrl`/`marker` config
fields. The `mode` type is now `'in-tree' | 'full-repo'`; a stale `'separate'` config silently
resolves to `in-tree` (no migration — nobody was on it). The master cloud-sync toggle
(`POST /api/brain/settings` / `brain enable`) now sets `full-repo` on enable (400 `no_origin`
without a project origin) and `in-tree` on disable.

Kept (all shared with `full-repo`): GitHub device-flow + PAT login, `resolveBrainSyncToken` +
`GIT_ASKPASS` credential supply, the scrub gate, the semantic merge agent + `/dream-sync` handoff,
`GitHubLogin` / `TeamUpdatesBadge` / `BrainSyncControl` dashboard components. Skills + docs swept
to the two-mode model (`brain-sync.md`, `merge-rules.md`, `integrations.md`, `cli-reference.md`,
`SKILL.md`, README, DEEP-DIVE); e2e reduced to the full-repo whole-folder suite (+ a new prose
agent-handoff test). Full unit + e2e suites green.

### 2026-07-08 - Cloud sync hardening: real one-click resolve + full-repo safety + failure UX

Closed every remaining gap in the whole-project sync + sidebar UX so that **every failure is
surfaced clearly, loses no local work, and offers a concrete recovery**. Eight items, each unit-tested
(+ a real-git e2e where it applies):

1. **REAL one-click "Resolve with AI"** (was: opened Settings). The sidebar banner now launches the
   in-app agent surface running `/dream-sync` (autonomous `brain sync --resume` → resolve the deferred
   report → `--continue`) via a `RUN_BRAIN_RESOLVE_EVENT` window-event bridge (`brainResolveAgent.ts`,
   mirroring the sleep-agent bridge); brain-status polls back to "Synced" on completion. In the plain
   browser dashboard (no agent surface) it falls back to a copyable `dream-sync` command panel.
2. **Detached HEAD in full-repo → refuse.** New `detached-head` outcome ("check out a branch before
   syncing the whole project") instead of falling back to `main` and pushing a detached HEAD's commits.
3. **User's-own-merge false positive fixed.** A `MERGE_HEAD` with NO conflict report is the user's own
   `git merge`/`rebase` (full-repo gitCwd is the project root) → new `user-merge-in-progress` ("Finish
   your in-progress git merge first"), never the misleading "team merge awaiting /dream-sync".
4. **Code-conflict policy.** A conflicted file OUTSIDE `_dream_context/` is classified `code` and
   deferred to the HUMAN's editor — NEVER semantically merged (no source mangling) and NEVER sent to
   the agent. Foreground leaves git's native markers (resolve → commit → sync pushes it); headless
   aborts to a clean tree. The conflict report now **separates `codeConflicts` from brain `deferred`**.
   Real-git e2e: two clones conflict on `src/app.ts` → markers preserve both sides, nothing pushed over
   it, converges after a human resolve. Also fixed `autoSync` to push a locally-ahead HEAD (else the
   human's resolved merge commit was silently stranded).
5. **Network/auth/token failure UX** (`failure.ts`). Engine errors map to SPECIFIC failures + recovery:
   expired/invalid token → **Reconnect GitHub**; offline → "you're offline, will retry"; missing
   Contents-write → **names the repo + scope**; the route returns `action:'error'` + `failure` (200) so
   the sidebar renders the affordance — never a bare "Sync failed".
6. **Scrub-block guidance.** `blocked-scrub` lists each block (file/line/rule) and offers one-click
   **"Add to .gitignore"** (`POST /api/brain/scrub/ignore`) — but ONLY for local secret/config files
   (`.env`, `credentials*`, `*.pem`, …); a real source file is refused (remove the secret, don't
   un-track it). Server-revalidated, traversal-guarded.
7. **Auto-checkpoint transparency.** The pull-only dirty-tree checkpoint now reports
   `checkpointed`/`checkpointSha` (subtle "Checkpointed your local edits" note + undo hint
   `git reset --soft <sha>^`), and a Settings toggle disables auto-checkpoint-on-open (`noCheckpoint`
   skips a dirty tree entirely, leaving WIP untouched).
8. **Non-fast-forward recovery.** Push-rejected-twice maps to `push-rejected` → a clear message + a
   **Retry sync** button in the sidebar error panel.

Sidebar sync UI extracted to `BrainSyncControl.tsx` (resolve/code/user banners + failure/scrub/checkpoint
panels + the sync row). Status route adds `mergeKind` (`agent`/`code`/`user`/`null`) + `codeConflicts` so
the right banner shows for each in-progress-merge kind.

**Adversarial-review hardening (same pass).** A clean-context reviewer found three real defects, all
fixed + regression-tested: (a) **gitignore-injection** — `isSafeToGitignore` accepted a `!`-negation
(`!.env`, `!_dream_context/state/.secrets.json`) that would UN-ignore a secret before a full-repo push;
now rejects `! # * ? [ ]` and control chars (server + client mirror). (b) **dropped agent record** — a
merge conflicting on BOTH a code file and a brain-prose file wrote `deferred: []`, stranding the prose
conflict with no record; now records both. (c) **unscrubbed locally-ahead push** — pushing a
human-finished merge commit (or any locally-ahead work) bypassed the scrub gate; new `scrubCommitRange`
scrubs the full push range and BLOCKS on a hit before any push, in BOTH `autoSync` (`origin/main..HEAD`)
AND `pushOnlySync` (the `--push-only` CLI path, `revParse(remoteRef) ?? EMPTY_TREE..HEAD`). A clean-context
reviewer re-verified all three fixes: **PASS**.

Coverage: +engine units (detached-head, user-merge, code-conflict fg/headless, checkpoint/noCheckpoint,
localAhead scrub-block/clean, mixed code+prose conflict record), +semantic-merge units (code
classification), +route units (mergeKind agent/code/user, scrub/ignore safe/unsafe/traversal/negation/
multiline), +`failure.ts` units (every failure class), +1 real-git full-repo code-conflict e2e. Full
suite **3013 green**. Merge rules updated: `skill-sync/references/merge-rules.md` §10 + new §16.

### 2026-07-08 - Whole-project sync mode + sidebar UX overhaul + one-click merge

User feedback (frustration): the cloud-sync feature was confusing and under-serving. Three concrete pains, all addressed:

**New `full-repo` sync mode — sync the WHOLE folder, not just `_dream_context/`.** Users can now sync the entire project (code + brain) to the project's own `origin` on the current branch, rather than carving `_dream_context/` out as a separate repo. New `POST /api/brain/scope` endpoint (`scope: 'full-repo' | 'brain'`) flips `brainRepo.mode` (full-repo requires a project `origin` — 400 `no_origin` without one). Settings → Brain gets a two-card "Sync scope" chooser. The engine now threads a per-context branch (`git.currentBranch` via `symbolic-ref` — works on unborn branches, unlike `rev-parse --abbrev-ref`) and remote-ref through every fetch/merge/push instead of hardcoding `origin/main`; commit messages are project-scoped (`chore: sync project (dreamcontext)`) in full-repo. Session-start background pull + `sleep done` autoSync both fire for full-repo (previously `separate`-only). `brain platform` correctly declines full-repo (root files sync natively).

**Gitignore-first safety (caught by the new full-repo e2e).** `git add -A` at the project root would stage `_dream_context/state/.brain-merge/.lock` — leaking the sync lock into every clone as a foreign LIVE PID that reads as `locked` — and, far worse, secrets. `ensureFullRepoGitignore(projectRoot, taskBackend)` writes the machine-local + secrets deny-list (`_dream_context/`-prefixed) to the project-root gitignore, run gitignore-first before every whole-project stage AND on scope-enable. The e2e asserts the lock, `.brain-local.json`, and `.secrets.json` never reach the remote.

**Sidebar UX overhaul.** Removed the inscrutable bare-number "team updates" card (it showed `pulledUpdates` — updates ALREADY pulled, not waiting — genuinely meaningless as a persistent badge). The sync row now SYNCS on click (was: opened Settings — the core confusion); a small gear is the only element that opens Settings. Status label is self-explanatory (`Syncing…` / `Pulled N update(s) ✓` / `Synced` / `Project synced`). Dashboard auto-runs a safe foreground pull+merge ONCE on open (`pull-only`, auto-checkpoints dirty work first so nothing is lost, never pushes); the button + sleep do the full commit→push cycle. A teammate-conflict surfaces as a one-click "Resolve with AI" banner instead of the cryptic "awaiting agent" label.

**Foreground scrub relaxation.** Dashboard-initiated syncs (`/brain/sync` defaults `foreground:true`) keep WARN-tier scrub hits non-blocking (only real secrets BLOCK) — absolute-path WARNs are common across a whole code repo and must not block the human-watched pull. The truly headless session-start background pull keeps its effective-strict "any hit blocks" gate.

Coverage: +5 engine unit tests (branch/foreground/messages/block), +4 route tests (full-repo status, scope enable/revert/no-origin/invalid), +1 real-git full-repo e2e (whole folder → feature branch, round-trip merge, lock+secret exclusion). Full suite 2974 green.

### 2026-07-07 - v0.14.1: Platform layer portability + Lab credentials + dashboard controls

**Platform layer — CLAUDE.md + .claude sync with the brain repo.** A separate-mode brain repo is rooted at `_dream_context/`, so Claude Code files at the project root (CLAUDE.md, `.claude/` skills/agents/hooks) would never sync on their own. `dreamcontext brain platform` now migrates them: real files move to `_dream_context/platform/` and the project root holds relative symlinks (Claude Code resolves transparently). From then on they sync like everything else; every `brain sync` runs `healPlatformLinks()` so a fresh clone self-wires. `doctor` flags broken links. Machine-local files (`platform/.claude/settings.local.json`, `scheduled_tasks.lock`) stay gitignored.

**Gitignore-first discipline hardening.** `setupPlatformLayer` now writes the FULL canonical gitignore BEFORE moving content — a platform-only stub used to defeat `bootstrapBrainRepo`'s `!existsSync` guard, leaking local state (`state/.brain-merge/.lock`, secrets) to the team. Caught by a new two-clone e2e test. `ensureLocalOnlyArtifacts` also self-heals older/hand-edited gitignores when a live platform layer exists.

**Lab credentials surface.** Tracked `lab/credentials.example.json` generated from `credentials_used` + `{{cred:*}}` placeholders (gitignore negation `!lab/credentials.example.json`), so teammates see which keys an insight needs. `GET/POST /api/lab/credentials` (key names only, values never returned/logged). `LabCredentialsBanner` in dashboard lists missing keys with inline add.

**Dashboard controls.** Sidebar refresh button next to "Synced" badge runs full pull+merge (`POST /brain/sync mode:auto`) with outcome feedback (ok / awaiting-agent / blocked-scrub). Settings → Memory: recall-mode radio group (haiku / raw / hybrid experimental / off) — the missing UI surface for v0.14.0 hybrid recall; `PATCH /api/sleep` now accepts validated `recall_mode`.

Suite 2958 tests green. See `skill-sync/references/merge-rules.md` for updated gitignore table.

### 2026-07-07 - Empty-remote attach now works end-to-end (v0.13.0)
- **Empty-remote attach and bootstrap fixed.** Attaching an empty GitHub repo (no `origin/main` ref) now works without fatal errors: (1) sync engine checks `remoteBranchExists()` before every fetch site — on a freshly-attached ref-less repo, auto sync bootstraps the first commit and births `main` (including attach-after-detach case where local commits exist but tree is clean); (2) pull-only — the background/session-start path — noops with guidance instead of dying on "couldn't find remote ref main"; (3) failed push to empty remote reports clean token/permissions error instead of fetch crash. A README-initialized repo gets actionable "unrelated histories — attach empty or existing brain repo" error instead of raw git output. Attach immediately bootstraps (same scrubbed first-commit-and-push as Create): response carries `bootstrap: "pushed"|"blocked-scrub"|"skipped"`, UI warns if first push was scrub-blocked. Existing brain repos untouched (attach never pushes over content).
- **Askpass permission fix** (GitHub token credential supply): helper shipped 644 because `cpSync` preserved source mode, and git execs `GIT_ASKPASS` directly — fixed: source file now +x, **build enforces 755** (`tsup.config.ts`), and **`resolveAskpassPath` self-heals** any already-shipped non-executable install at runtime. Verified helper executes (username → `x-access-token`, password → token). 99/99 tests across five brain/git-sync suites including new real-git e2e (attach empty bare → pull-only noop → auto births `main` → converged noop), askpass self-heal test, attach-bootstrap route tests, and fix for pre-existing token-test failures (now HOME-isolated).

### 2026-07-06 - OQ-1 RESOLVED: OAuth App registered, device flow LIVE
- **Registered the "dreamcontext" GitHub OAuth App** (owner `meanllbrl`, Device
  Flow enabled) and embedded its public client_id as
  `DEFAULT_BRAIN_OAUTH_CLIENT_ID = 'Ov23lisakBMDeqzsr6Xg'` in `oauth.ts`.
  One-click "Continue with GitHub" now works out of the box — the PAT form
  drops back to being the fallback, not the primary.
  - `DREAMCONTEXT_GITHUB_CLIENT_ID` env still overrides the embedded default;
    setting it to `PLACEHOLDER_CLIENT_ID` explicitly forces PAT-only mode.
  - Verified end-to-end: `startDeviceFlow()` with the embedded default returns
    a real `user_code` from GitHub.
  - Homepage/callback URL: https://github.com/meanllbrl/dreamcontext (device
    flow never uses the callback; the field is just required by the form).
  - Remaining before M2 fully complete: the manual UI walkthrough in the
    packaged app (device-flow login should now be testable there one-click).

### 2026-07-06 - Device-flow gracefully gated on OQ-1; PAT-primary fallback shipped
- **Fixed the "GitHub device-code request failed (404)" dead-end.** Root cause was
  OQ-1: no OAuth App registered, so the app shipped the placeholder client_id
  (`Iv1.dreamcontext-placeholder`), which GitHub 404s. Rather than fire that doomed
  request, the app now **detects the unconfigured state and degrades gracefully**:
  - `oauth.ts`: added `resolveBrainOAuthClientId()` (live env read, no longer
    frozen at import) + `isOAuthAppConfigured()` predicate; `PLACEHOLDER_CLIENT_ID`
    exported. `BRAIN_OAUTH_CLIENT_ID` kept as a deprecated import-time snapshot.
  - `brain-auth.ts`: `device/start` short-circuits to **501 `oauth_not_configured`**
    when unconfigured (never calls GitHub); `status` now returns `oauthConfigured`.
  - `GitHubLogin.tsx`: when `oauthConfigured === false`, the **PAT form is the
    primary, always-visible path** (no doomed "Continue with GitHub" button); new
    `brain.auth.oauthUnavailable` i18n string. Device-flow-first UI still renders
    once a real client_id is wired in (env var or embedded default).
  - Tests: +2 oauth unit tests (`isOAuthAppConfigured`/live resolver), +2
    brain-auth route tests (501 short-circuit without network, `oauthConfigured`
    flag). Full suite green (2816 pass).
  - **OQ-1 status:** to make one-click sign-in work, register a GitHub OAuth App
    (Device Flow enabled) and set `DREAMCONTEXT_GITHUB_CLIENT_ID` (or embed the
    real client_id as the default in `oauth.ts`). Until then PAT is the connect path.

### 2026-07-05 - M2 shipped (commit 7498307), manual validation pending
- **M2 Launcher/Dashboard/Desktop SHIPPED.** Device-flow OAuth (sessionId UUID, slow_down, global ~/.dreamcontext/.secrets.json 0600 token tier, injectable fetch), discover endpoint (dreamcontext-brain topic filter), create-from-UI (private default + S5 defense-in-depth confirmed gate at library level), attach flow (S6 trust gate server-enforced + read-only previewAttach diff), team-updates badge (cache-only endpoint, background fetch skips disabled), Settings toggle (Cloud sync master switch M2 tier, spreads brainRepo config). 15 server routes (brain-auth.ts + brain.ts call M1 fns in-process, NOT shell-to-CLI per validated M2 architecture), 3 lib modules (oauth.ts/auth-store.ts/team-fetch.ts), 4 dashboard components, shared src/server/desktop.ts isDesktop(). 36 M2-only files (+3403/-48). Automated validation PASS (57/57 backend tests green, dashboard builds clean, 77 i18n keys). **REMAINING:** manual UI walkthrough in packaged Tauri app (human step) + OQ-1 (register GitHub device-flow OAuth App, embed public client_id; PAT-paste fallback is code-complete + unit-tested and works without OQ-1). M3 still out of scope.

### 2026-07-04 - M1 shipped (commit d351cc8)
- **M1 CLI core SHIPPED.** Brain-repo sync CLI (`dreamcontext brain init|sync|enable|disable|status`), GIT_ASKPASS credential supply (0600 tmp token file, never in URL/env/argv), scrub gate (BLOCK on secrets, WARN on paths, effective-strict in headless), semantic merge (task changelog set-union, knowledge conflict discard-then-defer to agent), pull-only content delivery (merge into working tree, headless auto-checkpoint), `/dream-sync` skill loop (defer → resume → resolve → continue), sleep-done autoSync integration (sync failure never fails sleep), session-start background pull (non-blocking PATH-safe), master switch (GitHub-connected default-on, `brainRepo.enabled` explicit/derived). 41 files, 4924 additions. Merge semantics documented in **`skill-sync/references/merge-rules.md`** (shipped reference). M2/M3 pending. Status `planning` → `in_progress`.

### 2026-07-04 - Created (design-only)
- Feature PRD created from a 2026-07-04 product design discussion. Captures the
  phased (P1 read-only / P2 one-way push / P3 full semantic-merge sync) design and
  the constraints that came out of that session. No code yet — status `planning`.
