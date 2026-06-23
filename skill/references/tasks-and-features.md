# Tasks & Features — full protocol

## Tasks are your working documents

All context, decisions, user stories, acceptance criteria, constraints, technical details, notes, and progress live in the **task body**. Features are retrospective product docs updated only during sleep — never put in-progress context in a feature.

The auto-loaded snapshot already lists every non-completed task with status, priority, and last-updated date. Answer "what am I working on?" / "which tasks are active?" directly from it — no tool calls. Only read the full file when you need the body (the **Changelog** section is where the previous session left off).

### Lifecycle
```
todo → in_progress → in_review → completed
```
The sleep agent picks the status that matches reality: `completed` for work that's demonstrably done, low-risk, already validated; `in_review` only when a human genuinely must verify (a behavior change, a design decision, a risky/critical-path change). It does not reflexively park everything in `in_review`, and it closes finished work — so tasks neither rot in `todo` nor rot half-closed in `in_review`.

### Create
```bash
dreamcontext tasks create <name> \
  --description "..." --priority medium --why "What this accomplishes" \
  [--version v0.9.0] [--person "Ada"] [--due 2026-07-01] [--tags backend,api]
```
Defaults: `priority=medium`, `status=todo`. A task created without `--version` auto-attaches to the **active planning version** (see Versioning).

### Enrich (insert into any section during active work)
```bash
dreamcontext tasks insert <name> user_stories "As a user, I want X so that Y"
dreamcontext tasks insert <name> acceptance_criteria "API returns 200 with paginated results"
dreamcontext tasks insert <name> constraints "Use native fetch, no axios"
dreamcontext tasks insert <name> technical_details "Key file: src/api/tasks.ts (Express router)"
dreamcontext tasks insert <name> notes "Edge case: empty results return [] not null"
dreamcontext tasks insert <name> changelog "Implemented pagination for /api/tasks"
```
Sections: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`.

### Lifecycle commands
```bash
dreamcontext tasks log <name> "what was done"        # changelog entry — MANDATORY each session
dreamcontext tasks status <name> in_progress "reason" # bump status; first in_progress auto-stamps start_date if unset
dreamcontext tasks status <name> in_review "reason"  # bump status (logs automatically)
dreamcontext tasks complete <name> "summary"         # mark complete
dreamcontext tasks delete <name> --yes               # delete (propagates to remote on sync)
```

### Filtering & discovery
```bash
dreamcontext tasks list --version S5                              # one milestone
dreamcontext tasks list --tag memoryos --tag backend --status todo  # --tag repeatable, AND
dreamcontext tasks list --any-tag lina --any-tag studio          # --any-tag repeatable, OR
dreamcontext tasks list --priority critical
dreamcontext tasks list --feature recall-engine                  # match related_feature
dreamcontext tasks list --group-by version --all                 # sectioned + counts
dreamcontext tasks list --tag lina --json                        # scriptable (use this, not awk/grep)
dreamcontext tasks tags                                           # distinct tags with counts
```
Filters compose (AND across flags), case-insensitive; version/priority/feature match exactly.

---

## RICE prioritization

Optional, additive to priority/urgency; powers the dashboard Scatter view and RICE sort.
```bash
dreamcontext tasks create <name> --reach 5 --impact 3 --confidence 75 --effort 2
dreamcontext tasks rice <name>                 # print current values
dreamcontext tasks rice <name> --effort 4      # update one field, recompute
dreamcontext tasks rice <name> --clear         # remove all RICE values
```
- `--reach` integer 1–10 · `--impact` integer 1–5 · `--confidence` one of 25/50/75/100 (%) · `--effort` person-weeks (>0, ≤52, 0.5 steps).
- Score = `(reach × impact × confidence/100) / effort`, computed server-side, stored in frontmatter.

## Dates & urgency
A task has an optional **date range** — a planned `start` and a `due`/end. Either end is independently settable or clearable, and both sync to the remote backend.
```bash
dreamcontext tasks start <name> 2026-06-25   # set planned start (range start)
dreamcontext tasks due <name> 2026-07-01     # set due/end (range end)
dreamcontext tasks start <name> clear        # clear the start
dreamcontext tasks due <name> clear          # clear the due
dreamcontext tasks create <name> --start 2026-06-25 --due 2026-07-01
```
- `start` must be **on or before** `due` — an inverted range is rejected (clear one end first).
- Setting either date on a `backlog`-tagged task **removes the `backlog` tag** (a dated task is planned, not backlog).
- Both dates render in the dashboard timeline (Gantt) and calendar views.

`urgency` (critical/high/medium/low) is the second Eisenhower axis (priority × urgency) for the dashboard matrix.

---

## People & assignees (multi-person)

Single-person projects ignore all of this. For teams:
```bash
dreamcontext config people "Ada" "Mehmet"          # set the roster (syncs ## People in 1.user.md)
dreamcontext tasks create <name> --person "Ada"    # records a person:ada tag
dreamcontext tasks tag <name> person:mehmet        # add another assignee
dreamcontext tasks tag <name> person:ada --remove  # unassign
```
- `person:<slug>` tags are the source of truth for assignment and support **multiple assignees**. The legacy scalar `assignee` field is deprecated (still read, not written).
- When a cloud backend is active, `--person`/`tag person:<slug>` **resolves the name against the real member roster** (`tasks members`): an exact or fuzzy match is canonicalized to the member's slug, an **ambiguous** match aborts (be more specific), and an unmatched name is recorded but **warns** that it won't sync until that person is a member. Assignments are never silently dropped.
- With ClickUp enabled, the full assignee set round-trips to ClickUp's native `assignees[]` bidirectionally; map each person to a member with `dreamcontext config clickup-member <person> <memberId>`. With **GitHub** enabled, `person:<slug>` tags round-trip to issue assignees (repo collaborators; a non-collaborator is skipped, never a sync error). (see [integrations.md](integrations.md)).
- `DREAMCONTEXT_PERSON` env names the current person for attribution.

---

## The Workflow flowchart (keep it in sync)

Every task file has a `## Workflow` mermaid block near the top: one node per acceptance criterion, grouped under milestone subgraphs, with status classes `done` / `active` / `todo` / `blocked`. It is the load-bearing summary of the task — drift makes future sessions misread progress.

**Whenever** you check off a criterion, start one, add/remove one, or hit a blocker → update that node's `:::class`. Then verify:
```bash
dreamcontext tasks doctor <name>     # checks flowchart ⇄ acceptance-criteria sync (all tasks if omitted)
```
And flip the matching `- [ ]` → `- [x]` in the Acceptance Criteria list immediately — don't wait for sleep.

---

## Task file schema (reference)
```yaml
---
id: "task_abc123"
name: "Implement auth middleware"
description: "Add JWT validation to protected routes"
priority: "high"          # critical | high | medium | low
urgency: "medium"         # critical | high | medium | low (Eisenhower axis)
status: "todo"            # todo | in_progress | in_review | completed
created_at: "2026-02-25"
updated_at: "2026-02-25"
tags: []                  # includes person:<slug> for assignees
version: "v0.9.0"         # planning-version association (auto-set to active planning version)
parent_task: null
related_feature: null     # feature slug for cross-link
product: null             # multi-product scoping (optional)
due: null                 # YYYY-MM-DD
rice: { reach: 5, impact: 3, confidence: 75, effort: 2, score: 5.625 }
---
```
Files live at `_dream_context/state/<slug>.md`. Lookup is fuzzy: exact slug → prefix → substring.

---

## Task format & custom-field overrides (optional)

A project can override the default task shape AND declare its own custom fields by adding **`_dream_context/overrides/task.md`**. Absent this file, everything behaves exactly as the defaults above (zero regression).

The file carries two things:

- **Frontmatter `custom_fields:`** — a user-defined field schema. Each field: `name`, `type` (`text` | `number` | `select` | `date`), optional `key` (the stable field id / `custom_fields:` map key — defaults to the snake_cased `name`, so a rename keeps the same id), `required` (`true` ⇒ the agent MUST set it on every task; default optional), `ask` (`true` ⇒ the field is a HUMAN judgment the agent must NOT guess — it asks you for the value at task-creation time; default false), `options` (for `select`), `sync` (`[clickup, github]`, default both), and optional `prompt` (a system instruction telling the agent HOW to fill the field — surfaced in your snapshot + every sub-agent briefing).
- **Body** — the task TEMPLATE the CLI scaffolds from, plus an optional `## Agent Instructions` section that sub-agents read at runtime (it is stripped from scaffolded tasks).

```markdown
---
custom_fields:
  - { name: "Team", type: select, required: true, options: [platform, growth, infra], sync: [clickup, github], prompt: "The squad that owns the touched files." }
  - { name: "Story Points", key: story_points, type: number, sync: [clickup, github] }
  - { name: "Time estimate", key: time_estimate, type: text, required: true, ask: true, prompt: "How long will this take? Answer in ClickUp shorthand, e.g. 45m, 2h 30m, 1w 2d." }
  - { name: "Sprint", type: text }
---
## Why
{{WHY}}

## Acceptance Criteria
- [ ] First criterion

## Agent Instructions
Set Team to the owning squad before starting work.
```

When an override is active its briefing (the field list, each field's `required` + `ask` flags + `prompt`, and the Agent Instructions) is injected into your SessionStart snapshot and into every sub-agent. **Each active task's custom-field VALUES are also surfaced inline** — in the snapshot's Active Tasks block and in `dreamcontext tasks list --long` — with any unset **required** field flagged `⚠ UNSET (required)`. So you always see a task's fields without opening it: follow `overrides/task.md`'s layout and **set every declared custom field** when you create or reconcile a task — REQUIRED fields are mandatory, so never create or complete a task with a required field left empty. As a hard backstop, `dreamcontext tasks create` / `complete` / `status … completed|in_review` **fail (non-zero exit) and refuse the action** when a required field is unset — naming the field plus the exact fix command. Pass `--allow-missing-required` (or set `DREAMCONTEXT_ALLOW_MISSING_REQUIRED=1`) only for an intentional draft, which downgrades the failure to a warning.

**`ask: true` fields — don't fabricate, ask.** Some fields capture a judgment only the user can make (a time estimate, a business-impact call). A field marked `ask` is flagged **[ASK THE USER]** in the briefing: when you create a task on the user's request, **ask the user for that value first** — one concise question per field, using the field's `prompt` as the framing (the `AskUserQuestion` tool if you have it, else just ask in chat) — and wait for the answer **before** creating the task. Never invent the value to satisfy a `required` gate. The one exception is a no-user context (an autonomous reconcile or a sleep cycle): there, leave the field unset and note it rather than guessing.

**Setting values:** `dreamcontext tasks create … --field team=platform --field story_points=8`, or on an existing task `dreamcontext tasks field <slug> team platform` (`clear`/omit value to clear). Values are validated against the schema (select options, number coercion) and stored under a `custom_fields:` map in the task frontmatter.

**Sync — values flow to both backends, reusing remote fields that already exist:**

| Field type | ClickUp | GitHub |
|---|---|---|
| `select` | native list custom field (drop_down) | `<key>:<value>` **label** |
| `text` / `number` / `date` | native list custom field | `<!-- dc:fields -->` **body block** in the issue |

`dreamcontext tasks provision` creates any missing custom fields/labels on the remote and **reuses (never duplicates) ones that already exist by name**. `dreamcontext doctor` validates the override and warns (never silently ignores) on a malformed one.

---

## Features (PRDs)

Retrospective product documentation, **created and updated exclusively by the sleep agent**. During active work, everything goes in the task; sleep consolidates task content into the matching feature.

```bash
dreamcontext features create <name> -w "Why" -t backend,api -s planning --related-tasks a,b
dreamcontext features set <name> status active
dreamcontext features set <name> tags backend,api,topic:recall
dreamcontext features insert <name> acceptance_criteria "..."   # auto-formats as - [ ]
dreamcontext features doctor                                    # staleness / orphans / dangling refs
```
Status values: `planning | in_progress | in_review | active | shipped | deprecated`. Sections: `changelog`, `notes`, `technical_details`, `constraints`, `user_stories`, `acceptance_criteria`, `why`. PRDs live in `core/features/<name>.md` (flat directory; may carry `product:`).

---

## Versioning & releases

Versions and releases are unified in `RELEASES.json`. A "version" is a release entry with `status: planning`; releasing flips it to `released` with a date. Lifecycle: `planning → released`.

```bash
dreamcontext core releases add --ver v0.9.0 --summary "Dashboard improvements" --status planning
dreamcontext core releases active                # print the active planning version
dreamcontext core releases active v0.10.0        # switch active planning version
dreamcontext core releases active --clear        # unset
dreamcontext core releases list -n 10
dreamcontext core releases show v0.9.0
```
New tasks without `--version` auto-attach to the active planning version, so work is always linked to a milestone. If none exists, the sleep agent creates one. The dashboard Version Manager plans and releases versions; the sleep agent reports release readiness when all of a planning version's tasks are done.

---

## Multi-product (monorepos)

`dreamcontext init` asks whether the project is a monorepo with multiple products and records the list in `state/.config.json` under `multiProduct: string[] | false`. When products are configured:

- **Per-product data structures**: `knowledge/data-structures/<product>.md` (single-product → `default.md`). Body format is a single ` ```sql ` fenced block with `-- ...` comments (the dashboard highlights it). Recall-indexed, owned by `sleep-product`.
- **Per-product knowledge**: `knowledge/products/<product>.md`. Cross-cutting knowledge stays at top-level `knowledge/`.
- **Tasks** may carry `product: <name>` in frontmatter; CLI/dashboard surface a product filter.
- **Feature PRDs** may carry `product: <name>` (still in the flat `core/features/` directory).
- **Auto-injection**: the SessionStart hook resolves the active task (override `state/.active-task`, else most-recently-modified `in_progress` task). If its `product:` is in `multiProduct`, the hook injects `knowledge/products/<name>.md` into the snapshot under `## Active Product Knowledge: <name>` (capped ~200 lines). You don't load it manually — it's already in context.

If `multiProduct` is `false`/absent, treat the project as single-product and use `data-structures/default.md`.
