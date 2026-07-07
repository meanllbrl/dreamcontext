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

## Objectives — the OKR roadmap (task ↔ objective, many-to-many)

Objectives are **PO-authored outcomes** ("increase retention 20%", "ship v0.2.3", "launch mobile") stored one file each in `_dream_context/core/objectives/<slug>.md` — first-class, durable, recallable (`memory recall --types objective`), independent of any task. The roadmap is NOT a derived shadow of tasks and NOT a list of releases: the PO owns the structure; computation is the assist layer (rollups, forecast, slip detection).

**The load-bearing relationship:** a task declares the objectives it serves via `objectives: [a, b]` frontmatter — **many-to-many** (one shipped task often lifts revenue AND retention). The reverse direction (objective → member tasks, objective → dependents) is always **computed**, never stored — so the two sides cannot drift.

```bash
dreamcontext roadmap                                  # text board + regenerate knowledge/roadmap/board.md
dreamcontext roadmap --json                           # the typed RoadmapModel (query surface; no writes)
dreamcontext roadmap objective create <slug> --title "..." [--target YYYY-MM-DD] [--depends-on a,b] [--feature <prd-slug>] [--why "..."]
dreamcontext roadmap objective list|show <slug>       # show = members + dependents + "if this slips, so do: …"
dreamcontext roadmap objective edit <slug> [--title] [--target <date>|clear] [--status not_started|active|review|done|clear] [--feature <slug>|clear]
dreamcontext roadmap objective depend <A> <B>         # A depends on B — REJECTED at write time if it would create a cycle
dreamcontext roadmap objective undepend <A> <B>
dreamcontext roadmap objective metric <slug> [--current <n>] [--target <n>] [--baseline <n>] [--label ..] [--unit ..] [--clear]   # Key Result: --current is the common nudge
dreamcontext roadmap objective delete <slug> --yes    # also heals other objectives' depends_on
dreamcontext tasks create <name> --objectives a,b     # link at creation (slugs must exist)
dreamcontext tasks objectives <task> a,b|clear        # set/clear on an existing task
dreamcontext tasks list --objective <slug>            # all tasks serving an objective
```

**The computed model** (per objective, from `roadmap --json`):
- **Progress** = completed ÷ total member tasks (each objective counts over its OWN member set — a shared task contributes to each independently).
- **Rollup status** (real enum): all `completed`→`done` 🟢 · any `in_progress`→`active` 🔵 · any `in_review`→`review` 🟡 · else `not_started` ⚪. A manual `--status` override wins (`status_source: override`).
- **Forecast cascade — full transitive DAG:** `forecast_start = max(earliest member start, max(forecast_end of dependencies))`; `forecast_end = max(latest member due, forecast_start)`. A slip anywhere propagates to ALL transitive dependents (diamond shapes included).
- **Milestone forecast:** an objective with NO dated tasks of its own but WITH dependencies inherits its forecast from its latest dependency (finish-to-start) — so a pure milestone ("launch", which only depends on others) slips when an upstream slips. Only an objective with neither dated tasks nor a forecastable dependency stays `null` ("unforecastable") — and a null-forecast objective still never drags its dependents to "now".
- **Slipping** 🔴 = `forecast_end > target_date` (the PO's committed date). The model also exposes `slip_days` (how many days late) and `slip_upstream` (the auto-derived cause — the dependency slug(s) responsible, else empty = the objective's own tasks overrun). Surfaced in the snapshot and the board.
- **Prioritization + description:** each objective also carries `impact` (1–5), `effort` (weeks) and a one-line `description` (first body line) — rendered in the snapshot, which now surfaces current-month/quarter targets first.

**Rules for agents:**
1. **Propose, never overwrite.** Suggest `objectives:` for tasks you create or find unlabeled; an existing non-empty list is a PO decision — never change it unless the user asks.
2. **Local-only field.** `objectives` is never pushed/pulled by cloud sync backends. Do not try to map it to remote labels.
3. **Objectives are orthogonal to versions/cycles.** `version` = WHEN (the time-box); `objectives` = WHAT outcomes it serves. Both live on the task independently.
4. **`knowledge/roadmap/board.md` is auto-generated** — regenerate with `dreamcontext roadmap`, never hand-edit it. Objective files themselves are PO-authored prose — edit `## Why`/`## Notes` freely, but rollups/members are computed and don't belong in them.
5. A feature PRD *may* back an objective via the objective's `feature:` field — a convenience link, not a requirement.

### Proactive objective capture (in-session — ASK, never auto-create)

Objectives are PO-authored, so this is an **offer-and-confirm** flow, never a silent write. When, during a session, the user **states or clearly implies an outcome/goal** — an explicit target ("hedefimiz $2000 MRR", "we want to launch mobile by Q4") OR an inferred one from how they talk about direction ("we really need to grow this", "the whole point is to make it a business") — do this:

1. **Dedup first.** Run `dreamcontext roadmap objective list` and `dreamcontext memory recall "<the outcome>" --types objective`. If an objective already covers it, DON'T propose a new one — offer to update the existing one instead (or just link the current work to it).
2. **Offer it.** If it's genuinely new, ask: *"This sounds like a roadmap objective — want me to add it?"* Never create without a yes.
3. **Ask the dates.** On yes, ask for the committed window — start and target date (`--target`, and set start via `objective edit`/dashboard). Don't invent dates.
4. **Offer a Key Result.** Ask whether to track it by a number rather than member tasks: *"Track this by a metric (e.g. MRR 0→2000) or by its tasks?"* If a metric, capture `label` + `baseline`/`target` (`--metric*` flags on create, or `objective metric` after). If a Lab insight already measures this outcome (`memory recall "<outcome>" --types insight`), offer to connect it — `dreamcontext lab bind <insight> <objective>` — so `current` is measured, not asserted.
5. **Detect + propose dependencies.** From the existing objective list, infer likely `depends_on` edges ("make-it-a-business can't happen before simplified-ux and team-ready ship") and **propose them for confirmation**; on yes, apply with `objective depend <A> <B>` (the write-time cycle guard protects you). Never write a dependency edge silently.
6. **Keep the Key Result current — unless an insight feeds it.** When the session later surfaces a real observed value for a tracked objective ("MRR just hit $1,250", "we're at 400 active users"), offer to update it: `dreamcontext roadmap objective metric <slug> --current <n>`. Use a value you actually observed — never estimate. (Sleep may also refresh `--current` autonomously from observed values.) **Exception:** if a bound insight feeds the objective (`dreamcontext lab list --json` → a manifest whose `binding.objective` is the slug), `current` is *measured* — hands off; suggest `dreamcontext lab sync <insight>` instead of writing a number the next sync would overwrite. And when removing a fed objective's metric (`--clear`), disconnect the feeder first (`lab bind <insight> --clear`) — a binding with no Key Result warns on every sync.

The through-line: **you detect and propose; the PO confirms.** Every create, date, dependency, and metric write waits for a yes — matching the "objectives are PO-authored" invariant and the board-first ritual (`knowledge/visual-first-board-ritual.md`).

---

## Lab insights — curated analytics metrics

An **insight** is a named, curated **metric backed by an external source** — "Weekly Active Users from our PostHog API", "MRR from a billing script". It is a number/series that **re-syncs on demand**, never a prose document. This is the entity users mean by "create an insight", "track signups", "I want to see MRR every session".

**What an insight is NOT (route correctly):**
- NOT **knowledge** — knowledge is prose you write and maintain; an insight fetches its value from a source. Never `knowledge create` for a metric.
- NOT an **objective** — an objective is an outcome with a target date; an insight is the *measurement*. (The two connect: an insight can *feed* an objective's Key Result via binding, below.)
- NOT a raw data dump — rollup structurally caps every series at 62 points (daily→weekly→monthly coarsening by span). Insights are curated metrics, by design.

**Where it lives:** manifest at `_dream_context/lab/insights/<slug>.md` (frontmatter config + a `## Meaning` prose section that makes it recallable), cached series at `lab/cache/<slug>.json`, custom scripts at `lab/scripts/<slug>.mjs`, secrets in gitignored `lab/credentials.json`. Manifests + caches sync in the brain repo; only credentials stay local.

**How agents see it:** the SessionStart snapshot renders a **Lab** section (title / latest value / staleness / group) — answer "what's our MRR?" from it without tool calls. Deeper: `dreamcontext lab show <slug>` (cache only, no fetch) and `memory recall "<meaning phrase>" --types insight`. The dashboard has a Lab page (number/line/pie/raw cards, per-insight refresh, sync-all, tweak editing).

```bash
dreamcontext lab create <slug> --title "Weekly Active Users" [--render number|line|pie|raw] [--adapter http|script] [--group <section>] [--unit users] [--ttl 1440]
dreamcontext lab sync <slug> [--force]      # one insight (TTL-fresh is skipped unless --force)
dreamcontext lab sync --all [--force]       # every insight; exits non-zero if any fail
dreamcontext lab list [--json]              # all insights with latest value + staleness
dreamcontext lab show <slug> [--json]       # manifest + cached series (never fetches)
dreamcontext lab tweak <slug> <key> <value> # set a declared tweak (e.g. range last_1_year)
dreamcontext lab bind <slug> <objective>    # connect to an objective's KR (--value latest|series:<name>; --clear)
dreamcontext lab credentials set <key>      # hidden prompt; the ONLY way to store a secret
dreamcontext lab credentials list           # key NAMES only — values are never printed
```

**Adapters:** `http` — declarative JSON API (endpoint/headers/body templates with `{{tweak:key}}` and `{{cred:key}}` placeholders, JSON-path `extract`, multi-series split via `seriesKey`); `script` — escape hatch, `lab/scripts/<slug>.mjs` exporting a default async function. `lab create` scaffolds the manifest; edit it to set the real endpoint/extract config, then run the first sync.

**Key-Result binding (insight → objective):** a manifest `binding: {objective: <slug>, value: latest}` makes every successful sync write the objective's KR `metric.current` automatically — upgrading the roadmap from PO-asserted numbers to measured ones. Offer this whenever an insight measures an existing objective's outcome. Set it via `lab bind` (or the dashboard's objective create modal / detail panel, which search insights by name); binding is ONE feeder per objective — connecting a new insight unbinds the previous one loudly, and connecting immediately seeds `metric.current` from the cached latest.

**Sync semantics:** TTL staleness (default 1440 min) — fresh insights are skipped and reported, `--force` refetches; on failure the prior series is KEPT and the error is loud (never a silent half-sync). **Sleep does NOT run lab sync** — refresh is always an explicit user/agent action.

### Insight capture (in-session — ASK, never auto-create)

Mirrors proactive objective capture. When the user states or implies a recurring metric need ("I keep checking MRR by hand", "we should watch signups", "create an insight for DAU"):

1. **Dedup first.** `dreamcontext memory recall "<metric>" --types insight` and `dreamcontext lab list`. If one covers it, offer to update/re-sync it instead.
2. **Offer it.** *"Want me to track this as a Lab insight so every session sees the current value?"* Never create without a yes.
3. **Agree the shape.** Slug, title, render (number/line/pie/raw), group, unit — and write a real `## Meaning` section (it powers recall).
4. **Pick the source.** HTTP endpoint (+ extract path) or a custom script. Secrets go in via `dreamcontext lab credentials set <key>` — never inline in the manifest.
5. **Declare tweaks** the user will want to adjust (typed `enum`/`date`/`string`; a relative range is an enum tweak keyed `range`).
6. **Scaffold + first sync.** `lab create`, edit the manifest, `lab sync <slug>`, confirm the value looks right.
7. **Offer KR binding** if an existing roadmap objective tracks the same outcome: `dreamcontext lab bind <insight> <objective>` — connecting seeds the objective's `metric.current` from the cached latest immediately, and every future sync keeps it measured. One feeder per objective (binding a new insight unbinds the previous one loudly); disconnect with `lab bind <insight> --clear`.

Every write waits for a yes.

**Security (plain language, tell the user when relevant):** lab scripts execute **locally, in-process, with your credentials passed in** — anyone who can push to a shared brain repo can change what runs on your machine at the next sync. Review a script before its first sync and heed the loud "script changed since last run" tripwire notice. Credentials are written ONLY via `lab credentials set` (gitignore-first, file mode 0600, never printed back, redacted from every error/log).

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
start_date: null          # YYYY-MM-DD or null — planned start (range start)
due_date: null            # YYYY-MM-DD or null — due / planned end (range end)
objectives: []            # roadmap objective slugs this task serves (many-to-many, LOCAL-ONLY — never synced)
rice: { reach: 5, impact: 3, confidence: 75, effort: 2, score: 5.625 }
custom_fields: {}         # project-declared fields (only when overrides/task.md exists)
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

Features are **typed knowledge** — a feature PRD is a `knowledge/features/<name>.md` file with
frontmatter `type: feature` (plus `name`/`description`/`pinned:false`/`date` for knowledge-index
display). Retrospective product documentation, **created and updated exclusively by the sleep
agent**. During active work, everything goes in the task; sleep consolidates task content into
the matching feature. `dreamcontext features …` is a **deprecated compat alias** (prints a
deprecation notice on every call) that reads/writes `knowledge/features/` — it is not a separate
entity from knowledge.

```bash
dreamcontext features create <name> -w "Why" -d "One-line description" -t backend,api -s planning --related-tasks a,b
dreamcontext features set <name> status active
dreamcontext features set <name> tags backend,api,topic:recall
dreamcontext features insert <name> acceptance_criteria "..."   # auto-formats as - [ ]
dreamcontext features doctor                                    # staleness / orphans / dangling refs
```
Status values: `planning | in_progress | in_review | active | shipped | deprecated`. Sections: `changelog`, `notes`, `technical_details`, `constraints`, `user_stories`, `acceptance_criteria`, `why`. PRDs live in `knowledge/features/<name>.md` (flat directory under `knowledge/`; may carry `product:`); the generic knowledge index/recall channel excludes `knowledge/features/**` to avoid double-listing — features stay a distinct surface (snapshot Features section, dashboard Features tab, `--types feature` recall).

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
- **Feature PRDs** may carry `product: <name>` (still in the flat `knowledge/features/` directory).
- **Auto-injection**: the SessionStart hook resolves the active task (override `state/.active-task`, else most-recently-modified `in_progress` task). If its `product:` is in `multiProduct`, the hook injects `knowledge/products/<name>.md` into the snapshot under `## Active Product Knowledge: <name>` (capped ~200 lines). You don't load it manually — it's already in context.

If `multiProduct` is `false`/absent, treat the project as single-product and use `data-structures/default.md`.
