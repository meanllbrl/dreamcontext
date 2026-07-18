---
id: feat_rL12JiTu
status: active
created: '2026-05-31'
updated: '2026-07-18'
released_version: v0.18.0
tags:
  - 'topic:skills'
  - 'topic:cli'
  - 'topic:agents'
  - architecture
related_tasks:
  - goal-skill-v2-fork-resume
type: feature
name: context-gate-and-goal-skill
description: ''
pinned: false
date: '2026-05-31'
---

## Why

Agents starting sessions from the snapshot had knowledge injected but no behavioral bootstrap to USE that brain or invoke relevant skills before acting. Two mitigations shipped in v0.5.0 and evolved through v0.18.0:

1. **Context gate** (UserPromptSubmit hook): detects whether any installed non-always-apply skill is plausibly relevant to the user's prompt via a deterministic BM25 pass. If so, injects a behavioral directive telling the agent to review the full available skill list and invoke whatever fits — explicitly NOT a top-N pre-selection, which would anchor the agent on a pre-curated subset and risk omitting the right skill.

2. **goal-skill pack**: a skill-pack that turns the main agent into an orchestrator running a rigorous 6-phase loop: ask user for validation method → plan → parallel plan review → persist as dreamcontext task → wave-parallel implement → code review → validate. **v2 (shipped v0.18.0)**: builders (planner, implementers) run as CLI sessions that fork once from a base and resume on each revision round at cache-read price (~10 new tokens per delta), while judges (plan-reviewers, code reviewer, validator) stay clean and fresh every round. A tier router (S/M/L with hot-path override for auth/crypto/env/migrations) scales ceremony to goal size; dependency-map waves parallelize implementation; convergence is by signal (new findings → resume builder; repeated findings → one re-fork → escalate) with a safety valve at 8 rounds, not hard caps.

Both are inspired by the `superpowers` project pattern of behavioral bootstrapping at prompt-time.

## User Stories

- [x] As an agent, I see relevant installed skills surfaced on every substantive prompt, so I invoke them before acting rather than producing skill-blind output.
- [x] As a user, the context gate is silent when no skills match (greetings, off-topic prompts), so the hook does not add noise to routine messages.
- [x] As a user, I can invoke `/goal-skill` to drive a non-trivial goal through a plan→review→implement→validate loop with sub-agents, so complex goals get proper orchestration discipline.
- [x] As an agent orchestrator using goal-skill, I am blocked from abandoning loops early by explicit Red Flags tables, convergence-by-signal enforcement, and TodoWrite commitment ritual.
- [x] As a user, the full skill catalog is always reviewed by the agent (not a pre-selected few), so the agent never misses a relevant skill due to a noisy BM25 pick.
- [x] **[v2]** As a planner or implementer builder, I am resumed on each revision round paying only the delta tokens (~10 new input tokens), not the full context re-read, so plan-review iteration is cheap.
- [x] **[v2]** As a plan-reviewer or validator judge, I am dispatched clean and fresh every round with only the artifact (plan text or diff), never inheriting the builder's framing, so my verdict stays independent.
- [x] **[v2]** As an orchestrator, I scale ceremony via a tier router (S/M/L) based on goal size and domain hot-paths, so small goals don't pay large-goal overhead.

## Acceptance Criteria

**Context gate (v0.5.0+):**
- [x] On UserPromptSubmit (prompt length ≥8, `DREAMCONTEXT_SKILLS_HOOK` not `0`, sleep not in progress), the hook performs a BM25 check over installed non-always-apply skills. If any skill clears the score threshold, a context-gate block is emitted instructing the agent to review the FULL skill list in context and invoke any that fit.
- [x] Skills with `alwaysApply: true` (engineering, design) are excluded from the BM25 gate check — they are already always loaded.
- [x] When no skills are installed, `.claude/skills` is missing, or no skill clears the threshold, the block is silent and all existing hook behavior (sleep-debt, marketing nudge, memory recall) continues unaffected.
- [x] `src/lib/recall.ts` exports `loadSkillDocs(skillsRoot)` that loads `*/SKILL.md` files, reads `name/description/tags` via frontmatter, excludes `alwaysApply: true` skills, and returns them as a corpus for BM25.

**goal-skill v1 (v0.5.0–v0.17.x):**
- [x] `goal-skill` ships as a skill-pack with `SKILL.md` containing: orchestration flowchart (6 phases), commitment ritual (announce + TodoWrite), Red Flags table, rationalization table, and hard rules (orchestrator never writes code; never skip Phase 0; never auto-complete task — `in_review` only).
- [x] 4 agents: `goal-planner` (opus), `goal-plan-reviewer` (dispatched with a lens per-call), `goal-implementer` (sonnet), `goal-validator` (sonnet). Each has `skills:` frontmatter and `## Skills always loaded` body section.
- [x] `skill-packs/catalog.json` updated with `goal-skill` pack entry (`subSkills: []`, `relatedAgents` includes all 4 goal agents + `reviewer`) and 4 agent entries.

**goal-skill v2 (v0.18.0+):**
- [x] Builder sessions: `goal-planner` spawned via `claude -p --output-format json --model <tier-model>`, captures `session_id`, subsequent rounds resume via `--resume <id>` (pays only delta tokens ~10 new input per round).
- [x] Implementers forked from planner: `claude -p --resume <plannerId> --fork-session` mints a new session inheriting planner's full context at cache-read price; original planner session stays independently resumable.
- [x] Session registry: orchestrator writes a literal `## Session registry` block into the task doc's `technical_details` recording `planner: <id>`, `impl-<taskId>: <id>` for each implementer, and `planner-refork: <id>` if a fresh re-fork happened.
- [x] Judges stay clean: `goal-plan-reviewer`, `reviewer`, `goal-validator` dispatched as fresh Claude Code Agent-tool subagents every round, never forked or resumed.
- [x] Tier router: S/M/L tiers (inline, references `multi-review` thresholds) + hot-path override (auth/crypto/env/migrations → L) scales ceremony (S skips review/map; M 1 lens + map if >1 file-owning task; L 2–3 lenses ∥ + full map). Planner uses opus for L, sonnet for M/S.
- [x] Dependency map: Contract 1 columns (`task | files owned | depends on | wave | contract`) in SKILL.md; planner emits it for M/L goals; orchestrator writes it to task doc; implementers honor `files owned` and upstream contracts.
- [x] Wave-parallel implementation: max 3 concurrent implementers per wave; same-file tasks in same lane; build+test gate between waves; single-writer (orchestrator owns task doc + map).
- [x] Convergence by signal: new findings → `--resume` builder; repeated findings → one fresh re-fork from planner → escalate. Safety valve at 8 rounds (spend protection). No hard iteration caps.
- [x] `skill-packs/catalog.json` description and base updated to v2 language (fork/resume, tier router, convergence-by-signal + valve 8).
- [x] `npm run build` clean and `npm test` green with v2 code.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-17] v2 fork/resume mechanics.** Builders (planner + implementers) run as CLI sessions spawned via `claude -p --output-format json`, capturing their `session_id` into a session registry in the task doc. Revision rounds resume the same session via `--resume <id>` — only the delta (new findings) is new tokens, the prior context is served from cache (~10 new input tokens per round, verified live 2026-07-17). Implementers fork from the planner via `--resume <plannerId> --fork-session`, inheriting the planner's full context at cache-read price while the planner stays independently resumable. **Judges never fork or resume** — they stay clean and fresh every round to preserve verdict independence. This mechanic cuts plan-review iteration cost from ~90K full-price tokens/round in v1 to ~10 delta tokens/round in v2. Fork base is the planner CLI session, never the orchestrator's chat (which is not CLI-resumable). Documented in knowledge/patterns/fork-resume-builder-sessions.md.
- **[2026-07-17] v2 convergence by signal + valve 8.** Removed hard iteration caps (the v1 "cap 3, then escalate" phrasing). Loops now iterate on signal: new blocking findings → `--resume` the builder with those findings; repeated SAME findings (the builder is stuck) → one fresh re-fork from planner → if STILL stuck, escalate. Safety valve at 8 rounds (spend protection). Convergence is achieved when the judge's verdict is SOLID (plan-reviewer) or PASS (code reviewer, validator), not by hitting a fixed count. This prevents premature escalation when a plan genuinely needed 4 rounds to converge.
- **[2026-07-17] v2 tier router + hot-path override.** S/M/L tiers scale ceremony to goal size, referencing `multi-review` thresholds (inline). Hot-path override: auth/crypto/env/migrations → L tier (full review + map) regardless of file count, because their defects are disproportionately severe. Planner uses opus for L, sonnet for M/S (orchestrator sets `--model` on spawn). S-tier skips plan review and dep map; M gets 1 lens + map if >1 file-owning task; L gets 2–3 parallel lenses + full map.
- **[2026-07-17] v2 dependency map + wave-parallel implementation.** M/L goals produce a dep-map table (Contract 1: `task | files owned | depends on | wave | contract`) in the plan; orchestrator writes it to the task doc. Implementers are dispatched in waves (max 3 concurrent per wave; same-file tasks go in same lane); build+test gate between waves; a FAIL gate resumes the owning implementer. Orchestrator is the single writer of task doc + map; implementers never edit either. Session registry tracks one `impl-<taskId>: <session_id>` line per implementer.
- **[2026-05-31]** Context gate final design (iteration 4): the hook no longer lists a top-3 BM25-selected skill subset. That arbitrary pre-selection was removed because it anchors the agent on a pre-curated few and risks omitting the right skill. The BM25 check is retained only as a signal detector — if anything matches, emit the gate telling the agent to scan the full catalog itself. This is the correct design: the full skill catalog is already in the agent's context via the harness; the gate's job is to trigger the behavior, not to enumerate.
- **[2026-05-31]** `alwaysApply: true` skills excluded from the BM25 gate check — they are already loaded on every session. Surfacing them in the gate is noise; the gate is for non-always-apply skills that the agent might not realize are relevant.
- **[2026-05-31]** goal-skill reuses the existing `reviewer` agent for Phase 5 code review (not a new `goal-code-reviewer`). The existing `reviewer` is exactly a clean-context PASS/FAIL gate against a git diff — creating a near-duplicate would be YAGNI.
- **[2026-05-31]** No `dreamcontext goal` CLI command. All state transitions map cleanly to existing `tasks create/insert/status/log/complete`. A goal helper would add a parallel concept the snapshot, sleep, and recall systems don't understand.
- **[2026-05-31]** `goal-planner` uses opus model by default (v2: orchestrator sets via `--model` per tier). Cost is real: one goal run spends opus-planner + 2+ plan-reviewers + N implementers + reviewer + validator tokens × iteration count. The SKILL.md warns users to use goal-skill only for non-trivial goals.
- **[2026-05-31]** SKILL.md description follows the "trigger-conditions only" discipline — it states WHEN to invoke, never the 6-phase loop. This prevents the harness from pre-summarizing the skill for the agent and bypassing the full body.

## Technical Details

**Hook integration (`src/cli/commands/hook.ts`)**:
- `SKILL_SCORE_THRESHOLD = 2.0` and `MAX_SKILLS = 5` constants near top of file.
- UserPromptSubmit action: after the memory recall block, a new try/catch block runs the skill gate. `loadSkillDocs(join(cwd, '.claude', 'skills'))` builds the corpus; `bm25Search(prompt, docs, MAX_SKILLS).some(h => h.score >= SKILL_SCORE_THRESHOLD)` sets `gatedSkills = true`.
- Context gate block emitted when `hadRecallHits || gatedSkills`. The skills line within the gate always tells the agent to review the FULL list (regardless of `gatedSkills` — if `DREAMCONTEXT_SKILLS_HOOK` is not `0`).
- Opt-out: `DREAMCONTEXT_SKILLS_HOOK=0` suppresses both the gate BM25 check and the skills directive line.

**Skill corpus loader (`src/lib/recall.ts`)**:
- New `CorpusType = ... | 'skill'` union member.
- `loadSkillDocs(skillsRoot: string): CorpusDoc[]` — scans `<skillsRoot>/*/SKILL.md`, reads frontmatter, excludes `alwaysApply: true`, returns docs with `type: 'skill'` and `slug = frontmatter.name`.
- `'skill'` is NOT in the default `buildCorpus` types. Callers must pass `{ types: ['skill'] }` explicitly, keeping haikuRecall behavior unchanged.

**goal-skill pack (v2 as of v0.18.0)**:
- `skill-packs/goal-skill/SKILL.md` — v2 orchestration skill with: 6-phase flowchart (Phase 0 Ask → Phase 1 PLAN builder → Phase 2 PLAN REVIEW judges → Phase 3 TASK DOC → Phase 4 IMPLEMENT waves → Phase 5 CODE REVIEW judge → Phase 6 VALIDATE judge), two-lane model (builders fork/resume, judges clean/fresh), tier router (S/M/L + hot-path), commitment ritual (announce + TodoWrite), convergence rules (signal-based + valve 8), Red Flags table, hard rules (single writer, builders fork/resume, judges clean, full review once, convergence by signal).
- Builder session mechanics: `claude -p --output-format json` spawn, `--resume <id>` for revisions (~10 delta tokens), `--resume <plannerId> --fork-session` for implementers, session registry block (literal format: `planner: <id>`, `impl-<taskId>: <id>`, `planner-refork: <id | —>`) in task doc's `technical_details`.
- Dependency map: Contract 1 columns (`task | files owned | depends on | wave | contract`) emitted by planner for M/L; orchestrator writes to task doc; implementers honor it; max 3 concurrent per wave; same-file → same lane; build+test gate between waves.
- `skill-packs/agents/goal-planner.md` — v2: documents CLI session mechanics ("Running as a CLI builder session"), `--resume` behavior, xhigh thinking, dep-map emission, session registry citation.
- `skill-packs/agents/goal-plan-reviewer.md` — minimal v2 edit: one sentence stating it's dispatched clean+fresh every round, never inherits planner session, may critic-check dep-map.
- `skill-packs/agents/goal-implementer.md` — v2 role-rebind: "You are NO LONGER the planner", one task/lane only, files-owned discipline, engineering always loaded, `--resume` you for fixes, high thinking, registry citation.
- `skill-packs/agents/goal-validator.md` — no v2 changes (already clean+fresh validator).
- `skill-packs/catalog.json` — v2 description + base updated to mention "CLI builder sessions fork once and resume per round, clean fresh judges, tier router, dependency-map waves, convergence by signal + valve 8".

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-18 - Updated to v2
- Reconciled to v2 as-built architecture (shipped v0.18.0 via task `goal-skill-v2-fork-resume`). Added v2 user stories, acceptance criteria, constraints, and technical details. Updated frontmatter: `updated: '2026-07-18'`, `released_version: v0.18.0`, `related_tasks: [goal-skill-v2-fork-resume]`. v2 changes: fork/resume builder sessions (planner + implementers as CLI sessions, judges clean+fresh), session registry, tier router (S/M/L + hot-path), dependency map + wave-parallel implementation, convergence by signal + valve 8 (removed hard caps). Verified against working tree: `skill-packs/goal-skill/SKILL.md`, `skill-packs/agents/goal-*.md`, `skill-packs/catalog.json`.

### 2026-05-31 - Created
- Feature PRD created from v0.5.0 sessions. All v1 acceptance criteria met and verified by task `goal-skill-and-related-skills-recall` (in_review). Status set to in_review.
