---
id: "feat_council001"
status: "in_review"
created: "2026-04-19"
updated: "2026-04-19"
released_version: null
tags: ["skills", "cli", "sub-agents", "decision-making"]
related_tasks: ["council-skill"]
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

## Acceptance Criteria

- [x] `dreamcontext council --help` lists all 14 sub-commands
- [x] Debate creates `_dream_context/council/{debate_id}/` with `debate.md`, `round-log.md`, and per-persona subfolders
- [x] All persona sub-agents in a round run in parallel
- [x] `council report append` validates Executive Summary section is present
- [x] Round 2+ injects prior-round peer summaries into each persona's context
- [ ] Main agent context stays under ~20K tokens for 3 rounds x 6 agents (spot-check via transcript — needs dogfood)
- [x] Synthesizer writes `final-report.md` with Verdict, Why, Minority views, Open risks, Appendix
- [x] `council promote` copies trimmed report to `_dream_context/knowledge/decision-{slug}.md`
- [x] `council list --unpromoted` lists completed debates without knowledge promotion
- [x] rem-sleep agent reviews unpromoted debates during consolidation

## Constraints & Decisions

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

Three strict layers: orchestrator (main agent, reads summaries only via `council summaries`), persona sub-agents (debaters, isolated per-agent context), synthesizer sub-agent (runs at end, reads everything, writes final-report.md).

New files: `src/cli/commands/council.ts` (14 sub-commands), `src/lib/council.ts` (path helpers, cross-context builder, summary extractor, section validator), 4 markdown templates, `skill-packs/council/SKILL.md`, `skill-packs/council/debate-protocol.md`, `skill-packs/agents/council-persona.md`, `skill-packs/agents/council-synthesizer.md`.

Reuses: `src/lib/frontmatter.ts`, `src/lib/markdown.ts`, `src/lib/id.ts`, `src/lib/json-file.ts`.

### Dashboard UI (Council page)

CouncilHall: searchable card grid of debates (status badge, persona count, round progress). CouncilDetail: full-page view with back button + 3 tabs:

- **Overview**: StatTile row (personas, rounds, timestamp) + full final-report rendered as hero. Dynamic section extraction (reads all `## H2 sections` from final-report.md, does not hardcode section names).
- **Agents**: TranscriptView — persona-centric list with search + inline slug chips that jump to a specific agent. Renders per-persona report rounds with collapsible sections.
- **Matrix**: ArenaMatrix — inline cell expand on click, no sidebar.

Components: `CouncilHall.tsx`, `CouncilDetail.tsx`, `OverviewTab.tsx`, `TranscriptView.tsx`, `ArenaMatrix.tsx`, `PersonaAvatar.tsx`, `StatTile.tsx`, `StatusBadge.tsx`, `ModelBadge.tsx`. CSS: `CouncilPage.css`. Backend: `GET /api/council`, `GET /api/council/:id`, `GET /api/council/:id/:slug`.

Design lessons from 3 iterations: final report must be above fold (it's the payload), layout must be dense not spacious, no medals/particles/gamified decoration.

## Changelog

### 2026-04-19 — Council UI + Synthesizer readability rules
Council page shipped on dashboard (v3: CouncilHall grid + CouncilDetail). Synthesizer readability rules (6 rules) added to council-synthesizer.md. Dynamic section parsing in OverviewTab confirmed correct approach for final-report.md variability.

### 2026-04-19 — Built and security-reviewed (task: in_review)
All source files created, registered, and smoke-tested end-to-end (create → round × 2 → synthesize → promote). Reviewer returned FAIL with 2 issues, both fixed: (1) path traversal at lookup sites — `assertSafeSegment` + `assertWithinCouncil` guards in `src/lib/council.ts:62-89`; (2) code-fence parsing bug in `parseReportRounds` — fence state tracking prevents `## Round N` inside code blocks from being treated as section boundaries. One acceptance criterion pending real-world context budget verification.

### 2026-04-19 — Scoped and designed
Full spec written to task file `council-skill`. Architecture: 3 layers, 14 CLI sub-commands, nested file layout, 2 new sub-agent files, new skill pack. Implementation starting.
