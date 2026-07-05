---
id: feat_I4gU7kKs
status: active
created: '2026-05-09'
updated: '2026-06-21'
released_version: v0.8.7
tags:
  - 'topic:agents'
  - 'topic:sleep'
related_tasks:
  - sleep-fanout-architecture
type: feature
name: sleep-fanout-architecture
description: ''
pinned: false
date: '2026-05-09'
---

## Why

The original `dreamcontext-rem-sleep` agent was monolithic — one sub-agent handled every consolidation domain (tasks, changelog, core files, knowledge, features) in a single sequential pass. In practice, the tail of that pass was unreliable: changelog entries, release readiness checks, and feature-PRD updates were routinely skipped because too many concerns competed for one context window. By the time the agent reached "update feature PRDs," it had already burned attention on tasks and core files.

Fan-out fixes this by splitting the work into focused specialists, each owning a non-overlapping file domain. The design launched with 5 specialists and was subsequently collapsed to 3 when overhead analysis showed that parallel agents help wall-clock time only to the slowest (sleep-tasks); collapsing always-fire non-overlapping domains reduces launch overhead without slowing the consolidation floor.

**Current design — 3 specialists**:

- `sleep-tasks` → `_dream_context/state/*.md` (always)
- `sleep-state` → `_dream_context/core/0.soul.md`, `1.user.md`, `2.memory.md`, `CHANGELOG.json`, `RELEASES.json` (always; merged from old sleep-core + sleep-changelog)
- `sleep-product` → `_dream_context/knowledge/` + `_dream_context/core/features/*.md` (conditional; merged from old sleep-knowledge + sleep-features)

Each specialist runs with its own narrow context, owns one domain, and cannot stomp on another. Nothing falls through.

## User Stories

- [x] As the main agent running the SKILL.md sleep flow, I can dispatch tasks and state specialists in parallel from a single message so consolidation is faster and each specialist stays focused.
- [x] As the tasks specialist, I can update task statuses, log progress, and reconcile task bodies without touching changelog or core files.
- [x] As the state specialist (sleep-state), I can update soul/user/memory files and append changelog/release entries surgically in a single pass — merging two formerly separate specialist concerns without stepping on task changes.
- [x] As an orchestrator, I can conditionally fire sleep-product based on signals (knowledge access staleness, git status under `core/features/`, task slug overlap, research in session, ≥2 ACs on a new concept, user named feature, task `feature:` frontmatter) so cheap sessions stay cheap.
- [x] As an environment that cannot fan out, I previously could run the full consolidation via `dreamcontext-rem-sleep`; that fallback was removed in the cleanup pass — one authoritative path only.
- [ ] As the user, I see a single consolidated report at the end of sleep showing what each specialist did, so I know exactly what changed.

## Acceptance Criteria

- [x] Three specialist agent files exist under `agents/`: `sleep-tasks.md`, `sleep-state.md`, `sleep-product.md`.
- [x] Three specialist agent files are mirrored to `.codex/agents/prompts/` and `.codex/agents/*.toml`. `dreamcontext-rem-sleep.md`, `sleep-changelog.md`, `sleep-core.md`, `sleep-knowledge.md`, `sleep-features.md` were all removed.
- [x] `skill/SKILL.md` "Sleep" section instructs the main agent to fan out — dispatching `sleep-tasks` and `sleep-state` always in parallel from a single message.
- [x] `skill/SKILL.md` documents conditional dispatch rules for `sleep-product` (union of old sleep-knowledge + sleep-features signals) based on signals from `.sleep.json` and `git status`.
- [x] Each specialist owns a non-overlapping file domain, enforced by design (specialists' own protocols name only their domain paths).
- [x] Specialists fetch their own context via `dreamcontext` CLI commands directly — there is no shared digest file the orchestrator must produce.
- [x] `dreamcontext-rem-sleep` was rewritten as a serial fallback, then subsequently removed. The main-agent SKILL.md fan-out is the sole consolidation path.
- [x] Hook debt messages and SKILL.md point users at the SKILL.md fan-out flow as the only path; `dreamcontext-rem-sleep` no longer exists as a fallback.
- [x] `npm run build` passes and `dreamcontext --version` reflects the new flow.
- [ ] Live consolidation cycle completes without errors and produces a meaningful end-to-end report stitched from specialist reports.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-04]** Dedup hardening shipped in both `sleep-tasks` and `sleep-product` prompts. Root cause of duplication failures: `sleep-tasks` Step 2 previously said "create one" without a mandatory recall-first dedup gate; `sleep-product` had a one-line dedup note but no sharp-vs-soft distinction rubric. Fix: (a) `sleep-tasks` Step 2 now requires `memory recall --types task` + active-list scan before any create, with an explicit decision table (smaller slice → fold into existing via `tasks insert`; genuine new concern → create); (b) `sleep-product` B2 now has a full "consolidation rubric" (extend existing on soft/family distinction, create only on sharp topical boundary that sharpens tags). The rubric is also referenced in the orchestrator brief sent to each specialist. Four agent file locations kept in sync: `agents/`, `.codex/agents/prompts/`, `.claude/agents/`, `dist/agents/`.

- **[2026-06-09]** Data-structures ownership moved from `sleep-state` to `sleep-product` (issue #12). `sleep-state` B0b no longer routes to `core/data-structures/*` (that path is retired). `sleep-product` B6 now owns schema writes to `knowledge/data-structures/<product>.md` with a single-observation gate (schema changes reflected same cycle, no two-observation wait).
- **[2026-05-22]** `sleep-state` B0 split into two gates: B0a (two-observation recurrence threshold) for preference/decision updates to `1.user.md` + `2.memory.md`; B0b (single-observation, code-reality) for `3.style_guide`, `4.tech_stack`, `6.system_flow`. B1 priority row removed from the sleep-state protocol (was confusing, removed as dead weight).
- **[2026-05-22]** `sleep-product` A4 broadened: new PRD triggers are now OR(a) ≥2 acceptance criteria, (b) user named feature explicitly, (c) dangling `feature:` frontmatter in a task file. ACs in a newly-created PRD may be empty placeholder stubs — PRDs are created speculatively and filled during subsequent sessions.
- **[2026-05-22]** `sleep-product` A5 multi-product pass added: when multiple products are detected, each product may receive its own product-specific PRD/knowledge updates. B5 per-product knowledge stubs: if `multiProduct` lists products, ensure `knowledge/products/<name>.md` exists for each; create stub if missing.
- **[2026-05-10]** 5→3 specialist collapse. Domain merges: sleep-state = old sleep-core + sleep-changelog (both always-fire, non-overlapping file sets — CHANGELOG/RELEASES vs soul/user/memory). sleep-product = old sleep-knowledge + sleep-features (both conditional, both retrospective documentation). Collapse rationale: parallel agents reduce wall-clock only to the slowest (sleep-tasks); collapsing always-fire pairs reduces sub-agent launch overhead without slowing the consolidation floor. Files removed: `agents/sleep-changelog.md`, `agents/sleep-core.md`, `agents/sleep-knowledge.md`, `agents/sleep-features.md` (and all `.codex/` mirrors). Files created: `agents/sleep-state.md`, `agents/sleep-product.md`.
- **[2026-05-09]** Orchestrator role lives in the **main agent**, not a sub-agent. An earlier design used a thin `dreamcontext-rem-sleep` orchestrator that dispatched specialists. In practice, sub-agent → sub-agent dispatch did not fan out reliably (Claude Code sub-agents cannot consistently spawn parallel sub-agents). Driving fan-out from the main agent's `skill/SKILL.md` flow is the primary path.
- **[2026-05-09]** `dreamcontext-rem-sleep` was preserved temporarily as a single-agent serial fallback, then removed in the cleanup pass. The decision to remove: maintaining two paths created confusion about which is authoritative. The main-agent SKILL.md flow is sufficient; if fan-out is unavailable, users can invoke specialists manually. Files removed: `agents/dreamcontext-rem-sleep.md` and `.codex/agents/prompts/dreamcontext-rem-sleep.md`.
- **[2026-05-09]** No shared digest file. Each specialist runs `dreamcontext` CLI commands itself to pull context. The CLI is the source of truth; the orchestrator passes only a small text brief (epoch, session IDs, task slugs, planning version, signals, optional user hint).
- **[2026-05-09]** Specialists report back to the main agent as short structured strings; the main agent stitches them into one summary and calls `dreamcontext sleep done "<summary>"`.
- **[2026-05-09]** When unsure about firing conditional specialists, **over-fire** — they no-op cheaply if their signals don't actually warrant work.
- **[2026-05-09]** Specialists never edit files outside their domain. Cross-domain findings are surfaced in their reports for the right specialist (or main agent) to pick up — they don't reach across.

## Technical Details

**Architecture**: orchestrator-in-main-agent + 3 domain specialists. No fallback agent.

**Files**:
- `skill/SKILL.md` — "Sleep" section defines the orchestration flow: `sleep start` → build small brief → parallel dispatch → wait for reports → marketing pass → council promote check → `sleep done`.
- `agents/sleep-tasks.md` — domain: `_dream_context/state/*.md`. Logs progress, bumps statuses (max `in_review`, never `completed`), reconciles task bodies to current truth, updates Mermaid Workflow nodes. **Always fire.**
- `agents/sleep-state.md` — domain: `_dream_context/core/0.soul.md`, `1.user.md`, `2.memory.md`, `CHANGELOG.json`, `RELEASES.json`. Surgical core-file updates, anti-bloat sweep, changelog entries, planning-version readiness. Merged from old sleep-core + sleep-changelog. **Always fire.**
- `agents/sleep-product.md` — domain: `_dream_context/knowledge/` + `_dream_context/core/features/*.md`. Creates/updates knowledge files, staleness sweep, updates and creates feature PRDs. Merged from old sleep-knowledge + sleep-features. **Conditional dispatch.**
- `.codex/agents/prompts/` + `.codex/agents/*.toml` — mirror of the 3 specialist agent files for the codex harness.

**Dispatch signals** (built by the main agent from the brief, evaluated against `cat _dream_context/state/.sleep.json` and `git status --short`):

- **Always fire**: `sleep-tasks`, `sleep-state`.
- **Fire `sleep-product` if** (union of old knowledge + features signals): `last_assistant_message` mentions research/analysis/decision; a `knowledge_access` entry hasn't been touched in 30+ days; a research bookmark exists; a task slug matches an existing feature PRD filename; `git status` shows changes under `_dream_context/core/features/`; user hint mentions knowledge or a feature; a session advanced ≥1 acceptance criterion OR introduced a buildable concept with ≥2 acceptance criteria OR user named something "a feature" OR a task has `feature:` frontmatter pointing to a non-existent PRD. When unsure, over-fire — sleep-product no-ops cheaply.

**Brief contents** (small text passed in each specialist's prompt):
- Sleep epoch (from `sleep start`)
- Session IDs being consolidated
- Active task slugs
- Planning version
- Signals relevant to that specialist
- Optional user hint
- **Not** transcript content — specialists call `dreamcontext transcript distill <id>` themselves if needed.

**Reporting**: each specialist returns a short structured report (markdown). The main agent concatenates reports and uses them to compose the `sleep done` summary.

**No fallback**: `dreamcontext-rem-sleep` was removed (2026-05-09 cleanup). If fan-out is unavailable, specialists can be invoked manually in sequence. The main-agent SKILL.md flow is the only supported path.

## Notes

- The 3-specialist design has run across multiple consolidation cycles (first live test 2026-05-10; confirmed stable as of 2026-05-23).
- Open question: the conditional-dispatch heuristics may need tuning. If `sleep-product` no-ops too often, signals are too aggressive; if it misses real updates, signals are too narrow.
- If a future environment cannot fan out, the mitigation is manual sequential invocation of the 3 specialists. `dreamcontext-rem-sleep` has been removed and will not be restored.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-09 - Data-structures ownership transferred to sleep-product (issue #12)
- `sleep-state` B0b no longer routes schema writes to `core/data-structures/*` (retired path).
- `sleep-product` B6 owns schema writes to `knowledge/data-structures/<product>.md` with single-observation gate.
- Constraints updated to reflect ownership shift.

### 2026-06-04 - Dedup hardening: recall-before-create + consolidation rubric
- `sleep-tasks` Step 2: mandatory `memory recall --types task` + active-list scan before create; decision table distinguishes fold-in (smaller slice) vs new task (genuinely separate concern).
- `sleep-product` B2: new "Create vs. extend — the consolidation rubric" section (soft/family → extend; sharp topical boundary → create); B1 table routes "new research" through rubric first.
- Orchestrator brief (SKILL.md): "Consolidation discipline" reminder appended to parallel specialist dispatch step.
- Four agent locations kept in sync (agents/, .codex/agents/prompts/, .claude/agents/, dist/agents/).

### 2026-05-22 - v0.4 specialist protocol refinements
- sleep-state B0 split: B0a two-observation gate (prefs/decisions) vs B0b single-observation (code reality: style_guide, tech_stack, data-structures, system_flow). B1 priority row removed.
- sleep-product A4 broadened: new PRD now created on OR(≥2 ACs, user named feature, dangling feature: frontmatter). ACs may be empty placeholder.
- sleep-product A5 multi-product pass added; B5 per-product knowledge stub creation.
- Dispatch signal updated to match broadened A4 trigger.

### 2026-05-10 - 5→3 specialist collapse
- Merged sleep-core + sleep-changelog → sleep-state (always-fire, non-overlapping domains combined).
- Merged sleep-knowledge + sleep-features → sleep-product (conditional, both retrospective documentation).
- Rationale: parallel agents reduce wall-clock only to the slowest (sleep-tasks); collapsing always-fire pairs reduces launch overhead without slowing the consolidation floor.
- Deleted: `agents/sleep-changelog.md`, `agents/sleep-core.md`, `agents/sleep-knowledge.md`, `agents/sleep-features.md` (and `.codex/` mirrors).
- Created: `agents/sleep-state.md`, `agents/sleep-product.md` (mirrored to `.codex/agents/prompts/` and `.codex/agents/*.toml`).
- SKILL.md "Sleep" section updated: always-fire now `sleep-tasks` + `sleep-state`; conditional now `sleep-product`.

### 2026-05-09 - Cleanup: rem-sleep fallback removed
- `agents/dreamcontext-rem-sleep.md` deleted. `codex/agents/prompts/dreamcontext-rem-sleep.md` deleted.
- Decision: one path, no fallback. Maintaining two paths created ambiguity about which is authoritative.
- SKILL.md and all specialist files updated to reflect removal.

### 2026-05-09 - Architecture pivot + 5 specialists shipped
- Sub-agent → sub-agent fan-out found unreliable. Orchestration moved to the main agent via `skill/SKILL.md` "Sleep" flow.
- `dreamcontext-rem-sleep` rewritten as serial single-agent fallback.
- Five specialist agents written and mirrored to `.codex/agents/prompts/`: sleep-tasks, sleep-changelog, sleep-core, sleep-knowledge, sleep-features.
- Hook debt messages and SKILL.md updated to point at the new flow.

### 2026-05-09 - Created
- Feature PRD created.
