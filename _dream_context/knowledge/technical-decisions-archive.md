---
title: Technical Decisions Archive
name: technical-decisions-archive
type: knowledge
description: Archive of granular implementation decisions from dashboard, skill-packs, council, and infrastructure work (2026-03 through 2026-04). Core architecture decisions remain in 2.memory.md.
tags: [architecture, decisions, frontend, backend]
created: "2026-04-25"
updated: "2026-07-06"
pinned: false
archived: true
archived_date: "2026-07-06"
archived_reason: "Intentional cold archive of 2026-03/04 granular decisions extracted from 2.memory.md. Historical by design — staleness expected; do not re-flag. Archived docs stay recall-findable, just down-ranked."
---

# Technical Decisions Archive

Granular implementation decisions moved here from 2.memory.md to keep the active memory file lean. Core decisions (mk-skill rules, root build requirement, council UI principles) remain in memory.

## Dashboard & React

- **react-force-graph-2d chosen for dashboard brain graph**: ~60KB gzip, native force-directed layout, React-friendly. Sigma.js rejected (WebGL setup); react-flow rejected (not force-directed); cytoscape.js rejected (109KB, overkill for 50-200 nodes).
- **marked over react-markdown for task body rendering**: `marked@^15` is ~14KB gzipped with zero transitive deps. Safe to use `dangerouslySetInnerHTML` because content is local files only.
- **selectedSlug over selectedTask in KanbanBoard**: Store slug string in state, derive Task via useMemo from live query. Prevents stale snapshots after mutations without additional refetch logic.
- **FieldChange net-change detection**: Change tracker folds A->B->C into A->C and cancels A->B->A. Append-only actions and entries without a `fields` array bypass detection.
- **SQL ER diagram uses SVG bezier curves, not a graph library**: D3/React Flow overkill. SVG paths with cubic bezier + arrowheads over CSS grid entity layout.
- **MultiSelectFilter type-ahead threshold is 5**: Search input hidden when <= 5 options. Appears at 6+ options. UX constant, not user-configurable.
- **urgency defaults to 'medium' on readTask()**: Backward compat with existing tasks. Server-side default, never undefined in the client.
- **Eisenhower Matrix excludes completed tasks**: Prioritization tool for future work only. Completed work shows in Kanban "Completed" column.

## CLI & Infrastructure

- **sql-parser.ts uses line-by-line parsing, not comma-split**: Comma-split breaks on multi-line column definitions and inline comments. Line-by-line tracks context and handles REFERENCES, JSONB annotations.
- **--list flag reads catalog.json, no file system scan needed**: Pack discovery fully driven by catalog.json. No Glob or readdir required. Correct pattern for all skill-pack CLI operations.
- **install-skill --packs uses @inquirer/prompts checkbox, not confirmation per pack**: Single multi-select list vs N confirm prompts. `alwaysApply: true` packs marked with badge.
- **Base install-skill (no --packs) now hints about packs**: One-liner hint printed after base install. Discovery at the natural moment, not buried in docs.
- **skill-packs install flat into .claude/skills/{pack-name}/SKILL.md**: Agents in `skill-packs/agents/` (flat) install to `.claude/agents/` separately. catalog.json `agents` array links agent to pack via `pack` field.
- **brand-voice guidelines save to _dream_context/core/, not .claude/**: Numbered core file (e.g., `7.brand_voice.md`). Consistent with dreamcontext core-file pattern.
- **Non-alwaysApply skill descriptions must be trigger-specific**: Claude Code uses `description` to decide when to load a skill. Specific keywords beat generic category names.
- **Release discovery is built-in, not deferred**: `releases add --yes` auto-discovers all unreleased items and back-populates features.
- **Versions unified with Releases (no separate VERSIONS.json)**: `status: 'planning'` field on ReleaseEntry. One file, one schema, backward compat.

## Hook & Sleep System

- **execFileSync over execSync for hook subprocesses**: Shell injection risk eliminated. Array args, no shell interpolation. Never regress to execSync with string interpolation in hook.ts.
- **findProjectConfig() merges walk-up into single pass**: Single I/O walk collects all config types (biome, prettier, tsconfig). Previously two separate walks.
- **resolveLocalBin() + npx fallback pattern**: Checks `{dir}/node_modules/.bin/{bin}` walking up from cwd. Falls back to npx only if not found locally.
- **tsc --incremental flag**: First run ~5s (full type-check); subsequent runs <1s (incremental cache in `tsconfig.tsbuildinfo`).
- **PostToolUse single subcommand for format + tsc**: One hook invocation, sequential format then tsc. Avoids two hooks each adding latency.
- **compaction_log as audit trail**: PreCompact hook writes records to `compaction_log[]` in `.sleep.json`. Current state: write-only. Future: surface in snapshot.
- **ensureHooks() data-driven HOOK_SPECS table**: Array `{name, matcher, timeout, hookType}`. Registration loop is 15 lines. Adding a hook = one line in HOOK_SPECS.
- **UserPromptSubmit uses same thresholds as getConsolidationDirective() but single-line**: Full multi-line directives in SessionStart; compact one-liner in UserPromptSubmit context.
- **tasks list excludes completed by default**: Consistent with snapshot.ts `getActiveTaskLines()`. `--all` shows everything; `--status` for specific filter.
- **PreToolUse hook strategy for Explorer vs Plan**: Explorer replacement via deny hook (additionalContext can't override system prompt). Plan injection via SubagentStart (additive, no conflict).
- **transcript distill auto-filters by consolidated_at**: Defaults to showing only content after last consolidation. `--full` overrides.
- **SleepHistoryEntry stores session_ids for distill filtering**: `session_ids: string[]` enables `transcript distill` to find `consolidated_at` without scanning all sessions.
- **additionalContext is lower priority than sub-agent system prompt**: Cannot override via SubagentStart injection. Fix: main agent explicitly includes `_dream_context/` file paths in delegation prompts.
- **freshDefaults() prevents shared-reference mutation**: `DEFAULT_SLEEP_STATE` spread shared arrays across calls, causing test pollution. Always use `freshDefaults()` when initializing SleepState.
- **Trigger fired_count persisted inside generateSnapshot()**: `writeSleepState()` called within `generateSnapshot()` after matching triggers. Triggers expire in `sleep done`.
- **Transcript distillation is structural, not semantic**: Pure JSONL line filter. No AI call needed. Tool name pattern matching sufficient.
- **Warm knowledge uses 7-day window + tag overlap**: Two signals: accessed in last 7 days OR tag overlap with active tasks. First paragraph only.
- **System flow lives in core/6, not knowledge/**: Core reference always findable from snapshot. Knowledge files are for deep-topic research.
- **Stop hook is synchronous**: `readFileSync(0, 'utf-8')`. Guarantees `.sleep.json` written before next SessionStart hook fires.
- **Sleep epoch-based clearing**: `sleep start` records timestamp; `sleep done` only clears records from before epoch.
- **Bookmarks as primary consolidation signal**: Critical (★★★) bookmarks processed first. Mirrors Joo & Frank 2025 hippocampal model.
- **dreamcontext-explore budget caps prevent deep search spirals**: Quick 1-3, Medium 4-8, Thorough 9-20 tool calls. Based on SWE-Search (ICLR 2025) finding breadth beats depth.
- **Track C (Reusable Component Check) is always-on**: Explore agent always outputs a "Reusable" section. Enforcement mechanism for SKILL.md rule #12.
- **sleep_started_at guard suppresses duplicate sleep dispatch**: Both `getConsolidationDirective()` and `user-prompt-submit` hook check `sleep_started_at`. Prevents parallel sleep agents.
- **tool_count scoring uses Math.max over scoreFromChangeCount**: Bash-heavy sessions (no file writes) previously scored 0. `scoreFromToolCount` provides a floor.

## Council

- **assertSafeSegment + assertWithinCouncil pattern**: Two guards for user-supplied path segments: (1) reject traversal chars before path construction; (2) assert resolved path stays under council root. Validate at every lookup site, not just creation.
- **Fence-aware markdown section parser**: Track triple-backtick fence state when splitting on `## Section N` headers. `## Heading` inside a code fence is content, not a section boundary.
- **Council: one generic council-persona.md, not per-archetype files**: Persona identity from `context-and-persona.md` on disk. Avoids sprawling archetype library.
- **Council: main agent reads only executive summaries**: `council summaries` prints only `### Executive Summary` (<=150 words) per persona. Keeps orchestrator context under ~20K tokens.
- **Council: synthesizer is a separate sub-agent, not main agent**: Main agent dispatches synthesizer (opus) which reads all reports and writes final-report.md. Main agent context never expands to full report content.
- **Council: nested folder layout is deliberate convention break**: `_dream_context/council/{debate_id}/{persona_slug}/` because N×M doesn't scale flat. Exception, not a pattern to follow elsewhere.
- **Council: promotion is two-path, no forced synchronous decision**: Main agent asks post-synthesis; rem-sleep picks up unpromoted via `council list --unpromoted`.
- **Council: model diversity per persona uses Agent tool `model:` param**: Claude Code dispatch capability, not a dreamcontext feature.
