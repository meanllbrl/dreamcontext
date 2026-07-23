---
id: feat_council001
status: active
created: '2026-04-19'
updated: '2026-07-23'
released_version: v0.21.0
tags:
  - 'topic:skills'
  - 'topic:cli'
  - 'topic:agents'
  - decisions
related_tasks:
  - council-v2-the-chamber
type: feature
name: council-skill
description: 'Multi-persona debate orchestrator with structured verdicts, convergence metrics, interactive interludes, live chamber board, and decision-first synthesis. v2 (The Chamber) adds depth routing, persona CLI sessions with fork/resume, and goal-live parity in-app panel.'
pinned: false
date: '2026-04-19'
---

## Why

When facing a non-trivial architectural or strategic decision, a single agent perspective is often insufficient. Council lets the main agent orchestrate a small cast of persona-driven sub-agents that debate the question across multiple rounds, expose each other to each other's reasoning, and produce a synthesized decision report. Inspired by MiroFish (multi-persona simulation), adapted to stay lean: 3-10 agents, file-based IPC, bounded main-agent context.

## User Stories

- [x] As a developer, I want to invoke `/council` on a hard decision so persona sub-agents debate it and produce a final report with traced reasoning
- [x] As a developer, I want trigger phrases ("debate this", "help me decide") to auto-prompt council mode
- [x] As a developer, I want the main agent to generate 3-10 topic-specific personas on the fly with recommended models for cognitive diversity
- [x] As a developer, I want to choose round depth and whether to be interrupted between rounds for my input
- [x] As a persona sub-agent, I want to load my context cheaply each round via `council round-context` so I don't re-read everything
- [x] As a persona sub-agent, I want to do web research and persist findings to `researches/` so later rounds can reuse them
- [x] As a developer, I want the final report written by a dedicated synthesizer sub-agent so my main agent context stays small
- [x] As a developer, I want the debate promoted to knowledge either immediately post-synthesis or automatically by the rem-sleep agent
- [x] As a developer, I want per-round structured verdicts (stance + conviction 0-100 + headline + concession) so the debate state is queryable and computable
- [x] As a developer, I want a terminal chamber board showing convergence %, leading stance, and per-persona shifts so I can track debate evolution at a glance
- [x] As a developer, I want interactive interludes between rounds (inject fact / cross-examine / steelman / wildcard persona / call the vote) so I can steer the debate
- [x] As a developer, I want a live panel above the composer showing round progress, persona states, and convergence in real-time (goal-live parity)
- [x] As a developer, I want depth routing (Quick 1-round / Standard 2-round / Deep 3-round with interludes) matched to decision stakes, with irreversible-decision override
- [x] As a developer, I want persona CLI sessions with fork/resume mechanics so rounds compound without ballooning orchestrator context
- [x] As a developer, I want convergence rules (≥90% two rounds → early vote; <40% after planned rounds → escalate/split) to handle consensus and deadlock gracefully
- [x] As a developer, I want an optional Excalidraw decision board generated from timeline --json when the excalidraw pack is present

## Acceptance Criteria

- [x] `dreamcontext council --help` lists all 20 sub-commands (create, agent, round, round-context, report, summaries, research, synthesize, complete, promote, list, show, verdict, board, timeline, inject, question, live, demo-live, help)
- [x] Debate creates `_dream_context/council/{debate_id}/` with `debate.md`, `round-log.md`, `verdicts.json`, and per-persona subfolders
- [x] All persona sub-agents in a round run in parallel
- [x] `council report append` validates Executive Summary section is present
- [x] Round 2+ injects prior-round peer summaries into each persona's context
- [ ] Main agent context stays under ~20K tokens for 3 rounds x 6 agents (spot-check via transcript — needs dogfood)
- [x] Synthesizer writes `final-report.md` with Verdict, Decision card, Why, Position timeline, What was debated, Minority view & revisit conditions, Open risks, Appendix (report v2)
- [x] `council promote` copies trimmed report to `_dream_context/knowledge/decision-{slug}.md`
- [x] `council list --unpromoted` lists completed debates without knowledge promotion
- [x] rem-sleep agent reviews unpromoted debates during consolidation
- [x] `council verdict` writes structured per-persona verdicts (stance, conviction 0-100, headline, concession) to verdicts.json with PID lockfile serialization (O_EXCL + 2s bounded spin + 10s stale TTL)
- [x] `council board` renders terminal chamber board with convergence %, leading stance, per-persona conviction bars, and shift arrows vs previous round
- [x] `council timeline --json` outputs position-shift history for optional Excalidraw decision board generation
- [x] `_dream_context/tmp/.council-live.json` written automatically at every transition, session-stamped, with round/phase/personas/options/verdicts
- [x] `/api/agent/council-live` route serves live state to in-app panel
- [x] CouncilLivePanel renders above composer (compact strip + portal chamber view on click) with goal-live pattern parity
- [x] CouncilDockBadge shows active debate indicator
- [x] Depth router (Quick/Standard/Deep) with irreversible-decision override documented in skill
- [x] Interactive interlude cards (inject/cross-examine/steelman/wildcard/call-the-vote) implemented via `council inject` and `council question`
- [x] Convergence rules (≥90% → early vote; <40% → escalate/split) documented in skill
- [x] Persona fork/resume mechanics with session registry and re-fork rule documented in skill
- [x] council-synthesizer.md updated with 6 readability rules and report v2 template
- [x] council SKILL.md rewritten at goal-skill-v2 rigor (381 lines, depth router, interludes, persona sessions, convergence rules)

## Constraints & Decisions

### 2026-07-23 — PID lockfile serialization for verdicts.json, not optimistic-merge

Parallel persona sessions writing verdicts.json caused lost-update races. Verdict writes are now serialized via PID lockfile (O_EXCL + 2s bounded spin + 10s stale TTL + finally release). Each persona spins up to 2s in 25ms intervals; locks older than 10s are reclaimed even if the PID looks alive. This is safer than optimistic merge (which could silently lose a verdict) and faster than a mutex server.

### 2026-07-23 — Live state is session-stamped, not global

`_dream_context/tmp/.council-live.json` is stamped with the orchestrator's session ID. The `/api/agent/council-live` route only serves state for the requesting pane's conversation, so two concurrent debates in different panes never see each other's state. This mirrors goal-live's session scoping.

### 2026-07-23 — CouncilLivePanel is a strip + portal, not a viewer page

Goal-live pattern: compact strip above composer (zero footprint when inactive) + click-to-open portal chamber view on document.body (the agent surface's `contain: layout paint` would clip a fixed overlay). No browser viewer page. The chamber view shows per-persona stance chips, conviction bars, shift arrows, headline, and options tally footer.

### 2026-07-23 — Depth router default is Standard, with irreversible-decision override

Quick (1 round, 3 personas, no interludes) for low-stakes reversible decisions. Standard (2 rounds, 4-6 personas, interludes after round 1) is the default for most real decisions. Deep (3 rounds, 5-8 personas, interludes after every round) for high-stakes contested decisions. **Hot override**: irreversible or costly-to-reverse decisions (vendor lock-in, public API contract, migration with no rollback) force Deep regardless of user input.

### 2026-07-23 — Interactive interludes are opt-in, not forced

Between-round interludes (inject fact / cross-examine / steelman swap / wildcard persona / call the vote) are offered but not required. The orchestrator asks once during scope; user can say "no interruptions" and the debate runs hands-off. Autonomous fallback defaults to interludes off.

### 2026-07-23 — Convergence is derived from verdicts, not asserted

Convergence % = (sum of convictions of personas sharing the leading stance) / (sum of all convictions). Leading stance = the stance with highest total conviction. Shift = stance change vs previous round (→ = no change, A→B = shift). All metrics derived from verdicts.json; orchestrator never guesses or overrides.

### 2026-07-23 — Persona sessions fork once, resume thereafter, re-fork once on disengagement

Each persona is spawned as a `claude` CLI session at round 1 with `--permission-mode acceptEdits --allowedTools Bash,Read,WebSearch,WebFetch < /dev/null`. Session ID recorded in debate.md session registry. Rounds 2+ resume that session with delta-only brief. If a persona disengages (repeats verbatim, ignores directives), it gets ONE fresh spawn (recorded as `<slug>-refork`). If the refork also disengages, note it for synthesizer and move on; no loops.

### 2026-07-23 — Report v2 is decision-first, not narrative-first

Final report structure: Verdict (decision card at top), Why (1-2 sentences), Position timeline (who held what stance when), What was debated (key arguments), Minority view & revisit conditions (with observable triggers), Open risks, Appendix (per-agent per-round summaries). Decision is above the fold; narrative supports it. Trimmed promote version omits Appendix.

### 2026-07-23 — Excalidraw decision board is optional, not auto-generated

When the excalidraw pack is present, `council timeline --json` outputs position-shift history for optional Excalidraw decision board generation. Not auto-generated by the CLI; orchestrator or user generates it post-debate if wanted. Documented in skill as optional.

### 2026-04-19 — Sleep agent is a second promotion path, not primary
Two paths: (a) main agent asks post-synthesis, calls `council promote` on yes; (b) rem-sleep agent reviews unpromoted completed debates during consolidation and auto-promotes or flags. Avoids forced synchronous decision and keeps `knowledge/` curated.

### 2026-04-19 — Personas are generated per-topic, not preset
Main agent generates 3-10 personas appropriate to the topic. No shipped persona library. Topic-fit beats reusability for decision-making.

### 2026-04-19 — One generic council-persona.md sub-agent, parameterized via prompt
Not per-archetype files. Persona identity comes from `context-and-persona.md` on disk. The sub-agent file enforces the CLI protocol (round-context -> think -> report append).

### 2026-04-19 — Synthesizer is a separate sub-agent
Main agent never reads full reports. Dedicated synthesizer reads everything, writes `final-report.md`. Protects main context budget.

### 2026-04-19 — Nested folder layout is a deliberate exception to flat convention
`_dream_context/council/{debate_id}/{persona_slug}/` because N personas x M rounds x researches doesn't scale flat. This is the only exception to dreamcontext's flat-file convention.

### 2026-04-19 — final-report.md section format: dynamic parsing required
Real synthesizer output confirms only `## Verdict` and `## Appendix: per-agent per-round summaries` are reliably present. `## Why`, `## Minority views`, `## Open risks` are not always emitted. Any UI or parser that reads final-report.md must extract all `## Sections` dynamically; hardcoding section names causes data loss.

### 2026-04-19 — Council synthesizer 6 readability rules
Added to council-synthesizer.md: (1) sources after bullets/paragraphs, not mid-sentence; (2) 5+ same-source bullets collapse to "Consensus:"; (3) max 1 verbatim quote per section; (4) "Why it X" max 1-2 sentences; (5) meta-narration banned; (6) human prose first, source tag after.

## Technical Details

### Architecture: three strict layers + verdicts substrate

1. **Orchestrator** (main agent): reads summaries via `council summaries`, board via `council board`, timeline via `council timeline`, verdicts via `council verdict --latest`. Never reads full persona reports. Stays light.
2. **Personas** (debaters): CLI sessions (or Agent-tool subagents in fallback mode), isolated per-agent context, write to their own subfolder + verdicts.json. Forked once at round 1, resumed for rounds 2+, re-forked once on disengagement.
3. **Synthesizer** (judge): clean Agent-tool subagent that reads everything via files and CLI output, writes final-report.md. Never forked or resumed; always fresh.
4. **Verdicts substrate**: `verdicts.json` (options array + rounds object mapping round → persona → Verdict). PID-lockfile-serialized writes. Powers convergence/leading/shift metrics, board, timeline, live state.

### Core files

**CLI:** `src/cli/commands/council.ts` (20 sub-commands: create, agent, round, round-context, report, summaries, research, synthesize, complete, promote, list, show, verdict, board, timeline, inject, question, live, demo-live, help).

**Libraries:**
- `src/lib/council.ts` — path helpers, cross-context builder, summary extractor, section validator, verdicts file I/O, PID lockfile (acquire/release), convergence/leading/shift metrics, assertion guards (assertSafeSegment, assertWithinCouncil).
- `src/lib/council-board.ts` — chamber board renderer (pure function over verdicts data, no FS access, unit-testable, plain-mode support).

**Skill + agents:**
- `.claude/skills/council/SKILL.md` (381 lines, v2 rewrite: depth router, two-lane model, persona fork/resume, interludes, convergence rules).
- `.claude/skills/council/debate-protocol.md` (reference doc for personas).
- `.claude/agents/council-persona.md` — debater contract.
- `.claude/agents/council-synthesizer.md` — judge contract + report v2 template + 6 readability rules.

**Types:** Verdict (stance, conviction, headline, concession, at), VerdictOption (key, label), VerdictsFile (options, rounds), RoundVerdicts (persona → Verdict), DebateFrontmatter, PersonaFrontmatter, DebateIndexEntry.

**Reuses:** `src/lib/frontmatter.ts`, `src/lib/markdown.ts`, `src/lib/id.ts`, `src/lib/json-file.ts`.

### Dashboard UI

**Council page (retrospective view):** CouncilHall: searchable card grid of debates (status badge, persona count, round progress). CouncilDetail: full-page view with back button + 3 tabs:

- **Overview**: StatTile row (personas, rounds, timestamp) + full final-report rendered as hero. Dynamic section extraction (reads all `## H2 sections` from final-report.md, does not hardcode section names).
- **Agents**: TranscriptView — persona-centric list with search + inline slug chips that jump to a specific agent. Renders per-persona report rounds with collapsible sections.
- **Matrix**: ArenaMatrix — inline cell expand on click, no sidebar.

Components: `CouncilHall.tsx`, `CouncilDetail.tsx`, `OverviewTab.tsx`, `TranscriptView.tsx`, `ArenaMatrix.tsx`, `PersonaAvatar.tsx`, `StatTile.tsx`, `StatusBadge.tsx`, `ModelBadge.tsx`. CSS: `CouncilPage.css`. Backend: `GET /api/council`, `GET /api/council/:id`, `GET /api/council/:id/:slug`.

**In-app live panel (v2 — goal-live pattern parity):** CouncilLivePanel renders above the composer in the agent surface while a debate is active, session-scoped (only shows for the pane whose conversation is running the orchestrator). Two states:

- **Compact strip** (always rendered when active): council glyph ⚖, truncated topic, round progress dots, phase label, persona dots colored by stance, convergence meter + leading key. Zero footprint when inactive.
- **Chamber view** (click strip): portal popup on document.body with one row per persona — stance chip, 10-cell conviction bar, shift arrow vs previous round, headline — plus options tally footer. Portal required because agent surface's `contain: layout paint` would clip a fixed overlay.

Components: `dashboard/src/components/sleepy/CouncilLivePanel.tsx` + `.css`, `dashboard/src/lib/councilLive.ts` (helpers: councilPhaseLabel, councilStanceColor, councilTally, councilShift, councilElapsedMinutes), `dashboard/src/hooks/useAgentCouncilLive.ts`. Backend: `GET /api/agent/council-live` (session-stamped, returns `{ active, state }` where state has round/rounds/phase/topic/personas/options).

**CouncilDockBadge:** rendered under GoalLivePanel in the agent dock, shows active debate indicator (same session-scoping as live panel).

Design lessons: final report above fold, dense layout, no gamified decoration; live panel mirrors goal-live compact-strip-plus-portal pattern.

## Changelog

### 2026-07-23 — Council v2 ("The Chamber") shipped — structured verdicts, convergence metrics, live panel, interludes, depth router, persona sessions

Complete rewrite to goal-skill-v2 rigor. Council v1 was a flat prose debate with no structured state, no visualization, no interactivity between rounds, and a report that buried the decision. v2 brings:

**Verdict layer + queryable state:** Per-round structured verdicts (stance + conviction 0-100 + headline + concession) written to `verdicts.json` with PID-lockfile serialization (O_EXCL + 2s bounded spin + 10s stale TTL). Derived metrics: convergence % (sum of leading-stance convictions / total), leading stance (highest total conviction), shift (stance change vs previous round). Powers board, timeline, live state.

**CLI expansion:** 7 new subcommands (verdict, board, timeline, inject, question, live clear, demo-live) bring total to 20. `council board` renders terminal chamber board with convergence %, leading stance, per-persona conviction bars (10-cell), shift arrows. `council timeline --json` outputs position-shift history for optional Excalidraw decision board generation. `council inject` and `council question` drive interactive interludes.

**Live state + in-app panel (goal-live parity):** `_dream_context/tmp/.council-live.json` written automatically at every transition, session-stamped. `/api/agent/council-live` route serves state to CouncilLivePanel (compact strip above composer + click-to-open portal chamber view, session-scoped). CouncilDockBadge shows active debate indicator. Zero footprint when inactive.

**Depth router:** Quick (1 round, 3 personas, no interludes), Standard (2 rounds, 4-6 personas, interludes after round 1, DEFAULT), Deep (3 rounds, 5-8 personas, interludes after every round). Hot override: irreversible or costly-to-reverse decisions force Deep.

**Interactive interludes:** Between-round intervention cards (inject fact / cross-examine / steelman swap / wildcard persona / call the vote), opt-in. Orchestrator asks during scope; autonomous fallback defaults to off.

**Persona CLI sessions with fork/resume:** Each persona spawned as `claude` CLI session at round 1 (`--permission-mode acceptEdits --allowedTools Bash,Read,WebSearch,WebFetch < /dev/null`), resumed for rounds 2+ with delta-only brief. Session IDs in debate.md session registry. Re-fork rule: one fresh spawn on disengagement, then note for synthesizer. Fallback mode: Agent-tool subagents in parallel.

**Convergence rules:** ≥90% convergence for two rounds → early vote. <40% after planned rounds → escalate or split verdict. Documented in skill.

**Report v2 (decision-first):** Verdict (decision card at top), Why, Position timeline, What was debated, Minority view & revisit conditions (with observable triggers), Open risks, Appendix. Trimmed promote omits Appendix.

**Skill rewrite:** `.claude/skills/council/SKILL.md` rewritten to 381 lines at goal-skill-v2 rigor (depth router, two-lane model, persona fork/resume mechanics, interludes, convergence rules, red-flags). council-synthesizer.md updated with report v2 template + 6 readability rules.

**Implementation:** 45 new unit tests (council + live), 12 dashboard route tests. Full e2e smoke green (create-with-options, 4 personas, 2 rounds, verdicts+shifts, board, timeline, inject/question directives, live lifecycle). 3-process parallel verdict write smoke confirmed PID lockfile serialization. Task: council-v2-the-chamber (in_review).

### 2026-04-19 — Council UI + Synthesizer readability rules
Council page shipped on dashboard (v3: CouncilHall grid + CouncilDetail). Synthesizer readability rules (6 rules) added to council-synthesizer.md. Dynamic section parsing in OverviewTab confirmed correct approach for final-report.md variability.

### 2026-04-19 — Built and security-reviewed (task: in_review)
All source files created, registered, and smoke-tested end-to-end (create → round × 2 → synthesize → promote). Reviewer returned FAIL with 2 issues, both fixed: (1) path traversal at lookup sites — `assertSafeSegment` + `assertWithinCouncil` guards in `src/lib/council.ts:62-89`; (2) code-fence parsing bug in `parseReportRounds` — fence state tracking prevents `## Round N` inside code blocks from being treated as section boundaries. One acceptance criterion pending real-world context budget verification.

### 2026-04-19 — Scoped and designed
Full spec written to task file `council-skill`. Architecture: 3 layers, 14 CLI sub-commands, nested file layout, 2 new sub-agent files, new skill pack. Implementation starting.
