---
id: memory-archive-2026-h1
name: "Memory Archive — 2026 H1 (Feb–Apr)"
description: "Archive of older LIFO entries extracted from core/2.memory.md when the anti-bloat ceiling tightened from 300→150 lines (2026-05-23). Covers Feb–Apr 2026: meta-marketing skill build, project rename, v0.2.0 release, council skill, dashboard work, neuroscience phase 8, context-aware subagent optimization."
tags: ["architecture", "decisions", "domain"]
pinned: false
date: "2026-05-23"
---

## Why this exists

When `dreamcontext memory recall` shipped (v0.4.0+, BM25 over the live corpus), the sleep-state anti-bloat ceiling was tightened from 300 lines to 150 lines per core file. `2.memory.md` was at 285 lines on the day of the change. Everything below was extracted here so the always-loaded memory file can stay lean; recall still surfaces this content on demand.

Entries are LIFO-ordered (newest first within the archived window).

## Archived entries

### 2026-04-26 — meta-marketing corpus audit + project-agnostic scrub (task: meta-marketing-skill, post-closure)

Corpus audit across all 9 YouTube videos. Multiple skill mismatches found and corrected: §III creative volume anchored to corpus 20+ per adset (was 15-30 Andromeda-era); §II retargeting default corrected to hybrid (was "separate campaign"); prospecting+retention split added; §I audience data and exclusion-list-now-hard sharpened; §IV full rewrite of snow-globe cadence + decision-window discipline + ad-level-vs-adset-level matrix + spend-redistribution math + kill-by-spend-zero + biggest-impact-fewest-moves; §VII performance-goal trap elevated to hard-block-equivalent; §VIII Trust-Meta sharpened with "algorithm is not always right" caveat.

Project-agnostic scrub: user rule established — skill-pack content must never reference user's own projects. All Tilki/Turkish/₺-specific examples removed from 9 files. Corpus research files under `_dream_context/marketing/` left intact. Rule captured in soul.md Warnings.

creative-frameworks.md restoration: four structural pieces over-generalized during the scrub were restored in project-agnostic form: angle-fatigue vs algorithmic-fatigue (≥10-cell threshold rule); FB Ad Library spy three-bucket method; italic typographic craft; cross-funnel reciprocity 6-touchpoint table.

Build: dist/index.js 479 KB.

### 2026-04-26 — meta-marketing-skill CLOSED; build confirmed; SKILL.md skill-triage rule

All PRs shipped. Task closed. PR 7 lifted to standalone `marketing-dashboard-v0`. Final: 743/743 tests, mk CLI 28 subcommands. PR 8 = pre-commit binary guard hook + mk council wrapper + 4 marketing personas. PR 5 = Reinfluence vision pass. SKILL.md rule #2 "Skill triage before action" (9 task→skill mappings, hard regression if skipped). All 10 agents declare `skills:` frontmatter + `## Skills always loaded` body section. Commit d293d93. `dreamcontext` is globally npm-linked — every root `npm run build` auto-propagates.

### 2026-04-25 — meta-marketing-skill PRs 0.5/1/2/3/4/6 shipped

10 marketing commits, 675/675 tests, mk CLI 25 subcommands. PR 0.5 ingested 9 YouTube videos; resolved 8 user decisions; generated `skill-packs/meta-marketing/`. PR 6 agent roster (Strategy Optimizer + Performance Monitor + creative flag-gated stub). PR 1 `meta-fetch.ts` 525L (sole Graph wrapper, retry on 429/5xx + Meta codes {1,2,4,17,32,613}, exponential backoff jitter, UUIDv4 idempotency, header-only auth — `HeaderAuthAssertionError` if `access_token=` in URL, write queue cap 3, chunked >50MB, API v25.0). PR 2 13 verbs + 4 lib modules; all mutations dry-run by default; `BudgetMissingError` on missing input. PR 3 launch with WAL + entity-store + `--confirm <cohort_id>` verbatim. PR 4 learnings ledger (per-day `.md` + `.index.json` under `knowledge/marketing-learnings/`), `path-guards.ts` for .env protection, `mk rem-sleep` deterministic CLI. PR 4 fixes: `mkdirSync` in atomicWriteFile, idempotent merge, beginRun/succeed/fail wrap, realpath-scoped path guard.

### 2026-04-19 — v0.2.0 Release (tasks: council-skill, web-dashboard, optional-skill-packs, install-claude-md)

v0.2.0 shipped. All 4 tasks shipped in one session (2e902c8c). Tag pushed. RELEASES.json v0.2.0 moved planning→released. README and DEEP-DIVE updated.

### 2026-04-19 — Council UI v3 + Brain Light Mode

3 iterations to reach accepted Council UI. v1 (gamified arena) rejected — theatrical, not usable. v2 (verdict-first with Inspector) rejected — final report not prominent. v3 accepted: CouncilHall searchable card grid → CouncilDetail with back nav + 3 tabs. Overview tab = full final-report as hero, **dynamic section parsing** (reads all `## Sections`, does NOT hardcode Why/Minority/Risks). Agents tab = TranscriptView with search. Matrix tab = inline cell expand. Brain graph light mode added (theme-aware palettes). **Build pipeline lesson**: `npm run build` inside `dashboard/` does NOT update what `dreamcontext dashboard` serves; only root `npm run build` triggers tsup `onSuccess` copy.

### 2026-04-19 — Council Synthesizer Readability Rules

6 readability rules added to `skill-packs/agents/council-synthesizer.md` and final-report template: (1) sources inline after bullet, (2) 5+ same-source bullets collapse to "Consensus:" line, (3) max 1 verbatim quote per section, (4) "Why it X" max 1-2 sentences, (5) meta-narration banned, (6) human prose first source tag after. Synthesizer reliably emits `## Verdict` + `## Appendix`, NOT always `## Why`/`## Minority views`/`## Open risks` — dynamic extraction required.

### 2026-04-19 — install-claude-md Command

New `dreamcontext install-claude-md` command installs a terse CLAUDE.md template (~84 lines / ~3k tokens). Three modes: append (default, idempotent via `<!-- dreamcontext:start/end -->` fence), replace (with backup), skip. Reduces ~11k tokens/session vs old templates. Optional y/n prompt at end of `dreamcontext init` (default no).

### 2026-04-19 — Council Skill Build + Security Review

All files created: `src/cli/commands/council.ts` (14 subcommands), `src/lib/council.ts` (helpers + validators + report parser), 4 templates, skill-pack + 2 agents. Reviewer FAIL → 2 fixes before in_review: **path traversal** (`assertSafeSegment` rejects `/\\\0..`, `assertWithinCouncil` ensures resolved path under council dir, validated at every lookup site); **code-fence parsing bug** (triple-backtick fence state tracking before splitting on `## Round N`).

### 2026-04-19 — Council Skill Design

Three strict layers: orchestrator (main agent, summaries only), persona sub-agents (debaters, isolated context), synthesizer sub-agent (writes final-report.md, not the main agent). Nested layout `_dream_context/council/{debate_id}/{persona_slug}/`. 14 CLI subcommands. One generic `council-persona.md` parameterized via prompt (not per-archetype files). Personas generated per-topic (3–10, not preset); different models per persona for cognitive diversity. Promotion through main-agent-ask-first then rem-sleep-fallback. `researches/` included v1 (soft-fail). Deliberate break from flat folder convention.

### 2026-04-19 — Dashboard Brain Graph

Obsidian-style interactive brain graph (`BrainPage.tsx`). `src/lib/graph.ts` extracts tag nodes as first-class — 26 tags yielded 53 nodes / 73 links from this repo. Labels = filename basename. New `has_tag` link kind. Dark canvas, always-visible labels at 55% zoom, bigger nodes (nodeRelSize 4→5), arrows on non-tag links. Uses `react-force-graph-2d` (~60KB gzip).

### 2026-03-24 — Optional Skill-Packs Phase 2 CLI + Hook Cleanup

Phase 2 complete: `install-skill --packs` (interactive checkbox + direct names), `--skill <pack> <skill>` (individual sub-skill install), `--list` (show catalog). Cross-pack dependency warnings. Related agents copied to `.claude/agents/`. Firebase reference dirs copied intact. `alwaysApply: true` badge in interactive UI. 17 new integration tests, 490 total passing. Hook cleanup: removed 7 duplicate `agentcontext` hooks failing on every event.

### 2026-03-24 — Project Rename: agentcontext → dreamcontext + Optional Skill-Packs

Rename complete: npm package, binary, GitHub repo, local folder. Context directory `_agent_context/` → `_dream_context/`. Agents renamed (dreamcontext-explore, dreamcontext-initializer, dreamcontext-rem-sleep — last one later deleted). Optional skill-packs Phase 1 + Level 2 (42 files): 4 packs (engineering, design, growth, brand-voice) + 1 standalone (system-prompts) + 6 agents. `catalog.json` manifest. tsup `onSuccess` ships `skill-packs/` to `dist/skill-packs/`. 473 tests. Key decisions: base skill IS pack SKILL.md (no separate base); sub-skills flat .md (not subdirs) except firebase with `references/`; brand-voice guidelines save to `_dream_context/core/` (e.g., `7.brand_voice.md`); frontend pack dissolved into design + engineering.

### 2026-03-10 — Duplicate Sleep Dispatch Fix + Explore Agent Rewrite + Reuse Rule

`getConsolidationDirective()` and user-prompt-submit hook now check `sleep_started_at` before emitting directives. dreamcontext-explore rewrite (105→78 lines, briefing-first; Track A/B/C routing; budget caps Quick 1-3 / Medium 4-8 / Thorough 9-20). SKILL.md rule #12 "Reuse before create".

### 2026-03-07 — in_review Task Status + Dashboard Phase 4b/4c + Versions Unified

Added `in_review` as 4th task status (todo→in_progress→in_review→completed, treated as active). Eisenhower Matrix view mode (2×2 priority×urgency). MultiSelectFilter with type-ahead (checkbox-based, search when >5 options). Versions unified with Releases: VERSIONS.json deleted; `ReleaseEntry` extended with `status: 'planning' | 'released'`. Task urgency + version fields added. File/Preview tabs on Core/Knowledge/Features pages.

### 2026-03-02 — Code Quality Hooks (PostToolUse + PreCompact) + Pattern Extraction

PostToolUse hook fires on Edit|Write for JS/TS. `findProjectConfig()` single walk-up detects Biome (`biome.json/.jsonc`) and Prettier (11 variants); Biome preferred. `tsc --noEmit --incremental` filtered to edited file. `execFileSync` (no shell injection). 30s timeout. PreCompact hook saves `CompactionRecord` to `compaction_log[]` (LIFO, capped 20). Pattern Extraction Step 1c in rem-sleep agent (2+/3+ occurrence thresholds). `ensureHooks()` refactored from 160 lines to data-driven HOOK_SPECS table.

### 2026-03-01 — UserPromptSubmit hook + debt threshold tighten + tasks list + Context-Aware Subagent Optimization

UserPromptSubmit hook fires on every user message — reads sleep debt, outputs one-line reminder when debt ≥ 4. Critical bookmarks override threshold. PostToolUse considered and rejected (wrong timing, interrupts flow). Debt thresholds tightened (debt ≥ 4 triggers directives, was ≥ 7; rhythm 3+ sessions). SKILL.md language → mandatory ("MUST offer", "MUST inform"). `tasks list` command added (parity with `bookmark list` / `trigger list`). PreToolUse hook blocks default Explorer via JSON deny when `_dream_context/` exists; custom `dreamcontext-explore.md` has context-first behavior.

### 2026-02-25/28 — Neuroscience System (8 phases) + Dashboard + Infrastructure

Bookmarks (salience 1-3), Knowledge Decay (knowledge_access map), Consolidation Rhythm, Warm Knowledge Tier (7-day + tag-overlap), Contextual Triggers (fired_count in generateSnapshot), Transcript Distillation (structural JSONL, no AI), Sleep History (SleepHistoryEntry with consolidated_at + session_ids), System Flow doc (core/6.system_flow.md). freshDefaults() prevents shared-reference mutation. transcript distill full content, thinking blocks, subagent I/O, byte deltas on edits; auto-filters by consolidated_at from sleep history. Tool Count Debt Scoring: `scoreFromToolCount` (0/1-15/16-40/41+ → 0/1/2/3), `Math.max` with changeCount score. Web dashboard: Node.js native HTTP, 17 REST endpoints, React 19 + Vite 6 SPA. Kanban (drag-drop, filters, sort, group, sub-groups). Dashboard change tracker with field-level diffs. SQL ER diagram (SVG bezier).

## Mk-skill technical decisions (archived from 2.memory.md Technical Decisions list)

- `mk-skill: CLI is the only place that sets ctx.dryRun = false`. Library code accepts `ctx`, never constructs it. All mutations guard on `ctx.dryRun` + acquire marketing lock + write `runs/` WAL entry.
- `mk-skill: meta-fetch.ts is the sole Graph API wrapper`. Header-only auth (HeaderAuthAssertionError if `access_token=` in URL). Three-layer fallback: typed client → `api-reference.md` → live Meta docs (dry-run first, recipe write-back, typed wrapper after 3 uses).
- `mk-skill: budget never defaults`. `parseDailyBudget` throws `BudgetMissingError`. Strategy Optimizer emits `null + ASK_USER_FOR_BUDGET`.
- `mk-skill: mk launch requires --confirm <cohort_id> verbatim`. 6-line summary BEFORE WAL. Entity flips one-at-a-time, `noRetry: true`. `mk launch resume <run_id>` replays from WAL, rejects ctx mismatch.
- `mk-skill: learnings live under knowledge/marketing-learnings/`, NOT marketing/. Per-day `.md` + `.index.json`; quarterly `_archive-<YYYY-Q>.md` via `mk rem-sleep`. Performance Monitor is the only writer (CLI gate).
- `mk-skill: mk rem-sleep is a deterministic CLI verb`. dreamcontext-rem-sleep agent calls `dreamcontext mk rem-sleep`. Pure fns: pruneRuns/compactInsights/mergeDailyLearnings/redactRunsSweep. Idempotent.
- `mk-skill: Reinfluence artifacts strictly under _dream_context/marketing/`. `mk init` copies to `.tools/`, creates `.venv/`. System prereqs (python3 ≥ 3.10, ffmpeg) checked by health probe.

## Last verified

2026-05-23.
