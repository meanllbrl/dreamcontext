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
dreamcontext tasks create "Readable sentence name" \
  --description "..." --priority medium --why "What this accomplishes" \
  [--version v0.9.0] [--person "Ada"] [--due 2026-07-01] [--tags backend,api]
```
Defaults: `priority=medium`, `status=todo`. A task created without `--version` auto-attaches to the **active planning version** (see Versioning).

- **Name = a short plain sentence** describing what the task does ("Fix the login redirect loop"). Never a type-prefixed slug (`feat-x-y`) — the file slug is derived from the name automatically.
- **`--why` is mandatory.** Creation fails without a non-empty reason; `created_at` covers the "when". A task must be readable months later on its Why alone.
- **Lean scaffold.** New tasks contain only `## Why` and `## Changelog`. Every other section (`user_stories`, `acceptance_criteria`, `workflow`, `constraints`, `technical_details`, `notes`) is created on first `tasks insert` — in canonical position, before Changelog. Never insert placeholders to "complete" the shape; a section with nothing to say shouldn't exist.

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

**How agents READ it — the ladder, before reaching anywhere else:**

1. **Snapshot.** The SessionStart hook renders a **Lab** section (title / latest value / staleness / group). "What's our MRR?" is answered from it with **zero tool calls**.
2. **`dreamcontext lab show <slug>`** — the manifest plus the **full cached series** (and per-funnel step tables for `render: funnel`), and it **never fetches**. This is the right call the moment the question needs more than the latest number: a breakdown, a trend, a month-over-month comparison, "which step leaks". The snapshot only carries the latest value, so *not knowing the series is not a reason to go outside* — it is a reason to run `lab show`.
3. **`render: app` (or any dimensional data): `dreamcontext lab query <slug> [--where][--group-by][--top]`** to slice the cached `dataset/v1` numbers, or **`dreamcontext lab body <slug> [--page][--format text|md|html]`** to read what a script-authored page actually shows — both cache-only, both never fetch. This is how you answer "what does this card show?" or "what's this insight broken down by X?" without opening the dashboard, on a body you did not author.
4. **Don't know the slug?** `dreamcontext lab list [--json]` (every insight + latest value + staleness) or `dreamcontext memory recall "<meaning phrase>" --types insight` — this is what the `## Meaning` section exists for.
5. **Stale only:** `dreamcontext lab sync <slug>` when the cache is past TTL (`--force` to refetch a fresh one).

**An MCP tool, a raw API call, or a hand-written script is the LAST resort.** If `lab/insights/` already holds the metric, fetching it another way bypasses the manifest, cache, tweaks and KR binding — and produces a number the next session cannot reproduce. A real past failure: an agent asked for revenue reached for a billing MCP while the synced Paddle series was already cached, and the project had to hand-write a memory note to stop it. When you genuinely must go outside (the insight doesn't exist, or the question needs a dimension the manifest doesn't carry), say so explicitly — and offer to `lab create` it if the user will want it again. Full rule: SKILL.md Operational Rule 13.

The dashboard has a Lab page: one card per insight (the render draws the body — see the table below), a date-range control on every card, per-insight refresh, sync-all, and tweak editing.

```bash
dreamcontext lab create <slug> --title "Weekly Active Users" [--render <render>] [--size s|m|l] [--adapter http|script] [--category <tab>] [--group <section>] [--unit users] [--ttl 1440]
dreamcontext lab sync <slug> [--force]      # one insight (TTL-fresh is skipped unless --force)
dreamcontext lab sync --all [--force]       # every insight; exits non-zero if any fail
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

**`size: s\|m\|l`** (optional manifest field, `--size` on create) overrides the card's board footprint: `s`/`m` = one column, `l` = two. Absent, the render decides — `table` and `funnel` ask for two columns because they draw tables; everything else takes one. The board grants a 2-column span only where two columns actually exist, so a narrow window degrades instead of overflowing.

**Well-known tweaks — `range`, `from`, `to`.** The engine derives a time window for EVERY insight (a relative `range` like `last_30_days`, or an explicit `from`/`to` pair that out-ranks it), so those three keys are writable on any insight whether or not its manifest declares them — via `lab tweak` or the dashboard's date-range control, which is why every card and the funnel pages offer a window even when the author never declared one. A manifest that DOES declare `range` keeps its curated options (and still rejects outsiders); an undeclared one accepts the relative-range grammar and gains an implicit declaration on first write. Setting `range` clears any stored `from`/`to` — otherwise the explicit window would silently pin every later preset to the old dates. Any other knob (`country`, `cohort`, …) still has to be declared in the manifest to be settable.

**Adapters:** `http` — declarative JSON API (endpoint/headers/body templates with `{{tweak:key}}` and `{{cred:key}}` placeholders, JSON-path `extract`, multi-series split via `seriesKey`); `script` — escape hatch, `lab/scripts/<slug>.mjs` exporting a default async function. `lab create` scaffolds the manifest; edit it to set the real endpoint/extract config, then run the first sync.

**Key-Result binding (insight → objective):** a manifest `binding: {objective: <slug>, value: latest}` makes every successful sync write the objective's KR `metric.current` automatically — upgrading the roadmap from PO-asserted numbers to measured ones. Offer this whenever an insight measures an existing objective's outcome. Set it via `lab bind` (or the dashboard's objective create modal / detail panel, which search insights by name); binding is ONE feeder per objective — connecting a new insight unbinds the previous one loudly, and connecting immediately seeds `metric.current` from the cached latest.

**Sync semantics:** TTL staleness (default 1440 min) — fresh insights are skipped and reported, `--force` refetches; on failure the prior series is KEPT and the error is loud (never a silent half-sync). **Sleep does NOT run lab sync** — refresh is always an explicit user/agent action.

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

**Height is automatic — the author does nothing.** The page's own content height is measured and reported to the host continuously (a `ResizeObserver` plus a load/click re-check for late-loading fonts or images); the host resizes the card/page/full-screen frame to match. There is no height to set, no fixed card size to fight — write the page like a normal document and it fits.

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

The engine validates + caps it (≤3 dims; per-dim values beyond the top 8 collapse into "Other"; ≤400 rows, the tail merges into one all-Other row; 200 KB hard reject — every cap is a loud notice, and `doctor` re-flags a stored cache that violates one), synthesizes legacy `series` from the rows, and — the important part — **appends a DATED snapshot to `matrixHistory` on every successful sync** (count cap 60 AND a byte cap together). The matrix itself is a snapshot, not a time series: **the history trail IS the time axis**, so a daily sync cadence is what makes a report date-navigable. Δ vs previous period: a row's `prev` wins; else the equal-length (±25%) history snapshot; no honest comparison → no Δ shown. `lab create <slug> --render breakdown --adapter script` scaffolds the `range` tweak + a documented script template; `lab show <slug>` prints the pivot; legacy `Series[]` under `render: breakdown` still renders (bar-list fallback).

### HTML card bodies (`html/v1` hybrid — typed renders first, single-page)

A script may return `{ data, html? }`: **`data` is MANDATORY** (exactly what a bare return would be — the numbers keep feeding `latest`, KR bindings, Δ, reports, `lab show` and the Rule-13 read ladder; `{ html }` alone fails the sync loudly), `html` is an OPTIONAL card body, ≤300 KB (over-cap = loud sync failure, never truncated). The dashboard draws it in a **network-less sandboxed iframe** (`sandbox="allow-scripts"` with NO same-origin grant + a `default-src 'none'` CSP — it can animate and compute against the data embedded at sync time, but it cannot fetch, beacon, or touch the parent origin), and the detail panel always shows the typed data TWIN next to it, so a screen reader is never locked to the iframe. **Rule: reach for a typed render first; write `html` only when the render vocabulary cannot express the card in ONE screen — reach for `app` (above) the moment it needs more than one page** — and use the `lab-html-kit.css` classes instead of your own CSS (`lk-title`, `lk-value`, `lk-label`, `lk-muted`, `lk-delta--up/down`, `lk-stat`, `lk-chip`, `lk-table`, `lk-bar`/`lk-bar-fill--N`, `lk-low-sample`, `lk-empty`): the kit ships embedded with the current theme's design tokens, so a kit-classed card looks native dreamcontext in light and dark and repaints on theme change. A run whose script returns no `html` clears any prior body — stale presentation is worse than none. `app/v1` pages draw against the SAME kit and the SAME sandbox/CSP guarantee — `html/v1` is simply the one-page, no-bridge case of it.

### Reports (My Reports — `lab/reports/<slug>.md`)

A report is a **composed, window-navigable document over insights you already track** — it OWNS NO DATA and has no sync path of its own; it reads insight caches, dated history snapshots, and transient window measurements. Frontmatter: `title`, `description`, `date_nav: none|daily|weekly|monthly`, optional `window`, `sections: [{ title, prose?, window?, items: [{ insight, view?, breakdown?: { rows, cols, filter? }, window? }] }]`; body = `## Notes` prose. Create with `lab report create <slug> --title "…" --insights a,b,c`; read with `lab report show <slug> [--date YYYY-MM-DD]` or the dashboard's **My Reports** page (`/lab/reports/<slug>` — toolbar → Reports).

**The date navigator IS the measurement window** (owner decision, 2026-09-01): the `date_nav` granularity sets the default span (daily/weekly/monthly → the 1/7/30 days **ending at the selected date**; live = ending today), and every item RE-MEASURES that window through a transient sync — written to `lab/cache/.windows/`, never to the canonical cache, the snapshot trails or a KR binding (aligning a report must never move the roadmap). A `window` spec at report/section/item level overrides the default (most specific wins): a relative range (`last_30_days`, re-anchored at the selected date — right for lagging metrics like refunds) or `'own'` (the tile keeps its own window; also the automatic fallback for source-less manual tiles, which cannot re-measure). Pinned/own items SAY so on their chip, and a section whose shown windows genuinely differ wears a mixed-window warning. `window: own` at report level restores the pure snapshot-as-of semantics ("latest sync at/before the end of that day"), which is still what dated resolution means for own/manual items. Honesty stays absolute: a window with no measurement is an explicit "not measured yet" empty — never a silently substituted other window, never an interpolation. The navigator is a free RANGE control with quick presets (Last 7/14/30/90 days, Last 1 year): editing the start date (or picking a preset) turns the view into a custom from→to window (URL `?from=&date=`, CLI `--from`) that overrides the report default for every non-pinned item — pins still win and still say so. The dashboard fetches owed windows automatically on open/navigation; from the CLI or an automation, run `lab report sync <slug> [--date …] [--from …]`.

**AI commentary (optional layer).** A report may carry an agent-written reading per view, stored dated at `lab/reports/.commentary/<slug>/<dateKey>.md` and always labelled "AI-generated · <model> · <time>". The division of labor is fixed: deterministic honesty (mixed windows, unmeasured states, low sample) is the PLATFORM's job in code; the commentary adds interpretation on top and may never replace the author's section prose or own any number (the generation prompt embeds the resolved values and forbids inventing others). It is generated ONLY on demand — the report page's Analyze button or `lab report comment <slug> [--date] [--from]` — as a pure-text headless `claude -p` run (plan mode, no tools; the server writes the file). The output is SPREAD across the report, not one block: the model writes an overall reading first, then `## <section title>` blocks that render as slim AI notes INSIDE their sections (parse is lenient — an invented heading folds back into the summary rather than vanishing). Non-AI reports are first-class: `commentary: false` in the report frontmatter removes the surface entirely. A report referencing a deleted insight shows a warning for that item and keeps rendering. Opening the report page starts one scoped sync job (`slugs[]`) and sections fill progressively as each insight settles. **Window honesty**: every resolved item also carries its measurement `window` (`{fromISO,toISO}`) and `rangeKey` (the `range` tweak value, e.g. `last_7_days`) — live items derive it from the cache's own tweaks/typed range, dated items from the snapshot's recorded range, and a dated series event honestly reports `null` (today's tweak never relabels history). The surface renders the window next to each as-of stamp ("7-day · Aug 25 – Sep 1" / "no declared window" / "window unknown") and a section whose items mix windows wears a mixed-window warning strip — don't hand-write window caveats into prose for what the surface now says itself; keep prose for interpretation.

### Insight capture (in-session — ASK, never auto-create)

Mirrors proactive objective capture. When the user states or implies a recurring metric need ("I keep checking MRR by hand", "we should watch signups", "create an insight for DAU"):

1. **Dedup first.** `dreamcontext memory recall "<metric>" --types insight` and `dreamcontext lab list`. If one covers it, offer to update/re-sync it instead.
2. **Offer it.** *"Want me to track this as a Lab insight so every session sees the current value?"* Never create without a yes.
3. **Agree the shape.** Slug, title, render (the table above), category (top-level dashboard tab, e.g. "Marketing"), group (section within it), unit, optional `size` — and write a real `## Meaning` section (it powers recall).
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
