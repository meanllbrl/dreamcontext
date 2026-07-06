---
id: feat_lab_insights
status: in_review
created: '2026-07-05'
updated: '2026-07-06'
released_version: '0.12.0'
tags:
  - feature
  - analytics
  - 'topic:cli'
  - 'topic:dashboard'
  - backend
  - frontend
  - 'topic:roadmap'
related_tasks:
  - feat-lab-analytics-insights-subsystem
type: feature
name: lab-analytics-insights
description: ''
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
- [ ] As a user, I can tweak an insight's time range (e.g., last_30_days → last_1_year) from the dashboard and see the chart re-fetch and granularity coarsen to monthly. *(M1 shipped dashboard tweak editing, validation pending)*
- [ ] As a user, the doctor command warns me when an insight manifest declares credentials I haven't set, and fails when credentials.json exists but isn't gitignored. *(M1 shipped, validation pending)*

## Acceptance Criteria

*(From task `feat-lab-analytics-insights-subsystem` — validated plan v3, converged via goal-skill with 3 reviewers over 3 iterations.)*

### Core engine + storage

- [x] `lab create <slug> --title "..." --render number|line|pie|raw --adapter http|script` scaffolds `lab/insights/<slug>.md` (frontmatter config + `## Meaning` prose); `lab list` shows it.
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
- [ ] **Manual dashboard checklist** (8 items): Lab page opens; insights render grouped; number shows latest+unit+staleness; line renders SVG with date axis; pie renders slices+legend; raw toggles table⇄JSON; per-insight Refresh updates on success and toasts loud error on failure; Sync all refreshes every insight with one deliberate failure still updating the others; edit tweak (range last_30_days → last_1_year), Save, reload → still set, refresh re-fetches and granularity coarsens; bound insight shows "feeds <objective>" provenance chip.

## Constraints & Decisions
<!-- LIFO: newest at top -->

- **[2026-07-05]** **Insights, not raw data.** MAX_POINTS=62 per series is a structural cap enforced in `rollup.ts` (`capSeries` coarsens daily→weekly→monthly until under cap). A ~1-year span is monthly-only; a ~1-month span may be daily/weekly. Granularity derives from resolved tweak span: >180d monthly, 45-180d weekly, <=45d daily. Lab is NOT a BI tool — it delivers curated metrics to agents + dashboards, never raw data dumps.
- **[2026-07-05]** **Security contract (non-negotiable, from adversarial security review).** Credentials written ONLY via `lab credentials set` → `writeCredential`, which calls `ensureLocalOnlyArtifacts` FIRST (never creates a stub `_dream_context/.gitignore` — full canonical template iff missing), layers lab gitignore entries, aborts without writing on any gitignore failure, chmod 0600. Doctor FAILS on existing-but-gitignore-uncovered `credentials.json`. Every error/log/cache string built from the redacted resolution (`{{cred:*}}` → `***`) + `redactSecrets` final net; raw Error objects never logged. Script-hash tripwire prints loud notice before executing a changed script.
- **[2026-07-05]** **Trust model (accepted).** `lab/scripts/*.mjs` are the first executable artifact brain-repo sync carries; they run in-process with credentials passed in — same trust level as the repo itself. No sandbox in MVP; mitigation = plain-language statement in skill docs + the change tripwire. Anyone with brain-repo push access can change what runs on a peer machine at next lab sync.
- **[2026-07-05]** **Sleep does NOT run lab sync** (credential exposure, latency, non-determinism). The only sleep↔metric interaction remains the existing `metric.current` relaxation; a bound insight feeds it via its own lab sync instead.
- **[2026-07-05]** **Provenance: plan converged via goal-skill** (planner + pragmatist/critic/security reviewers, 3 iterations, 9 blocking findings folded in — scope cuts P1-P3, `ApiAdapter` integration C1 + URL-split C2, security S1-S3 + stub-gitignore regression S4). All integration claims verified against working tree on branch `feat/sleep-debt-header-tracker` as of 2026-07-05.
- **[2026-07-05]** **Plan assumptions (defaults chosen; PO may veto before implementation).** A1: charts are hand-rolled SVG (no chart lib exists or added); A2: insight manifests + cache snapshots DO sync in the brain repo — only credentials excluded; A4: `writeCredential` ensures BOTH governing gitignores unconditionally; Q1: `lab create` is flag-driven (conversation lives in skill protocol); Q2: empty bound series leaves `metric.current` untouched and warns (never writes non-finite).
- **[2026-07-05]** **Out of scope / v2.** Roadmap-side provenance chip (insight-side "feeds <objective>" is in); ready-made PostHog/Google-Sheets adapters (expressible via generic HTTP or scripts); JS-expression extraction (JSON-path only in MVP); range tweak TYPE (enum|date|string only); sourceHash/request-level cache invalidation (staleness is TTL-only); objective-side metric time-series/trendline; `useLabPrefs` persistence; sleep-driven sync; insight federation; lab-adapter-builder sub-agent; script sandboxing beyond tripwire+docs; init scaffolding/migration for `lab/` (store creates dirs lazily like objectives).

## Technical Details

**Architecture (plan v3, converged 2026-07-05 — 3 reviewers SOLID).** Lab mirrors the objectives subsystem (the load-bearing precedent). Markdown-first storage: manifest per insight at `_dream_context/lab/insights/<slug>.md` (frontmatter config + `## Meaning` prose, recall-indexed), cache snapshot at `_dream_context/lab/cache/<slug>.json` (post-rollup series + `fetchedAt` + `scriptHash`), gitignored `_dream_context/lab/credentials.json` written ONLY via gitignore-first CLI. Pure store reads/writes manifests; sync engine resolves tweaks → adapter (generic-HTTP | custom-script) → granularity-capped rollup → cache write → optional bound-objective `metric.current` write via existing `updateObjectiveMetric`. CLI and `/api/lab*` routes call the same engine. Agents: SessionStart snapshot section + `insight` recall corpus type + `lab show --json` (cache only, no fetch). Dashboard: Lab page with number/line/pie/raw renders, per-insight + sync-all refresh, generic typed tweak editing, manifest-declared grouping. Sleep does NOT run lab sync. Three security nets: gitignore-first credential writes + doctor FAIL self-heal, end-to-end secret redaction of every error/log/cache string, script-hash change tripwire.

**Manifest frontmatter schema:** `title` (req), `description`, `group` (string|null → dashboard section), `render: number|line|pie|raw` (req), `source.adapter: http|script`; `source.http`: `endpoint` (may contain `{{tweak:key}}`/`{{cred:key}}`), `method: GET|POST` (default GET), `headers` (values may contain `{{cred:key}}`), `body` (string template, MUST resolve to valid JSON for POST, null for GET), `extract: {seriesPath, seriesKey|null (A/B multi-series split), x, y, agg: last|sum|mean|max}`; `source.script.file` (`scripts/<slug>.mjs` relative to lab/, exports default async fn); `refresh: {ttl_minutes}` (default 1440); `tweaks[]` typed `enum|date|string` ONLY (relative range = enum tweak, explicit range = two date tweaks from/to; there is NO range type); `binding: {objective: <slug>, value: latest|series:<name>}` (optional); `credentials_used: [key...]` (doctor WARNS on missing); `unit` (string|null).

**Cache JSON:** `{slug, fetchedAt, tweaks, granularity, unit, series[{name, points[{t,v}]}], latest, error, errorAt, scriptHash}`. No `sourceHash` (cut — staleness is TTL-only; `scriptHash` exists for the tripwire consumer).

**Backend files (all new):**
- `src/lib/lab/types.ts` — `InsightManifest`, `HttpSource`, `ScriptSource`, `TweakDecl`, `Binding`, `InsightCache`, `SeriesPoint`, `Series`, `RawSeries`, `LabError`; adapter contract `LabAdapter.fetch(ctx)`.
- `src/lib/lab/store.ts` — mirrors `objectives-store.ts`: paths, `isSafeInsightSlug`, LENIENT parsers (malformed → null, never throw on read), `readInsightFile`/`listInsights`/`getInsight`, `createInsight` (lazy dirs), `writeInsightTweaks`, `readCache`/`writeCache` (atomic), strict `validateManifestForWrite`.
- `src/lib/lab/tweaks.ts` — pure `resolveTweaks(manifest)`: range enum → concrete windows; from/to override; unknown keys pass through.
- `src/lib/lab/rollup.ts` — MAX_POINTS=62; `deriveGranularity(spanDays)`, rollup by YYYY-MM / ISO-week / YYYY-MM-DD; `capSeries` coarsens one level + re-buckets until <=MAX_POINTS.
- `src/lib/lab/credentials.ts` — `readCredentials` (missing → {}); `writeCredential` with STRICT ordering: (1) `ensureLocalOnlyArtifacts` FIRST (full canonical template iff missing), (2) layer lab entries, (3) abort on failure; chmod 0600. `resolvePlaceholders` (redact option); `redactSecrets` final net.
- `src/lib/lab/adapters/generic-http.ts` — resolve endpoint template, SPLIT via `new URL()` into `origin` + `pathname+search` (NEVER full endpoint as baseUrl — trailing-slash/query-corruption hazard). POST: JSON.parse body template before passing (adapter JSON.stringify's — raw string would double-encode). Redaction: every `LabError` built from redacted resolution only.
- `src/lib/lab/adapters/custom-script.ts` — dynamic import of `source.script.file` under lab/ (path-contained). Trust model in file header. On throw: `LabError` + `redactSecrets(err.message, credentialValues)`.
- `src/lib/lab/sync.ts` — `syncInsight`/`syncAll`: TTL staleness skip unless `--force`; script-hash tripwire (sha256 before exec, loud notice on change); resolve tweaks → fetch → `capSeries` → latest; on error keep prior + `error`/`errorAt` via `redactSecrets`; binding write: `updateObjectiveMetric` only when finite + metric exists; `syncAll` sequential, aggregates `failed[]` → non-zero exit.
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
- `dashboard/src/pages/LabPage.tsx` + `.css`, `components/lab/LabBoard.tsx` (grouping by `group`, sync-all with loud `failed[]` summary), `InsightCard.tsx` + `.css` (title/unit/staleness/Refresh/provenance chip "feeds <objective>"; `TweakEditor`; body switch on `render`), `NumberCard.tsx` (latest + unit + delta), `LineChart.tsx` (hand-rolled SVG polyline + date axis — NO chart lib), `PieChart.tsx` (SVG arcs + legend), `RawDataView.tsx` (table ⇄ JSON toggle), `TweakEditor.tsx` (generic form from `TweakDecl[]`: enum→select, date→date input, string→text; NO range branch).
- `dashboard/src/components/layout/Sidebar.tsx` — add `'lab'` to Page union + nav item + `NavIcon` case (distinct key `nav.labpage`, NOT the existing `lab?:boolean` experimental badge field).
- `dashboard/src/App.tsx` — case `'lab'` in `PageRouter`.
- `dashboard/src/context/I18nContext.tsx` — `nav.labpage` (EN + TR).

**Skill/docs:**
- `.claude/skills/dreamcontext/SKILL.md` — "Lab (insights)" capabilities row.
- `references/tasks-and-features.md` — "Insight capture (in-session — ASK, never auto-create)" protocol mirroring proactive objective capture: detect metric need → dedup via `recall --types insight` → offer → agree name + MEANING prose → pick source → declare tweaks → scaffold via `lab create` (+ script) → offer binding; every write waits for yes. Include plain security statement: "lab scripts execute locally with your credentials; anyone who can push to the brain repo can change what runs on your machine — review a script before the first sync and heed the change-tripwire notice."
- `references/cli-reference.md` — document all lab verbs, credentials file (`credentials set` = ONLY supported creation path), SessionStart Lab section, script trust statement + tripwire, and that sleep does NOT run lab sync.

**Tests (tests/unit/):** `lab-rollup`, `lab-tweaks`, `lab-store`, `lab-adapter-http` (injected `fetchImpl`; POST JSON-parse/double-encode guard + byte-for-byte URL fidelity), `lab-adapter-script`, `lab-sync` (staleness/force/loud-fail/binding-write/script-hash-tripwire), `lab-credentials` (gitignore-first abort, 0600, stub-regression guard, error-redaction), `lab-doctor` (WARN + FAIL branches), `server-lab-routes`. Full suite 2650 passed (as of M1 validation).

**Size/cut lines (if short).** (1) roadmap-side provenance chip — ALREADY cut to v2; (2) pie chart (degrade to number+line+raw; FLAG rather than silently drop); (3) lab tweak CLI verb (dashboard editing still satisfies checklist). NEVER cut: security nets (credentials writer ordering, doctor FAIL, redaction, tripwire), loud-failure/no-silent-sync, or metric-binding write. No migration, no new agent, no changes to `roadmap-model.ts`/`objectives-store.ts`.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-06 - v0.12.0 shipped with Lab showcase
- Lab page showcase shipped in v0.12.0 (commit 5201cc0): animated `LabShowcase` component with insight pipeline flow, `LabEmptyState` with flow diagram, shared `labFlowSpec` flow geometry extracted for reuse across About/Council/Lab diagrams.

### 2026-07-05 - M1 implemented, manual validation in-progress (goal-skill Phase 4-6)
- Backend complete: `lib/lab/{types,store,tweaks,rollup,credentials,sync,adapters/{generic-http,custom-script,index}}.ts`; `server/routes/lab.ts` + index registration; CLI `lab.ts` + index registration; `recall.ts` insight corpus type; `snapshot.ts` Lab section; `doctor.ts` checkLab; `brain-repo.ts` + root `.gitignore` lab credential entries. Dashboard complete: `useLab.ts` hook, `LabPage`/`LabBoard`/`InsightCard`/`NumberCard`/`LineChart`/`PieChart`/`RawDataView`/`TweakEditor` components + CSS; `Sidebar`/`App`/`NavIcons`/`I18nContext` wired (page `'lab'`, distinct `nav.labpage` key). Skill docs updated: `SKILL.md` capabilities row, `tasks-and-features.md` Lab section + insight-capture protocol + security statement, `cli-reference.md` lab verbs. Dashboard `tsc --noEmit` clean. Automated validation (91 new unit tests + suite green) PASS; manual dashboard checklist (8 items) pending. Status: `planning` → `in_progress` → `in_review`.

### 2026-07-05 - Created from task plan v3
- Feature PRD created from converged goal-skill plan (task `feat-lab-analytics-insights-subsystem`). Plan validated by 3 reviewers (pragmatist/critic/security) over 3 iterations, 9 blocking findings resolved. Status `planning`.
