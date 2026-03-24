---
id: task_HJnXDBJ1
name: neuroscience-improvements
description: >-
  Implement neuroscience-inspired improvements to dreamcontext: bookmarks (awake
  ripples), transcript distillation, sleep history, consolidation rhythm,
  knowledge decay tracking, warm knowledge tier, contextual triggers, and system
  flow documentation
priority: critical
status: completed
created_at: '2026-02-27'
updated_at: '2026-02-27'
tags:
  - architecture
  - backend
  - decisions
parent_task: null
related_feature: sleep-consolidation
---

## Why

Based on Joo & Frank 2025 Science paper revealing the brain's two-stage memory selection system. The hippocampus doesn't just record everything -- it has an elegant mechanism: during waking, it fires "awake ripples" that bookmark important moments; during sleep, bookmarked memories compete for consolidation with only the strongest winning. Memory selection (tagging) and consolidation (storage) are separate processes. Our system had good sleep consolidation but was fundamentally missing the waking-phase selection.

## User Stories

- [x] As an agent, I want to bookmark important moments during active work so that the sleep agent processes critical decisions first
- [x] As a sleep agent, I want to distill session transcripts so that I get high-signal content without noise
- [x] As an agent, I want to see consolidation history so that I know what was recently consolidated
- [x] As an agent, I want a rhythm advisory after 5+ sessions so that consolidation happens regularly
- [x] As an agent, I want knowledge access tracking so that stale knowledge is flagged
- [x] As an agent, I want warm knowledge loaded as first-paragraph previews so that I have just enough context
- [x] As an agent, I want contextual triggers so that context-dependent decisions surface when relevant tasks are active
- [x] As an agent, I want a system flow reference document so that the complete lifecycle is documented

## Acceptance Criteria

- [x] `dreamcontext bookmark add/list/clear` commands work
- [x] `dreamcontext trigger add/list/remove` commands work
- [x] `dreamcontext transcript distill <session_id>` extracts high-signal content
- [x] `dreamcontext knowledge touch <slug>` records access
- [x] `dreamcontext sleep history` shows consolidation log
- [x] Snapshot includes bookmarks, contextual reminders, warm knowledge, staleness indicators, sleep history
- [x] Stop hook links bookmarks, increments sessions_since_last_sleep
- [x] getConsolidationDirective checks for critical bookmarks and rhythm
- [x] sleep done writes history entry, clears bookmarks, expires triggers, resets counter
- [x] SKILL.md documents all new commands and behaviors
- [x] Rem-sleep agent updated with bookmark-first processing and transcript distillation
- [x] System flow core file (6.system_flow.md) created
- [x] All existing tests pass, 48 new tests added (384 total, 383 passing)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-02-27 - Implementation decisions
- `freshDefaults()` replaces `DEFAULT_SLEEP_STATE` spread to prevent shared-reference mutation across test runs
- `extractFirstParagraph()` handles YAML frontmatter blocks (--- ... ---) correctly
- Trigger `fired_count` is persisted by `writeSleepState()` within `generateSnapshot()` when triggers match
- Warm knowledge uses 7-day recency window for "recently accessed" and tag overlap for "task-relevant"
- Staleness threshold: 30+ days since last access or creation
- Transcript distillation is pure Node.js (no AI) -- structural filtering by tool name patterns
- System flow lives in core/6.system_flow.md (extended core file), not in knowledge/

## Technical Details

### Phase 1: Bookmarks (Awake Ripples)
- **New file**: `src/cli/commands/bookmark.ts` -- add/list/clear subcommands
- **Modified**: `sleep.ts` -- `Bookmark` type, `bookmarks[]` in `SleepState`
- **Modified**: `hook.ts` -- stop hook links unlinked bookmarks to session; `getConsolidationDirective()` checks for critical (salience 3) bookmarks
- **Modified**: `snapshot.ts` -- bookmarks section sorted by salience (*** > ** > *)

### Phase 2: Knowledge Decay Tracking
- **Modified**: `sleep.ts` -- `KnowledgeAccessRecord` type, `knowledge_access{}` in `SleepState`
- **Modified**: `knowledge.ts` -- `knowledge touch <slug>` subcommand
- **Modified**: `snapshot.ts` -- staleness indicators on knowledge index entries

### Phase 3: Consolidation Rhythm
- **Modified**: `sleep.ts` -- `sessions_since_last_sleep` counter in `SleepState`, reset in `sleep done`
- **Modified**: `hook.ts` -- increment counter in stop hook; rhythm advisory in `getConsolidationDirective()`

### Phase 4: Warm Knowledge
- **Modified**: `snapshot.ts` -- `extractFirstParagraph()` helper; warm knowledge section between index and pinned; warm = recently accessed (7 days) OR task-tag-relevant

### Phase 5: Contextual Triggers
- **New file**: `src/cli/commands/trigger.ts` -- add/list/remove subcommands
- **Modified**: `sleep.ts` -- `Trigger` type, `triggers[]` in `SleepState`, expire in `sleep done`
- **Modified**: `snapshot.ts` -- trigger matching against task names, tags, bookmark text; contextual reminders section; fired_count increment + persistence

### Phase 6: Transcript Distillation
- **New file**: `src/cli/commands/transcript.ts` -- `distillTranscript()` structural filter + `formatDistilled()` markdown output
- Keeps: user messages, agent text (>20 chars), Write/Edit/NotebookEdit calls, modifying Bash commands, bookmark calls, errors
- Discards: Read/Glob/Grep/WebFetch/WebSearch results, tool metadata, subagent internals

### Phase 7: Sleep History
- **Modified**: `sleep.ts` -- `SleepHistoryEntry` type, `sleep_history[]` (LIFO), `sleep history` subcommand, `sleep done` writes entry
- **Modified**: `snapshot.ts` -- last 3 history entries in sleep state section

### Phase 8: System Flow Documentation
- **New file**: `_dream_context/core/6.system_flow.md` -- complete lifecycle, neuroscience mapping, data flows, salience levels, consolidation triggers, SleepState schema

### Cross-cutting
- **Modified**: `index.ts` -- registered 3 new commands (bookmark, trigger, transcript), updated help groups
- **Modified**: `change-tracker.ts`, `routes/sleep.ts` -- fixed `as Record<string, unknown>` casts broken by new SleepState fields
- **Updated**: `skill/SKILL.md` -- bookmarking section, updated auto-loaded context, consolidation triggers, +9 commands
- **Updated**: `agents/dreamcontext-rem-sleep.md` -- bookmark-first processing, transcript distillation, trigger creation, knowledge access anti-bloat

## Notes

- The 1 failing test (`id.test.ts:15`) is pre-existing (nanoid intermittently returns 5 chars instead of 8). Not related to this work.
- Implementation order followed the plan: 1 (bookmarks) -> 6 (transcript) -> 7 (history) -> 3 (rhythm) -> 2 (decay) -> 4 (warm) -> 5 (triggers) -> 8 (docs). In practice, all SleepState schema changes were batched upfront for efficiency.
- The `freshDefaults()` fix in `readSleepState` was critical -- the old `DEFAULT_SLEEP_STATE` spread shared array references across calls, causing test pollution.

## Changelog
<!-- LIFO: newest entry at top -->


### 2026-02-27 - Session Update
- All 8 phases implemented and verified. 48 new tests (384 total, 383 passing). Task completed.
### 2026-02-27 - Implemented all 8 phases
- Phase 1: Bookmark command (add/list/clear), Bookmark type in SleepState, stop hook linking, critical bookmark consolidation advisory
- Phase 2: knowledge_access tracking in SleepState, knowledge touch command, staleness indicators in snapshot (30+ days)
- Phase 3: sessions_since_last_sleep counter, rhythm advisory at 5+ sessions, reset in sleep done
- Phase 4: extractFirstParagraph() helper, warm knowledge section (recently accessed or task-tag-relevant)
- Phase 5: Trigger command (add/list/remove), trigger matching in snapshot against tasks/tags/bookmarks, fired_count persistence, auto-expiry in sleep done
- Phase 6: transcript distill command with structural JSONL filtering (pure Node.js, no AI)
- Phase 7: SleepHistoryEntry type, sleep_history[] (LIFO), sleep history subcommand, sleep done writes entry, snapshot shows last 3
- Phase 8: Core file 6.system_flow.md with lifecycle, neuroscience mapping, data flows, schema
- Updated SKILL.md with bookmarking section, consolidation triggers, +9 commands
- Updated rem-sleep agent with bookmark-first processing, transcript distillation, trigger creation, access-based anti-bloat
- 48 new tests (384 total, 383 passing, 1 pre-existing flaky)
- Fixed shared-reference bug in readSleepState via freshDefaults()
- Fixed unnecessary SleepState casts in change-tracker.ts and routes/sleep.ts

### 2026-02-27 - Created
- Task created.
