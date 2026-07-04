---
id: "feat_Sx4EmLgP"
status: "planning"
created: "2026-07-04"
updated: "2026-07-04"
released_version: null
tags:
  - topic:github
  - topic:cli
  - topic:desktop
  - architecture
  - backend
related_tasks: []
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

**Status: design-only as of 2026-07-04.** No code has shipped yet; this session
converged on the phased design below during a product discussion. The scaffolding
this design will connect to (where `sleep done` runs, existing GitHub auth/token
handling, current skill distribution mechanism, the hook pipeline) is being mapped
by a discovery pass immediately following this sleep cycle — update this section
once that mapping lands and P1 implementation starts.

**Reusable as-is (already built, per design discussion):**
- GitHub OAuth/token plumbing from the GitHub Issues task backend
  (`src/lib/task-backend/github.ts`, `ApiAdapter`) — device flow or PAT, least new
  surface for P1 login.
- Multi-people awareness (`1.user.md` `## People`, `person:<slug>` tags, changelog
  authors) — the personal-layer mechanism this feature rides rather than
  reinventing.
- `dreamcontext sleep done` as the natural hook point for the automatic post-sleep
  sync step.

**Genuinely new subsystems (the real work, by phase):**
1. **P1** — GitHub login surfaced in the Launcher; repo discovery by
   topic/marker; guided clone/locate flow for a new machine; local-only index
   build step.
2. **P2** — the push step itself (git plumbing from Node/CLI), the
   secrets/absolute-path scrub gate, and conflict detection that stops and
   surfaces rather than force-pushing.
3. **P3** — the semantic merge agent (fetch → detect conflict → agent-driven
   reconcile → commit → push) and GitHub Issues onboarding for teams that also use
   the issue task backend.

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
