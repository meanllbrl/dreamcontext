---
id: feat_LDQn2Bi8
status: active
created: '2026-02-25'
updated: '2026-06-15'
released_version: 0.1.0
tags:
  - backend
  - architecture
  - cli
related_tasks:
  - multi-assignee-via-person-tags
  - post-sleep-clickup-sync-rate-limit-headroom-retry-no-silent-fail
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
- [x] As a developer, I want to filter `tasks list` by tag, version, priority, status, and feature so I can surface the right subset without reading all task files.
- [x] As a developer, I want to group `tasks list` output by version, priority, status, or tags so I can see planned work organized by milestone.
- [x] As a developer, I want `tasks list --json` to emit machine-readable output so I can pipe tasks into scripts and other tools.
- [x] As an AI agent, I want to RICE-score tasks (reach, impact, confidence, effort) so that work can be prioritized quantitatively.
- [x] As an AI agent, I want tasks to carry urgency and version fields so that Eisenhower Matrix and milestone grouping work correctly in the dashboard.
- [x] As a developer, I can assign multiple team members to a task using `person:<slug>` tags, with ClickUp syncing the full assignee set bidirectionally, so task assignment is multi-person and survives push/pull cycles.

- [x] As a developer, post-sleep ClickUp sync completes in a single pass without 429 errors, so bulk task pushes always reach ClickUp rather than silently dropping tasks.

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
- [x] `tasks list --tag <t>` (repeatable, AND semantics) and `--any-tag <t>` (OR semantics) filter by tags; `--version`, `--priority`, `--feature` filter by those frontmatter fields; all filters compose (case-insensitive).
- [x] `tasks list --group-by version|priority|status|tag` emits sectioned output with per-group counts.
- [x] `tasks list --json` emits the filtered result set as a JSON array suitable for piping.
- [x] `tasks list --long` shows version and tags inline alongside slug/status/priority.
- [x] `tasks tags [--all]` lists distinct tags with counts.
- [x] `tasks create` and `tasks rice` accept `--reach`, `--impact`, `--confidence`, `--effort` flags; score is computed server-side as `(reach × impact × confidence/100) / effort`.
- [x] Tasks carry `urgency` (critical/high/medium/low, default medium) and `version` frontmatter fields; CLI and dashboard both surface them.
- [x] Multiple `person:<slug>` tags on a task represent multiple assignees; dashboard renders a multi-assignee chip picker; ClickUp push/pull maps the full set to ClickUp's native `assignees[]` array bidirectionally; legacy scalar `assignee` frontmatter is still read (migrated to person tag on pull); removing a person tag that backed the legacy `assignee` clears the legacy field to avoid ghost reappearance.
- [x] ClickUp version-tag drift fixed: push diff reconciles `version:<v>` tags against LIVE remote tags from the PUT response (not the base snapshot), so exactly one version tag survives after any version change — including changes driven by a bound ClickUp version FIELD. Regression test in `tests/unit/clickup-tags.test.ts`.

- [x] ClickUp adapter throttles at 90 req/min (below the 100/min hard cap) with maxRetries=5 and Retry-After-respecting exponential backoff; SyncReport.failedPushes[] structurally tracks which task slugs failed to push; sleep done auto-retries the full sync once on any failedPushes, then surfaces a prominent red 'Task sync INCOMPLETE' error with the slug list (not a dim warning) rather than treating the partial push as success.

## Constraints & Decisions


- **[2026-06-15]** ClickUp rate-limit contract: ratePerMinute=90 (10 req/min headroom below the 100/min hard cap) ensures a full post-sleep bulk push completes in ONE window without hitting 429 at the rate-window edge. maxRetries=5 with Retry-After-respecting exponential backoff in ApiAdapter. SyncReport.failedPushes is a structural field — a partial push can never look like success. sleep done auto-retries once on failedPushes, then errors loudly if any remain.
- **[2026-06-15]** `person:<slug>` tags are the source of truth for assignment (multiple assignees supported). The legacy scalar `assignee` frontmatter field is deprecated — still readable but not written. ClickUp push sends the full set of person-tag slugs resolved to ClickUp member IDs; pull maps ALL remote `assignees` back to `person:<slug>` tags. Set deltas computed on each sync cycle (add/remove set operations) to avoid clobbering.
- **[2026-06-15]** ClickUp version-tag drift: the PUT response (not the base snapshot) is the authoritative source for live remote tags after a push. Version tag reconciliation must happen against the POST/PUT response, because a bound ClickUp version FIELD can change other tags server-side between the base snapshot and the push.
- **[2026-06-09]** `tasks list` filter flags (`--tag`, `--any-tag`, `--version`, `--priority`, `--feature`) all compose as AND; `--any-tag` is OR within its own set. Multiple `--tag` flags require ALL tags present. Case-insensitive matching throughout. `--json` uses the same filter pipeline, emitting raw JSON for scripting.
- **[2026-06-09]** RICE score = `(reach × impact × confidence/100) / effort`; computed server-side on create/update; stored in frontmatter as `rice: {reach, impact, confidence, effort, score}`. `tasks rice <name>` prints current values; `--clear` removes them. Score powers the Scatter view and RICE sort in the dashboard.
- **[2026-02-25]** Tasks live in `_dream_context/state/` as individual `.md` files (one file per task). This makes each task independently readable and allows the snapshot to glob them efficiently.
- **[2026-02-25]** Task slugs are generated via `slugify()` — lowercase, hyphen-separated. The filename is the primary identifier; the `name` field in frontmatter preserves the original display name.
- **[2026-02-25]** No delete command is intentional. Tasks are completed, not deleted, to preserve history. Users can archive manually if needed.
- **[2026-02-25]** `parent_task` field exists in the schema for potential subtask support but is not currently used by any command.

## Technical Details

**Task file location**: `_dream_context/state/<slug>.md`

**Task file schema** (current as of v0.6.0):```yaml
---
id: "task_abc123"
name: "Implement auth middleware"
description: "Add JWT validation to all protected routes"
priority: "high"          # critical | high | medium | low
urgency: "medium"         # critical | high | medium | low (Eisenhower axis)
status: "todo"            # todo | in_progress | in_review | completed
created_at: "2026-02-25"
updated_at: "2026-02-25"
tags: []
version: "v0.6.0"         # optional planning-version association
parent_task: null
related_feature: null     # feature slug for cross-link
rice:
  reach: 5
  impact: 3
  confidence: 75
  effort: 2
  score: 5.625
---```
**Commands** (`src/cli/commands/tasks.ts`):
- `tasks create <name>` — interactive or flag-driven (`-d`, `-p`, `-t`, `-w`). RICE flags: `--reach`, `--impact`, `--confidence`, `--effort` (additive).
- `tasks list` — multi-filter: `--tag` (AND), `--any-tag` (OR), `--version`, `--priority`, `--feature`, `--status`, `--all`; compose freely. `--group-by version|priority|status|tag` for sectioned output. `--long` adds version+tags inline. `--json` emits raw JSON array.
- `tasks tags [--all]` — distinct tag counts (includes completed when `--all`).
- `tasks rice <name>` — print or update RICE fields; `--clear` removes all.
- `tasks log <name> [content]` — LIFO insert into `## Changelog`.
- `tasks status <name> <status> [reason]` — bump status with automatic changelog entry.
- `tasks complete <name> [summary]` — sets `status: completed`.
- `tasks insert <name> <section> <content>` — inserts into any named section.

**Lookup logic** (`findTaskFile`): exact slug → prefix match → substring match.

**Library dependencies**: `src/lib/frontmatter.ts`, `src/lib/markdown.ts`, `src/lib/id.ts`

**Snapshot integration**: globs `state/*.md`, skips `status: completed`, shows slug/status/priority/updated date per task.

**ClickUp sync reliability (v0.9.0)** (`src/lib/task-backend/clickup.ts`, `src/cli/commands/sleep.ts`):
- `CLICKUP_RATE_PER_MINUTE = 90` (hard constant; deliberate 10 req/min headroom under ClickUp's 100/min cap).
- `CLICKUP_MAX_RETRIES = 5` with Retry-After-respecting exponential backoff in `ApiAdapter`.
- `SyncReport.failedPushes: string[]` — structural field; push loop appends slug on any error. A partial push can never silently look like success.
- `sleep done` flow: if `failedPushes.length > 0` after first sync, auto-retries ONCE (full sync, not partial). If failures persist after retry, calls `error()` (red, loud) listing all failed slugs — not `warn()`.
- Local backend (`src/lib/task-backend/local.ts`): `taskAssigneeMembers` wraps list+get in a single try/catch returning `[]` on any error (failure-isolated); `tasks-members` route folds task-derived entries (id='') to fill gaps without clobbering real IDs.

## Notes

- The task `## Changelog` section is the agent's "breadcrumb trail" — the most critical piece for cross-session continuity. Agents should log every meaningful action, not just session summaries.
- The SKILL.md instructs: "Log every session that modifies code or makes decisions." This is the cross-session continuity mechanism.
- Priority values (critical, high, medium, low) are not enforced by the CLI but are documented in the create command's interactive prompt choices.
- The snapshot only shows a one-line summary per task. Agents needing full task context should `Read _dream_context/state/<task>.md` directly.

## Changelog
<!-- LIFO: newest entry at top -->



### 2026-06-15 - Update
- ClickUp sync hardening (v0.9.0, task: post-sleep-clickup-sync-rate-limit-headroom-retry-no-silent-fail): adapter 90 req/min + maxRetries=5, SyncReport.failedPushes structural field, sleep done auto-retry + loud error. Local backend assignee-candidate fix: taskAssigneeMembers failure-isolated, tasks-members route folds task-derived entries (id='') without clobbering real IDs.
### 2026-06-15 - Update
- ClickUp version-tag drift fix (session ce29af35): push diff now reconciles version:<v> against LIVE remote tags from PUT response rather than the base snapshot; exactly one version tag survives after any version change including field-driven changes. Regression test added.
- Multi-assignee via person tags shipped (task: multi-assignee-via-person-tags): person:<slug> tags are the source of truth for assignment. ClickUp push sends full set; pull maps all remote assignees bidirectionally. Legacy scalar assignee field deprecated. Dashboard TaskDetailPanel: multi-chip picker, add picker. Ghost-reappearance fix: removing the backing person tag clears legacy assignee field. Passes multi-review (FAIL→FAIL→PASS cycle).
### 2026-06-09 - tasks list filters/grouping/JSON (#5) + RICE scoring
- `tasks list`: `--tag` (AND), `--any-tag` (OR), `--version`, `--priority`, `--feature`, `--group-by`, `--long`, `--json` — all filters compose case-insensitively. `tasks tags` added.
- RICE scoring: `--reach/--impact/--confidence/--effort` on create + `tasks rice` command; score stored in frontmatter.
- `urgency` and `version` frontmatter fields added; `related_feature` cross-link field added.
- `tasks status` command added (explicit status bump with reason).
- All shipped in issue #5; full suite green.

### 2026-03-01 - tasks list command + SKILL.md zero-tool-call fix
- Added `tasks list` command (default: excludes completed; `--all`; `-s status` filter; colored output). Consistent with `bookmark list` / `trigger list` patterns.
- Fixed SKILL.md: Auto-Loaded section now explicitly says "answer 'which tasks are active?' directly, zero tool calls needed". Task Protocol section added bold paragraph. Discovery section replaced `Glob state/*.md` with `dreamcontext tasks list`.
- Root cause: pattern inconsistency (bookmark/trigger list existed, tasks list didn't) caused agents in other projects to assume tasks list existed, wasting 5 tool calls.
- 4 integration tests added (407 total passing).

### 2026-02-25 - Created
- Feature PRD created.
