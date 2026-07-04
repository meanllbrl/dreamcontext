---
id: "feat_Sx4EmLgP"
status: "planning"
created: "2026-07-04"
updated: "2026-07-04"
status: "planning"
released_version: null
tags:
  - topic:github
  - topic:cli
  - topic:desktop
  - architecture
  - backend
related_tasks:
  - github-cloud-collaboration-brain-repo-sync
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

- [ ] As a user, I can point my project's brain at a dedicated GitHub repo (separate
  from my code repo), so my team can collaborate on tasks/knowledge/features the
  way they already collaborate on code.
- [ ] As a user, every `dreamcontext sleep done` automatically fetches, merges (via
  a semantic merge agent on conflict), commits, and pushes the brain repo, so my
  teammates' consolidated context reaches me (and mine reaches them) without a
  manual step.
- [ ] As a user, I can run a manual sync skill (`/dream-sync`-style) at any time to
  pull/push the brain repo outside of a sleep cycle.
- [ ] As a user, I can log into GitHub from the desktop Launcher (OAuth device flow,
  or a PAT as fallback) and see which of my accessible repos are brain repos (via a
  topic/marker), so connecting a project doesn't require hand-typing a repo URL.
- [ ] As a user, on a new machine, the Launcher guides me to clone or locate the
  brain repo for a project (the brain repo stores a pointer back to its code repo),
  so setting up a second machine doesn't mean re-deriving which repo goes with
  which.
- [ ] As a user, every machine builds its OWN local index/cache over the shared
  brain (recall index, embeddings, etc.) that is NEVER pushed, so per-machine
  derived state never pollutes the shared repo or causes merge noise.
- [ ] As a user, my personal notes/attributions ride the existing multi-people
  awareness (`user.md` `## People`, `person:<slug>` tags, changelog authors) rather
  than a new per-person file namespace, so the brain doesn't fragment into
  per-person copies.
- [ ] As a user, nothing containing secrets or absolute local paths is ever
  auto-pushed — a scrub gate runs before every push and blocks/redacts violations.
- [ ] As a user, issue-linked tasks (GitHub Issues task backend) keep working when
  the brain also lives in its own repo — issue mapping is reused, not
  reimplemented.

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

**Validated design (plan v3.2, 2026-07-04) — 3 reviewers SOLID over 5 iterations, 21 findings resolved.** The task (`github-cloud-collaboration-brain-repo-sync`) is the authoritative implementation spec with 30 acceptance criteria across M1/M2/M3 milestones. This PRD carries product intent + validated architecture summary.

**Architecture (compact form — full detail in the task):**

**Modes:** `separate` (brain in its own GitHub repo + remote; full auto-sync) vs `in-tree` (brain nested in code repo; commit-only, NEVER auto-pushes; the safe default). Scrub gate applies to both.

**Credential supply:** Token NEVER embedded in remote URL (S1 — would persist in `.git/config` plaintext). Every git network call runs via `GIT_ASKPASS` + 0600-at-create tmp token file (path in env, token never in env/argv); `-c credential.helper=` disables persisted helpers; tmp file unlinked in `finally`. Resolves per-project `.secrets.json` → global `~/.dreamcontext/.secrets.json` (0600) → env (M1 is secrets-first; M2 inserts global tier). The reversed priority from `resolveGitHubToken` (env-first) is intentional — a distinct resolver, never reused.

**Scrub gate:** Runs before EVERY brain commit (in-tree S2, `brain init` first push S3, `brain detach` S4, post-merge results). WARN-tier hits block ONLY in headless pull-only (effective-`--strict` — no human eye on the auto-commit); foreground modes keep WARN non-blocking. BLOCK-tier hits abort loudly everywhere. A staged file containing `ghp_`+36 chars → BLOCK.

**Pull-only content delivery:** With clone A ahead by a knowledge edit, clone B's `brain sync --pull-only` on a clean tree merges the edit into B's working tree (`pulled`, `pulledUpdates>0`) — not just counted — and pushes nothing. Dirty tracked tree → auto-commit first (scrubbed, message `chore(brain): auto-checkpoint local edits before team merge`, M1 author tiering) under effective-`--strict` scrub (any hit refuses the headless auto-commit); clean merge delivers content. Agent-class conflict → write report + base/ours/theirs snapshots, `abortMerge` back to a clean committed tree, set `pendingAgentMerge:true`.

**Handoff loop (`--resume` / `--continue`):** Pull-only agent-class conflict writes the report, aborts to clean committed tree, sets `pendingAgentMerge:true`. Plain `brain sync` then returns `already-awaiting-agent`. `brain sync --resume` (ATTENDED only — unattended callers never resume) re-fetches/re-merges into a FRESH `awaiting-agent` with real `MERGE_HEAD`; re-defer leaves real `MERGE_HEAD` + FRESH report; clean resolve completes alone. Agent resolves. `brain sync --continue` commits the in-progress merge, re-scrubs, pushes → report + snapshots gone, `pendingAgentMerge:false`. If remote moved on, `--resume` alone completes with no agent step. Flag misuse (e.g., `--continue` w/o `MERGE_HEAD`) returns `invalid-flag` + guiding `note`.

**Concurrency + liveness:** PID-liveness lock via `verifyPidLiveness` opt-in on `acquireFileLock` — a second `runBrainSync` while a live holder owns the lock returns `locked`; a lock left by a dead PID past the staleness window is reclaimed; lock held by alive PID is NOT reclaimed even past window.

**Private-by-default + attach trust gate:** Brain repos default PRIVATE (S5 — public requires `--public` flag/toggle + loud interactive confirm). `brain attach` / dashboard attach is a TRUST decision (S6 — a brain repo is a prompt-injection channel); prints loud trust warning + incoming diff preview and refuses without confirmation.

**M1/M2/M3 milestones:** M1 (CLI core, no launcher required) = brain init, git wrapper + GIT_ASKPASS credentials, resolveBrainSyncToken tiering, brain sync CLI, scrub gate BLOCKS on both commit paths, commit author tiering (git identity or `dreamcontext-sync <noreply@dreamcontext.local>` fallback), semantic merge (task changelog set-union + furthest status wins; knowledge conflict discard remote-wins + awaiting-agent), conflict-report lifecycle, pull-only content delivery + dirty-tree auto-checkpoint + headless effective-strict scrub, dream-sync skill loop (defer/resume/resolve/continue), reentrancy guard, brain lock, sleep done autoSync integration (sync failure never fails sleep), in-tree mode (commit-only, still scrubbed), session-start background pull (non-blocking PATH-safe detached spawn). M2 (Launcher/Dashboard/Desktop) = device-flow login, scope disclosure + fine-grained PAT recommendation, discover `dreamcontext-brain` topic repos, create from UI (one-click private + scrubbed first push), attach (trust warning + diff preview + refuses w/o confirm), team-updates badge (cache-only endpoint + background fetch). M3 (Polish) = `taskBackend=github` task md gitignored + issues source of truth + doctor check, post-pull task-mirror refresh via `getTaskBackend sync`, GitHub login maps to person slug commit author, brain detach (private, scrubbed, showcase-safe `--keep-tracked` default).

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

### 2026-07-04 - Created (design-only)
- Feature PRD created from a 2026-07-04 product design discussion. Captures the
  phased (P1 read-only / P2 one-way push / P3 full semantic-merge sync) design and
  the constraints that came out of that session. No code yet — status `planning`.
