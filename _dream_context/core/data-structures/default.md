-- Data Structures — dreamcontext
-- Updated: 2026-02-24
--
-- dreamcontext has no database. All data is stored as files in _dream_context/.
-- This file documents the file-based data schemas instead.
--
-- ============================================================
-- FILE SCHEMAS (markdown with YAML frontmatter)
-- ============================================================

-- TASK FILE: _dream_context/state/<task-name>.md
-- Created by: dreamcontext tasks create <name>
-- Fields in YAML frontmatter:
--
-- id:          "task_xK9pQ2mL"   -- nanoid prefixed with "task_"
-- name:        "My Task Name"    -- original name as entered
-- description: "What this task does"
-- priority:    "critical" | "high" | "medium" | "low"
-- status:      "todo" | "in_progress" | "in_review" | "blocked" | "completed" | "backlog"
-- created_at:  "2026-02-24"      -- YYYY-MM-DD
-- updated_at:  "2026-02-24"      -- YYYY-MM-DD, updated on every write
-- tags:        []                -- array of strings
-- parent_task: null              -- string or null
--
-- Body contains a ## Changelog section with LIFO entries (### DATE - Event)


-- FEATURE FILE: _dream_context/core/features/<feature-name>.md
-- Created by: dreamcontext features create <name>
-- Fields in YAML frontmatter:
--
-- id:               "feat_xK9pQ2mL"  -- nanoid prefixed with "feat_"
-- status:           "planning" | "in_progress" | "done" | "cancelled"
-- created:          "2026-02-24"
-- updated:          "2026-02-24"     -- updated on every write
-- released_version: null             -- semver string or null
-- tags:             []               -- array of strings
-- related_tasks:    []               -- array of task IDs
--
-- Body sections (## headers):
--   Why, User Stories, Acceptance Criteria,
--   Constraints & Decisions, Technical Details, Notes, Changelog


-- KNOWLEDGE FILE: _dream_context/knowledge/<topic-name>.md
-- Created by: dreamcontext knowledge create <name>
-- Fields in YAML frontmatter:
--
-- id:          "know_xK9pQ2mL"   -- nanoid prefixed with "know_"
-- name:        "Topic Name"      -- original name as entered
-- description: "One-line summary"
-- tags:        []                -- array of strings
-- date:        "2026-02-24"      -- creation date


-- ============================================================
-- JSON ARRAY SCHEMAS
-- ============================================================

-- CHANGELOG: _dream_context/core/CHANGELOG.json
-- Managed by: dreamcontext core changelog add
-- Schema (LIFO array, newest at index 0):
-- [
--   {
--     "date":        "2026-02-24",
--     "type":        "feat" | "fix" | "refactor" | "chore" | "docs" | "perf" | "test",
--     "scope":       "auth",        -- module or area affected
--     "description": "Added JWT middleware",
--     "breaking":    false
--   },
--   ...
-- ]


-- RELEASES: _dream_context/core/RELEASES.json
-- Managed by: dreamcontext core releases add
-- Schema (LIFO array, newest at index 0):
-- [
--   {
--     "version":  "1.2.0",
--     "date":     "2026-02-24",
--     "summary":  "Auth system complete",
--     "changes":  ["Added JWT auth", "Fixed token refresh"],
--     "breaking": false
--   },
--   ...
-- ]


-- NOTE: code_registry.json was removed before v0.1.0. It went stale immediately
-- when methods were renamed or moved. Native Glob/Grep tools serve code discovery better.
-- Slot 6 in core is reserved for user customization (e.g., 6.system_flow.md, 7.brand_voice.md).


-- ============================================================
-- SLEEP STATE: _dream_context/state/.sleep.json
-- Managed by: dreamcontext sleep *, bookmark *, trigger *
-- ============================================================

-- SleepState (written/read by freshDefaults() in src/lib/sleep.ts):
-- {
--   "debt": 0,                           -- accumulated, 0-15+
--   "last_sleep": "2026-02-27",
--   "last_sleep_summary": "...",
--   "sleep_started_at": null,            -- ISO timestamp or null; set by sleep start
--   "sessions_since_last_sleep": 0,
--   "sessions": [{                       -- LIFO
--     "session_id", "transcript_path", "stopped_at",
--     "last_assistant_message", "change_count", "tool_count", "score",
--     "task_slugs"
--   }],
--   "bookmarks": [{                      -- LIFO
--     "id", "message", "salience", "created_at", "session_id"
--   }],
--   "triggers": [{
--     "id", "when", "remind", "source", "created_at", "fired_count", "max_fires"
--   }],
--   "knowledge_access": { "<slug>": { "last_accessed", "count" } },
--   "dashboard_changes": [{              -- LIFO, field-level diffs
--     "timestamp", "entity", "action", "target", "fields", "summary"
--   }],
--   "compaction_log": [{                 -- LIFO, capped at 20
--     "timestamp", "trigger", "debt", "session_count", "bookmark_count"
--   }]
-- }
