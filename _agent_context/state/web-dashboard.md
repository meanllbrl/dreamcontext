---
id: task_FmI9fzhk
name: web-dashboard
description: >-
  Build the agentcontext web dashboard. Full feature PRD at
  core/features/web-dashboard.md. Phases 1-4c complete: Kanban board, Eisenhower
  Matrix view, urgency+version fields, MultiSelectFilter (type-ahead search),
  SubGroupSection (collapsible sub-groups), VersionManager (planning/released
  sections, unified with Releases), Features page File/Preview tabs, markdown
  preview on Core/Knowledge/Features pages. Versions-as-Releases unification:
  VERSIONS.json deleted, ReleaseEntry extended with status field. 468 tests
  passing. Phase 5 remaining: a11y audit, responsive layout, i18n token
  extraction, bundle audit.
priority: critical
status: in_progress
created_at: '2026-02-25'
updated_at: '2026-03-10'
tags:
  - frontend
  - architecture
  - design
parent_task: null
---

## Changelog
<!-- LIFO: newest entry at top -->






### 2026-03-10 - Session Update
- Added in_review status: 4th Kanban column (purple), todo→in_progress→in_review→completed workflow. In-review tasks shown in snapshot, default task list, Eisenhower Matrix. CLI, server, dashboard, i18n, tests all updated (12 files, 469 tests passing).
### 2026-03-07 - Session Update
- Bug fix: task slug extraction regex in transcript/hook code tightened. Was matching task names in prose text (false positives). Now only matches within JSON command/file_path values using context-specific patterns. 468 tests passing.
### 2026-03-07 - Session Update
- Dashboard Features page: File/Preview tabs with rendered markdown preview (same pattern as Core and Knowledge pages). Features page now consistent with other content pages.
### 2026-03-07 - Session Update
- Versions unified with Releases: deleted VERSIONS.json system, extended ReleaseEntry with status: 'planning' | 'released' (backward compat for entries without status). CLI 'core releases add --status planning' creates planning versions. Snapshot shows 'Upcoming Versions' section for planning entries. VersionManager redesigned: full-width 680px modal, stats header, separate planning/released sections, Release button to promote. src/server/routes/versions.ts deleted.
### 2026-03-07 - Session Update
- Dashboard Phase 4b/4c complete: urgency+version fields on tasks (CLI + API + UI), Eisenhower Matrix view (priority x urgency 2x2 grid, excludes completed tasks), MultiSelectFilter with type-ahead search (shows when >5 options), SubGroupSection (collapsible nested groups in Kanban), group-by-version/urgency/tags, VersionManager modal (680px, planning/released sections, Release button). 468 tests passing.
### 2026-02-28 - transcript distill improvements + SleepHistoryEntry fields
- transcript distill: full content no truncation, thinking blocks, trivial responses, subagent I/O, byte deltas on edits (443b944)
- SleepHistoryEntry: consolidated_at + session_ids fields; auto-filter in transcript distill prevents re-processing already-consolidated sessions
- 394 tests passing (all)

### 2026-02-27 - Session Update
- SubagentStart hook root cause analysis + fix: directive strengthened (IMPORTANT -> MANDATORY), named tools (Glob, Grep), actionable decision rule added. SKILL.md Context Propagation paragraph replaced: now tells main agent to match task keywords against feature names/tags and include _agent_context/ paths in Explore/Plan prompts. 386 tests passing. Installed globally.
### 2026-02-27 - Notion-Style TaskDetailPanel + Tool Count Scoring
- TaskDetailPanel: properties block (Notion bordered card, 140px label/1fr value grid) + markdown body via marked@^15
- Panel widened 520px → 680px; ExpandableText (3-line clamp, requestAnimationFrame scroll height detection)
- `body: string` added to TaskData (src/server/routes/tasks.ts) + Task interface (useTasks.ts); backward compat maintained
- Removed: TASK_SECTIONS array, per-section <pre> blocks, all section insert inputs, useInsertTaskSection import
- Tool count debt scoring: scoreFromToolCount() in hook.ts, Math.max over scoreFromChangeCount; SessionRecord.tool_count field
- 336 tests passing

### 2026-02-26 - Session Update
- SQL parser rewrite (line-by-line parsing, REFERENCES FK detection, JSONB sub-field parsing, isSqlType validation). SqlPreview collapsible JSONB groups with toggle arrows and count badges. SubagentStart briefing restructured: directive at top, features section promoted with direct Read paths, compact context directory reference. 3 integration tests updated. 325 tests passing.
### 2026-02-26 - Enhanced Task Filters + localStorage Persistence
- Added status filter dropdown to Kanban filters
- Added text search input (searches task name + description)
- Added date range filter with field selector (created_at or updated_at)
- All filter state persisted to localStorage via new usePersistedState hook (prefix: agentcontext:)
- Clear Filters button shows active-count badge; clears filters but preserves sortField and groupBy
- FilterState interface and DEFAULT_FILTERS exported from TaskFilters.tsx for type safety

### 2026-02-26 - UI Polish + Bug Fix + Release Discovery
- Fixed selectedTask stale snapshot bug: now stores selectedSlug + derives task via useMemo from live query data
- CSS polish: animated radial brand gradient background (subtle-pulse 20s), stagger entrance animations for Kanban columns (slide-up-fade with spring curve)
- Refined CSS across all components: Header, Sidebar, TaskCard, TaskCreateModal, TaskDetailPanel, CorePage, FeaturesPage, SleepPage, tokens
- Release discovery system shipped: releases add --yes, releases list, releases show, 3 new API routes, back-populates features
- README and DEEP-DIVE fully updated with Dashboard section and release commands
- 325 tests passing

### 2026-02-25 - Phase 4 Polish Complete
- Error boundaries, loading states, res.ok checks in API client (274 tests)
- Field-level change tracking: FieldChange interface, net-change detection (A->B->A cancelled, A->B->C folded), 19 new unit tests
- SQL ER diagram preview: sql-parser.ts, SqlPreview.tsx/css, File/Preview tab toggle in CorePage
- SubagentStart briefing enriched: features listing, extended core index, knowledge index, priority instructions (301 tests)
- sleep start/done epoch-based clearing, tasks create non-interactive (279 tests)
- Interactive mode highlight styling fixed (purple background fill on focused items)
- 313 tests passing; remaining: Phase 5 (a11y, responsive, i18n tokens, bundle audit)

### 2026-02-25 - Phase 1-4 Complete
- Server: Node HTTP server with 17 REST API endpoints (tasks, sleep, core, knowledge, features, changelog, releases, health)
- Change tracking: dashboard_changes in .sleep.json, cleared on sleep done
- React dashboard: Kanban board (drag-drop, filter, sort, group), task CRUD, sleep page, core editor, knowledge manager, features viewer
- Design: purple-magenta brand tokens, light/dark mode, 4px grid, i18n-ready
- Build pipeline: build:dashboard + build:cli, 258 tests passing

### 2026-02-25 - Created
- Task created.
