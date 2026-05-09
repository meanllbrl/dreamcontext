---
id: "feat_I4gU7kKs"
status: "in_review"
created: "2026-05-09"
updated: "2026-05-09"
released_version: null
tags: ["agents", "sleep", "consolidation"]
related_tasks: ["sleep-fanout-architecture"]
---

## Why

The original `dreamcontext-rem-sleep` agent was monolithic — one sub-agent handled every consolidation domain (tasks, changelog, core files, knowledge, features) in a single sequential pass. In practice, the tail of that pass was unreliable: changelog entries, release readiness checks, and feature-PRD updates were routinely skipped because too many concerns competed for one context window. By the time the agent reached "update feature PRDs," it had already burned attention on tasks and core files.

Fan-out fixes this by splitting the work into five focused specialists, each owning a non-overlapping file domain:

- `sleep-tasks` → `_dream_context/state/*.md`
- `sleep-changelog` → `_dream_context/core/CHANGELOG.json` + `RELEASES.json`
- `sleep-core` → `_dream_context/core/0.soul.md`, `1.user.md`, `2.memory.md`
- `sleep-knowledge` → `_dream_context/knowledge/` (conditional)
- `sleep-features` → `_dream_context/core/features/*.md` (conditional)

Each specialist runs with its own narrow context, owns one domain, and cannot stomp on another. Nothing falls through.

## User Stories

- [x] As the main agent running the SKILL.md sleep flow, I can dispatch tasks, changelog, and core specialists in parallel from a single message so consolidation is faster and each specialist stays focused.
- [x] As the tasks specialist, I can update task statuses, log progress, and reconcile task bodies without touching changelog or core files.
- [x] As the core specialist, I can update soul/user/memory files surgically without stepping on task or changelog changes.
- [x] As the changelog specialist, I can append release-relevant entries and check planning-version readiness without holding the rest of the consolidation context.
- [x] As an orchestrator, I can conditionally fire knowledge and features specialists based on signals (knowledge access staleness, git status under `core/features/`, task slug overlap) so cheap sessions stay cheap.
- [x] As an environment that cannot fan out, I previously could run the full consolidation via `dreamcontext-rem-sleep`; that fallback was removed in the cleanup pass — one authoritative path only.
- [ ] As the user, I see a single consolidated report at the end of sleep showing what each specialist did, so I know exactly what changed.

## Acceptance Criteria

- [x] Five specialist agent files exist under `agents/`: `sleep-tasks.md`, `sleep-changelog.md`, `sleep-core.md`, `sleep-knowledge.md`, `sleep-features.md`.
- [x] Five specialist agent files are mirrored to `.codex/agents/prompts/`. `dreamcontext-rem-sleep.md` was removed in the cleanup pass.
- [x] `skill/SKILL.md` "Sleep" section instructs the main agent to fan out — dispatching `sleep-tasks`, `sleep-changelog`, `sleep-core` always in parallel from a single message.
- [x] `skill/SKILL.md` documents conditional dispatch rules for `sleep-knowledge` and `sleep-features` based on signals from `.sleep.json` and `git status`.
- [x] Each specialist owns a non-overlapping file domain, enforced by design (specialists' own protocols name only their domain paths).
- [x] Specialists fetch their own context via `dreamcontext` CLI commands directly — there is no shared digest file the orchestrator must produce.
- [x] `dreamcontext-rem-sleep` was rewritten as a serial fallback, then subsequently removed. The main-agent SKILL.md fan-out is the sole consolidation path.
- [x] Hook debt messages and SKILL.md point users at the SKILL.md fan-out flow as the only path; `dreamcontext-rem-sleep` no longer exists as a fallback.
- [x] `npm run build` passes and `dreamcontext --version` reflects the new flow.
- [ ] Live consolidation cycle completes without errors and produces a meaningful end-to-end report stitched from specialist reports.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-05-09]** Orchestrator role lives in the **main agent**, not a sub-agent. An earlier design used a thin `dreamcontext-rem-sleep` orchestrator that dispatched specialists. In practice, sub-agent → sub-agent dispatch did not fan out reliably (Claude Code sub-agents cannot consistently spawn parallel sub-agents). Driving fan-out from the main agent's `skill/SKILL.md` flow is the primary path.
- **[2026-05-09]** `dreamcontext-rem-sleep` was preserved temporarily as a single-agent serial fallback, then removed in the cleanup pass. The decision to remove: maintaining two paths created confusion about which is authoritative. The main-agent SKILL.md flow is sufficient; if fan-out is unavailable, users can invoke specialists manually. Files removed: `agents/dreamcontext-rem-sleep.md` and `.codex/agents/prompts/dreamcontext-rem-sleep.md`.
- **[2026-05-09]** No shared digest file. Each specialist runs `dreamcontext` CLI commands itself to pull context. The CLI is the source of truth; the orchestrator passes only a small text brief (epoch, session IDs, task slugs, planning version, signals, optional user hint).
- **[2026-05-09]** Specialists report back to the main agent as short structured strings; the main agent stitches them into one summary and calls `dreamcontext sleep done "<summary>"`.
- **[2026-05-09]** When unsure about firing `sleep-knowledge` or `sleep-features`, **over-fire** — they no-op cheaply if their signals don't actually warrant work.
- **[2026-05-09]** Specialists never edit files outside their domain. Cross-domain findings are surfaced in their reports for the right specialist (or main agent) to pick up — they don't reach across.

## Technical Details

**Architecture**: orchestrator-in-main-agent + 5 domain specialists. No fallback agent.

**Files**:
- `skill/SKILL.md` — "Sleep" section defines the orchestration flow: `sleep start` → build small brief → parallel dispatch → wait for reports → marketing pass → council promote check → `sleep done`.
- `agents/sleep-tasks.md` — domain: `_dream_context/state/*.md`. Logs progress, bumps statuses (max `in_review`, never `completed`), reconciles task bodies to current truth, updates Mermaid Workflow nodes.
- `agents/sleep-changelog.md` — domain: `_dream_context/core/CHANGELOG.json` + `RELEASES.json`. Appends entries, checks planning-version readiness.
- `agents/sleep-core.md` — domain: `_dream_context/core/0.soul.md`, `1.user.md`, `2.memory.md`. Surgical updates, anti-bloat sweep.
- `agents/sleep-knowledge.md` — domain: `_dream_context/knowledge/`. Creates/updates knowledge files; staleness sweep. **Conditional dispatch.**
- `agents/sleep-features.md` — domain: `_dream_context/core/features/*.md`. Updates feature PRDs and creates new ones for buildable concepts that lack one. **Conditional dispatch.**
- `.codex/agents/prompts/` — mirror of the 5 specialist agent files for the codex harness. `dreamcontext-rem-sleep.md` removed.

**Dispatch signals** (built by the main agent from the brief, evaluated against `cat _dream_context/state/.sleep.json` and `git status --short`):

- **Always fire**: `sleep-tasks`, `sleep-changelog`, `sleep-core`.
- **Fire `sleep-knowledge` if**: `last_assistant_message` mentions research/analysis/decision; a `knowledge_access` entry hasn't been touched in 30+ days; a research bookmark exists; `git status` shows changes under `_dream_context/knowledge/`; user hint mentions knowledge.
- **Fire `sleep-features` if**: a task slug matches an existing feature PRD filename; `git status` shows changes under `_dream_context/core/features/`; user hint names a feature; a session advanced ≥1 acceptance criterion or shipped a buildable concept without a PRD.

**Brief contents** (small text passed in each specialist's prompt):
- Sleep epoch (from `sleep start`)
- Session IDs being consolidated
- Active task slugs
- Planning version
- Signals relevant to that specialist
- Optional user hint
- **Not** transcript content — specialists call `dreamcontext transcript distill <id>` themselves if needed.

**Reporting**: each specialist returns a short structured report (markdown). The main agent concatenates reports and uses them to compose the `sleep done` summary.

**No fallback**: `dreamcontext-rem-sleep` was removed in the cleanup pass. If fan-out is unavailable, specialists can be invoked manually in sequence. The main-agent SKILL.md flow is the only supported path.

## Notes

- First live consolidation cycle (2026-05-09) is the validation test for the fan-out. This session is exercising the fan-out.
- Open question: the conditional-dispatch heuristics may need tuning. If `sleep-knowledge` or `sleep-features` no-op too often, signals are too aggressive; if they miss real updates, signals are too narrow.
- `dreamcontext-rem-sleep` has been removed. If a future environment cannot fan out, the mitigation is manual sequential invocation of the 5 specialists.

## Changelog
<!-- LIFO: newest entry at top -->

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
