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

## Due dates & urgency
```bash
dreamcontext tasks due <name> 2026-07-01     # set
dreamcontext tasks due <name> clear          # clear
```
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
