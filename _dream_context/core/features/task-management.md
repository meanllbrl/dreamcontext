---
id: feat_LDQn2Bi8
status: in_review
created: '2026-02-25'
updated: '2026-06-23'
released_version: 0.1.0
tags:
  - backend
  - architecture
  - topic:cli
  - 'topic:clickup'
  - 'topic:github'
related_tasks:
  - multi-assignee-via-person-tags
  - post-sleep-clickup-sync-rate-limit-headroom-retry-no-silent-fail
  - github-task-backend
  - tasks-clearable-due-dates-start-end-date-ranges-reliably-synced-to-backend
  - clickup-sync-unmapped-person-slug-tags-silently-drop-assignee-falls-back-to-api-token-owner-assignee-picker-offers-non-member-free-text-slugs
  - per-project-format-rule-overrides-for-specialist-agents-task-feature-knowledge
  - feat-dashboard-sprint-aware-version-filter-current-completed-actions-status-sort
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
- [x] As a developer, I can set `taskBackend: "github"` with an `owner/repo` and a personal access token, so my dreamcontext tasks sync bidirectionally to that repo's GitHub Issues.
- [x] As a developer, completing a task closes its GitHub issue as `completed` and deleting a task closes it as `not_planned` (soft-delete — issue history preserved), so issue state mirrors task lifecycle without destroying history.
- [x] As a developer, my task's markdown body, changelog (as issue comments), priority/urgency/tags/version (as labels) and assignees round-trip through GitHub Issues without loss.
- [x] As a developer, I can discover which repos to sync to, test the connection, and provision the recommended `dc:*` label set on a repo from the CLI or dashboard.
- [x] As an agent/user, I can set a `start_date` alongside the existing `due_date` so that tasks have a planned date range, not just a deadline.
- [x] As an agent/user, I can clear either date outright (`tasks due <name> clear`, `tasks start <name> clear`) without editing YAML manually.
- [x] As an agent/user, the start≤due constraint is enforced at the CLI and API level so invalid ranges are rejected immediately.
- [x] As an agent/user, setting any date on a task auto-removes the `backlog` tag so the task graduates from the backlog.
- [x] As an agent/user, creating a task with `--person <name>` resolves the name against the real member roster (fuzzy match by display name / first name), so the resulting `person:<slug>` tag maps to a real member and survives a backend sync round-trip.
- [x] As a developer, unmapped `person:<slug>` tags never silently drop an assignee — the sync surface (push to ClickUp or GitHub) emits a `SyncReport.warnings[]` entry and skips the assignment, so failures are visible, not silent.

- [x] As a project maintainer, I can drop `_dream_context/overrides/task.md` into my brain to declare custom fields (name, key, type, options, sync targets, prompt) that attach extra project-specific data to every task, so tasks carry domain-specific attributes without forking the CLI.
- [x] As a project maintainer, I can mark a custom field as `required: true` so that the CLI refuses to create or complete a task (or transition it to `completed`/`in_review`) while that field is unset, preventing stale or incomplete task records from entering the done pipeline.
- [x] As a project maintainer, custom fields of type `select` sync to ClickUp as native `drop_down` list fields (provisioned by name, reusing existing fields); other types sync as `short_text` or `number` fields; `select` values sync to GitHub as `key:value` labels; all other types ride in a `<!-- dc:fields -->` body block.
- [x] As an AI agent, I receive a `renderOverrideBriefing()` in the SessionStart snapshot and every sub-agent briefing when an override is active, so I fill every custom field per its `prompt` consistently across sessions.
- [x] As an AI agent, I can see each task's current custom field values directly in the snapshot Active Tasks block (`Custom fields: key=value / key=⚠ UNSET (required)`) and in `tasks list --long`, so I know at a glance which required fields are missing without opening individual task files.
- [x] As a developer, I can set, view, and manage custom field values with `dreamcontext tasks field <slug> <key> <value>`.
- [x] As a developer, the active planning version ("current sprint") is stored in `state/.active-version.json` and re-validated against RELEASES.json on every read, so a released sprint never silently remains "active".
- [x] As an agent, setting a task to `in_progress` for the first time auto-stamps `start_date` with today (unless a start date was already planned), so the Timeline Gantt auto-populates without manual date entry.
- [x] As a project maintainer, I can mark a custom field as `ask: true` so the agent asks the user for the value at interactive task-creation time (rather than inventing it), enabling fields like time estimates where the user's judgment is required and a fabricated value would be harmful.

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
- [x] GitHub backend: `getTaskBackend()` resolves `'github'` to `GitHubTaskBackend extends LocalTaskBackend`; `github-map.ts` is pure (no I/O), maps status↔(state+state_reason+`dc:*` labels), priority/urgency/tags/version↔labels, body↔issue body, changelog↔issue comments; sync reuses `merge.ts`/`sync-state.ts`/`api-adapter.ts` unchanged (zero provider strings in the generic engine); delete = soft-delete via `state_reason: not_planned` (no hard-delete — GitHub REST limitation, user-confirmed); Projects-v2 GraphQL custom fields deferred to Tier-2. 129 tests green. Full rationale: `knowledge/decision-github-task-backend.md`.
- [x] Date ranges (PR #67): `start_date` added to `TaskFrontmatter`/`TaskData`/`CreateTaskInput`. `tasks start <name> <date|clear>` new CLI verb. `tasks due <name> clear` supported. `tasks create --start/--due`. Start≤due validated in CLI, server routes, and each backend adapter. ClickUp: `start_date` is a native field — pushed/pulled/LWW-merged/cleared symmetrically with `due_date`. GitHub: dates ride in a `<!-- dc:dates -->` block inside the issue body (composed above prose on push; parsed+stripped before 3-way prose merge on pull). `normalizeBacklogFields()` clears BOTH dates when the `backlog` tag is applied; setting any date removes `backlog`. Conformance test added to `task-backend-conformance.ts`.
- [x] Backlog precedence rule: `normalizeBacklogFields()` enforces — adding the `backlog` tag clears both `start_date` and `due_date`; setting a date removes the `backlog` tag. Applied in all three backends (local, ClickUp, GitHub) so the rule is consistent regardless of sync path.
- [x] Member resolution (PR #69): new pure matcher `src/lib/task-backend/member-match.ts` (`matchMember`): ASCII/Turkish-folded fuzzy match against the live member roster (display name and first name); returns `{ kind: 'exact'|'fuzzy'|'ambiguous'|'no-match', member?, candidates? }`. `tasks create --person <name>` and `tasks tag person:<slug>` resolve through the matcher on a remote backend — canonical slug on match, abort with candidates on ambiguous, loud warning on no-match (records intent but states it won't sync). Local backend unchanged (free-text is harmless with no remote). Covered by `tests/unit/member-match.test.ts`.
- [x] Push-path safety net (PR #69): `pushTask` in `clickup.ts` and `github.ts` splits resolved/unmapped `person:<slug>` sets and appends a `SyncReport.warnings[]` entry per unmapped slug. The task still pushes; the assignment gap is surfaced loudly in `sleep done` and `tasks sync`, not silently dropped. New structural field on `SyncReport` (`warnings: string[]`) parallel to `failedPushes`.
- [x] Dashboard picker enforcement (PR #69): `TaskDetailPanel` picker sets `allowCustom = false` on a remote backend; non-member chips already on a task flagged ⚠ "won't sync" (red dashed). `GET /api/tasks/members` route drops `id:''` stub entries when a real roster exists. Loading-window safe: `remoteBacked` defaults to `true` while `syncStatus` is `undefined` (prevents transient free-text re-enable during roster fetch).

- [x] Custom field override system (`src/lib/overrides.ts`): `loadTaskOverride(contextRoot)` parses `_dream_context/overrides/task.md` frontmatter `custom_fields:` list; absent file → null (zero-regression). Each def must have `name`, optional `key` (defaults to snake_case of name), `type` (text|number|select|date), `options` (select only), `sync` (clickup|github, defaults to both), `prompt`. Malformed entries are dropped with `warnings[]` — never thrown, never fatal to task creation.
- [x] ClickUp custom-field bridge (`src/lib/task-backend/clickup-fields.ts`): `buildSpecs(userDefs)` merges user-defined field defs into the built-in KEY_SPECS (built-in key collision → built-in wins). `matchCustomFields(defs, specs)` binds list custom fields to specs by folded name. `localFieldValue(fm, key)` reads built-in fields from their dedicated frontmatter paths; reads user fields from `fm.custom_fields[key]`. `encodeFieldValue`/`decodeFieldValue` handle drop_down option ID resolution. `userProvisionDefs(userDefs)` maps custom field types to ClickUp API types for `tasks provision`.
- [x] GitHub custom-field sync: `select` fields → `key:value` GitHub labels (via `github-map.ts`); all other types → `<!-- dc:fields -->` body block (parsed on pull, stripped before prose merge — same pattern as `<!-- dc:dates -->`).
- [x] `renderOverrideBriefing(ov)` renders a concise agent briefing (template note + custom field list with prompts); injected into the SessionStart snapshot and sub-agent briefing by `generateSubagentBriefing()` when an override is present.
- [x] `tasks field <slug> <key> <value>` CLI verb: sets a value in the task's `custom_fields:` frontmatter map; validates the key exists in the active override.
- [x] Custom field defs accept an optional `required: true` boolean. `loadTaskOverride()` passes this flag through in each `CustomFieldDef`.
- [x] Hard-fail enforcement: `tasks create`, `tasks complete`, and `tasks status <name> completed|in_review` each call `checkRequiredFields(task, override)` before mutating; if any required field is unset the command exits with code 1 and prints a descriptive error listing the unset field(s) — the action is refused. The `--allow-missing-required` flag (or env var `DREAMCONTEXT_ALLOW_MISSING_REQUIRED=1`) bypasses the check for draft/WIP use. Blast radius is CLI command paths only; the dashboard create flow does not enforce the hard-fail (it may show a warning instead).
- [x] Agent visibility of custom field values: the snapshot Active Tasks block renders per-task `Custom fields: key=value / key=⚠ UNSET (required)` when an override is active; `tasks list --long` includes the `custom_fields` map from `TaskRecord.custom_fields` in its per-task output.
- [x] `tasks status <name> in_progress` auto-stamps `start_date` with today on the FIRST transition to `in_progress` if no start date is set; isolated in the pure `shouldStampStartDate()` helper; an already-planned start date is never overwritten. No other status transition stamps.
- [x] Active planning version: `state/.active-version.json` holds `{ active_planning_version: string | null }`; re-validated against RELEASES.json on read (cleared if the version is no longer `planning`). CLI: `dreamcontext core releases active` / `dreamcontext core releases set-active <version>` / `dreamcontext core releases clear-active`. Dashboard: `GET/PUT /api/releases/active`.
- [x] `CustomFieldDef` supports `ask?: boolean`. When `ask: true`, `renderOverrideBriefing()` tags the field `[ASK THE USER]` in the briefing and emits an `ASK-FIRST:` rule block — agent asks the user for the value before creating the task (in interactive sessions) and leaves the field unset with a note in no-user contexts (sleep, autonomous reconcile). No CLI hard-fail for `ask` fields (leaving unset in no-user context is valid). Dashboard: `AddCustomFieldForm` has an "Ask me" toggle; `POST /api/task-overrides/fields` carries `ask` boolean. Architecture rationale: `[[decisions/decision-task-format-override-and-custom-fields]]`.

## Constraints & Decisions

- **[2026-06-23]** `ask: true` fields — ask-before-create for human-judgment fields: a field marked `ask` has a behavioral rule injected into the override briefing ("`[ASK THE USER]`" annotation + `ASK-FIRST:` block). The agent asks the user for the value at interactive task creation and leaves it unset (with a note) in no-user contexts (sleep/autonomous). This prevents the agent from satisfying a `required` gate by inventing a number. `ask` and `required` are orthogonal flags and may coexist on the same field. Full design: `[[decisions/decision-task-format-override-and-custom-fields]]`.
- **[2026-06-23]** Required-field hard-fail: the enforcement gate (`checkRequiredFields`) fires at `tasks create`, `tasks complete`, and `tasks status … completed|in_review`. Blast radius is CLI command paths only — the dashboard task-create flow is excluded (advisory warning only) to avoid breaking the UI for partially-filled drafts. The `--allow-missing-required` / `DREAMCONTEXT_ALLOW_MISSING_REQUIRED=1` draft escape is intentional: agents or automation pipelines may need to create skeleton tasks before fields are known. Advisory briefing alone (snapshot `⚠ UNSET`) is not sufficient to prevent stale tasks reaching done status — hard-fail is the only lever that works across stale sessions where the briefing may not be read.
- **[2026-06-23]** Agent visibility of custom field values is a two-part lever: (1) the snapshot Active Tasks block renders per-task `Custom fields:` with values and `⚠ UNSET (required)` annotations so any session sees the state at startup; (2) `tasks list --long` emits `TaskRecord.custom_fields` so scripting and sub-agent automation can read them without opening individual task files.
- **[2026-06-23]** Custom field override system (`src/lib/overrides.ts`): the override lives in `_dream_context/overrides/task.md` (inside the brain), so it survives `dreamcontext update` and travels with the project. Discovery is purely by file presence — absent file = byte-identical to shipped defaults. Malformed entries emit warnings, never exceptions (broken override must never block task creation or sync). A user-declared field key that collides with a built-in ClickUp bridge key (urgency, description, rice fields, etc.) is silently dropped — the built-in wins. gray-matter's string-interned parse cache is cloned before mutation to prevent cache poisoning across multiple `upsertCustomField` calls on the same serialized string.
- **[2026-06-23]** `start_date` auto-stamp on first `in_progress` transition: rule is pure (`shouldStampStartDate()`), isolated from the status-bump mutation path, and only fires when `start_date` is null. Existing planned start dates are never overwritten. No other status transition stamps (rationale: `in_progress` is the point at which planning turns into execution; other transitions don't mark a start).
- **[2026-06-23]** Active planning version is stored in a dedicated `state/.active-version.json` file (not in RELEASES.json or `.config.json`) because it is ephemeral mutable runtime state — it changes within a release cycle and should not pollute the canonical release ledger. Re-validated on every read so a released sprint can never linger as "active" after `mark-complete`.

- **[2026-06-23]** Member resolution shipped (PR #69): `member-match.ts` is pure (no I/O) and provider-generic — it resolves a typed name against any `TaskMember[]` slice returned by the backend's `listMembers()`. The matcher is ASCII/Turkish-folded (handles diacritics common in the team's names). On a remote backend, the CLI refuses to mint an unmappable `person:<slug>`; on a local backend it is permissive (no roster to check). Push path: unmapped slugs are skipped and logged in `SyncReport.warnings[]` — they NEVER silently assign the API-token owner.
- **[2026-06-23]** Date-range model shipped (PR #67): `start_date` is the official planned-start field; `due_date` remains the end/deadline. Backlog rule: `backlog` ↔ no dates (bi-directional; setting a date removes `backlog`; adding `backlog` clears both dates). GitHub dates ride in a `<!-- dc:dates -->` body block because GitHub Issues have no native date fields (milestone is too coarse). The `<!-- dc:dates -->` block is composed ABOVE the prose and stripped before prose-merge so it never contaminates the human-readable body diff. `tasks start` is a new top-level CLI verb to make the start-date surface as discoverable as `tasks due`.
- **[2026-06-21]** GitHub Issues backend shipped (PR #38, 129 tests green). Plain-Issues REST only; Projects-v2 GraphQL (full status-field fidelity) is Tier-2. The 4-state dreamcontext status degrades to open/closed + `dc:*` labels on plain issues. Delete = soft-delete (`not_planned` close) because GitHub REST cannot hard-delete issues. Full decision + mapping table: `knowledge/decision-github-task-backend.md`.
- **[2026-06-21]** The pluggable `TaskBackend` interface (`src/lib/task-backend/types.ts`) is the provider boundary — no provider-specific logic may cross it. Provider-generic engine (`merge.ts`, `sync-state.ts`, `api-adapter.ts`) has zero provider strings; adding a new provider means `<name>.ts` + `<name>-map.ts` only.
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

**Task file schema** (current as of v0.10.0 — includes custom_fields):```yaml
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
start_date: null          # YYYY-MM-DD or null (v0.10.0) — planned start
due_date: null            # YYYY-MM-DD or null — deadline / planned end
rice:
  reach: 5
  impact: 3
  confidence: 75
  effort: 2
  score: 5.625
custom_fields:          # populated by `tasks field` or dashboard; synced to ClickUp/GitHub per override def
  sprint_goal: "Ship auth module"
  complexity: "medium"
---```
**Commands** (`src/cli/commands/tasks.ts`):
- `tasks create <name>` — interactive or flag-driven (`-d`, `-p`, `-t`, `-w`). RICE flags: `--reach`, `--impact`, `--confidence`, `--effort` (additive).
- `tasks list` — multi-filter: `--tag` (AND), `--any-tag` (OR), `--version`, `--priority`, `--feature`, `--status`, `--all`; compose freely. `--group-by version|priority|status|tag` for sectioned output. `--long` adds version+tags inline. `--json` emits raw JSON array.
- `tasks tags [--all]` — distinct tag counts (includes completed when `--all`).
- `tasks rice <name>` — print or update RICE fields; `--clear` removes all.
- `tasks log <name> [content]` — LIFO insert into `## Changelog`.
- `tasks status <name> <status> [reason]` — bump status with automatic changelog entry. Auto-stamps `start_date` with today the FIRST time a task enters `in_progress` if it has no start date yet (an explicitly-planned start is never overwritten; no other transition stamps). Decision isolated in the pure `shouldStampStartDate()` helper (unit-tested).
- `tasks complete <name> [summary]` — sets `status: completed`.
- `tasks insert <name> <section> <content>` — inserts into any named section.
- `tasks start <name> <date|clear>` — sets or clears `start_date` (v0.10.0).
- `tasks due <name> <date|clear>` — sets or clears `due_date`; `clear` sentinel accepted (v0.10.0).
- `tasks field <name> <key> <value>` — set a custom field value in `custom_fields:` frontmatter; validates key against active override (v0.10.0).

**Lookup logic** (`findTaskFile`): exact slug → prefix match → substring match.

**Library dependencies**: `src/lib/frontmatter.ts`, `src/lib/markdown.ts`, `src/lib/id.ts`

**Snapshot integration**: globs `state/*.md`, skips `status: completed`, shows slug/status/priority/updated date per task.

**GitHub Issues backend (v0.9.0)** (`src/lib/task-backend/github.ts`, `github-map.ts`, `github-fields.ts`):
- `GitHubTaskBackend extends LocalTaskBackend` — mirrors remote to local; offline reads/writes work without network.
- `github-map.ts` (pure, no I/O): status↔(`state`+`state_reason`+`dc:*` label), priority/urgency/tags/version↔labels (`version:x` label), body↔issue body (`## Changelog` stripped), changelog entries↔issue comments (union-merge with dedup).
- Push: `completed`→closed/`completed`; `delete`→closed/`not_planned` (soft-delete); `todo`/`in_progress`/`in_review`→open + `dc:*` label; reopen→open/`reopened` + label.
- Pull: closed+`completed`→`completed`; closed+`not_planned`→local mirror removed; open→status from `dc:*` label (default `todo`).
- `sync()` reuses `merge.ts`/`sync-state.ts`/`api-adapter.ts` unchanged; `ApiAdapter` configured for `api.github.com` with Bearer auth (5000 req/hr); delta fetch uses `GET /repos/{o}/{r}/issues?state=all&since=<watermark>` with Link-header pagination. Watermark source: issue `updated_at` (ISO-8601 epoch ms).
- `provisionRemote()`: creates `dc:*` label set on the repo. `discoverContainers()`: lists user/org repos. `listMembers()`: repo collaborators. `testConnection()`: `GET /user`.
- Assignees round-trip via `person:<slug>` tags (reuses v0.8.6 person-tag system); non-collaborator assignees skipped gracefully (never a 4xx abort).
- `setup-config.ts`: `taskBackend: 'github'` + `GitHubConfig{owner, repo}`; `secrets.ts`: GitHub token via `.secrets.json` (gitignored).
- Dashboard Settings: GitHub panel paralleling ClickUp (connect, test, pick repo, provision labels).
- Token scope: classic PAT needs `repo`; fine-grained needs Issues (read/write) + Metadata.
- Projects-v2 GraphQL custom fields (full 4-state Status field) explicitly deferred to Tier-2.

**Task format override + custom fields (v0.10.0)** (`src/lib/overrides.ts`, `src/lib/task-backend/clickup-fields.ts`) — architecture rationale: `[[decisions/decision-task-format-override-and-custom-fields]]`:
- `_dream_context/overrides/task.md` — optional project file. Frontmatter `custom_fields:` list; body = scaffold template + optional `## Agent Instructions` block (stripped on scaffold, kept for agents). Absence = zero-regression.
- `loadTaskOverride(contextRoot)` → `TaskOverride | null`: parses, validates, returns `{ template, agentInstructions, customFields, warnings }`. Malformed entries dropped with warnings.
- `CustomFieldDef` shape: `{ name, key, type, options?, sync, prompt, required?: boolean }`. The `required` flag is optional (falsy = not required). Used by `checkRequiredFields(task, override)` at `tasks create`, `tasks complete`, and `tasks status … completed|in_review`.
- `checkRequiredFields(task, override)` — pure helper: returns a list of unset required field keys. Caller exits with code 1 on non-empty result. Bypassed by `--allow-missing-required` / `DREAMCONTEXT_ALLOW_MISSING_REQUIRED=1`.
- `ask?: boolean` on `CustomFieldDef` — parsed by `loadTaskOverride()`; persisted by `upsertCustomField()` (sets `entry.ask = true`). `renderOverrideBriefing()` annotates ask fields with `[ASK THE USER]` and, if any ask fields exist, appends an `ASK-FIRST:` rule block instructing agents never to fabricate the value and to ask the user at interactive task creation. Dashboard: `AddCustomFieldForm` "Ask me" checkbox; `POST /api/task-overrides/fields` carries `ask` boolean; `useTasks.ts` types carry the flag.
- Snapshot rendering: when an override is active, the Active Tasks block appends per-task `Custom fields: key=value / key=⚠ UNSET (required)`. `tasks list --long` includes `custom_fields` from `TaskRecord`.
- `upsertCustomField(contextRoot, input)` / `removeCustomField(contextRoot, key)`: atomic read-modify-write with gray-matter; clones the parsed data object to avoid cache poisoning.
- `renderOverrideBriefing(ov)`: agent-facing text listing the override + custom fields with types and prompts; injected at snapshot + sub-agent briefing time.
- `fieldKey(name)` — ASCII/Turkish-fold → snake_case → stable key; used for local map key and GitHub label namespace.
- `buildSpecs(userDefs)` (in `clickup-fields.ts`): merges user field defs into built-in KEY_SPECS for the ClickUp bridge; user fields map to `kind: 'string' | 'number'` based on type.
- `userProvisionDefs(userDefs)`: maps user field types to ClickUp API types for `tasks provision`.
- `customFieldsFor(defs, target)`: filters by sync target (clickup | github).

**Active planning version (v0.10.0)** (`src/lib/active-version.ts`):
- `state/.active-version.json` — `{ active_planning_version: string | null }`. Read-time re-validation against RELEASES.json ensures a released sprint never lingers as active.
- `getActivePlanningVersion(contextRoot)`, `setActivePlanningVersion(version, contextRoot)`, `clearActivePlanningVersion(contextRoot)`.
- `setActivePlanningVersion` throws if the version is not found in RELEASES.json or is not in `planning` status (must create the release entry first).
- Dashboard: `GET /PUT /api/releases/active` (in `src/server/routes/changelog.ts`, registered before `/:version`).

**Date range fields (v0.10.0)** (`src/lib/task-backend/`):
- `types.ts`: `TaskData.start_date?: string | null` added alongside `due_date`.
- `clickup-map.ts`: maps `start_date` ↔ ClickUp `start_date` (ms epoch ↔ ISO string), symmetric with `due_date`.
- `clickup.ts`: `pushTask` writes both fields when present; `pullTask` reads both; base-snapshot clear propagation handles both.
- `github-map.ts` extension: serialises start/due in a `<!-- dc:dates -->` block composed above the changelog-free prose body on push; parsed + stripped before the 3-way prose merge on pull; LWW-merged as scalars.
- `local.ts`: `normalizeBacklogFields()` — mutual exclusion enforcement: backlog tag → clears both dates; any date set → removes backlog tag. Applied for all backends.
- Server routes (`src/server/routes/tasks.ts`): PATCH/POST validate start≤due constraint; test coverage in `tests/unit/clickup-start-date.test.ts` and `tests/unit/github-dates.test.ts`.

**Member resolution (v0.10.0)** (`src/lib/task-backend/member-match.ts`):
- `matchMember(input: string, roster: TaskMember[]): MatchResult` — pure function, no I/O. ASCII/Turkish-fold normalization (`á→a`, `ç→c`, etc.). Tries exact slug, then exact display name, then first-name match; returns `ambiguous` rather than guessing when >1 candidate shares the same normalized first name.
- Integrated in `src/cli/commands/tasks.ts` for `tasks create --person` and `tasks tag person:<slug>` (on remote backends only).
- `SyncReport.warnings: string[]` — new field on `types.ts`, populated by `clickup.ts`/`github.ts` push paths for unmapped slugs; surfaced in `sleep done` (red) and `tasks sync` output.
- Covered by `tests/unit/member-match.test.ts`.

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

### 2026-06-23 - Task format override + custom fields + active sprint version (v0.10.0)
- `src/lib/overrides.ts`: project-local `overrides/task.md` declares custom fields (name/key/type/options/sync/prompt); `loadTaskOverride` parses + validates; malformed entries drop with warnings, never fatal. `upsertCustomField`/`removeCustomField` for atomic CRUD. `renderOverrideBriefing` injected into snapshot + sub-agent briefing.
- ClickUp bridge (`clickup-fields.ts`): `buildSpecs(userDefs)` merges user defs; `matchCustomFields` binds by folded name; `localFieldValue` reads custom_fields map for user keys; `userProvisionDefs` maps types for provision.
- GitHub: select → `key:value` labels; others → `<!-- dc:fields -->` body block (parsed/stripped on pull, same pattern as dc:dates).
- `tasks field <slug> <key> <value>` CLI verb. Dashboard: `TaskCustomFields`/`CustomFieldInput` in TaskDetailPanel; `TaskOverrideEditor`/`AddCustomFieldForm` in Settings; backed by 5 new `/api/task-overrides/*` routes.
- `state/.active-version.json` + `src/lib/active-version.ts`: active planning version with re-validation on read. `GET/PUT /api/releases/active` dashboard routes.
- `tasks status in_progress` auto-stamps `start_date` on first transition (`shouldStampStartDate()` pure helper).

### 2026-06-21 - GitHub Issues backend shipped (PR #38)
- Added GitHub Issues as the second remote task backend (129 tests green). GitHubTaskBackend extends LocalTaskBackend; github-map.ts (pure, no I/O); sync reuses generic engine unchanged. Delete = soft-delete (not_planned close). Dashboard Settings GitHub panel. Feature status bumped to in_review.

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
