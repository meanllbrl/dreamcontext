---
id: feat_rL12JiTu
status: active
created: '2026-05-31'
updated: '2026-06-21'
released_version: v0.8.7
tags:
  - skills
  - cli
  - sub-agents
  - hook
  - orchestration
related_tasks:
  - goal-skill-and-related-skills-recall
---

## Why

Agents starting sessions from the snapshot had knowledge injected but no behavioral bootstrap to USE that brain or invoke relevant skills before acting. Two mitigations shipped in v0.5.0:

1. **Context gate** (UserPromptSubmit hook): detects whether any installed non-always-apply skill is plausibly relevant to the user's prompt via a deterministic BM25 pass. If so, injects a behavioral directive telling the agent to review the full available skill list and invoke whatever fits — explicitly NOT a top-N pre-selection, which would anchor the agent on a pre-curated subset and risk omitting the right skill.

2. **goal-skill pack**: a new skill-pack that turns the main agent into an orchestrator running a disciplined 6-phase loop: ask user for validation method → plan → parallel plan review → persist as dreamcontext task → implement → code review → validate. Each gate has a hard iteration cap (3) with escalate-to-user on cap, preventing loop abandonment.

Both are inspired by the `superpowers` project pattern of behavioral bootstrapping at prompt-time.

## User Stories

- [x] As an agent, I see relevant installed skills surfaced on every substantive prompt, so I invoke them before acting rather than producing skill-blind output.
- [x] As a user, the context gate is silent when no skills match (greetings, off-topic prompts), so the hook does not add noise to routine messages.
- [x] As a user, I can invoke `/goal-skill` to drive a non-trivial goal through a plan→review→implement→validate loop with sub-agents, so complex goals get proper orchestration discipline.
- [x] As an agent orchestrator using goal-skill, I am blocked from abandoning loops early by explicit Red Flags tables, iteration-cap enforcement, and TodoWrite commitment ritual.
- [x] As a user, the full skill catalog is always reviewed by the agent (not a pre-selected few), so the agent never misses a relevant skill due to a noisy BM25 pick.

## Acceptance Criteria

- [x] On UserPromptSubmit (prompt length ≥8, `DREAMCONTEXT_SKILLS_HOOK` not `0`, sleep not in progress), the hook performs a BM25 check over installed non-always-apply skills. If any skill clears the score threshold, a context-gate block is emitted instructing the agent to review the FULL skill list in context and invoke any that fit.
- [x] Skills with `alwaysApply: true` (engineering, design) are excluded from the BM25 gate check — they are already always loaded.
- [x] When no skills are installed, `.claude/skills` is missing, or no skill clears the threshold, the block is silent and all existing hook behavior (sleep-debt, marketing nudge, memory recall) continues unaffected.
- [x] `src/lib/recall.ts` exports `loadSkillDocs(skillsRoot)` that loads `*/SKILL.md` files, reads `name/description/tags` via frontmatter, excludes `alwaysApply: true` skills, and returns them as a corpus for BM25.
- [x] `goal-skill` ships as a new skill-pack with `SKILL.md` containing: orchestration flowchart (6 phases), commitment ritual (announce + TodoWrite), Red Flags table, rationalization table, iteration caps (3 per loop), and hard rules (orchestrator never writes code; never skip Phase 0; never auto-complete task — `in_review` only).
- [x] 4 new agents: `goal-planner` (opus), `goal-plan-reviewer` (dispatched with a lens per-call), `goal-implementer` (sonnet), `goal-validator` (sonnet). Each has `skills:` frontmatter and `## Skills always loaded` body section.
- [x] `skill-packs/catalog.json` updated with `goal-skill` pack entry (`subSkills: []`, `relatedAgents` includes all 4 goal agents + `reviewer`) and 4 agent entries.
- [x] `npm run build` clean and `npm test` green with the new code.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-05-31]** Context gate final design (iteration 4): the hook no longer lists a top-3 BM25-selected skill subset. That arbitrary pre-selection was removed because it anchors the agent on a pre-curated few and risks omitting the right skill. The BM25 check is retained only as a signal detector — if anything matches, emit the gate telling the agent to scan the full catalog itself. This is the correct design: the full skill catalog is already in the agent's context via the harness; the gate's job is to trigger the behavior, not to enumerate.
- **[2026-05-31]** `alwaysApply: true` skills excluded from the BM25 gate check — they are already loaded on every session. Surfacing them in the gate is noise; the gate is for non-always-apply skills that the agent might not realize are relevant.
- **[2026-05-31]** goal-skill reuses the existing `reviewer` agent for Phase 5 code review (not a new `goal-code-reviewer`). The existing `reviewer` is exactly a clean-context PASS/FAIL gate against a git diff — creating a near-duplicate would be YAGNI.
- **[2026-05-31]** No `dreamcontext goal` CLI command. All state transitions map cleanly to existing `tasks create/insert/status/log/complete`. A goal helper would add a parallel concept the snapshot, sleep, and recall systems don't understand.
- **[2026-05-31]** `goal-planner` uses opus model by default. `goal-implementer` uses sonnet (orchestrator may escalate to opus for genuinely hard goals by overriding in the dispatch prompt). Cost is real: one goal run spends opus-planner + 2 plan-reviewers + implementer + reviewer + validator tokens × iteration count. The SKILL.md warns users to use goal-skill only for non-trivial goals.
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

**goal-skill pack**:
- `skill-packs/goal-skill/SKILL.md` — orchestration skill with the 6-phase flowchart, commitment ritual, Red Flags table, hard rules.
- `skill-packs/agents/goal-planner.md`, `goal-plan-reviewer.md`, `goal-implementer.md`, `goal-validator.md`.
- `skill-packs/catalog.json` — new `packs[]` entry and 4 `agents[]` entries.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-05-31 - Created
- Feature PRD created from v0.5.0 sessions. All acceptance criteria met and verified by task `goal-skill-and-related-skills-recall` (in_review). Status set to in_review.
