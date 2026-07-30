---
name: default
type: data-structures
product: default
tags:
  - domain:database
  - database
  - topic:schema
updated: "2026-07-30"
---```sql
-- Data Structures — dreamcontext
-- Updated: 2026-07-30
--
-- dreamcontext has no database. All data is stored as files in _dream_context/.
-- This file documents the file-based data schemas instead.
--
-- ============================================================
-- FILE SCHEMAS (markdown with YAML frontmatter)
-- ============================================================

-- TASK FILE: _dream_context/state/<task-name>.md
-- Created by: dreamcontext tasks create <name>
-- Fields in YAML frontmatter (current as of v0.6.0):
--
-- id:             "task_xK9pQ2mL"   -- nanoid prefixed with "task_"
-- name:           "My Task Name"    -- original name as entered
-- description:    "What this task does"
-- priority:       "critical" | "high" | "medium" | "low"
-- urgency:        "critical" | "high" | "medium" | "low"  -- Eisenhower axis
-- status:         "todo" | "in_progress" | "in_review" | "blocked" | "completed" | "backlog"
-- created_at:     "2026-06-09"      -- YYYY-MM-DD
-- updated_at:     "2026-06-09"      -- YYYY-MM-DD, updated on every write
-- tags:           []                -- array of strings
-- version:        "v0.6.0"          -- optional planning-version association
-- parent_task:    null              -- string or null
-- related_feature: null             -- feature slug cross-link (optional)
-- rice:           null | { reach: N, impact: N, confidence: N, effort: N, score: N }
--
-- Body contains a ## Changelog section with LIFO entries (### DATE - Event)


-- FEATURE FILE: _dream_context/core/features/<feature-name>.md
-- Created by: dreamcontext features create <name>
-- Fields in YAML frontmatter (current as of v0.6.0):
--
-- id:               "feat_xK9pQ2mL"  -- nanoid prefixed with "feat_"
-- status:           "planning" | "in_progress" | "in_review" | "active" | "shipped" | "deprecated"
-- created:          "2026-06-09"
-- updated:          "2026-06-09"     -- updated on every write
-- released_version: null             -- semver string or null
-- tags:             []               -- array of strings
-- related_tasks:    []               -- array of task slugs
-- product:          null | "name"    -- optional product scope (multi-product projects)
--
-- Body sections (## headers):
--   Why, User Stories, Acceptance Criteria,
--   Constraints & Decisions, Technical Details, Notes, Changelog


-- KNOWLEDGE FILE: _dream_context/knowledge/<topic-name>.md
--   or          : _dream_context/knowledge/data-structures/<product>.md (schemas)
--   or          : _dream_context/knowledge/products/<product>.md (per-product)
-- Created by: dreamcontext knowledge create <name>
-- Fields in YAML frontmatter:
--
-- id:          "know_xK9pQ2mL"   -- nanoid prefixed with "know_"
-- name:        "Topic Name"      -- original name as entered
-- description: "One-line summary"
-- tags:        []                -- array of strings
-- date:        "2026-06-09"      -- creation date
-- pinned:      false             -- true = full content auto-loaded in snapshot
-- product:     null | "name"     -- optional product scope
-- type:        null | "data-structures"  -- for schema files in subdirs


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
-- SETUP CONFIG: _dream_context/state/.config.json
-- Managed by: dreamcontext setup, brain commands, link commands
-- ============================================================

-- SetupConfig (written by setup.ts, read by setup-config.ts):
-- {
--   "platforms":           ["cli"],               -- PlatformId[]
--   "packs":               ["default"],           -- installed skill packs
--   "multiProduct":        false | ["api", ...],  -- multi-product monorepo products
--   -- "people": RETIRED in 0.23.0 (retire-config-roster). The roster moved to
--   -- people/people.json; `dreamcontext config people` now redirects and exits 1,
--   -- and the config merger strips a stale `people` key on sync.
--   "setupVersion":        "1.2.0",
--   "disableNativeMemory": true,                  -- disable Claude's auto MEMORY.md
--   "taskBackend":         "local" | "clickup" | "github",  -- where tasks live
--   "cloudTaskManagement": false,                 -- Advanced Config switch (remote backend in use)
--   "linkedRepos":         [                      -- bare code repos (no _dream_context/) governed by this brain
--     {
--       "name":          "api",                   -- per-project display label
--       "gitRemoteUrl":  "https://github.com/owner/repo.git"  -- canonical GitHub URL (globally unique key)
--     }
--   ],
--   "brainRepo": {                                -- cloud sync config
--     "mode":         "in-tree" | "full-repo",    -- sync mode
--     "autoSync":     false,                      -- auto-sync on sleep done
--     ...                                         -- origin, marker (full schema in brain-repo.ts)
--   }
-- }

-- LinkedRepo entry: shared {name, gitRemoteUrl} in .config.json (team-committed);
-- machine-local path registry in ~/.dreamcontext/linked-repos.json (gitignored, keyed by URL).


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
--   }],
--   "pendingMigrationNotices": ["..."]   -- written by update/sleep, cleared by sleep start
-- }
-- NOTE: session records gained "novel_tokens" + "scoring_version" (weighted
-- scoring, 2026-07-28); 0.23.0's rescale-legacy-sleep-debt migration rewrites
-- legacy records in place.


-- ============================================================
-- PEOPLE: _dream_context/people/  (0.23.0 people-first, replaces core/1.user.md)
-- Managed by: dreamcontext people *, init/setup, migration 0.23.0
-- ============================================================

-- ROSTER: people/people.json  — STRUCTURE only, never prose.
-- {
--   "version": 1,
--   "people": {
--     "<slug>": {                        -- slug: PERSON_SLUG_RE-safe, roster membership
--       "name":  "Mehmet Nuraydın",      -- display name (non-ASCII preserved)
--       "emails": ["a@b.com", ...],      -- git identity match; union-merged on sync
--       "role":  "owner" | "..."         -- free text, rendered in the snapshot roster line
--     }
--   }
-- }
-- Sorted slug keys for byte-stable merges; semantic-merge kind "people-json"
-- (key-union, ours-wins, email-union). Sanitize-on-read drops unaddressable
-- entries. Concurrency guarded by people/.people.lock (gitignored, both brain
-- repo modes).

-- CONSTITUTION: people/<slug>.md — ONE WRITER PER FILE (conflict surface zero).
-- Identity + unconditional Preferences + Communication Style ONLY.
-- The ACTIVE person's file renders VERBATIM in every snapshot (never-evict, no
-- rungs), so it is audited on the same ~4,000-char ceiling as core files.
-- Deliberately NOT indexed for recall — read with `dreamcontext people show <slug>`.

-- ACTIVE-PERSON RESOLUTION (machine-local, never written into the synced brain):
--   env DREAMCONTEXT_PERSON -> pin (activePersonSlug on .brain-local.json)
--   -> git email match -> solo fallback -> none.
-- Invariant P: charset regex AND roster membership checked at EVERY slug entry
-- point, so the env var can never traverse the filesystem.


-- ============================================================
-- MIGRATION LEDGER: _dream_context/state/.migrations.json
-- Managed by: dreamcontext update / sleep start / migrations record
-- ============================================================

-- Array of applied steps (atomic tmp+rename write; defensive read -> [] on
-- missing/malformed, never throws):
-- [{
--   "version":      "0.23.0",            -- ORDERING key only, NOT an identity:
--                                        -- two migrations may share a version
--   "step":         "split-user-file",   -- the identity; gating is per-step
--   "executor":     "code" | "agent" | "detected",
--   "timestamp":    "2026-07-30T...Z",
--   "filesTouched": ["core/1.user.md", ...],
--   "summary":      "..."
-- }]
-- The ledger — not setupVersion — is the only honest answer to "what is left to
-- do": unfinishedAgentTasks() requires a code/detected entry to exist and no
-- matching agent entry with the same step id.```