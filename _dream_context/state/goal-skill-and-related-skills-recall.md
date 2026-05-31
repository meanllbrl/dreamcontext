---
id: task_JS5Rr2n3
name: goal-skill-and-related-skills-recall
description: >-
  Add a Related-skills recall hook line + a goal-skill subagent-driven
  orchestration skill-pack (superpowers-inspired)
priority: high
urgency: high
status: in_review
created_at: '2026-05-31'
updated_at: '2026-05-31'
tags:
  - skills
  - recall
  - hook
  - orchestration
  - sdd
  - superpowers
parent_task: null
related_feature: null
version: v0.5.0
---

## Workflow
<!-- The shape of this task at a glance. One node per acceptance criterion, grouped under milestone subgraphs. Update node classes as work progresses: `:::done` (green), `:::active` (amber), `:::todo` (gray), `:::blocked` (red). Run `dreamcontext tasks doctor` to verify sync. -->

```mermaid
flowchart TD
  subgraph M1 ["Milestone 1 — rename me"]
    A1[First criterion]:::todo
  end

  classDef done fill:#86efac,stroke:#15803d,color:#052e16
  classDef active fill:#fde68a,stroke:#b45309,color:#451a03
  classDef todo fill:#e5e7eb,stroke:#6b7280,color:#111827
  classDef blocked fill:#fecaca,stroke:#b91c1c,color:#450a0a
```

## Why
<!-- What problem does this solve? What breaks if we don't do it? Be concrete — name the user, the friction, the cost. -->

Our SessionStart injects a knowledge snapshot but nothing makes the agent USE the brain or invoke relevant skills before acting. Superpowers proves a behavioral bootstrap + tested orchestration discipline materially improves agent reliability. We adopt two scoped pieces: (1) surface relevant installed skills on every prompt so the agent invokes them before acting; (2) a goal-skill that drives non-trivial goals through plan->review->implement->validate loops with sub-agents.

## User Stories
<!-- As a <role>, I can <action>, so that <outcome>. Tick when demonstrably true in the running system. -->

- [ ] As a [role], I can [action], so that [outcome]

## Acceptance Criteria
<!-- The contract. Each line is testable and gets a node in the Workflow flowchart above. -->

- [ ] First criterion (matches node A1 in Workflow)


D1: On UserPromptSubmit (prompt length >= 8, not a greeting, env DREAMCONTEXT_SKILLS_HOOK != 0, sleep not in progress), the hook emits a '— Related skills —' block listing up to 3 relevant installed skills by their exact Skill-tool name, with the instruction to invoke them via the Skill tool BEFORE acting.

D1: Skills with alwaysApply:true (engineering, design) are EXCLUDED from the Related-skills line (they are always loaded; surfacing them is noise).

D1: When no skills are installed / .claude/skills is missing / no skill clears the score threshold, the block is silent and the hook still exits 0 with all existing behavior (sleep-debt, marketing, memory recall) intact.

D2: A new skill-pack goal-skill (description = triggering conditions only, never a workflow summary) instructs the MAIN agent to orchestrate: Phase0 ask user (confirm goal + choose validation method) -> Phase1 PLAN (goal-planner, opus) -> Phase2 PLAN-REVIEW (2 goal-plan-reviewer lenses in parallel, iterate until SOLID or cap=3 then escalate) -> Phase3 persist validated plan into a dreamcontext task -> Phase4 IMPLEMENT (goal-implementer) -> Phase5 CODE-REVIEW (reuse existing reviewer agent, iterate until PASS or cap=3) -> Phase6 VALIDATE (goal-validator runs the user-chosen method; FAIL routes back to Phase4) until validation PASSES.

D2: goal-skill ships 4 new agents in skill-packs/agents/ (goal-planner opus, goal-plan-reviewer, goal-implementer, goal-validator), each declaring skills: frontmatter + '## Skills always loaded' body, and reuses the existing reviewer agent for code review. catalog.json has a goal-skill packs[] entry with subSkills:[] + base + relatedAgents (incl. reviewer).

D2: SKILL.md contains an orchestration mermaid flowchart, a Red Flags table, a rationalization table, explicit iteration caps with TodoWrite-tracked 'iteration N/cap', and hard rules (orchestrator never writes code; never skip Phase0 validation question; never auto-complete the task — user-only; tell reviewer to run git diff itself).

Validation of THIS build: npm run build (tsup) clean + npm test (vitest) green, including new unit tests for the skill corpus loader and integration tests for the Related-skills hook output; goal-skill installs into a tmp project (.claude/skills/goal-skill/SKILL.md + 4 goal agents + reviewer.md present) and catalog.json parses.
## Constraints & Decisions
<!-- LIFO: newest at top. Capture the why, not just the what. -->





- **[2026-05-31]** Build sequence: A = recall.ts loadSkillDocs + CorpusType + unit tests (pure lib, lowest risk). B = hook.ts Related-skills block + integration tests (completes D1). C = goal-skill SKILL.md + 4 agents + catalog.json + install assertion (completes D2). D = install goal-skill into dev repo (npx dreamcontext install-skill --packs goal-skill) + manual smoke run. Verify build+test green after each of A/B/C.
- **[2026-05-31]** Decisions pending user confirmation (recorded, not blocking): iteration cap = 3 per loop; SKILL_SCORE_THRESHOLD = 1.0; plan-reviewer parallel lenses default = 2; goal-planner stays opus per explicit user request despite cost.
- **[2026-05-31]** Skill name is goal-skill (NOT goal) to avoid colliding with the built-in /goal harness command. Invoked via description trigger phrases (no .claude/commands or settings.json wiring needed — confirmed council/multi-review work the same way).
- **[2026-05-31]** YAGNI / out of scope (deferred follow-ups, do NOT build now): standalone writing-skills meta-skill; brainstorming skill; full description audit of all existing packs; CLAUDE.md AI-contributor guardrails; cross-platform tool-mapping & Codex .agents/skills scanning; user-level ~/.claude/skills scanning (v1 is project-only, anchored at process.cwd()); a dreamcontext goal CLI command (existing task system suffices); programmatic loop-iteration enforcement (prose + TodoWrite only for v1); Playwright validation (no playwright in repo; goal-validator has no browser tools — v1 validation = unit/integration tests + build + manual checklist).
## Technical Details
<!-- Where the work lives. Files, services, key functions to reuse. Body is current truth — update in place; don't append. -->

(Key files, services, dependencies, implementation approach.)


D1 / src/lib/recall.ts — Add 'skill' to CorpusType union (the docs returned by the loader carry type:'skill'). Add exported loadSkillDocs(skillsRoot: string): CorpusDoc[] using fg.sync('*/SKILL.md',{cwd:skillsRoot,absolute:true}) (NOT *.md; only top-level pack SKILL.md, not nested sub-skills). Per file: readFrontmatter; skip if data.alwaysApply===true; slug = data.name (fallback dir basename); description = data.description ?? first body line; tags = data.tags ?? []; body tokenized for BM25; relPath relative to skillsRoot. Wrap per-file in try/catch. DO NOT add a 'skill' branch to buildCorpus — keep buildCorpus scoped to contextRoot so haikuRecall is byte-for-byte unchanged.

D1 / src/cli/commands/hook.ts (user-prompt-submit action) — After the memory-recall block, in its OWN try/catch (must never break the hook): gate on prompt.trim().length>=8 and process.env.DREAMCONTEXT_SKILLS_HOOK!=='0'. projectRoot = process.cwd() (matches install-skill.ts:241; the hook runs from project root). skillsRoot = join(projectRoot,'.claude','skills'); if !existsSync -> silent. const docs = loadSkillDocs(skillsRoot); const hits = bm25Search(prompt, docs, 3).filter(h=>h.score>=SKILL_SCORE_THRESHOLD). SKILL_SCORE_THRESHOLD=1.0 (lower than memory's 2.0; safe because alwaysApply noise is filtered and the corpus is tiny). If 0 hits -> silent. Else console.log a '— Related skills (top N) —' block: 'Invoke these via the Skill tool BEFORE acting if they fit the task:' then '  • <slug> — <desc≤120 chars>'. Note in a comment: the sleep_started_at early-return (hook.ts ~579-584) intentionally suppresses this block during consolidation sessions.

D2 / files — CREATE skill-packs/goal-skill/SKILL.md and skill-packs/agents/goal-{planner,plan-reviewer,implementer,validator}.md. EDIT skill-packs/catalog.json: add packs[] entry {name:'goal-skill', description (triggers only), tags, alwaysApply:false, base:'<one-paragraph>', subSkills:[], relatedAgents:['goal-planner','goal-plan-reviewer','goal-implementer','goal-validator','reviewer'], crossPackDeps:['engineering']} AND add the 4 agents to the top-level agents[] array ({name, file:'agents/goal-*.md', pack:'goal-skill', description, tags, model}); reviewer already exists in agents[] — do not duplicate. subSkills:[] and base are MANDATORY or installPackFiles throws at the subSkills iteration.

D2 / agent roster — goal-planner: model opus (per user), tools Read/Glob/Grep/Bash (read-only), skills [engineering,dreamcontext]; produces file-by-file plan, never writes code/task doc, 'a plan that says "update the relevant files" is REJECTED'. goal-plan-reviewer: model sonnet, read-only tools, lens passed per-dispatch (default lenses: pragmatist + critic; security conditional), returns SOLID|NEEDS_WORK + blocking findings, no rubber-stamp / no invented problems. goal-implementer: model sonnet (opus on hard goals), tools Read/Glob/Grep/Bash/Write/Edit + load domain skill the task references, implement ONLY acceptance criteria, STOP+report if plan is wrong, dreamcontext tasks log progress. goal-validator: model sonnet, tools Read/Glob/Grep/Bash (no Write), runs the actual chosen validation, flaky/skipped=FAIL, evidence (command+output) required. Code-review gate reuses reviewer (Phase5) — orchestrator tells it to run git diff <base> itself, NOT pass a raw diff.

D2 / task lifecycle (existing CLI only, no new command): Phase3 dreamcontext tasks create <slug> + tasks insert acceptance_criteria/technical_details/constraints (include 'Validation method: <user choice>'); de-collide slug if it exists (check-before-create, suffix if needed); status todo. Phase4 start: tasks status <slug> in_progress. progress: tasks log. fail loop: tasks log 'review/validation FAIL: <reason>; re-implementing' (stay in_progress). pass: tasks status <slug> in_review. complete is USER-ONLY (orchestrator asks, never auto-completes).

Tests — CREATE tests/unit/recall-skill-corpus.test.ts (tmpdir+fs; loadSkillDocs loads SKILL.md w/ type/slug/desc/tags; alwaysApply:true skipped; missing dir->[]; malformed->skip; bm25 ranks relevant skill above unrelated; multi-level nested SKILL.md ignored). EDIT tests/integration/hook.test.ts: add env?:NodeJS.ProcessEnv param to runWithStdin (execSync env); cases: 'review this PR with the team' -> Related skills + multi-review + invoke instruction; unrelated/below-threshold -> no line; no .claude/skills -> no line + exit 0 + existing recall/sleep assertions intact; greeting <8 chars -> no line; DREAMCONTEXT_SKILLS_HOOK=0 -> suppressed. Install integration: install --packs goal-skill into tmp -> assert .claude/skills/goal-skill/SKILL.md + 4 goal agents + reviewer.md exist + catalog.json parses + relatedAgents resolve.
## Notes
<!-- Loose ends, edge cases, open questions. -->

(Working notes, edge cases, open questions.)


Plan was produced by an opus plan agent and reviewed by 3 parallel reviewers (correctness / pragmatism-YAGNI / risk-edge-cases), all NEEDS_WORK on first pass; findings consolidated into the technical_details above (converged on: alwaysApply exclusion mandatory; use process.cwd() not dirname(contextRoot); don't route skills through buildCorpus; catalog subSkills:[]+base required; runWithStdin needs env param; loop cost controls). This task itself was built by dogfooding the goal-skill loop.
## Changelog
<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->




### 2026-05-31 - Status → in_review
- all acceptance criteria met; validation passed via unit+integration tests + build + install check
### 2026-05-31 - Session Update
- VALIDATION PASS. Build clean (tsup). New tests green: 7 unit (recall-skill-corpus) + 6 integration (user-prompt-submit Related-skills incl. alwaysApply-filter, no-skills, <8char, env-off). Reviewer agent returned PASS on the diff. Install verified: goal-skill -> .claude/skills + 4 goal agents + reviewer land in a tmp project. 3 repo test failures (session-start snapshot summary/tool_count, subagent-start pinned knowledge) confirmed PRE-EXISTING at HEAD via stash+rebuild — zero new failures from this work.
### 2026-05-31 - Status → in_progress
- plan validated by 3 reviewers; beginning implementation increment A
### 2026-05-31 - Created
- Task created.
