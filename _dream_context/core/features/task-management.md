---
id: feat_LDQn2Bi8
status: active
created: '2026-02-25'
updated: '2026-03-01'
released_version: 0.1.0
tags:
  - backend
  - architecture
related_tasks: []
---

## Why

Work spans multiple sessions, and agents need a structured way to track what is in progress, what was tried, and what is left. Tasks provide a LIFO changelog per work item so that any new session can read a task file and immediately know exactly where the previous session left off — without relying on fragile conversational memory.

## User Stories

- [x] As an AI agent, I want to create a task with a name, description, and priority so that work is tracked from the start.
- [x] As an AI agent, I want to log progress entries to a task so that the next session knows exactly what was done and what remains.
- [x] As an AI agent, I want to mark a task complete with a summary so that completed work is recorded and excluded from the active task snapshot.
- [x] As an AI agent, I want active tasks surfaced automatically in the context snapshot so I can orient immediately without reading individual files.
- [x] As a developer, I want fuzzy task lookup by name so I don't have to type the exact slug every time.
- [x] As a developer, I want tasks stored as Markdown files with YAML frontmatter so they are human-readable and editable outside the CLI.

## Acceptance Criteria

- `tasks create <name>` creates a file at `state/<slug>.md` with YAML frontmatter (id, name, description, priority, status: "todo", created_at, updated_at, tags, parent_task) and a `## Changelog` section.
- `tasks log <name> <content>` prepends a `### <date> - Session Update` entry to the `## Changelog` section and updates `updated_at`.
- `tasks complete <name> <summary>` prepends a `### <date> - Completed` changelog entry and sets `status: completed` and `updated_at`.
- `tasks list` lists all non-completed tasks; `--all` shows all statuses; `--status <status>` filters by specific status. Output is colored (in_progress=yellow, completed=green).
- Task lookup is fuzzy: tries exact slug match, then prefix match, then substring match.
- Duplicate task creation (same slug) returns an error and does not overwrite.
- Completed tasks are excluded from the context snapshot Active Tasks section.
- Active tasks in the snapshot show: slug name, status, priority, and last updated date.
- Task IDs are generated with `generateId('task')` (nanoid-based, prefixed).

## Constraints & Decisions

- **[2026-02-25]** Tasks live in `_dream_context/state/` as individual `.md` files (one file per task). This makes each task independently readable and allows the snapshot to glob them efficiently.
- **[2026-02-25]** Task slugs are generated via `slugify()` — lowercase, hyphen-separated. The filename is the primary identifier; the `name` field in frontmatter preserves the original display name.
- **[2026-02-25]** No delete command is intentional. Tasks are completed, not deleted, to preserve history. Users can archive manually if needed.
- **[2026-02-25]** `parent_task` field exists in the schema for potential subtask support but is not currently used by any command.

## Technical Details

**Task file location**: `_dream_context/state/<slug>.md`

**Task file schema**:
```yaml
---
id: "task_abc123"
name: "Implement auth middleware"
description: "Add JWT validation to all protected routes"
priority: "high"          # critical | high | medium | low
status: "todo"            # todo | in_progress | completed
created_at: "2026-02-25"
updated_at: "2026-02-25"
tags: []
parent_task: null
---

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-02-25 - Created
- Task created.
```

**Commands** (`src/cli/commands/tasks.ts`):
- `tasks create <name>` — interactive prompts for description and priority if not provided via flags (`-d`, `-p`). Uses `@inquirer/prompts`.
- `tasks list [--all] [-s status]` — lists tasks from `state/*.md`. Default excludes `status: completed`. `--all` shows all. `-s` (or `--status`) filters by a specific status value. Output sorted by updated_at descending. Colored output. `validStatuses` includes `new` to handle non-standard status values from other projects.
- `tasks log <name> [content]` — appends to `## Changelog` section at top (LIFO). If content not provided as argument, prompts interactively.
- `tasks complete <name> [summary]` — updates `status` and `updated_at` in frontmatter, prepends completion changelog entry.

**Lookup logic** (`findTaskFile`): exact slug → prefix match → substring match, using fast-glob to enumerate `state/*.md`.

**Library dependencies**:
- `src/lib/frontmatter.ts` — `updateFrontmatterFields()`
- `src/lib/markdown.ts` — `insertToSection()`
- `src/lib/id.ts` — `generateId()`, `slugify()`, `today()`

**Snapshot integration**: `src/cli/commands/snapshot.ts` globs `state/*.md`, reads each file's frontmatter, skips `status: completed`, and formats the active task list.

## Notes

- The task `## Changelog` section is the agent's "breadcrumb trail" — the most critical piece for cross-session continuity. Agents should log every meaningful action, not just session summaries.
- The SKILL.md instructs: "Log every session that modifies code or makes decisions." This is the cross-session continuity mechanism.
- Priority values (critical, high, medium, low) are not enforced by the CLI but are documented in the create command's interactive prompt choices.
- The snapshot only shows a one-line summary per task. Agents needing full task context should `Read _dream_context/state/<task>.md` directly.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-03-01 - tasks list command + SKILL.md zero-tool-call fix
- Added `tasks list` command (default: excludes completed; `--all`; `-s status` filter; colored output). Consistent with `bookmark list` / `trigger list` patterns.
- Fixed SKILL.md: Auto-Loaded section now explicitly says "answer 'which tasks are active?' directly, zero tool calls needed". Task Protocol section added bold paragraph. Discovery section replaced `Glob state/*.md` with `dreamcontext tasks list`.
- Root cause: pattern inconsistency (bookmark/trigger list existed, tasks list didn't) caused agents in other projects to assume tasks list existed, wasting 5 tool calls.
- 4 integration tests added (407 total passing).

### 2026-02-25 - Created
- Feature PRD created.
