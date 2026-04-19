---
id: task_boSrCvBt
name: council-skill
description: >-
  Structured multi-agent debate skill for decisions: orchestrator + persona
  sub-agents + synthesizer, file-based IPC
priority: high
urgency: medium
status: in_review
created_at: '2026-04-19'
updated_at: '2026-04-19'
tags:
  - skill
  - council
  - sub-agents
  - cli
  - debate
  - decision-making
parent_task: null
related_feature: council-skill
version: v0.2.0
---

## Why

dreamcontext already ships sub-agents for narrow jobs (initializer, rem-sleep, explore). This task adds a *decision-making* capability: when facing a non-trivial choice, the main agent orchestrates a small cast of persona-driven sub-agents that debate the question across multiple rounds, expose each other to each other's reasoning, and produce a synthesized decision report.

Inspiration: MiroFish (multi-persona simulation with per-agent persistent memory + separate report agent). We adopt the pattern but keep it lean — 3–10 agents (not thousands), file-based IPC, and strictly bounded main-agent context.

**Core constraint**: the main agent must stay light. It orchestrates only — never reads full sub-agent output, only executive summaries. Sub-agents build their own per-persona context on disk via dreamcontext CLI, so rounds compound without ballooning the main context.

## User Stories

- [ ] As a developer, I want to invoke `/council` on a hard decision so a cast of persona sub-agents debate it and produce a decision report with traced Whys.
- [ ] As a developer, I want trigger phrases ("debate this", "help me decide") to auto-prompt the main agent to offer council mode.
- [ ] As a developer, I want the main agent to generate 3–10 topic-specific personas on the fly (not a fixed library) with recommended models for cognitive diversity.
- [ ] As a developer, I want to choose round depth and whether to be interrupted between rounds for my input.
- [ ] As a persona sub-agent, I want to load my own context cheaply each round via one CLI call (`council round-context`) so I don't re-read everything.
- [ ] As a persona sub-agent, I want to do web research and persist findings to `researches/` so later rounds can reuse them without re-searching.
- [ ] As a developer, I want the final report to be written by a dedicated synthesizer sub-agent (not the main agent) so the main agent's context stays small.
- [ ] As a developer, I want the main agent to ask post-synthesis if the decision should be promoted to knowledge, OR the rem-sleep agent to auto-promote based on my engagement signals — not a manual `dreamcontext knowledge create`.

## Acceptance Criteria

- `npm run build` succeeds; `dreamcontext council --help` lists all sub-commands.
- `/council` slash command triggers the flow; SKILL.md also triggers on phrases like "debate this", "help me decide", "run this by council".
- A debate creates `_dream_context/council/{debate_id}/` with `debate.md`, `round-log.md`, and one subfolder per persona containing `context-and-persona.md` and `report.md`.
- All persona sub-agents in a round run in parallel (single message, N Agent tool calls, varied models).
- Each persona's `report.md` has required sections; `council report append` rejects reports missing an Executive Summary.
- On round N≥2, `council round start` injects prior-round peer summaries into each persona's `context-and-persona.md` under a new "Round N — Cross-context loaded" section.
- Main agent's per-debate context stays under ~20K tokens end-to-end (summaries only) even with 3 rounds × 6 agents — verified via transcript spot-check.
- Synthesizer agent reads every report + persona file and writes `final-report.md` with sections: Verdict, Why (with traced reasoning), What was debated (ideas, pushback, position shifts), Minority views, Open risks, Appendix.
- Post-synthesis, main agent prompts "Promote to knowledge? (y/n/later)". On `y` → `council promote` copies trimmed report to `_dream_context/knowledge/decision-{slug}.md` and writes `promoted_to_knowledge` pointer into `debate.md`.
- rem-sleep agent surfaces unpromoted completed debates via `council list --unpromoted` and either auto-promotes (if user engaged positively with outcome) or flags for review.
- Failure modes handled: `round start` is idempotent; missing Executive Summary rejected; research tool unavailable is a soft-fail (agent continues without researches/).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-04-19 — Sleep agent is a second promotion path, not primary

User does not want manual `dreamcontext knowledge create`. Two paths: (a) main agent asks right after synthesis, calls `council promote` on yes; (b) rem-sleep agent reviews unpromoted completed debates during consolidation and auto-promotes based on user engagement signals, or flags for review. Keeps `knowledge/` curated without forcing a synchronous decision.

### 2026-04-19 — Personas are generated, not preset

Main agent generates 3–10 personas per topic. Agent count varies with topic complexity (agent decides, not hard-coded). No persona library shipped. Rationale: topic-fit > reusability for decisions.

### 2026-04-19 — Model diversity per persona

Different personas can use `opus` / `sonnet` / `haiku` for genuine cognitive diversity. Claude Code's Agent tool supports `model:` param per dispatch.

### 2026-04-19 — Researches enabled in v1

Sub-agents have WebFetch/WebSearch and persist findings via `council research add`. Soft-fail if tools unavailable.

### 2026-04-19 — Deliberate break from flat folder convention

dreamcontext standard is flat files under `_dream_context/{core,knowledge,state}/`. Council uses nested `_dream_context/council/{debate_id}/{persona_slug}/` because each debate has N personas × M rounds × researches — flat naming doesn't scale.

### 2026-04-19 — Separate synthesizer sub-agent, not main-agent synthesis

Main agent never reads full reports (only summaries). Dedicated synthesizer agent reads everything and writes `final-report.md`. Protects main context budget.

### 2026-04-19 — One generic `council-persona.md` sub-agent file, parameterized via prompt

Not one file per persona archetype. The sub-agent file enforces the CLI protocol (round-context → think → report append). Persona identity comes from `context-and-persona.md` on disk, loaded via `round-context`.

## Technical Details

### Architecture (three strict layers)

1. **Main agent (orchestrator)** — reads only executive summaries; calls CLI to create/advance debate; dispatches sub-agents; relays user interruptions.
2. **Persona sub-agents (debaters)** — isolated context per-agent; `round-context` loads their persona + peer cross-context; can use WebFetch/WebSearch and persist via `research add`; write `report.md` with required sections.
3. **Synthesizer sub-agent (reporter)** — runs at the end; reads every report + persona file; writes `final-report.md`.

### File layout (new, nested)

```
_dream_context/council/
├── index.json                               # list of all debates (id, topic, status, created_at)
└── {debate_id}/                             # e.g. council_aB3xZ9
    ├── debate.md                            # topic, rounds config, persona roster, status
    ├── round-log.md                         # append-only round timeline (main agent)
    ├── final-report.md                      # written by synthesizer at end
    └── {persona_slug}/                      # e.g. migration-risk-auditor
        ├── context-and-persona.md           # name, aspects, model, body — grows incrementally
        ├── report.md                        # executive-summary + full reasoning (per round, LIFO)
        └── researches/                      # optional, created on demand
            ├── index.json
            └── {topic_slug}.md
```

### File formats

**`debate.md`** frontmatter: `id`, `topic`, `status` (created | round_N_running | round_N_complete | synthesizing | complete), `rounds_planned`, `current_round`, `interrupt_between_rounds`, `personas: []`, `promoted_to_knowledge`, `created_at`, `updated_at`. Sections: `## Question`, `## Constraints & Known Facts`.

**`context-and-persona.md`** frontmatter: `name`, `model`, `aspects: []`, `round_entries`. Sections: `## Persona` (initial), `## Round N — Cross-context loaded` (appended each round ≥2).

**`report.md`** frontmatter: `persona`, `rounds_completed`. Per-round section (LIFO): `## Round N — YYYY-MM-DD` with required subsections `### Executive Summary` (≤150 words), `### Position`, `### Reasoning`, `### Reactions to peers`, `### Open questions`.

**`final-report.md`** sections: `Verdict`, `Why (with traced reasoning)`, `What was debated (ideas, pushback, position shifts)`, `Minority views`, `Open risks`, `Appendix: per-agent per-round summaries`.

### CLI commands (new: `src/cli/commands/council.ts`)

| Command | Caller | Purpose |
|---|---|---|
| `council create <topic> --rounds N --interrupt` | main agent | create debate folder + `debate.md` + append to `council/index.json`; prints `debate_id` |
| `council agent create <debate_id> <persona_slug> --model <m> --aspects <a,b,c>` | main agent | create persona folder, write `context-and-persona.md` from stdin body |
| `council round start <debate_id> <N>` | main agent | update status, append to `round-log.md`, inject cross-context into each persona (for N≥2); idempotent |
| `council round-context <debate_id> <persona_slug>` | **sub-agent** | print persona body + peer cross-summaries — first call each round |
| `council report append <debate_id> <persona_slug>` | sub-agent | append round entry to `report.md` from stdin; **validates Executive Summary section present** |
| `council round end <debate_id> <N>` | main agent | validate all personas submitted round N; update status |
| `council summaries <debate_id> <N>` | main agent | print ONLY executive summaries across personas — what main agent reads |
| `council research add <debate_id> <persona_slug> <topic>` | sub-agent | write note to `researches/` + update index |
| `council research list <debate_id> <persona_slug>` | sub-agent | list this agent's prior researches |
| `council synthesize <debate_id>` | main agent | status=synthesizing; print manifest of files synthesizer should read |
| `council complete <debate_id>` | main agent | status=complete after `final-report.md` written |
| `council promote <debate_id>` | main agent / sleep agent | copy trimmed final-report (verdict + Whys + minority views, skip appendix) into `_dream_context/knowledge/decision-{slug}.md`; write pointer into `debate.md` |
| `council list --unpromoted` | sleep agent | list completed debates with `promoted_to_knowledge: null` |
| `council list` / `council show <debate_id>` | inspection | — |

### Skill + sub-agent files

- **`skill-packs/council/SKILL.md`** — new pack. `alwaysApply: false`. Trigger words: "debate this", "get second opinions", "help me decide", "run this by council", "council mode". Documents the protocol and CLI call sequence. Explicit invocation: `/council`.
- **`skill-packs/council/debate-protocol.md`** — sub-skill, detailed round protocol reference.
- **`skill-packs/agents/council-persona.md`** — single reusable sub-agent file; persona details passed via prompt. System prompt enforces: first call is `round-context`, last call is `report append`, executive summary is mandatory. Can use WebFetch/WebSearch + `research add` between.
- **`skill-packs/agents/council-synthesizer.md`** — reads every `report.md` + persona file; writes `final-report.md`. Runs with `opus`.
- **`skill-packs/catalog.json`** — register new pack + two agents (`pack: "council"`).

### Round protocol

**Round 1:** `council create` → main generates personas → `council agent create` per persona → `council round start {id} 1` → dispatch N parallel sub-agents → each: `round-context` → think (optional `research add`) → `report append` → `council round end` → `council summaries` shown to user → (optional interrupt for user input appended to `debate.md`).

**Round N+1:** same, but `round start` injects prior-round peer summaries into each persona's `context-and-persona.md`. Sub-agents instructed to react, push back, update position.

**Synthesis:** `council synthesize` → dispatch synthesizer → synthesizer reads full reports → writes `final-report.md` → main calls `council complete` → reports to user.

**Promotion:** main agent asks "Promote to knowledge? (y/n/later)". On yes → `council promote`. Otherwise rem-sleep agent picks it up later via `council list --unpromoted` and decides based on engagement signals.

### Files to create

- `src/cli/commands/council.ts` — all sub-commands
- `src/lib/council.ts` — path helpers, cross-context builder, summary extractor, section validator
- `src/templates/council-debate.md`, `council-persona.md`, `council-report.md`, `council-final-report.md`
- `skill-packs/council/SKILL.md`
- `skill-packs/council/debate-protocol.md`
- `skill-packs/agents/council-persona.md`
- `skill-packs/agents/council-synthesizer.md`

### Files to modify

- `src/cli/index.ts` — register `registerCouncilCommand(program)`
- `skill-packs/catalog.json` — add `council` pack + two agents
- rem-sleep agent definition — teach it `council list --unpromoted` + promotion heuristics

### Reuse (do not duplicate)

- `src/lib/frontmatter.ts` — `readFrontmatter`, `writeFrontmatter`, `updateFrontmatterFields`
- `src/lib/markdown.ts` — `readSection`, `insertToSection`
- `src/lib/id.ts` — `generateId('council')`, `slugify`, `today`
- `src/lib/json-file.ts` — for `index.json` + `researches/index.json`

### Non-goals (v1)

- No cross-debate learning — each debate is standalone; synthesizer reads only within one `{debate_id}/`.
- No UI / dashboard — CLI + markdown only.
- No preset persona library.
- No automatic manual knowledge promotion — see Decisions above.

### Verification

1. Build succeeds; `dreamcontext council --help` lists all sub-commands.
2. Dogfood end-to-end on a real decision in this repo. Confirm: personas created under `_dream_context/council/{id}/`, parallel round execution, each persona's `report.md` has Executive Summary, main agent context stays small, interrupt prompt appears, round 2 agents reference peers' R1 positions, synthesizer writes `final-report.md` with traced Whys.
3. Failure modes: missing Executive Summary rejected; `round start` idempotent; research tool unavailable is soft-fail; user cancels mid-round and state is recoverable.
4. Context budget: <~20K main-agent tokens for 3 rounds × 6 agents.

## Notes

### Open questions to resolve during implementation

- Cross-context injection: should peer summaries be inlined into `context-and-persona.md` (larger file, one read) or kept in a separate `round-{N}-context.md` that `round-context` concatenates? Leaning toward inline for fewer IO ops and easier inspection.
- Research tool permission scope: does each persona sub-agent inherit main-agent WebFetch/WebSearch permissions, or does the council SKILL.md declare them explicitly? Likely declare explicitly to avoid surprise.
- Executive Summary word-count enforcement: CLI soft-warns or hard-rejects at >150 words? Leaning soft-warn (truncating a sub-agent's output would be worse than the overage).
- Idempotency of `agent create`: if the main agent re-runs with same slug, overwrite or error? Probably error by default, `--force` to overwrite.
- Sleep engagement signals: what specifically counts as "user engaged positively"? Needs a concrete rubric in the rem-sleep agent definition (e.g. referenced the debate by id, cited the verdict in later work, explicit thumbs-up).

### Related

- Inspiration: https://github.com/666ghj/MiroFish (multi-persona simulation; we take personas + per-agent memory + report agent pattern, discard the thousand-agent social sim).
- Plan file: `/Users/mehmetnuraydin/.claude/plans/read-that-https-github-com-666ghj-mirofi-mutable-umbrella.md`.

## Changelog
<!-- LIFO: newest entry at top -->






### 2026-04-19 - Session Update
- Council synthesizer readability rules: 6 rules added to council-synthesizer.md and council-final-report.md template. Rules: sources go inline after bullets/paragraphs (not mid-sentence), consensus lines collapse 5+ same-source bullets, max 1 verbatim quote per section, 'Why it X' max 1-2 sentences, meta-narration banned (Surfaced by/Echoed by/Synthesizer call patterns), human prose first then source tags. Enforces final-report.md readability on real council output.
### 2026-04-19 - Session Update
- Build complete: all files created (src/cli/commands/council.ts 14 sub-commands, src/lib/council.ts helpers + validators + report parser, 4 templates, skill-packs/council/SKILL.md + debate-protocol.md, skill-packs/agents/council-persona.md + council-synthesizer.md). Registered in src/cli/index.ts + catalog.json. Reviewer returned FAIL — 2 issues fixed: (1) Critical path traversal: assertSafeSegment + assertWithinCouncil guards added to src/lib/council.ts:62-89, synthesize validates persona paths; (2) Major parsing bug: parseReportRounds now tracks triple-backtick fence state so ## Round N inside code blocks is not treated as a section boundary (src/lib/council.ts:200-213). Both fixes smoke-verified end-to-end. Task moved to in_review. User confirmed install-skill --packs council copies all 4 files to .claude/.
### 2026-04-19 - Session Update
- Moved to in_review. Reviewer agent returned FAIL with 2 issues (1 Critical: path traversal via personaSlug/debateId at lookup sites; 1 Major: parseReportRounds split on ## Round N inside fenced code blocks). Both fixed: assertSafeSegment + assertWithinCouncil guards in src/lib/council.ts:62-89; fence-aware parser in src/lib/council.ts:200-213; synthesize manifest validates each persona via getPersonaDir. Smoke-verified: traversal attempt rejected cleanly, ## Round 99 inside a fence preserved intact through append/summaries.
### 2026-04-19 - Session Update
- Implementation complete — 14 CLI sub-commands built in src/cli/commands/council.ts, shared helpers in src/lib/council.ts, 4 templates, council skill pack (SKILL.md + debate-protocol.md), council-persona + council-synthesizer sub-agent files, catalog.json updated, rem-sleep agent taught to promote unpromoted debates. End-to-end smoke test passed: create → agent create x2 → round start → round-context → report append (with validation rejecting missing Executive Summary) → round end → summaries → round 2 start (cross-context injected) → reports → synthesize → complete → promote → knowledge file created with trimmed verdict+why+minority+risks.
### 2026-04-19 - Session Update
- Scoped and designed the full council skill: 3-layer architecture (orchestrator/persona sub-agents/synthesizer), nested _dream_context/council/{debate_id}/{persona_slug}/ file layout, 14 CLI sub-commands (council.ts), two new sub-agent files (council-persona.md, council-synthesizer.md), new skill pack at skill-packs/council/. Key decisions: generated personas 3-10 (not preset), model diversity per persona, promotion via main-agent-ask + sleep-agent-fallback, researches/ enabled in v1, separate synthesizer protects main context budget, one generic council-persona.md parameterized via prompt. Implementation ready to begin.
### 2026-04-19 — Scoped and designed
- Read inspiration repo (MiroFish); confirmed we take the persona + per-agent memory + separate synthesizer pattern, not the social-simulation mechanics.
- Resolved 4 scope decisions with user: generated personas (3–10), slash + trigger invocation, promotion via main-agent-ask + sleep-agent-fallback (not manual knowledge create), researches/ included in v1.
- Architected three-layer design (orchestrator / persona sub-agents / synthesizer), nested folder layout, 14 CLI sub-commands, two new sub-agent definitions, new skill pack.

### 2026-04-19 — Created
- Task created.
