-- Data Structures — agentcontext
-- Updated: 2026-02-24
--
-- agentcontext has no database. All data is stored as files in _agent_context/.
-- This file documents the file-based data schemas instead.
--
-- ============================================================
-- FILE SCHEMAS (markdown with YAML frontmatter)
-- ============================================================

-- TASK FILE: _agent_context/state/<task-name>.md
-- Created by: agentcontext tasks create <name>
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


-- FEATURE FILE: _agent_context/core/features/<feature-name>.md
-- Created by: agentcontext features create <name>
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


-- KNOWLEDGE FILE: _agent_context/knowledge/<topic-name>.md
-- Created by: agentcontext knowledge create <name>
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

-- CHANGELOG: _agent_context/core/CHANGELOG.json
-- Managed by: agentcontext core changelog add
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


-- RELEASES: _agent_context/core/RELEASES.json
-- Managed by: agentcontext core releases add
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


-- CODE REGISTRY: _agent_context/core/6.code_registry.json
-- Managed by: agentcontext coderegistry insert
-- Schema (append-bottom array):
-- [
--   {
--     "name":        "useAuth",
--     "category":    "hooks",            -- hooks, utils, components, services, etc.
--     "path":        "src/hooks/useAuth.ts",
--     "description": "Authentication hook with token refresh",
--     "tags":        ["auth", "session", "jwt"],
--     "exports":     ["useAuth", "AuthContext", "AuthProvider"]
--   },
--   ...
-- ]
