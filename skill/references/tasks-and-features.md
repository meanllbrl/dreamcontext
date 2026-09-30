# Tasks & Features — full protocol

## Tasks are your working documents

All context, decisions, user stories, acceptance criteria, constraints, technical details, notes, and progress live in the **task body**. Features are retrospective product docs updated only during sleep — never put in-progress context in a feature.

The auto-loaded snapshot already lists every non-completed task with status, priority, and last-updated date. Answer "what am I working on?" / "which tasks are active?" directly from it — no tool calls. Only read the full file when you need the body (the **Changelog** section is where the previous session left off).

### Lifecycle
```
todo → in_progress → in_review → completed          # the shipped four — always present
```
A project can **declare more statuses** (e.g. `planned`, `cancelled`) in `_dream_context/overrides/task.md`, each **under one of the four above** — see "Task format, custom-field & status overrides" below. Every status carries a semantic **kind** (`open | active | review | done | cancelled`), and every derived behaviour reads the kind, never the literal: a `cancelled`-kind task is terminal (hidden from `tasks list`, never overdue, out of roadmap progress on both sides, closes its GitHub issue) without being "done". `dreamcontext tasks statuses` prints the project's set with its remote mapping.

The sleep agent picks the status that matches reality: `completed` for work that's demonstrably done, low-risk, already validated; `in_review` only when a human genuinely must verify (a behavior change, a design decision, a risky/critical-path change). It does not reflexively park everything in `in_review`, and it closes finished work — so tasks neither rot in `todo` nor rot half-closed in `in_review`.

### Create
```bash
dreamcontext tasks create "Readable sentence name" \
  --description "..." --priority medium --why "What this accomplishes" \
  [--version v0.9.0] [--person "Ada"] [--due 2026-07-01] [--tags backend,api]
```
Defaults: `priority=medium`, `status=todo`. A task created without `--version` auto-attaches to the **active planning version** (see Versioning).

- **Name = a short plain sentence** describing what the task does ("Fix the login redirect loop"). Never a type-prefixed slug (`feat-x-y`) — the file slug is derived from the name automatically.
- **`--why` is mandatory.** Creation fails without a non-empty reason; `created_at` covers the "when". A task must be readable months later on its Why alone.
- **Lean scaffold.** New tasks contain only `## Why` and `## Changelog`. Every other section (`user_stories`, `acceptance_criteria`, `workflow`, `constraints`, `technical_details`, `notes`) is created on first `tasks insert` — in canonical position, before Changelog. Never insert placeholders to "complete" the shape; a section with nothing to say shouldn't exist.
- **`--neighbor-checked <slug>` / `--declined-checked <key>` — proof of having looked (sleep only).** During a sleep cycle the filing bar refuses a task whose nearest existing task is semantically close, or that looks like an idea somebody declined. Both refusals name the exact flag that lifts them, and each takes the **slug/key it named** — passing a different one is refused again. They are not bypasses: they say "I read that neighbor / that declined reason, and this is genuinely separate". A near-verbatim duplicate (the merge band) has no flag at all; fold it in instead. A person filing their own task during a background cycle uses `--by human`, which is never checked. When the CLI prints `neighbor check skipped (…)` the semantic floor is OFF for that run — do the keyword dedup yourself (`memory recall "<topic>" --types task`) and check `tasks declined` by hand.

### Declining an idea (work that never became a task)

When the user drops, cancels or says no to a piece of work that has **no task yet**, record it — otherwise the next sleep cycle sees only that it was discussed, and files it.

```bash
dreamcontext tasks decline "<topic sentence>" --reason "<why it was dropped>"   # --reason is MANDATORY, >= 20 chars
dreamcontext tasks declined [--json]                                            # what this brain has declined
dreamcontext tasks undecline <key>                                              # the decision changed — lift it
```

- **Key = the slugified topic** (`"Drop the offline mode"` → `drop-the-offline-mode`), which is what `undecline` takes and what the filing bar's refusal names. `tasks declined` prints the keys.
- **Scope: ideas only.** Work that DID become a task ends through the task lifecycle instead — a cancelled-kind status where the project declares one (else `in_review "confirm close"`), or `tasks delete --into <slug>` — and those already leave a tombstone sleep respects. `decline` therefore refuses a topic whose live task exists and points you at the status verb. A slug that is only *tombstoned* may still be declined: the task is gone, the idea can still come back.
- **`--reason` is the payload, not ceremony.** It is what a later cycle (or a teammate) reads to decide whether the decision still holds, so "no" is not a reason; the CLI enforces a 20-character floor.
- **Stored as brain content** in `_dream_context/state/.task-declined.json` (newest-first, cap 500) and it **syncs** like `.task-tombstones.json` — a teammate's sleep cycle must not re-file what you declined here.
- **How sleep uses it.** A sleep-filed task whose slug matches a declined key is refused outright with the date and reason. One that merely *looks* like a declined idea (semantic match) is refused with `--declined-checked <key>` named in the message — the specialist reads the reason and either drops the candidate or re-runs naming that key. Reversing a decision is an awake act: `tasks undecline <key>`, then file.

### Enrich (insert into any section during active work)
```bash
dreamcontext tasks insert <name> user_stories "As a user, I want X so that Y"
dreamcontext tasks insert <name> acceptance_criteria "API returns 200 with paginated results"
dreamcontext tasks insert <name> constraints "Use native fetch, no axios"
dreamcontext tasks insert <name> technical_details "Key file: src/api/tasks.ts (Express router)"
dreamcontext tasks insert <name> notes "Edge case: empty results return [] not null"
dreamcontext tasks insert <name> changelog "Implemented pagination for /api/tasks"
```
Sections: `why`, `user_stories`, `acceptance_criteria`, `workflow`, `constraints`, `technical_details`, `notes`, `changelog`. A missing section is created on first insert (before Changelog); `workflow` holds the mermaid flowchart — add it only when the task is big enough to need one (`tasks doctor` validates it against the criteria once present).

### Lifecycle commands
```bash
dreamcontext tasks log <name> "what was done"        # changelog entry — MANDATORY each session
dreamcontext tasks status <name> in_progress "reason" # bump status; first in_progress auto-stamps start_date if unset, completed stamps due_date with the real end
dreamcontext tasks status <name> in_review "reason"  # bump status (logs automatically; any declared status key works too)
dreamcontext tasks statuses                        # the project's status set: key, kind, order, colour, GitHub/ClickUp mapping
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
- `start` is always **on or before** `due`. Moving the **start** past the due date doesn't fail — the due date is pushed out by just enough to preserve the window's length (a 5-day job that starts late is still a 5-day job). Moving the **due** end before the start is still rejected, since that's a direct contradiction.
- Status transitions record real-world timing: the first `in_progress` stamps `start_date` (and reschedules a due date it would have invalidated), `completed` stamps `due_date` with the actual end date. Completing a task that never had a start means it went not-started → done in one move, so it gets today at **both** ends (and loses its `backlog` tag, since it is now dated).
- Setting either date on a `backlog`-tagged task **removes the `backlog` tag** (a dated task is planned, not backlog). The rule runs the other way too: adding the tag clears both dates. That direction is enforced in the BACKEND, so every surface inherits it — the dashboard's "Send to backlog" writes only the tag and lets the backend undate the task, rather than keeping a second copy of the rule in the UI.
- Both dates render in the dashboard timeline (Gantt) and calendar views.

`urgency` (critical/high/medium/low) is the second Eisenhower axis (priority × urgency) for the dashboard matrix.

---

## People & assignees (multi-person)

**The roster lives in `_dream_context/people/people.json`** (since 0.23.0 — `dreamcontext config people` is a redirect that writes nothing). Every person also has a constitution at `people/<slug>.md`. Full surface → [cli-reference.md](cli-reference.md#people--who-works-in-this-vault).

Single-person projects ignore most of this. For teams:
```bash
dreamcontext people add "Ada" --email ada@example.com --role backend   # roster row + people/ada.md
dreamcontext people list                           # who is on the roster; `← you` marks the active person
dreamcontext people whoami --set ada               # bind THIS machine (machine-local, never synced)
dreamcontext tasks create <name> --person "Ada"    # records a person:ada tag
dreamcontext tasks tag <name> person:kerem        # add another assignee
dreamcontext tasks tag <name> person:ada --remove  # unassign
```
- `person:<slug>` tags are the source of truth for assignment and support **multiple assignees**. The legacy scalar `assignee` field is deprecated (still read, not written).
- **`--person` defaults to the active person.** Omit it and the work is attributed to whoever this machine resolves to (`DREAMCONTEXT_PERSON` → machine pin → git `user.email` → a solo vault's only person → nothing). Pass `--person`/`--authors` explicitly only to attribute to **someone else**. On a vault with no `people/people.json` at all, author stamping stays **absent** — the field is omitted, not written empty, so an un-migrated vault's output is byte-identical to before.
- When a cloud backend is active, `--person`/`tag person:<slug>` **resolves the name against the real member roster** (`tasks members`): an exact or fuzzy match is canonicalized to the member's slug, an **ambiguous** match aborts (be more specific), and an unmatched name is recorded but **warns** that it won't sync until that person is a member. Assignments are never silently dropped.
- With ClickUp enabled, the full assignee set round-trips to ClickUp's native `assignees[]` bidirectionally; map each person to a member with `dreamcontext config clickup-member <person> <memberId>`. With **GitHub** enabled, `person:<slug>` tags round-trip to issue assignees (repo collaborators; a non-collaborator is skipped, never a sync error). (see [integrations.md](integrations.md)).
- `DREAMCONTEXT_PERSON` env names the current person for attribution — rung 1 of the resolution ladder, above the machine pin and git email. It must name a real roster slug.
- A **release** records `contributors` (derived from the changelog authors and task `person:` tags of everything it discovered, sorted, deduped, bots dropped). The key is omitted when empty.

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
- **Progress** = done ÷ total member tasks, by KIND (each objective counts over its OWN member set — a shared task contributes to each independently). A `cancelled`-kind task leaves BOTH the numerator and the denominator — abandoned work is neither progress nor remaining work.
- **Rollup status** (real enum, by kind): all live members `done`→`done` 🟢 · any `active`-kind→`active` 🔵 · any `review`-kind→`review` 🟡 · else `not_started` ⚪. Cancelled members are ignored, so an objective whose remaining tasks are all cancelled rolls up `done`. A manual `--status` override wins (`status_source: override`).
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

**How agents READ it — the ladder, before reaching anywhere else:**

1. **Snapshot.** The SessionStart hook renders a **Lab** section (title / latest value / staleness / group). "What's our MRR?" is answered from it with **zero tool calls**.
2. **`dreamcontext lab show <slug>`** — the manifest plus the **full cached series** (and per-funnel step tables for `render: funnel`), and it **never fetches**. This is the right call the moment the question needs more than the latest number: a breakdown, a trend, a month-over-month comparison, "which step leaks". The snapshot only carries the latest value, so *not knowing the series is not a reason to go outside* — it is a reason to run `lab show`.
3. **`render: app` (or any dimensional data): `dreamcontext lab query <slug> [--where][--group-by][--top]`** to slice the cached `dataset/v1` numbers, or **`dreamcontext lab body <slug> [--page][--format text|md|html]`** to read what a script-authored page actually shows — both cache-only, both never fetch. This is how you answer "what does this card show?" or "what's this insight broken down by X?" without opening the dashboard, on a body you did not author.
4. **Don't know the slug?** `dreamcontext lab list [--json]` (every insight + latest value + staleness) or `dreamcontext memory recall "<meaning phrase>" --types insight` — this is what the `## Meaning` section exists for.
5. **Stale only:** `dreamcontext lab sync <slug>` when the cache is past TTL (`--force` to refetch a fresh one).

**An MCP tool, a raw API call, or a hand-written script is the LAST resort.** If `lab/insights/` already holds the metric, fetching it another way bypasses the manifest, cache, tweaks and KR binding — and produces a number the next session cannot reproduce. A real past failure: an agent asked for revenue reached for a billing MCP while the synced Paddle series was already cached, and the project had to hand-write a memory note to stop it. When you genuinely must go outside (the insight doesn't exist, or the question needs a dimension the manifest doesn't carry), say so explicitly — and offer to `lab create` it if the user will want it again. Full rule: SKILL.md Operational Rule 13.

The dashboard's **Insights** page (Beta) is a set of **boards** (§ Boards below): cards on a 12-column grid, each drawing an insight through its render (the table below) or through blocks from the catalog, with a date-range control, refresh, tweak editing and a freshness line on every insight card.

```bash
dreamcontext lab create <slug> --title "Weekly Active Users" [--render <render>] [--size s|m|l] [--adapter http|script] [--category <board title>] [--group <section>] [--unit users] [--ttl 1440] [--board <slug>|--no-board]
dreamcontext lab sync <slug> [--force]      # one insight (TTL-fresh is skipped; --force skips the TTL, the freshness probe still decides)
dreamcontext lab sync --all [--force]       # every insight; exits non-zero if any fail
dreamcontext lab sync --all --dry-run       # what would be fetched / probed / skipped, ZERO upstream requests
dreamcontext lab sync <slug> --force-hard   # skip the TTL AND the probe: always a full fetch
dreamcontext lab list [--json]              # all insights with latest value + staleness
dreamcontext lab show <slug> [--json]       # manifest + cached series (never fetches)
dreamcontext lab tweak <slug> <key> <value> # a declared tweak, or well-known range/from/to (e.g. range last_1_year)
dreamcontext lab bind <slug> <objective>    # connect to an objective's KR (--value latest|series:<name>; --clear)
dreamcontext lab credentials set <key>      # hidden prompt; the ONLY way to store a secret
dreamcontext lab credentials list           # key NAMES only — values are never printed
```

**Renders — pick how the metric is DRAWN.** Every render below reads the same cached `Series[]` (only `funnel` takes its own payload), so switching one is a manifest edit, not a re-model. The engine's `RENDERS` list is the single source of truth: the `--render` enum, doctor's validation and the dashboard's chart registry all derive from it, and an unrecognised value degrades to `number` instead of blanking the board.

| `render` | Draws | Reach for it when |
|---|---|---|
| `number` | Latest value + Δ + inline sparkline | One figure IS the answer (MRR, WAU) |
| `line` | Multi-series trend over time | The shape of the movement matters |
| `pie` | Share of total by series | Composition — "who makes up the whole" |
| `bar` | Horizontal bar per series (latest) | "Who is biggest right now" |
| `bar_compare` | Grouped bars, series × last N buckets | Period-over-period comparison per series |
| `stacked` | Stacked bars over time | Composition *and* total, together |
| `table` | Series × latest + Δ + trend, sortable | Many series, exact numbers, scanned not eyeballed |
| `heatmap` | Week × weekday grid (daily buckets) | Rhythm — which days carry the metric |
| `raw` | The numbers, unstyled | Debugging an adapter |
| `funnel` | Routed multi-page funnel view (below) | Step-by-step conversion analysis |
| `app` | Routed, multi-page, full-screen-capable view the SCRIPT builds itself (below) | Dimensional/drill-down data, or any multi-screen interactive story — without writing a component |

**`size: s\|m\|l`, `width`, `height`** (optional legacy manifest fields) only shape the card a DERIVED board gives the insight (width 1/2/3 → 4/8/12 grid columns, height s/m/l/xl → 3/4/6/8 rows; absent, the render decides: `table` and `funnel` take two thirds). Once boards are saved, a card's place and size live in the board file (`at: {x, y, w, h}`) and are changed by dragging in Edit mode or with `lab board set`.

**Well-known tweaks — `range`, `from`, `to`.** The engine derives a time window for EVERY insight (a relative `range` like `last_30_days`, or an explicit `from`/`to` pair that out-ranks it), so those three keys are writable on any insight whether or not its manifest declares them — via `lab tweak` or the dashboard's date-range control, which is why every card and the funnel pages offer a window even when the author never declared one. A manifest that DOES declare `range` keeps its curated options (and still rejects outsiders); an undeclared one accepts the relative-range grammar and gains an implicit declaration on first write. Setting `range` clears any stored `from`/`to` — otherwise the explicit window would silently pin every later preset to the old dates. Any other knob (`country`, `cohort`, …) still has to be declared in the manifest to be settable.

**Adapters:** `http` — declarative JSON API (endpoint/headers/body templates with `{{tweak:key}}` and `{{cred:key}}` placeholders, JSON-path `extract`, multi-series split via `seriesKey`); `script` — escape hatch, `lab/scripts/<slug>.mjs` exporting a default async function. `lab create` scaffolds the manifest; edit it to set the real endpoint/extract config, then run the first sync.

**Key-Result binding (insight → objective):** a manifest `binding: {objective: <slug>, value: latest}` makes every successful sync write the objective's KR `metric.current` automatically — upgrading the roadmap from PO-asserted numbers to measured ones. Offer this whenever an insight measures an existing objective's outcome. Set it via `lab bind` (or the dashboard's objective create modal / detail panel, which search insights by name); binding is ONE feeder per objective — connecting a new insight unbinds the previous one loudly, and connecting immediately seeds `metric.current` from the cached latest.

**Sync semantics — sync only pays for change.** Three strengths:

| Run | Who asks | TTL | Freshness probe |
|---|---|---|---|
| automatic (no force) | a board opening, the page's 60 s re-check, a tab becoming visible | respected | consulted when past TTL |
| `user` (`--force`, ↻, Sync board, a tweak save) | a person or agent on purpose | skipped | consulted |
| `hard` (`--force-hard`, card menu "Force full refresh") | on purpose, distrusting the probe | skipped | skipped: always a full fetch |

TTL staleness defaults to 1440 min; age counts from the later of the last real fetch and this machine's last unchanged probe. **The freshness probe** is optional: an `http` manifest may declare `refresh.freshness: {url, method?, headers?, body?, extract: {marker, asOf?, note?}}` (resolved through the same `{{tweak:*}}`/`{{cred:*}}` placeholders as the source; credentials go ONLY to the source's own origin, compared after placeholder resolution, so a cross-origin probe carrying one is refused), and a script may `export async function freshness(ctx)` beside its default export or return `{data, freshness: {marker, asOf?, note?}}` from a normal run. A sync skips the fetch as **upstream unchanged** only when the probe's marker AND the request fingerprint (`queryKey`: resolved tweaks, window, source/script hash) both match the last real fetch; a changed tweak always fetches, a probe that throws, times out (5 s) or returns garbage falls back to a full fetch, and a real fetch is forced once the last one is older than max(24 h, 10 × TTL). The skip reason (`ttl` or `upstream unchanged`) is printed by the CLI and shown on the card; a source's `note` renders as plain text. **Freshness checks are per machine**: the time of the last unchanged probe lives in the gitignored `state/.lab-freshness.json`, so an unchanged probe never dirties the brain-synced cache. Automatic runs leave a slug alone for max(TTL, 15 min) after it failed (no retry pass); `user`/`hard` runs retry. Opening an all-fresh board starts **zero** sync jobs; a request the running job does not cover queues ONE follow-up job (the card says queued). On failure the prior series is KEPT and the error is loud (never a silent half-sync). **Sleep does NOT run lab sync** — refresh is always an explicit user/agent action, or an automation's.

### Funnel insights (`render: funnel` — the first multi-page insight)

For funnel analysis (comparative across funnels + sequential across steps), an insight can render as a **routed multi-page view** instead of a card+slide-over: the Lab card shows a top-N mini-table and opens `/lab/<slug>` (all-funnels comparison table: metric columns from the payload, sort/search, date-range presets via the `range` tweak, Δ-vs-previous-period chips, low-sample de-emphasis, multi-select→compare) and `/lab/<slug>/f/<funnelId>` (the step lane: rounded nodes left→right, drop badges, a two-click A→B conversion-arrow gesture, dimension filters, one-dimension breakdown as stacked bands or small-multiple lanes, an accessible step-table twin). Long funnels (real quiz funnels run 40-60 steps) get horizontal scroll + zoom-to-fit plus a **significant-change collapse mode** (toolbar `Collapse` + user-set threshold %, URL `clt`): runs of steps whose adjacent change is below the threshold fold into one node showing start → end users + a step-count chip — cumulative drops stay visible, never hidden. Filters, breakdown, compare set, pinned arcs, collapse threshold, and sort all live in the URL — a copied link reproduces the exact view.

**Columns are the reader's choice.** The overview table's **Columns** popover lists every available column as a checkbox, grouped and scrolled: the payload's *Metrics*, plus **derived step columns computed client-side** from `steps` — *Step conversion* (one per adjacent pair of the union step order, "A → B %") and *% of top* (one per step). Derived columns align by step KEY across funnels, so a funnel missing that step renders "—" rather than a fabricated 0, a zero denominator is "—" rather than ∞, the low-sample rule de-emphasizes derived rates exactly as it does payload ones, and a Δ chip appears only where the previous period has BOTH of the rate's steps. They cost nothing to add — the `funnel-set/v1` contract is unchanged. Defaults are exactly the payload's metric columns (every derived column starts off); sort and copy-as-Markdown follow whatever is visible; **Reset** returns to the default set. The selection rides the URL `cols` param **and** writes through to per-machine lab prefs keyed by insight slug — a shared link shows the sender's columns (URL wins), your own machine remembers yours otherwise, and keys naming columns the payload no longer has are dropped silently.

**Payload contract (`funnel-set/v1`):** instead of `Series[]`, the adapter (script or HTTP) returns ONE object:

```jsonc
{ "kind": "funnel-set/v1",
  "primary": "users",                    // metric driving the card value + default sort (optional)
  "low_sample_threshold": 30,            // rows under this top-step n render de-emphasized (optional)
  "benchmarks": { "finish_rate": { "floor": 1, "target": 3 } },   // cell tinting, off when absent (optional)
  "dimensions": [                        // filter/breakdown declarations
    { "key": "language", "label": "Language", "mode": "client" },            // segments below carry the data
    { "key": "country",  "label": "Country",  "mode": "refetch", "tweak": "country" }  // value → tweak + re-sync
  ],
  "funnels": [{
    "id": "516", "name": "en-start-516",
    "meta": { "url": "…", "hypothesis": "…" },                    // free-form, shown in the detail rail
    "metrics": { "users": { "v": 33, "format": "count", "prev": 40 } },  // format: count|pct|usd|x|seconds|number; prev optional
    "steps": [ { "key": "session_start", "label": "session_start", "users": 33 } ],  // ORDER = step order; key aligns across funnels/periods
    "segments": [ { "dims": { "language": "en" }, "users": 21, "steps": [ { "key": "session_start", "users": 21 } ] } ]  // DISJOINT cells, optional
  }]
}
```

The engine validates + caps the payload (max 40 funnels, 64 steps — over-cap keeps first 63 + the final step, 8 dimensions; per-dimension values beyond the top 8 collapse into "Other"; 64 segment cells; 400 KB — every cap is a loud notice, never silent), synthesizes legacy `series` from step users (so `latest`, KR binding, and the snapshot keep working), and records a bounded per-sync snapshot trail. **Δ vs previous period:** an adapter-provided `prev` wins; otherwise the engine compares against the best equal-length history snapshot ending at/before the current window — and shows NOTHING when no honest comparison exists. `lab create <slug> --render funnel --adapter script` scaffolds the `range` tweak (7d/28d/90d presets) plus a fully documented script template; `lab show <slug>` prints per-funnel step tables with the worst drop highlighted. Legacy `Series[]` payloads under `render: funnel` still render (compact bar list). Data FEEDING stays out of Lab scope — sleep never syncs funnels either.

### App insights (`render: app` — a script builds its own multi-page, interactive, full-screen body)

> **LEGACY since Insights v2 (2026-09-29).** Existing `app/v1` insights keep working unchanged (they draw through a board's `insight` block, with the `lk-` kit), and `app` stays the answer for a genuinely multi-page, routed, full-screen body. For a one-screen custom view over data you already sync, reach for a board **`html` block** instead (§ Boards): it binds declared inputs, uses the full `dc-` kit, can be saved to the vault library and reused, and needs no script change.

The `funnel` render above is hand-written React — the ONE multi-page view the platform built for a specific analysis shape. `app` generalizes that: **a script author builds a multi-page, interactive, full-screen-capable body itself, with no React component written for them.** If the user wants "the funnel insight's shape, but for my own data", this is the render — never a hand-built dashboard, never a request to platform-engineer a new insight type.

**How it's created, end to end:**

```bash
dreamcontext lab create <slug> --title "…" --render app --adapter script
```

This scaffolds `lab/insights/<slug>.md` (with the `range` tweak pre-declared, same as `funnel`/the old `breakdown`) and a fully documented `lab/scripts/<slug>.mjs` template. Edit the template's real query, then `dreamcontext lab sync <slug>`. The script returns **`{ data, app }`** — two independent halves, never conflated:

- **`data`** — MANDATORY, the queryable numbers. Typically a `dataset/v1` bundle (below); may also be plain `Series[]`, a `funnel-set/v1`, or a `matrix/v1` payload — whatever shape the numbers actually are. Feeds `latest`, KR bindings, `lab show`, `lab query`, and the Rule-13 read ladder exactly like a bare return would. `{ app }` with no `data` fails the sync loudly — a body is never a substitute for the numbers, same rule `html/v1` has always enforced.
- **`app`** — OPTIONAL-shaped-as-mandatory-for-this-render: `{ kind: 'app/v1', entry, pages: [...], card?, shell? }`. `entry` names the page shown at `/lab/<slug>`; `card` (optional) names a different page for the board card preview, defaulting to `entry`; `shell` (optional) is CSS/JS that wraps every page (`shell.style`, `shell.script`). Each page is `{ id, title, html, dataset? }` — `id` is URL-safe (`[a-z0-9][a-z0-9-]*`, unique), `dataset` names which of `data`'s datasets `lab.data()` defaults to on that page. Caps: ≤12 pages, ≤300 KB for the whole spec (host-served data means the html itself should not need to embed numbers) — every violation is a loud sync-time reject, never a silent truncation (a missing/colliding page id would break a real route and every deep link into it, so there is nothing safe to collapse the way a matrix row is).

**`dataset/v1` — the plural successor to `matrix/v1`, for the numbers:**

```jsonc
{ "kind": "dataset/v1",
  "primary": "breakdown",                // the key lab.data()/lab query resolve to with no key given
  "datasets": [{
    "key": "breakdown",
    "dims": [                            // 1-3 dims — SAME grammar as matrix/v1: [0]=rows, [1]=cols, [2]=filter chips
      { "key": "funnel", "label": "Funnel" },
      { "key": "language" }
    ],
    "rows": [{ "d": { "funnel": "F3000", "language": "TR" }, "v": 119000, "n": 4200 }],
    "total": { "v": 255000, "n": 9100 }  // optional — feeds the card value + KR binding
  }]
}
```

An app can carry several named datasets (≤12), one per page or shared — each validated by the exact same dimensional grammar and caps `matrix/v1` uses (per-dim values beyond top-8 collapse to "Other", ≤400 rows per dataset, notices are loud never silent). **Never bake dimension values into series names** — the anti-pattern this whole lineage (matrix/v1 → dataset/v1) exists to kill.

**Interactivity already works — it always has.** Every `app/v1` (and `html/v1`) page is drawn in a network-less sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`, srcdoc CSP `default-src 'none'`), and an inline `<script>` tag inside that html **runs**. This has been true since the very first `html/v1` card shipped; it was never written down, so nobody built on it. Write real `<script>` — buttons, `fetch`-free client-side computation, DOM updates — against the page's own data. What the sandbox forbids is reaching the network (fetch/XHR/beacon/remote image all die silently) or the parent page; it does not forbid the page from being alive.

**How it goes multi-page.** Declare more than one entry in `app.pages`; each becomes a route:

- `/lab/<slug>` — the `entry` page.
- `/lab/<slug>/p/<pageId>` — any other declared page, deep-linkable and Back-button-safe (real history entries, same as funnel's `/f/<funnelId>`).

From inside a page's own script, `lab.navigate('otherPageId', { optionalParam: 'value' })` switches pages — the host pushes the new URL, and the previous page's iframe is torn down and a fresh one mounted for the new page (a page never mutates in place; switching pages is always a remount, which is also what keeps the security model in the pattern doc sound). `lab.onRoute(callback)` fires when the CURRENT page's params change without a page switch (in-page navigation).

**How it goes full screen.** Append `?fs=1` to the insight's URL (or click "⛶ Full screen" in the page toolbar) — the whole page becomes the app body, no dashboard chrome. **Escape** exits (there's also a visible "Exit full screen" button, because a sandboxed iframe's own key events never bubble to the host page once focus is inside it — Escape only works when focus is still on the host). This is a URL-driven CSS overlay, not the browser's native Fullscreen API, specifically so it deep-links, survives a reload, and is scriptable/testable.

**The author API — the host injects it, you don't build any of it:**

| Call | Does |
|---|---|
| `lab.page` | This page's own id (string) |
| `lab.params` | This page's current params (object) |
| `lab.navigate(pageId, params?)` | Switch to a declared page, optionally with params |
| `lab.data(datasetKey?)` | `Promise` resolving to the named `Dataset` from `data` — omit the key to get the page's declared `dataset`, else the bundle's `primary`, else the first. Numbers come from the HOST (embedded at sync time) — this is never a network fetch. |
| `lab.onRoute(callback)` | Fires `(pageId, params)` on in-page navigation |

**Height is automatic — the author does nothing.** The page's own content height is measured and reported to the host continuously (a `ResizeObserver` plus a load/click re-check for late-loading fonts or images); the host resizes the card/page/full-screen frame to match. There is no height to set and no height field in the manifest — write the page like a normal document and it fits. **One bound, and it is the BOARD's, not yours: the card preview is clamped to 120–320px** (a taller tile would set its whole grid row's height and strand its neighbours in whitespace), while the page and full-screen frames are effectively unbounded. So put the depth on a page and let the card be a preview — and do NOT shrink type below the kit's scale to squeeze a card: a body over the cap keeps its own scrollbar and reads in full when opened. `size` in the manifest picks the card's COLUMN span (`s`/`m` = 1, `l` = 2), never its height.

**`lab.navigate` params are capped, and a bad value is DROPPED, never truncated.** Params can reach the real, shareable browser URL (Copy-link included), so: ≤8 params, keys matching `[a-z0-9_-]{1,24}`, values ≤64 chars, ≤256 chars total. A value over the cap is **dropped entirely, not cut short** — a truncated value would silently show the wrong view (e.g. a truncated filter id that happens to match some OTHER real value) with no sign anything was wrong; a dropped one is visibly absent. Every drop logs a console warning naming the key. Design params to stay well under these caps — they are for "which tab/filter is open", not for carrying data (`lab.data()` is what carries data).

**Reading a body you did not author, from the terminal:**

```bash
dreamcontext lab show <slug>                  # page list (entry marked) + one pivot per dataset
dreamcontext lab body <slug> [--page <id>] [--format text|md|html]   # what a page actually renders
dreamcontext lab query <slug> [--dataset <key>] [--where k=v] [--group-by <dim>] [--top <n>]  # slice the numbers
```

None of these fetch — all three read the cache. This is how an agent answers "what does this card show?" or debugs/reviews a body written by someone (or something) else, without opening the dashboard. `--json` on all three for machine consumption.

`lab create <slug> --render app --adapter script` scaffolds the `range` tweak + the documented `{ data, app }` template above. Best-practice pattern (the security model, the bridge contract, why it's safe without relaxing the sandbox) → the `sandboxed-app-bridge-pattern` knowledge pattern.

### Breakdown insights (`render: breakdown` — the `matrix/v1` contract, DEPRECATED for new insights)

> **DEPRECATED as an authoring path (2026-08-26).** `lab create --render breakdown` no longer scaffolds a script template, and the render decision table no longer routes new dimensional work here — use `app` + `dataset/v1` instead (above), which carries the identical dims/rows/total grammar in a plural, multi-page-ready shape. **Existing `breakdown` insights are grandfathered: they keep rendering exactly as before, and no migration is forced.** This section is kept for reference against those existing insights, not as a guide for new ones.

For DIMENSIONAL data — a value broken down over 1-3 dimensions (funnel × language, plan × country) — the adapter returns ONE matrix object instead of `Series[]`. **Never bake dimension values into series names** ("F3000 · TR · 119k" is the anti-pattern this contract exists to kill):

```jsonc
{ "kind": "matrix/v1",
  "dims": [                              // 1-3, ORDER MATTERS: [0]=pivot rows, [1]=columns, [2]=filter chips
    { "key": "funnel", "label": "Funnel" },
    { "key": "language" }
  ],
  "rows": [                              // one row per dim-value combination
    { "d": { "funnel": "F3000", "language": "TR" }, "v": 119000, "n": 4200, "prev": 101000 }
  ],                                     // v = the value; n (optional) = sample size (n<30 renders de-emphasized);
                                         // prev (optional) = previous equal-length period — wins over history-derived Δ
  "total": { "v": 286000, "n": 9125 },   // optional grand total — feeds the card value + KR binding (loud warn if bound and absent)
  "unit": "USD"                          // optional unit override
}
```

The engine validates + caps it (≤3 dims; per-dim values beyond the top 8 collapse into "Other"; ≤400 rows, the tail merges into one all-Other row; 200 KB hard reject — every cap is a loud notice, and `doctor` re-flags a stored cache that violates one), synthesizes legacy `series` from the rows, and — the important part — **appends a DATED snapshot to `matrixHistory` on every successful sync** (count cap 60 AND a byte cap together). The matrix itself is a snapshot, not a time series: **the history trail IS the time axis**, so a daily sync cadence is what builds a dated trail. Δ vs previous period: a row's `prev` wins; else the equal-length (±25%) history snapshot; no honest comparison → no Δ shown. `lab create <slug> --render breakdown --adapter script` scaffolds the `range` tweak + a documented script template; `lab show <slug>` prints the pivot; legacy `Series[]` under `render: breakdown` still renders (bar-list fallback).

### HTML card bodies (`html/v1` hybrid — typed renders first, single-page)

> **LEGACY since Insights v2 (2026-09-29).** Existing `html/v1` bodies keep rendering exactly as before through a board's `insight` block (the `lk-` kit stays for them). Do not write NEW script-embedded html bodies: a custom card is a board **`html` block** (§ Boards), which is decoupled from the sync script, bound to data by declared inputs, and reusable from the vault library.

A script may return `{ data, html? }`: **`data` is MANDATORY** (exactly what a bare return would be — the numbers keep feeding `latest`, KR bindings, Δ, board blocks, `lab show` and the Rule-13 read ladder; `{ html }` alone fails the sync loudly), `html` is an OPTIONAL card body, ≤300 KB (over-cap = loud sync failure, never truncated). The dashboard draws it in a **network-less sandboxed iframe** (`sandbox="allow-scripts"` with NO same-origin grant + a `default-src 'none'` CSP — it can animate and compute against the data embedded at sync time, but it cannot fetch, beacon, or touch the parent origin), and the detail panel always shows the typed data TWIN next to it, so a screen reader is never locked to the iframe. **Rule: reach for a typed render first; write `html` only when the render vocabulary cannot express the card in ONE screen — reach for `app` (above) the moment it needs more than one page** — and use the `lab-html-kit.css` classes instead of your own CSS (`lk-title`, `lk-value`, `lk-label`, `lk-muted`, `lk-delta--up/down`, `lk-stat`, `lk-chip`, `lk-table`, `lk-bar`/`lk-bar-fill--N`, `lk-low-sample`, `lk-empty`): the kit ships embedded with the current theme's design tokens, so a kit-classed card looks native dreamcontext in light and dark and repaints on theme change. A run whose script returns no `html` clears any prior body — stale presentation is worse than none. `app/v1` pages draw against the SAME kit and the SAME sandbox/CSP guarantee — `html/v1` is simply the one-page, no-bridge case of it. **Height is automatic here too, on exactly the same terms** (the body measures itself and the host resizes to match; fixed at 232px until 2026-09-08, which quietly pushed authors to shrink type until it fit — the opposite of why the kit exists): the CARD is clamped to 120–320px because that bound belongs to the board grid, and the DETAIL panel is effectively unbounded, so a long body reads in full when opened rather than being written small. There is no height field to set — if the card needs more than one screen of its own, that is the signal to make it an `app`.

### Boards (the Insights page, Beta — `lab/boards/<slug>.md`)

A **board** is a composed page over insights you already track: **cards** on a 12-column grid (a row is 56 px), each card a stack of **blocks**. A board OWNS NO DATA and has no sync path of its own; its blocks read insight caches. Boards replace the old categories, groups and Reports (Reports and their AI commentary were removed; an old `lab/reports/` folder in a vault is left untouched and ignored).

```yaml
# lab/boards/growth.md (frontmatter = the spec, body = optional prose)
title: Growth
order: 1
cards:
  - id: c-signups                  # unique within the board (React key, brain-sync merge key)
    at: {x: 0, y: 0, w: 4, h: 3}   # 12 columns; h in rows
    title: Signups                 # optional; defaults to the primary insight's title
    insight: daily-signups         # optional primary: detail panel, refresh, range, tweaks
    blocks:                        # optional; absent = one `insight` block (the insight drawn exactly as before)
      - stat: {data: daily-signups, delta: prev, spark: true}
      - line: {data: daily-signups, area: true, color: 2}
```

A binding is `data: "<insight>"` or `"<insight>/<datasetKey>"` (a `dataset/v1` key). **The block catalog** (`dreamcontext lab block list [--json]` prints every type, the frames it accepts and its options). Every option lives in ONE place, the engine catalog in `src/lib/lab/blocks.ts` (EN and TR labels); the dashboard inspector is generated from it, `lab board set` validates against it, and the table below is generated from it too (a lockstep test fails when they drift). An unset option takes its default:

<!-- block-catalog:start (generated from dashboard/src/generated/block-catalog.json; see tests/unit/lab-block-catalog-doc.test.ts) -->
| block | option | what it sets | values | default |
|---|---|---|---|---|
| `stat`: One number with its change and a sparkline. | `delta` | Change | `none`, `prev` | `none` |
|  | `spark` | Sparkline | `true`, `false` | `false` |
|  | `unit` | Unit | text | unset |
|  | `format` | Format | `number`, `compact`, `percent`, `currency` | `number` |
|  | `series` | Series | list of names | unset |
|  | `size` | Size | `sm`, `md`, `lg` | `md` |
|  | `goal` | Goal | number | unset |
| `line`: Series over time. | `area` | Fill area | `true`, `false` | `false` |
|  | `color` | Color | number 1 to 8 | `1` |
|  | `series` | Series | list of names | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `curve` | Curve | `linear`, `smooth`, `step` | `linear` |
|  | `points` | Points | `auto`, `always`, `never` | `auto` |
|  | `yMin` | Y axis starts at | `auto`, `zero` | `auto` |
|  | `reference` | Reference line | number | unset |
|  | `referenceLabel` | Reference label | text | unset |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `bar`: Values side by side. | `orientation` | Orientation | `h`, `v` | `h` |
|  | `color` | Color | number 1 to 8 | `1` |
|  | `comparePrev` | Compare with previous period | `true`, `false` | `false` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `series` | Series | list of names | unset |
|  | `valueLabels` | Value labels | `true`, `false` | `true` |
|  | `topN` | Top N, rest as Other | number 1 to 50 | unset |
|  | `group` | Several series | `grouped`, `stacked` | `grouped` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
| `stacked`: Parts of a whole over time. | `color` | Color | number 1 to 8 | `1` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `series` | Series | list of names | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `mode` | Shape | `bar`, `area` | `bar` |
|  | `normalize` | Show as 100% | `true`, `false` | `false` |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
| `pie`: Shares of a total. Seven or more slices draw as bars. | `donut` | Donut | `true`, `false` | `false` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `centerTotal` | Total in the center | `true`, `false` | `false` |
|  | `labels` | Slice labels | `legend`, `outside`, `inside`, `none` | `legend` |
|  | `topN` | Top N, rest as Other | number 1 to 50 | unset |
|  | `color` | Color | number 1 to 8 | `1` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `table`: Rows and columns of numbers. | `columns` | Columns | list of names | unset |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `density` | Density | `compact`, `comfortable` | `compact` |
|  | `bars` | Data bars | `true`, `false` | `false` |
|  | `deltaColor` | Color the change | `true`, `false` | `true` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `heatmap`: Intensity across two axes. | `color` | Color | number 1 to 8 | `1` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `scale` | Color scale | `sequential`, `diverging` | `sequential` |
|  | `cellLabels` | Values in cells | `true`, `false` | `false` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `funnel`: Step by step conversion. | `compact` | Compact | `true`, `false` | `false` |
|  | `showConversion` | Conversion rates | `true`, `false` | `true` |
|  | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `layout` | Layout | `bars`, `flow` | `bars` |
|  | `markWorst` | Mark the biggest drop | `true`, `false` | `false` |
| `pivot`: One dimension down, another across. | `rows` | Rows | text | unset |
|  | `cols` | Columns | text | unset |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
| `text`: Markdown notes and headings. | `markdown` | Text | markdown | unset |
| `callout`: A highlighted note. | `tone` | Tone | `info`, `success`, `warning`, `danger` | `info` |
|  | `markdown` | Text | markdown | unset |
| `tabs`: Panels of blocks, one visible at a time. Tabs do not nest. | `tabs` | Tabs | `[{label, blocks: [...]}]` | unset |
| `filter`: Chips that filter the blocks bound to the same dataset. | `dim` | Dimension | text | unset |
| `html`: Your own markup in a sandbox, fed only the inputs it declares. | `html` | HTML | inline HTML | unset |
|  | `ref` | Library block | text | unset |
|  | `inputs` | Inputs | `{name: <binding>}` | unset |
| `insight`: The insight exactly as it renders on its own. | `page` | Page | one name (pick: app-pages) | unset |
|  | `nav` | Page tabs | `true`, `false` | `false` |
| `breakdown`: Chips per dimension that select one measured path for the funnel blocks in the card, and pin paths as compare lanes. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `dims` | Breakdowns | list of names (pick: dims) | unset |
|  | `counts` | User counts | `true`, `false` | `false` |
|  | `lanes` | Compare lanes | `true`, `false` | `true` |
| `trend`: The selected path's metrics day by day. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `metrics` | Metrics | list of names (pick: metrics) | unset |
|  | `chart` | Chart | `line`, `bar` | `line` |
|  | `switch` | Metric switch | `true`, `false` | `true` |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `benchmark`: Each metric against its floor and target on one ruler. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `metrics` | Metrics | list of names (pick: metrics) | unset |
|  | `comparePrev` | Compare with previous period | `true`, `false` | `true` |
|  | `sources` | Band sources | `true`, `false` | `true` |
| `segments`: One row per value of a dimension, under the current selection. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `by` | Split by | one name (pick: dims) | unset |
|  | `metrics` | Metrics | list of names (pick: metrics) | unset |
|  | `bands` | Band colors | `true`, `false` | `true` |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `density` | Density | `compact`, `comfortable` | `compact` |
<!-- block-catalog:end -->

How the chart options read. `format`: `auto` groups digits below 10,000 and turns compact above (12.4K), `percent` expects a fraction (0.25 shows 25%), `currency` uses the unit when it is a 3-letter code. `color` is the first palette slot (1 to 8); colours follow the entity, never its rank, so a filter, a legend toggle or a series pick never repaints a survivor, and a 9th series or an Other bucket is grey. `topN` keeps the N largest and folds the rest into one Other row (grey, always last); `normalize` shows each x as 100%; `sort`, `topN` and `normalize` change the VALUES, so `lab board show` prints them too. `legend` places the series legend (a single series never gets one); clicking a legend item hides that series. `axes` and `grid` only change chrome. A pie with 7 or more slices kept draws as bars. `filter` narrows every sibling block bound to the same dataset, client-side, with zero sync requests; `tabs` never nest; `text` and `callout` markdown is sanitized with remote images stripped; `insight` is the whole insight exactly as its render draws it (the migration path; html/v1 and app/v1 bodies keep the `lk-` kit there).

Static options run in ONE fixed order, `where` → interactive filter → `sort` → `limit`, and a table's total is computed after filtering and before the limit, so a filtered board never shows the total of a pre-cut list. `lab board show` and the dashboard run the same code and print the same values.

**Opening a legacy vault writes nothing.** With no `lab/boards/` the boards are DERIVED: one per manifest `category` (uncategorized → "Other"), in the saved tab order from `state/.lab-prefs.json` (prefs that only ever lived in one browser's storage are invisible to the server, so cards then fall back to manifest order), each `group` a full-width heading, legacy width/height mapped onto the grid. The **first edit** (UI or CLI) materializes ALL boards at once, atomically, into `lab/boards/`; after that an insight on no board is **unplaced** (the Add card menu lists it first). `lab create` places a new insight on the board titled like its `--category`, else the first board (`--board <slug>` picks one, `--no-board` opts out).

**Editing.** In the dashboard, Edit mode drags and resizes cards on the grid (below 720 px the board is one read-only column), the card menu edits blocks in the **inspector** (type, data, options, all generated from the catalog; ⌘Z undoes), and **Add card** offers an insight, a catalog block, or custom HTML. Saves are rev-checked: a board changed elsewhere (a teammate, an agent, a sync) reloads with a notice instead of being overwritten, and a failed save keeps the edit pending with a Retry. Agents edit the same files through the CLI (`lab board create|add-card|set|validate|remove-card|delete`), which validates strictly: every problem names the card id, the block path and the fix.

**Custom HTML blocks and the vault library.** An `html` block runs its markup in the same network-less sandbox Chat uses (no network, no same-origin, `default-src 'none'`) with the full **`dc-` kit** (the Chat kit's classes, tabs and diagrams), fills its grid cell (a tall body scrolls inside it) and repaints on theme change. It gets data ONLY through the inputs it declares: `inputs: {revenue: mrr-by-plan/plans}` makes `lab.data('revenue')` resolve to that input's frame (`lab.inputs` lists the declared names); any other name is refused. Save a block to the vault library with the inspector's "Save to library" or `dreamcontext lab block save <slug> --file block.html --inputs revenue:table`; it lands in `lab/blocks/<slug>.md` (frontmatter `title`, `description`, `inputs: [{name, kind}]`, body = the HTML) and any card reuses it with `- html: {ref: <slug>, inputs: {revenue: <binding>}}`.

**Trust statement (what an HTML block can and cannot see).** Caches already sync with the brain, so a declared input exposes nothing a teammate does not already have. The allow-list separates a library body's author from the card's author: the body can only read the names the card binds. Local-only material (credentials, `state/.secrets*`, anything outside `lab/cache/`) never reaches a frame: every read goes through the hardened cache reader, so a symlinked cache, a `../` or a `%2F` in a binding yields no data. HTML blocks carry no script-hash tripwire (they render the moment a board opens), which is exactly why they only ever get declared, already-synced data. App shortcuts do not reach into a focused HTML block (no shortcut bridge; click outside first).

**Brain sync.** Board files merge semantically (`lab-board` class): cards union by `id`, a card changed on both sides keeps ours, a card deleted on one side and changed on the other is kept and reported, overlaps are resolved on the grid. A board file left with conflict markers opens as an error board (read-only, "Open file") until fixed. Library blocks (`lab/blocks/*.md`) merge as prose. Per-machine state stays local: `state/.lab-prefs.json` (active board, legacy tab order, funnel columns) and `state/.lab-freshness.json` are never synced.

### Funnel explorer (board blocks over a funnel set)

A funnel explorer is ONE synced insight whose pages are board blocks: each page can sit on its own card, or the whole explorer can be one interactive card. Pick-type options (`funnel`, `dims`, `metrics`, `by`, `page`) take names from the synced data; the inspector lists them, and a name that is not in the data renders a visible note, never a silent fallback.

**Contract.** The script returns `{data, app?}` where `data` is a `dataset/v1` bundle that may carry ONE extra member, `funnel: funnel-set/v1`. The sync writes both: the bundle to `cache.datasets` (tables for stat/bar/filter blocks) and the funnel set to `cache.funnel` plus its history. A malformed `funnel` member fails the sync loudly and keeps the prior cache. `funnel-set/v1` gains optional fields (old payloads stay valid):

- `segment_mode`: `cells` (default: disjoint cells the engine may sum) or `lookup` (each segment is its own measured path for an exact selection, one axis or an intersection; looked up, never summed, never folded into Other, no per-dim value cap; 64 segments max, the tail dropped with a notice).
- Per segment `measured` (default true) and `reason` (up to 200 chars). **Not measured is not zero**: an unmeasured path has no steps, its chip is disabled with the reason on hover and focus, its metrics read "Not measured: reason" and no 0 or 0% is ever drawn. An unmeasured cell never adds to a `cells` sum.
- Per segment `metrics`, `benchmarks` (absent = the set's band, shown as inherited) and `daily`; per funnel `daily: [{t: 'YYYY-MM-DD', m: {metricKey: number|null}}]` (keys must exist in `metrics`, 92 days max, a null day is a gap).
- Per metric `measured` / `reason` (a broken denominator). Per benchmark `floor_source`, `target_source` (up to 64 chars, printed under the ruler) and `better: higher|lower` (`lower` flips below/above and improving/worsening).
- Over 400 KB the engine trims segment daily, then funnel daily, then segments.

In `cells` mode a selection sums the matching measured cells, so it has step users but no rates (rates cannot be summed); the benchmark says so.

**Blocks.** All bind `data: <insight>` and share the card's selection:

| page | block | what it draws |
|---|---|---|
| chips | `breakdown` | one chip row per dim, intersections, disabled unmeasured combos with their reason, pin up to 4 selections as compare lanes |
| daily | `trend` | the selected path's daily metrics as a line or bar chart, a metric switch (one series at a time) |
| benchmark | `benchmark` | floor, current and target on one ruler, delta vs the previous window, status word, each bound's source |
| flow / steps | `funnel` with `layout: flow` or `bars`, `markWorst` | the selected path (never summed in lookup mode), drop badges, the worst drop marked, pinned lanes side by side on one step spine (a missing step is a dash) |
| per dim | `segments` with `by: <dim>` | one row per value of that dim under the selection on the other axes, band tone washes, faded low-sample rows, sortable |

A funnel block with default options draws exactly as before. Loss reasons (payment declines and the like) need no page type: a `stat` and a `bar` on a dataset of the same bundle plus a `filter` on a cohort dim. A second funnel in the set (say "Activation ladder") is drawn by `funnel: <id>`.

**One interactive card (app mode).** `dreamcontext lab board add-card <board> --preset funnel-explorer --insight <slug> [--locale en|tr]` writes a 12x12 card: a `breakdown` block above a `tabs` block with Daily, Benchmark, Flow, Steps and one Segments tab per client dim (first 4). The insight must be synced first (the tabs come from its dims; otherwise the command exits 1 with "sync <slug> first"). `--preset` and `--block` are mutually exclusive. The dashboard's Add card menu offers the same preset for an insight whose cache holds a funnel, and writes the same blocks. Any card opens full screen from its menu (`?card=<id>`, Esc or Back closes) and keeps its selection and active tab.

**Selection is card-scoped.** A chip click narrows every funnel-frame block in the same card (tabs included) and filters same-insight tables by the dims they carry (the total follows); a table without a selected dim says "Not split by X". Chip and tab clicks send zero sync requests. Cards do not share a selection.

**CLI parity.** `dreamcontext lab board show <board> --select "platform=Web,language=EN" [--json]` adds an `explorer` field to every explorer block (and to a funnel block in explorer mode): `{selection, slice, axes | series | rows | drops}`, computed by the same frameOps functions the dashboard blocks call, so the CLI prints the same benchmark rows, step users, worst step and segment rows as the card. Human output prints "Not measured: reason" and marks the biggest drop.

**A v1 app insight on a board.** The `insight` block takes `page` (pin any app page) and `nav: true` (page pills in the card; a pill click and an in-frame `lab.navigate` both switch pages with a fresh frame). `nav: false` keeps the plain card preview.

**Synthetic names only.** Fixtures, presets, docs and screenshots use a fictional vocabulary (e.g. "Acme Storefront", "Quiz checkout (v2)", "Activation ladder"), never a registered vault or real product name.

### Insight capture (in-session — ASK, never auto-create)

Mirrors proactive objective capture. When the user states or implies a recurring metric need ("I keep checking MRR by hand", "we should watch signups", "create an insight for DAU"):

1. **Dedup first.** `dreamcontext memory recall "<metric>" --types insight` and `dreamcontext lab list`. If one covers it, offer to update/re-sync it instead.
2. **Offer it.** *"Want me to track this as a Lab insight so every session sees the current value?"* Never create without a yes.
3. **Agree the shape.** Slug, title, render (the table above), the board it lands on (`--board <slug>`, or `--category` to land on the board with that title), unit — and write a real `## Meaning` section (it powers recall).
4. **Pick the source.** HTTP endpoint (+ extract path) or a custom script. Secrets go in via `dreamcontext lab credentials set <key>` — never inline in the manifest.
5. **Declare tweaks** the user will want to adjust (typed `enum`/`date`/`string`). Declare `range` only to CURATE its presets — the window keys work without a declaration (see well-known tweaks above).
6. **Scaffold + first sync.** `lab create`, edit the manifest, `lab sync <slug>`, confirm the value looks right.
7. **Offer KR binding** if an existing roadmap objective tracks the same outcome: `dreamcontext lab bind <insight> <objective>` — connecting seeds the objective's `metric.current` from the cached latest immediately, and every future sync keeps it measured. One feeder per objective (binding a new insight unbinds the previous one loudly); disconnect with `lab bind <insight> --clear`.

Every write waits for a yes.

**Security (plain language, tell the user when relevant):** lab scripts execute **locally, in a short-lived child process, with your credentials passed in over stdin** — anyone who can push to a shared brain repo can change what runs on your machine at the next sync. The child process is an isolation boundary (a hung or crashing script cannot take the host down, and every run re-reads the whole import graph so an edited shared lib is never stale), NOT a sandbox — the script still has your filesystem and network access. Review a script before its first sync and heed the loud "script changed since last run" tripwire notice. Credentials are written ONLY via `lab credentials set` (gitignore-first, file mode 0600, never printed back, redacted from every error/log).

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
status: "todo"            # todo | in_progress | in_review | completed — or any key declared in overrides/task.md
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

## Task format, custom-field & status overrides (optional)

A project can override the default task shape, declare its own custom fields AND declare its own task statuses by adding **`_dream_context/overrides/task.md`**. Absent this file, everything behaves exactly as the defaults above (zero regression).

The file carries three things:

- **Frontmatter `statuses:`** — extra task statuses, each living **under one of the shipped four**. Each entry: `name` (label), `key` (stable frontmatter value — ALWAYS write it explicitly; defaults to the snake_cased name), `kind` (`open | active | review | cancelled` — `done` is reserved for `completed`, exactly one done-kind status ever), `parent` (which of `todo`/`in_progress`/`in_review`/`completed` it rides under; defaults from the kind — `cancelled` → `completed`), `order` (pipeline position; the shipped four sit at 0 / 10 / 20 / 30, so `5` slots between `todo` and `in_progress`), optional `color` (6-hex — the GitHub label colour and the dashboard swatch) and optional `clickup` (list-status name aliases). The **kind drives everything**: `active` stamps the start date and counts as "being worked"; `review` triggers the required-field gate; `cancelled` is terminal — hidden by default, never overdue / at-risk / in the Eisenhower matrix, out of roadmap progress on both sides, and never the task a bookmark hint offers. The shipped four can be relabelled / reordered / recoloured but never removed or re-kinded. Every invalid entry (bad kind, non-hex colour, duplicate or reserved key, a collision with a custom-field key, a second done-kind) is dropped with a warning `doctor` shows — never fatal.
  - **THE PARENT IS THE WIRE.** A cloud backend only ever sees the parent — one of the four it already understands — so **a declared status needs nothing created on the provider**. The child's identity rides beside it as a `dc:<key>` marker and round-trips.
  - **GitHub**: the parent gives the open/closed state (parent `completed` → closed + `state_reason: completed`), and the `dc:<key>` label is auto-provisioned in the declared colour. `not_planned` stays EXCLUSIVELY the soft-delete signal (see integrations.md). A status key the local set does not know never reopens or closes an issue and never strips another machine's label.
  - **ClickUp**: the API cannot create list statuses, and it never has to. A declared status tries its own names first (so a list that really carries "Cancelled" gets the honest value — declare a `clickup:` alias when the list spells it differently), then falls back to the parent's status, with the `dc:<key>` **tag** carrying the child. On pull the tag wins only while it still agrees with the list status, so **a human moving the task in ClickUp always beats a stale tag**. `doctor` reports which declared statuses ride as a tag and flags any list status whose meaning your declaration changes.
  - The set travels with the brain by **git only**; a teammate who has not pulled the override sees the status downgraded (closed → `completed`, open → `todo`), never deleted, with a warning in the sync report — it self-corrects on their next pull.

- **Frontmatter `custom_fields:`** — a user-defined field schema. Each field: `name`, `type` (`text` | `number` | `select` | `date`), optional `key` (the stable field id / `custom_fields:` map key — defaults to the snake_cased `name`, so a rename keeps the same id), `required` (`true` ⇒ the agent MUST set it on every task; default optional), `ask` (`true` ⇒ the field is a HUMAN judgment the agent must NOT guess — it asks you for the value at task-creation time; default false), `options` (for `select`), `sync` (`[clickup, github]`, default both), and optional `prompt` (a system instruction telling the agent HOW to fill the field — surfaced in your snapshot + every sub-agent briefing).
- **Body** — the task TEMPLATE the CLI scaffolds from, plus an optional `## Agent Instructions` section that sub-agents read at runtime (it is stripped from scaffolded tasks).

```markdown
---
statuses:
  - { name: Planned, key: planned, kind: open, order: 5, color: c5def5 }
  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99, color: cfd3d7, clickup: [cancelled, canceled, "won't do"] }
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
