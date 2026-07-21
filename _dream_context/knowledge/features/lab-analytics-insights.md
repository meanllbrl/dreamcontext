---
id: feat_lab_insights
status: in_review
created: '2026-07-05'
updated: '2026-07-21'
released_version: v0.13.1
tags:
  - 'topic:lab'
  - 'topic:cli'
  - 'topic:dashboard'
  - backend
  - frontend
  - 'topic:roadmap'
related_tasks:
  - feat-lab-analytics-insights-subsystem
  - lab-funnel-analytics
type: feature
name: lab-analytics-insights
description: >-
  Lab (dashboard: "Insights") — curated analytics metrics synced from external
  sources (generic HTTP or custom script) into the brain: manifest + bounded
  cache with sync history, TTL sync, secret-redacting credential layer,
  roadmap KR binding, SessionStart/recall surfacing, dashboard Lab page with
  interactive charts (number/line/pie/raw renders) and InsightDetailPanel slide-over.
  NEW (in_review): funnel analytics — multi-page routed insights with comparison tables,
  node lanes, arc gestures, filters, breakdowns, and multi-funnel compare.
pinned: false
date: '2026-07-05'
---

## Why

Agents need to stay current on business/product analytics without re-fetching raw data or requiring manual syncing. Today, metrics that matter (WAU, conversion rates, revenue) live in external systems (PostHog, Stripe, Google Sheets, custom DBs), and the only way to surface them in dreamcontext is to manually copy numbers into a roadmap objective's Key Result or mention them in a task note — both stale the moment they're written. This breaks the "measured progress" feedback loop: the PO sets a target, the team ships work, but nobody sees current-vs-target drift until the next manual check.

Lab solves this by introducing **insights** — curated analytics metrics (NEVER raw data dumps) backed by external sources. A user or agent defines a named insight (e.g., "Weekly Active Users") with a data source (any HTTP JSON API or a custom script), declares display preferences (number/line/pie chart), and sets a refresh TTL. One CLI sync refreshes all or one insight; cached snapshots live in the brain so every session sees them (SessionStart snapshot + recall). A bound roadmap Key Result metric updates automatically on sync — upgrading the roadmap from PO-asserted numbers to measured numbers that agents can reason about.

This is NOT a BI tool. Lab is a **metrics delivery** subsystem: it captures WHAT to fetch and HOW to display it, fetches on demand, caches the result, and surfaces it to agents + the dashboard. The source adapters (generic HTTP + custom script) make Lab pluggable — ready-made PostHog/Sheets adapters are v2; the generic layer is expressive enough that most sources fit without bespoke code.

**Naming note:** The user-facing dashboard page is labeled "Insights" (flask icon); "Lab" is the internal/CLI/technical name. This PRD uses "Lab" to match the codebase and CLI surface.

## User Stories

- [x] As a PO, I can define a curated insight (e.g., "Weekly Active Users") backed by a PostHog or custom API endpoint, so my team's agents see live business metrics without me pasting stale numbers into task notes. *(M1 shipped: `lab create`, generic-HTTP adapter)*
- [x] As an agent, every session I see the latest cached value + staleness of bound insights in my SessionStart snapshot, so I can reason about current-vs-target progress without asking the user "what's the latest WAU?". *(M1 shipped: SessionStart Lab section)*
- [x] As a user, I can bind an insight to a roadmap objective's Key Result metric, so `lab sync` automatically writes `metric.current` and the roadmap forecast cascade reflects measured progress. *(M1 shipped: binding write via `updateObjectiveMetric`)*
- [x] As an agent, I can recall an insight by its meaning prose (e.g., "recall 'weekly active users'") without knowing its slug or that it's an insight, so discovery is natural. *(M1 shipped: `insight` recall corpus type)*
- [x] As a user, I can view all insights grouped by category in the dashboard Lab page, refresh one or all with one click, and see live success/error feedback. *(M1 shipped: LabPage, LabBoard, per-insight + sync-all refresh)*
- [x] As a user, insights respect a TTL — `lab sync` skips fresh data unless `--force`, so I'm not rate-limited by over-polling. *(M1 shipped: staleness skip + fresh-skip reporting)*
- [x] As a user, when an insight sync fails, the prior cached series remains intact and the error is surfaced loudly — no silent half-sync, no data loss. *(M1 shipped: on-error keep-prior-series + failed[] aggregate + non-zero exit)*
- [x] As a user, credentials for insight sources (API keys, tokens) are stored gitignored-first and never logged or returned — the scrub is structural, not advisory. *(M1 shipped: gitignore-first `writeCredential`, end-to-end secret redaction)*
- [x] As a user, custom-script insights (`.mjs` files in `lab/scripts/`) execute locally with my credentials and carry a plain-language trust warning — and if a script changes, I see a loud tripwire notice before it runs. *(M1 shipped: script-hash tripwire, trust statement in skill docs)*
- [x] As a user, I can tweak an insight's time range (e.g., last_30_days → last_1_year) from the dashboard and see the chart re-fetch and granularity coarsen to monthly. *(M1 shipped dashboard tweak editing, E2E verified v0.13.0)*
- [x] As a user, the doctor command warns me when an insight manifest declares credentials I haven't set, and fails when credentials.json exists but isn't gitignored. *(M1 shipped, E2E verified v0.13.0)*
- [x] As a user, I can connect an insight to a roadmap objective's Key Result from either the insight card (dashboard Lab page) or the objective detail panel, so `lab sync` automatically updates the objective's measured progress. *(Shipped v0.13.0: `lab bind` CLI + dashboard InsightPicker in create modal + detail panel KR section)*
- [x] As a user, insights are grouped on the dashboard Lab page with collapsible sections, and I can drag cards to reorder them within their group with preferences persisted per-machine. *(Shipped v0.13.0: collapsible groups + HTML5 drag-drop + useLabPrefs persistence to `.lab-prefs.json`)*
- [x] As a user, clicking an insight card opens a detail panel with a large interactive chart, the insight's Meaning prose, sync history, and inline tweak editing. *(Shipped v0.13.0: InsightDetailPanel slide-over + bounded sync history)*

### Funnel analytics (multi-page insights, in_review)

- [ ] As a funnel operator, I open ONE insight and see a **table of all my funnels** (users, spend, CPM, step rates, finish rate, click→sub, per-column delta vs the previous period), sortable by any column, so I can spot the underperformer in seconds.
- [ ] As a funnel operator, I **click a table row and land on that funnel's detail page** (breadcrumb back to the table), so drilling down is one gesture, not a filter dance.
- [ ] As a funnel operator, the detail page shows the funnel as a **horizontal, full-content-width lane of step NODES** (Excalidraw-board aesthetic: rounded node cards with step name + users + % of top, connected left→right), with the **drop between adjacent steps rendered as a first-class red badge** (−n users · −x%), so the leak is visible without reading numbers.
- [ ] As a funnel operator, I **click node A and then node B, and an arrow is drawn from A to B** (curved arc above the lane, arrowhead at B) labeled with the A→B conversion % and the absolute counts (nA → nB), so I can interrogate any two steps — not just adjacent ones. I can pin several arcs at once, remove one by clicking its ✕ or either endpoint, and clear all with Esc.
- [ ] As a funnel operator, I can apply **filters** (date range, language, country, campaign/UTM, device, funnel type) on both pages, and **break the detail view down by one dimension** — either as stacked segments inside each node or as aligned small-multiple lanes (one lane per segment value) — so "step 3 leaks" becomes "step 3 leaks for DE mobile".
- [ ] As a funnel operator, I can **select 2+ funnels in the table and compare them** as parallel lanes with steps aligned by step key, so A/B funnel variants are read side-by-side.
- [ ] As a teammate, I can **open a link someone sent me** and see exactly their view — funnel, date range, filters, breakdown, pinned arcs are all in the URL.
- [ ] As a screen-reader / keyboard user, every reading of the graph is available as a **step table twin**, and nodes/arcs are focusable and operable by keyboard, so the graph is not the only path to the data.
- [x] As an insight author, I can scaffold a funnel insight with `dreamcontext lab create <slug> --render funnel`, return the documented funnel payload from a script or HTTP adapter, and `lab show <slug>` prints the step table with the worst drop highlighted in the terminal. *(Shipped 2026-07-21: A1, A12)*

## Acceptance Criteria

*(From task `feat-lab-analytics-insights-subsystem` — validated plan v3, converged via goal-skill with 3 reviewers over 3 iterations.)*

### Core engine + storage

- [x] `lab create <slug> --title "..." --render number|line|pie|raw|funnel --adapter http|script` scaffolds `lab/insights/<slug>.md` (frontmatter config + `## Meaning` prose); `lab list` shows it.
- [x] Granularity derivation (`deriveGranularity`): >180 days → monthly, 45-180 days → weekly, <=45 days → daily. Boundary-tested at 45/46 and 180/181 span thresholds.
- [x] Rollup + capping (`capSeries`): a year of daily raw points rolls to ≤ MAX_POINTS (62) monthly buckets; a 30-day daily insight keeps ≤31 daily points. Lab is insights, not raw dumps.
- [x] Tweak resolution (`resolveTweaks`): `last_1_year` enum maps to ~365-day window; explicit `from`/`to` date tweaks override the enum.
- [x] Generic-HTTP adapter (injected `fetchImpl`): a GET extracts `seriesPath` and splits a `seriesKey` response into >=2 series (A/B); a POST with body template resolves to valid JSON and is sent once, not double-encoded; invalid JSON body template throws loud `LabError`. **URL fidelity:** for both GET and POST the request URL observed by `fetchImpl` equals the resolved endpoint byte-for-byte including query string (no trailing slash, no corrupted final param) — guards the `ApiAdapter.buildUrl` trailing-slash/query-corruption hazard.
- [x] Custom-script adapter: loads a fixture `.mjs` (default async fn) and returns its series.
- [x] `syncInsight` skips a fresh insight (within `ttl_minutes`) unless `--force`; the fresh-skip is reported, not silent.
- [x] On adapter failure, the cache keeps its prior series, sets `error` + `errorAt`, and `syncAll` returns non-empty `failed[]`; the CLI exits non-zero — no silent half-sync.
- [x] Syncing an insight with `binding.objective` + a KR metric writes `metric.current` via `updateObjectiveMetric`; a non-finite latest or missing metric warns loudly and writes nothing.

### Security (all non-negotiable)

- [x] Secret redaction end-to-end: a non-2xx response (and separately a thrown custom-script error) against a manifest using `{{cred:key}}` produces a `cache.error` and log line containing `***`, NEVER the real credential value or raw echoed response-body snippet. `readCredentials` on missing file returns `{}`.
- [x] Credential write is safe end-to-end: `writeCredential` refuses to write (throws, creates no file) when a governing `.gitignore` cannot be ensured; on success the file is mode 0600. **STUB-REGRESSION GUARD:** `writeCredential` on a repo with NO `_dream_context/.gitignore` produces a FULL canonical brain gitignore (contains `state/.secrets.json`, `state/.sleep.json`, `**/.env`, etc.) with lab entries appended — not a 2-line stub. `lab credentials list` prints names only, never values.
- [x] Doctor WARNS when a manifest `credentials_used` key is absent from `credentials.json`, and FAILS when `lab/credentials.json` exists but `gitignoreCovers()` says the mode-appropriate `.gitignore` does not cover it.
- [x] Script-hash tripwire: after a successful script sync the cache records `scriptHash`; re-running after the script file changes prints loud "[lab] script changed since last run for <slug>" notice BEFORE executing. Hash recorded only on successful runs.

### Integration (CLI, recall, snapshot, dashboard)

- [x] `memory recall "<meaning phrase>" --types insight` surfaces the insight; `insight` is in `buildCorpus` defaults.
- [x] The SessionStart snapshot renders a budget-demotable Lab section (title / latest / staleness / group) and never crashes on malformed manifest.
- [x] HTTP: `GET /api/lab` lists summaries; `GET /api/lab/:slug` returns full series; `POST /api/lab/sync {all:true}` runs same engine and returns `failed[]`; `PATCH /api/lab/:slug/tweaks` persists. No route ever returns a credential value.
- [x] Full existing test suite stays green; `npm run build` clean.

### Validation (M1 definition-of-done)

- [x] **Automated:** unit/integration tests for all criteria above (91 new tests) + dashboard `tsc -b` clean.
- [x] **Manual dashboard checklist** (8 items): Lab page opens; insights render collapsible grouped sections; number shows latest+unit+staleness; line renders interactive SVG with date axis + crosshair tooltip; pie renders slices+legend with hover tooltips; raw toggles table⇄JSON; per-insight Refresh updates on success and toasts loud error on failure; Sync all refreshes every insight with one deliberate failure still updating the others; edit tweak (range last_30_days → last_1_year), Save, reload → still set, refresh re-fetches and granularity coarsens; bound insight shows "feeds <objective>" provenance chip. *(Verified v0.13.0)*

### Funnel analytics (in_review, 2026-07-21)

- [x] F1 — **Funnel payload contract + cache schema** written and versioned: adapter returns a funnel-set (funnels → meta/metrics/steps/segments + declared dimensions; `funnel-set/v1` shape); engine validates, caps (max 40 funnels, max 30 steps, max 8 dimensions with top-8 values→Other, max 64 segment cells, max 400KB), and stores history snapshots per sync for deltas/trends. Legacy `Series[]` payloads under `render: funnel` still render (compact bar fallback) — no breakage of existing insights.
- [x] F2 — **Multi-page insight routing contract**: an insight can declare pages; funnel insights route to `/lab/<slug>` (overview) and `/lab/<slug>/f/<funnelId>` (detail) with breadcrumb back, browser back/forward working, and the card on the Lab board acting as page 1's entry (card body shows a top-N mini-table preview, not a blank). Routing via pushState within the page-state Shell (no router library); view state (filters, breakdown, compare, arcs, sort, range) is query-string so `?vault=` survives.
- [x] F3 — **Overview table**: identity + volume + rate + economics columns driven by the payload's metric keys (format hints: %, currency, count, x); column sort (stable, keyboard accessible); text search over funnel id/name; date-range control (7d/28d/90d presets + custom, wired to the existing tweak-range mechanism); loading/empty/error/stale states consistent with Lab conventions.
- [x] F4 — **Deltas + sample guard**: every rate cell can show Δ vs the previous equal-length period (▲/▼ pp with tooltip of both values); rows with users below a configurable threshold render a "low sample" chip and de-emphasized rates (no confident-looking 0%/100% on n<30). Adapter `prev` wins over history-derived fallback; equal-length ±25% guard, ends-before-current-start.
- [x] F5 — **Row → detail, multi-select → compare**: row click (and Enter on focused row) opens detail; checkbox multi-select of 2–4 rows enables a "Compare" action opening the compare view; kebab per row: copy deep link, copy row as Markdown.
- [x] F6 — **Detail node lane**: horizontal, full-content-width lane; each step a rounded node card (label, users, % of top, volume-proportional visual weight); adjacent connectors carry the step→step conversion %; drop badge between nodes (−n · −x%) with severity tinting; >12 steps handled via horizontal scroll with edge-fade + optional zoom-to-fit; a compact fallback (v0-style vertical bars) below a width breakpoint.
- [x] F7 — **Arc gesture**: click node A (anchor state, visibly marked) then node B → curved labeled arrow A→B above the lane: conversion %, nA → nB, absolute drop; multiple pinned arcs stack at distinct heights/colors; remove per-arc (✕ / endpoint re-click), Esc clears all; arcs work backwards (B before A in step order) by swapping automatically; pinned arcs persist in the URL.
- [x] F8 — **A11y twin + keyboard**: a toggleable step TABLE renders the same numbers (steps × [users, % of top, % of prev, drop]); nodes and arcs are in the tab order with ARIA labels; the whole detail page is operable without a pointer; color encodings meet contrast and are not the sole carrier of meaning.
- [x] F9 — **Filters**: dimension filters declared by the payload (values + counts), rendered as multi-select chips with search; two evaluation modes — `client` (payload includes segments; filter is instant) and `refetch` (filter value interpolated into the adapter query via the tweak mechanism); active-filter chip row with clear-all; filters shared between overview and detail and encoded in the URL. Client-filtered overview metrics stay honest by dimming (payload metrics cannot be recomputed client-side).
- [x] F10 — **Breakdown**: pick ONE dimension → detail renders either (a) stacked segment bands inside each node with a legend, or (b) small-multiple lanes per segment value (top-N + Other), steps aligned, shared scale; toggle between (a)/(b); arc gesture in breakdown mode shows a per-segment A→B mini-table.
- [x] F11 — **Compare**: 2–4 funnels as parallel lanes; steps aligned by step KEY (not index), unmatched steps ghosted; per-step delta chips between lanes; compare state deep-linkable.
- [x] F12 — **CLI/engine**: `lab create --render funnel` scaffolds a funnel-payload script template with inline docs; `lab show <slug>` prints the step table + worst-drop highlight; `lab sync` records funnel history snapshots; `doctor` validates funnel cache shape and flags cap violations; unit tests for contract validation, rollup, and delta computation. 30 new unit tests; full suite 3773 green.
- [x] F13 — **Deep links**: funnel id, date range, filters, breakdown dimension + mode, compare set, and pinned arcs all round-trip through the URL (open link → identical view).
- [ ] F14 — **Benchmarks + exports**: optional per-column benchmark thresholds (floor/target) color rate cells and node drop badges (config lives with the insight, off by default); copy-as-Markdown for table and step table; PNG export of the detail lane. *(Partial: benchmarks + copy-as-Markdown shipped; PNG export slipped per the criterion's may-slip clause)*

## Constraints & Decisions
<!-- LIFO: newest at top -->

### Funnel analytics (2026-07-21, in_review)

- **[2026-07-21] Δ-vs-previous-period precedence: adapter `prev` wins; history fallback is equal-length-guarded.** An adapter may put `prev` on any metric/step (authoritative). Otherwise the engine picks the best history snapshot whose span matches ±25% AND ends at/before the current window's start — when none qualifies (e.g. right after a range change), NO delta is shown. Honest-nothing beats plausible-wrong.
- **[2026-07-21] Multi-page routing rides pushState inside the page-state Shell — no router library.** `labRoute.ts` owns /lab/<slug>[/f/<id>] paths + a NAV_EVENT for same-document pushes; Shell only learned to map a /lab/ path to page 'lab' on load; LabPage clears the path on unmount so other sections never resurrect a funnel page on reload. View state (filters `flt`, breakdown `bd`/`bdm`, compare `cmp`, arcs `arcs`, sort, range) is query-string, so `?vault=` survives. Future table/cohort insights reuse this module, not a framework.
- **[2026-07-21] Client-filtered OVERVIEW metrics stay honest by dimming.** Payload metrics (spend, CPM, payload-computed rates) cannot be recomputed client-side from segments, so active client filters dim the metric cells + show a notice, instead of silently showing unfiltered numbers as filtered. The detail lane DOES recompute steps from segment cells.
- **[2026-07-21] F14 PNG export slipped** (per the criterion's may-slip clause) — would need an html-to-canvas dependency for the HTML+SVG lane; benchmarks + copy-as-Markdown shipped.
- **[2026-07-20] Node-lane visual language = Excalidraw boards, not BI-tool bars.** Explicit user direction: horizontal, full row width, steps as NODES "aynı excalidraw'da yaptığımız gibi" (like our Excalidraw funnel-map boards), and the two-click A→B arrow gesture. The team already thinks in these boards; the dashboard should read the same way. Bars are the compact/mobile fallback only.
- **[2026-07-20] This SUPERSEDES the v0 `funnel` render prototype** (uncommitted working-tree changes of 2026-07-20: `RENDERS+='funnel'`, `FunnelChart.tsx` vertical bar list with click-to-pin). Legacy `render: funnel` + `Series[]` payloads must keep rendering (backward compat).
- **[2026-07-20] Presentation layer only — data feeding is NOT this task.** Scheduling/pulling funnel data on sleep cadence belongs to `sleep-connectors` and learning-from-funnels to `proactive-learning-layer`. This task defines the payload contract they will eventually deliver into, and renders it. Lab stays metric delivery.
- **[2026-07-20] Multi-page contract: minimal, funnel-only generalization.** Don't build a generic page framework speculatively (YAGNI). Define the routing/URL-state contract so a future insight kind CAN adopt it, implement it only for `funnel`.
- **[2026-07-20] Small-n honesty is a rendering requirement, not a nicety.** The motivating real dataset (funnel 516: 33 users, 0% lead rate but 3.03% finish) shows tiny cohorts produce confident-looking garbage. Low-sample de-emphasis (F4) and "% shown, n visible" everywhere are contract-level requirements.
- **[2026-07-20] All visual encodings via design tokens; no hardcoded colors; color-blind-safe severity scale.** Per the design system rules already used across the dashboard.

### Core Lab subsystem (v0.13.0 and earlier)

- **[2026-07-07]** **Lab prefs persistence — localStorage + server write-through.** `useLabPrefs` hook mirrors `useRoadmapPrefs` to persist collapsible-group state and card order: localStorage for immediate reactivity PLUS debounced write to `state/.lab-prefs.json` via new `GET/PUT /api/lab-prefs` route (added to `buildBrainGitignore`). This matters for the desktop app — every launch gets a fresh empty localStorage (new loopback port), so localStorage-only would silently lose your layout. New insights not in a saved order simply appear after the ordered ones. Collapsible state and order are both per-machine (local-only, not synced in brain repo).
- **[2026-07-07]** **Insights board UX — collapsible groups + within-group reorder only.** Group headers are toggle buttons (chevron + card count, `SubGroupSection` idiom from tasks board). Cards use HTML5 drag-and-drop (dims dragged card, highlights drop target) within the SAME group only — since a card's `group` comes from the manifest, dropping across groups is ignored rather than silently rewriting the manifest (cross-group reassignment is an edit-manifest operation). This mirrors TaskCard drag behavior but stricter.
- **[2026-07-07]** **InsightDetailPanel as a centered near-fullscreen modal, not a slide-over.** User feedback from the initial right slide-over: the chart felt cramped, especially for line charts with many series. Reworked to a centered modal (`min(1160px,94vw) × min(820px,92vh)`) with large interactive chart + Meaning prose on the left, Details/Edit tweaks/Update history rail on the right; collapses to one column under 900px. Pop animation + dimmed overlay. Escape (overlayStack-integrated with form-field guard) + overlay click both close.
- **[2026-07-07]** **Chart interactivity — crosshair + multi-series tooltip for line charts.** LineChart: vertical crosshair snaps to the nearest data position (pointer aims at a DATE, not a 2px line), one tooltip reads out EVERY series at that x. Hover-independent geometry (scales, tick labels) memoized so pointer-move renders only rebuild the crosshair/tooltip overlay (perf). PieChart: hover slice highlight + tooltip; lone 100% slice renders as a `<circle>` (SVG coincident-endpoint arc bug). Both charts: `touchAction: pan-y` (mobile scroll).
- **[2026-07-07]** **Keyboard accessibility for InsightCard.** The whole card is clickable (opens detail panel) but has `role="button"`, `tabIndex={0}`, and Enter handler — matching TaskCard parity. Inner controls (Refresh, tweak fields, raw-view toggle) use `stopPropagation` so clicking them doesn't trigger the card click.

- **[2026-07-06]** **Bounded sync history — count cap AND size cap.** `cache.history` keeps the cache an insight snapshot, not a log file: HISTORY_MAX=50 events, per-event error truncated at HISTORY_ERROR_MAX=300 chars. Review lesson (bookmarked): a count cap alone is not a size cap — a bounded list of unbounded strings still bloats; cap both. TTL "fresh" skips never append (no run happened). Companion UI lesson: render-time state indexing into derived arrays (crosshair `hoverIdx` into `xKeys`) must be clamped where it is READ — props can shrink between renders.
- **[2026-07-05]** **Insights, not raw data.** MAX_POINTS=62 per series is a structural cap enforced in `rollup.ts` (`capSeries` coarsens daily→weekly→monthly until under cap). A ~1-year span is monthly-only; a ~1-month span may be daily/weekly. Granularity derives from resolved tweak span: >180d monthly, 45-180d weekly, <=45d daily. Lab is NOT a BI tool — it delivers curated metrics to agents + dashboards, never raw data dumps.
- **[2026-07-05]** **Security contract (non-negotiable, from adversarial security review).** Credentials written ONLY via `lab credentials set` → `writeCredential`, which calls `ensureLocalOnlyArtifacts` FIRST (never creates a stub `_dream_context/.gitignore` — full canonical template iff missing), layers lab gitignore entries, aborts without writing on any gitignore failure, chmod 0600. Doctor FAILS on existing-but-gitignore-uncovered `credentials.json`. Every error/log/cache string built from the redacted resolution (`{{cred:*}}` → `***`) + `redactSecrets` final net; raw Error objects never logged. Script-hash tripwire prints loud notice before executing a changed script.
- **[2026-07-05]** **Trust model (accepted).** `lab/scripts/*.mjs` are the first executable artifact brain-repo sync carries; they run in-process with credentials passed in — same trust level as the repo itself. No sandbox in MVP; mitigation = plain-language statement in skill docs + the change tripwire. Anyone with brain-repo push access can change what runs on a peer machine at next lab sync.
- **[2026-07-05]** **Sleep does NOT run lab sync** (credential exposure, latency, non-determinism). The only sleep↔metric interaction remains the existing `metric.current` relaxation; a bound insight feeds it via its own lab sync instead.
- **[2026-07-05]** **Provenance: plan converged via goal-skill** (planner + pragmatist/critic/security reviewers, 3 iterations, 9 blocking findings folded in — scope cuts P1-P3, `ApiAdapter` integration C1 + URL-split C2, security S1-S3 + stub-gitignore regression S4). All integration claims verified against working tree on branch `feat/sleep-debt-header-tracker` as of 2026-07-05.
- **[2026-07-05]** **Plan assumptions (defaults chosen; PO may veto before implementation).** A1: charts are hand-rolled SVG (no chart lib exists or added); A2: insight manifests + cache snapshots DO sync in the brain repo — only credentials excluded; A4: `writeCredential` ensures BOTH governing gitignores unconditionally; Q1: `lab create` is flag-driven (conversation lives in skill protocol); Q2: empty bound series leaves `metric.current` untouched and warns (never writes non-finite).
- **[2026-07-07]** **Binding is objective-side editable now — one feeder per objective.** `lab bind <slug> <objective>` / `PATCH /api/lab/:slug/binding` / dashboard InsightPicker (objective create modal + detail panel Key Result section) all call the same `bindInsight` engine: validates the objective exists, enforces a SINGLE feeder per objective (any other insight bound to it is unbound and reported in `unbound[]`), and immediately seeds `metric.current` from the cached latest (`seededCurrent`) so the roadmap shows the measured value without waiting for the next sync. Removing an objective's metric from the panel also disconnects its feeding insight (a binding with no KR would warn on every sync). This ships the former "roadmap-side provenance" v2 cut.
- **[2026-07-05]** **Out of scope / v2.** ~~Roadmap-side provenance chip~~ (shipped 2026-07-07 as the objective-side InsightPicker + `lab bind`); ready-made PostHog/Google-Sheets adapters (expressible via generic HTTP or scripts); JS-expression extraction (JSON-path only in MVP); range tweak TYPE (enum|date|string only); sourceHash/request-level cache invalidation (staleness is TTL-only); objective-side metric time-series/trendline; `useLabPrefs` persistence; sleep-driven sync; insight federation; lab-adapter-builder sub-agent; script sandboxing beyond tripwire+docs; init scaffolding/migration for `lab/` (store creates dirs lazily like objectives).

## Technical Details

**Architecture (plan v3, converged 2026-07-05 — 3 reviewers SOLID).** Lab mirrors the objectives subsystem (the load-bearing precedent). Markdown-first storage: manifest per insight at `_dream_context/lab/insights/<slug>.md` (frontmatter config + `## Meaning` prose, recall-indexed), cache snapshot at `_dream_context/lab/cache/<slug>.json` (post-rollup series + `fetchedAt` + `scriptHash`), gitignored `_dream_context/lab/credentials.json` written ONLY via gitignore-first CLI. Pure store reads/writes manifests; sync engine resolves tweaks → adapter (generic-HTTP | custom-script) → granularity-capped rollup → cache write → optional bound-objective `metric.current` write via existing `updateObjectiveMetric`. CLI and `/api/lab*` routes call the same engine. Agents: SessionStart snapshot section + `insight` recall corpus type + `lab show --json` (cache only, no fetch). Dashboard: Lab page with number/line/pie/raw renders, per-insight + sync-all refresh, generic typed tweak editing, manifest-declared grouping. Sleep does NOT run lab sync. Three security nets: gitignore-first credential writes + doctor FAIL self-heal, end-to-end secret redaction of every error/log/cache string, script-hash change tripwire.

**Manifest frontmatter schema:** `title` (req), `description`, `group` (string|null → dashboard section), `render: number|line|pie|raw|funnel` (req), `source.adapter: http|script`; `source.http`: `endpoint` (may contain `{{tweak:key}}`/`{{cred:key}}`), `method: GET|POST` (default GET), `headers` (values may contain `{{cred:key}}`), `body` (string template, MUST resolve to valid JSON for POST, null for GET), `extract: {seriesPath, seriesKey|null (A/B multi-series split), x, y, agg: last|sum|mean|max}`; `source.script.file` (`scripts/<slug>.mjs` relative to lab/, exports default async fn); `refresh: {ttl_minutes}` (default 1440); `tweaks[]` typed `enum|date|string` ONLY (relative range = enum tweak, explicit range = two date tweaks from/to; there is NO range type); `binding: {objective: <slug>, value: latest|series:<name>}` (optional); `credentials_used: [key...]` (doctor WARNS on missing); `unit` (string|null).

**Cache JSON:** `{slug, fetchedAt, tweaks, granularity, unit, series[{name, points[{t,v}]}], latest, error, errorAt, scriptHash, history?}`. No `sourceHash` (cut — staleness is TTL-only; `scriptHash` exists for the tripwire consumer). `history` is a bounded sync log, oldest→newest, of `SyncEvent {at, status: 'ok'|'failed', latest: number|null, granularity: Granularity|null, error: string|null}`: real runs only — TTL "fresh" skips do NOT append (nothing changed); capped at HISTORY_MAX=50 events AND per-event `error` truncated at 300 chars (HISTORY_ERROR_MAX) — count cap + size cap, both required. Optional field: absent on caches written pre-history; `appendHistory` tolerates a malformed prior cache (non-array `history`).

**Backend files (all new):**
- `src/lib/lab/types.ts` — `InsightManifest`, `HttpSource`, `ScriptSource`, `TweakDecl`, `Binding`, `InsightCache`, `SeriesPoint`, `Series`, `RawSeries`, `LabError`; adapter contract `LabAdapter.fetch(ctx)`.
- `src/lib/lab/store.ts` — mirrors `objectives-store.ts`: paths, `isSafeInsightSlug`, LENIENT parsers (malformed → null, never throw on read), `readInsightFile`/`listInsights`/`getInsight`, `createInsight` (lazy dirs), `writeInsightTweaks`, `readCache`/`writeCache` (atomic), strict `validateManifestForWrite`.
- `src/lib/lab/tweaks.ts` — pure `resolveTweaks(manifest)`: range enum → concrete windows; from/to override; unknown keys pass through.
- `src/lib/lab/rollup.ts` — MAX_POINTS=62; `deriveGranularity(spanDays)`, rollup by YYYY-MM / ISO-week / YYYY-MM-DD; `capSeries` coarsens one level + re-buckets until <=MAX_POINTS.
- `src/lib/lab/credentials.ts` — `readCredentials` (missing → {}); `writeCredential` with STRICT ordering: (1) `ensureLocalOnlyArtifacts` FIRST (full canonical template iff missing), (2) layer lab entries, (3) abort on failure; chmod 0600. `resolvePlaceholders` (redact option); `redactSecrets` final net.
- `src/lib/lab/adapters/generic-http.ts` — resolve endpoint template, SPLIT via `new URL()` into `origin` + `pathname+search` (NEVER full endpoint as baseUrl — trailing-slash/query-corruption hazard). POST: JSON.parse body template before passing (adapter JSON.stringify's — raw string would double-encode). Redaction: every `LabError` built from redacted resolution only.
- `src/lib/lab/adapters/custom-script.ts` — dynamic import of `source.script.file` under lab/ (path-contained). Trust model in file header. On throw: `LabError` + `redactSecrets(err.message, credentialValues)`.
- `src/lib/lab/sync.ts` — `syncInsight`/`syncAll`: TTL staleness skip unless `--force`; script-hash tripwire (sha256 before exec, loud notice on change); resolve tweaks → fetch → `capSeries` → latest; on error keep prior + `error`/`errorAt` via `redactSecrets`; binding write: `updateObjectiveMetric` only when finite + metric exists; `syncAll` sequential, aggregates `failed[]` → non-zero exit; `appendHistory` records one bounded `SyncEvent` per real run (ok AND failed) into `cache.history` (see Cache JSON above).
- `src/server/routes/lab.ts` — mirrors `objectives.ts`: `handleLabList` (GET /api/lab), `handleLabShow` (GET /api/lab/:slug), `handleLabSync` (POST /api/lab/sync), `handleLabTweaks` (PATCH /api/lab/:slug/tweaks). No credential value ever returned.

**Backend edits:**
- `src/server/index.ts` — register 4 routes (~line 302).
- `src/cli/commands/lab.ts` (CREATE) + `src/cli/index.ts` — register beside roadmap (~line 127). Verbs: `sync [slug] --all --force`, `list [--json]`, `show <slug> [--json]` (cache only, NO fetch), `create <slug> --title --group --render --adapter --ttl`, `tweak <slug> <key> <value>`, `credentials set <key>` (hidden prompt or `--value`) + `credentials list` (names only).
- `src/lib/recall.ts` — add `'insight'` to `CorpusType` + `buildCorpus` defaults + loader block mirroring objectives.
- `src/cli/commands/snapshot.ts` — `renderLabSection` mirroring objectives; budget-demotable; cache-only; try/catch → null.
- `src/cli/commands/doctor.ts` — `checkLab` mirroring objectives: safe slug, adapter valid, binding resolves, tweak decls well-formed, render in enum; missing `credentials_used` → WARN; `credentials.json` exists but gitignore doesn't cover it → FAIL. Silent when `lab/insights/` empty.
- `src/lib/git-sync/brain-repo.ts` — `buildBrainGitignore()` adds `'lab/credentials.json'` + `'lab/credentials.*'`. Insights + cache DO sync; only credentials excluded.
- `.gitignore` (root) — add `_dream_context/lab/credentials.json` + `_dream_context/lab/credentials.*` (in-tree mode).

**Dashboard (all new, patterned on roadmap; strictly self-contained):**
- `dashboard/src/hooks/useLab.ts` — mirrors `useObjectives.ts`: `useLabInsights`, `useLabInsight`, `useSyncInsight`, `useSyncAll`, `useUpdateTweaks`.
- `dashboard/src/pages/LabPage.tsx` + `.css`, `components/lab/LabBoard.tsx` (grouping by `group`, sync-all with loud `failed[]` summary; holds `openSlug` state and re-derives the open panel's summary from the live insight list so the panel header refreshes after a sync instead of showing a stale snapshot), `InsightCard.tsx` + `.css` (title/unit/staleness/Refresh/provenance chip "feeds <objective>"; `TweakEditor`; body switch on `render`; whole card is clickable → opens the detail panel, with `stopPropagation` islands on actions/tweaks/raw-view so inner controls don't trigger it), `NumberCard.tsx` (latest + unit + delta), `LineChart.tsx` (hand-rolled SVG polyline + date axis — NO chart lib; interactive: vertical crosshair snaps to the nearest data position, one tooltip reads out EVERY series at that x — pointer aims at a date, never a 2px line; hover-independent geometry memoized so pointer-move renders only rebuild the crosshair/tooltip overlay), `PieChart.tsx` (SVG arcs + legend, hover slice highlight + tooltip), `RawDataView.tsx` (table ⇄ JSON toggle), `TweakEditor.tsx` (generic form from `TweakDecl[]`: enum→select, date→date input, string→text; NO range branch), `InsightDetailPanel.tsx` + `.css` (slide-over opened from a card: large interactive chart, `## Meaning` prose from `GET /api/lab/:slug`, tweak editing, per-insight refresh, and a sync-history rail rendering `cache.history` newest-first with ok/failed status, value, and truncated error; Escape closes).
- `dashboard/src/components/layout/Sidebar.tsx` — add `'lab'` to Page union + nav item + `NavIcon` case (distinct key `nav.labpage`, NOT the existing `lab?:boolean` experimental badge field).
- `dashboard/src/App.tsx` — case `'lab'` in `PageRouter`.
- `dashboard/src/context/I18nContext.tsx` — `nav.labpage` (EN + TR).

**Skill/docs:**
- `.claude/skills/dreamcontext/SKILL.md` — "Lab (insights)" capabilities row.
- `references/tasks-and-features.md` — "Insight capture (in-session — ASK, never auto-create)" protocol mirroring proactive objective capture: detect metric need → dedup via `recall --types insight` → offer → agree name + MEANING prose → pick source → declare tweaks → scaffold via `lab create` (+ script) → offer binding; every write waits for yes. Include plain security statement: "lab scripts execute locally with your credentials; anyone who can push to the brain repo can change what runs on your machine — review a script before the first sync and heed the change-tripwire notice."
- `references/cli-reference.md` — document all lab verbs, credentials file (`credentials set` = ONLY supported creation path), SessionStart Lab section, script trust statement + tripwire, and that sleep does NOT run lab sync.

**Tests (tests/unit/):** `lab-rollup`, `lab-tweaks`, `lab-store`, `lab-adapter-http` (injected `fetchImpl`; POST JSON-parse/double-encode guard + byte-for-byte URL fidelity), `lab-adapter-script`, `lab-sync` (staleness/force/loud-fail/binding-write/script-hash-tripwire), `lab-credentials` (gitignore-first abort, 0600, stub-regression guard, error-redaction), `lab-doctor` (WARN + FAIL branches), `server-lab-routes`. Full suite 2650 passed (as of M1 validation).

**Size/cut lines (if short).** (1) roadmap-side provenance chip — ALREADY cut to v2; (2) pie chart (degrade to number+line+raw; FLAG rather than silently drop); (3) lab tweak CLI verb (dashboard editing still satisfies checklist). NEVER cut: security nets (credentials writer ordering, doctor FAIL, redaction, tripwire), loud-failure/no-silent-sync, or metric-binding write. No migration, no new agent, no changes to `roadmap-model.ts`/`objectives-store.ts`.

### Funnel analytics (2026-07-21, in_review)

**Payload contract (`funnel-set/v1`).** New adapter payload kind for `render: funnel`; scripts/HTTP extract return:

```jsonc
{
  "kind": "funnel-set/v1",
  "dimensions": [                        // declared breakdowns; drive filter UI
    { "key": "language", "label": "Language", "mode": "client" },   // segments included below
    { "key": "country",  "label": "Country",  "mode": "refetch" }   // value interpolated via tweak
  ],
  "funnels": [
    {
      "id": "516",
      "name": "en-start-516",
      "meta": { "product": "…", "url": "…", "hypothesis": "…" },    // free-form, shown in detail rail
      "metrics": {                        // overview table columns, format-hinted
        "users":   { "v": 33,   "format": "count" },
        "spend":   { "v": 831,  "format": "usd" },
        "cpm":     { "v": null, "format": "usd" },
        "lead_rate":   { "v": 0,    "format": "pct" },
        "finish_rate": { "v": 3.03, "format": "pct" }
      },
      "steps": [                          // ORDER = step order; key aligns across funnels/periods
        { "key": "session_start", "label": "session_start", "users": 33 },
        { "key": "email_input",   "label": "Step 01 email_input", "users": 23 }
      ],
      "segments": [                       // optional; enables client-mode filter/breakdown
        { "dims": { "language": "en" }, "users": 21,
          "steps": [ { "key": "session_start", "users": 21 }, … ] }
      ]
    }
  ]
}
```

**Engine (`src/lib/lab/funnel.ts`):** schema validation + caps (MAX_FUNNELS=40, MAX_STEPS=30, MAX_DIMENSIONS=8, segment cardinality → top-8 + Other, MAX_SEGMENTS=64, MAX_FUNNEL_BYTES=400KB — every cap produces a loud notice), cache versioning (`cache.funnel` field + `funnelHistory` bounded trail of MAX=40 snapshots), synthesized `series` for backward compat (card binding uses `funnelLatest` = total users of the first funnel). Reuses tweak mechanism (date range + `refetch` dimension values are tweaks), credential layer, TTL/staleness, script-hash tripwire.

**Dashboard (`dashboard/src/components/lab/funnel/`):** `FunnelOverviewPage.tsx` (table with sort/search/range/deltas/low-sample/benchmarks/kebab/multi-select), `FunnelDetailPage.tsx` (node lane with drop badges + arc gesture + step-table twin + filters + breakdown stack/lanes modes), `FunnelCompareView.tsx` (step-key aligned parallel lanes), `FunnelBars.tsx` (compact fallback), `FunnelCardPreview.tsx` (mini-table preview for the card body). Routing: `labRoute.ts` module owns `/lab/:slug` and `/lab/:slug/f/:funnelId` paths + a NAV_EVENT for same-document pushState pushes; Shell maps `/lab/` to page `'lab'` on load; LabPage clears the path on unmount. View state serialized to query params (F13).

**CLI (`src/cli/commands/lab.ts`):** `lab create --render funnel` scaffolds a funnel-payload script template with inline docs; `lab show <slug>` prints the step table + worst-drop highlight; `doctor` validates funnel cache shape and flags cap violations.

**First consumer / fixture:** h-f_dreamcontext — BigQuery share delivers GA4 funnel steps + spend + transactions; the hand-read funnel-516 dataset (33 users → 0 leads but 1 finish) is the dev fixture. 30 new unit tests added (`tests/unit/lab-funnel.test.ts`); full suite 3773 green.

**Phasing:** F1-F8 = P0 (table + lane + arcs, no breakdowns). F9-F11 = P1 (filters + breakdowns + compare). F12-F14 = P2 (CLI + benchmarks + exports). Each milestone independently shippable. Status: F1-F13 shipped (2026-07-21), F14 partial (PNG export slipped).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-21 - Funnel analytics shipped (in_review, pending visual QA)
- Extended PRD to document funnel analytics (multi-page routed insights): new user stories (9), acceptance criteria F1-F14 (F1-F13 shipped, F14 partial — benchmarks + copy-as-Markdown done, PNG export slipped), technical details (funnel-set/v1 contract, engine caps, dashboard pages, CLI scaffold/show/doctor), and constraints/decisions (Δ-precedence, multi-page routing, client-filter dimming, Excalidraw visual language). Shipped across commits 4cf4ec8 (engine), 8a1bf63 (dashboard), 16c0c3f (skill docs). 30 new unit tests, full suite 3773 green. Task `lab-funnel-analytics` status in_review — visual browser QA pending. PRD status `completed` → `in_review` to reflect new in-flight work; `updated` → 2026-07-21, `related_tasks` += lab-funnel-analytics.

### 2026-07-07 - Completed and shipped in v0.13.0
- Feature fully released: all user stories, acceptance criteria, and manual validation checklist completed. Status `in_review` → `completed`. Lab M1 specification shipped across v0.12.0–v0.13.0 with dashboard UX polish (collapsible groups, reorderable cards, detail panel, interactive charts), `lab bind` objective-side binding, bounded sync history, and Entity Router hardening (language-independent entity nouns + problem-shape triggers + don't-rebuild rule). Full test suite 2891 tests green.

### 2026-07-07 - Insights board UX + prefs persistence (v0.13.0)
- Groups now collapsible (chevron header + count, aria-expanded) and cards drag-reorderable within their group (HTML5 dnd, TaskCard idiom). Prefs persist per-machine via new `useLabPrefs` hook (localStorage mirror + debounced write-through to new `GET/PUT /api/lab-prefs` → `state/.lab-prefs.json` via `makeSettingsHandlers`, gitignored in `buildBrainGitignore`) — survives the desktop app loopback-port localStorage wipe. Runtime-verified via scratch vault: API round-trip, hydration after `localStorage.clear()`, drag reorder (`DragEvent` dispatch), collapse persistence, card-click panel intact.

### 2026-07-07 - Objective-side insight binding UI + `lab bind` (v0.13.0)
- New `bindInsight` engine (`sync.ts`) + strict `writeInsightBinding` store write: objective-existence check, single-feeder invariant (`unbound[]`), immediate `metric.current` seeding from the cached latest (`seededCurrent`).
- Surfaces: `PATCH /api/lab/:slug/binding`, CLI `lab bind <slug> <objective> [--value] [--clear]`, dashboard `InsightPicker` (searchable, shows latest value + "feeds <objective>" badges) wired into ObjectiveCreateModal (prefills metric label/unit/current from the insight; binds after create) and ObjectiveDetailPanel Key Result section (connect/change/disconnect with toasts; clearing the metric also unbinds).
- `useUpdateBinding` hook invalidates lab + objectives + roadmap queries. 5 new route tests; full suite 2891 passed.
- Agent-facing docs pass (all surfaces): SKILL.md Lab capabilities row + Entity Router now name `lab bind`; cli-reference (`lab bind` row + insight-fed hands-off caveat on `roadmap objective metric`); tasks-and-features (objective protocol steps 4/6 offer-connect + measured-KR exception + clear-order rule, insight protocol step 7 names the verb); installed skill copy re-synced; sleep agents (.claude/agents/sleep-tasks/state) already carried the hands-off + one-feeder rules; README (bullet + cheatsheet row) and DEEP-DIVE (bind flow + verb list) updated. Marker tests green.

### 2026-07-06 - Bounded sync history + InsightDetailPanel slide-over + interactive charts (working tree, in_review)
- `cache.history` bounded sync log added (`SyncEvent` in `types.ts`, `appendHistory` in `sync.ts`; HISTORY_MAX 50, per-event error cap 300 chars, fresh-skips don't append) + `tests/unit/lab-sync.test.ts` coverage. A review verifier flagged this PRD's cache-JSON contract as drifted — reconciled above.
- Dashboard: `InsightDetailPanel` slide-over (large interactive chart, Meaning prose, tweak editing, sync-history rail), clickable cards with stopPropagation islands, `LineChart` crosshair + all-series tooltip (memoized geometry), `PieChart` hover tooltips.
- Skill docs (see dreamcontext-skill-folder PRD): v0.11.0 had shipped Lab with ZERO skill docs in `skill/` (edits had hit installed copies and were clobbered); Lab capabilities row + Entity Router section + Lab reference sections landed in `skill/` this session, pinned by marker tests in `taxonomy-markers.test.ts`.
- Status stays `in_review`: the 8-item manual dashboard checklist is still pending user validation.

### 2026-07-06 - v0.12.0 shipped with Lab showcase
- Lab page showcase shipped in v0.12.0 (commit 5201cc0): animated `LabShowcase` component with insight pipeline flow, `LabEmptyState` with flow diagram, shared `labFlowSpec` flow geometry extracted for reuse across About/Council/Lab diagrams.

### 2026-07-05 - M1 implemented, manual validation in-progress (goal-skill Phase 4-6)
- Backend complete: `lib/lab/{types,store,tweaks,rollup,credentials,sync,adapters/{generic-http,custom-script,index}}.ts`; `server/routes/lab.ts` + index registration; CLI `lab.ts` + index registration; `recall.ts` insight corpus type; `snapshot.ts` Lab section; `doctor.ts` checkLab; `brain-repo.ts` + root `.gitignore` lab credential entries. Dashboard complete: `useLab.ts` hook, `LabPage`/`LabBoard`/`InsightCard`/`NumberCard`/`LineChart`/`PieChart`/`RawDataView`/`TweakEditor` components + CSS; `Sidebar`/`App`/`NavIcons`/`I18nContext` wired (page `'lab'`, distinct `nav.labpage` key). Skill docs updated: `SKILL.md` capabilities row, `tasks-and-features.md` Lab section + insight-capture protocol + security statement, `cli-reference.md` lab verbs. Dashboard `tsc --noEmit` clean. Automated validation (91 new unit tests + suite green) PASS; manual dashboard checklist (8 items) pending. Status: `planning` → `in_progress` → `in_review`.

### 2026-07-05 - Created from task plan v3
- Feature PRD created from converged goal-skill plan (task `feat-lab-analytics-insights-subsystem`). Plan validated by 3 reviewers (pragmatist/critic/security) over 3 iterations, 9 blocking findings resolved. Status `planning`.
