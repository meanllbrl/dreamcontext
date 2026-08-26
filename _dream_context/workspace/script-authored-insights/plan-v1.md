I read the task doc, the engineering skill, and the live code (`types.ts`, `sync.ts`, `matrix.ts`, `store.ts`, `lab.ts`, `doctor.ts`, `routes/lab.ts`, `labHtmlKit.ts`, `HtmlInsightBody.tsx`, `chartRegistry.ts`, `labRoute.ts`, `LabPage.tsx`, `InsightCard.tsx`, `InsightDetailPanel.tsx`, `lab-breakdown-reports.mjs`, the skill docs and `feature-integration-pattern.md`). Plan below.

---

# (a) The envelope decision

## What replaces `{ data, html? }`

`RawPayloadEnvelope` is **extended, not replaced** — `{ data, html?, app? }`. Two new payload kinds land, one for presentation and one for typed data, because the goal needs both a *declared page list* and a *per-page queryable dataset*:

| kind | half | what it is |
|---|---|---|
| `app/v1` | presentation | the multi-page body: `entry`, `pages[{id,title,html,dataset?}]`, optional `card`, optional `shell{style?,script?}` |
| `dataset/v1` | typed data | **named, plural** dimensional datasets — the successor authoring shape to `matrix/v1`, same row grammar (`dims[] + rows[{d,v,n?,prev?}]`), N of them instead of 1 |

`data` stays **MANDATORY** and now accepts a fourth shape:

```ts
// src/lib/lab/types.ts
export interface RawPayloadEnvelope {
  data: RawSeries[] | RawFunnelSet | RawMatrixSet | RawDatasetBundle;  // + dataset/v1
  html?: string;        // html/v1 — unchanged, grandfathered
  app?: RawAppSpec;     // NEW — app/v1
}
```

**Why `dataset/v1` and not "keep returning matrix/v1":** a multi-page app has one table *per page* — the acceptance criterion literally says "pick a page's dataset". `matrix/v1` gives exactly one set per insight. `dataset/v1` keeps `matrix/v1`'s dimension-coordinate row grammar verbatim (constraint 2: dimensions never in series names) and is validated by **delegating each dataset to the existing `parseMatrixSet`** — one dimensional grammar, one cap set, one parser. matrix/v1's *scaffold and decision-table row* are what get deprecated; its *grammar* is what survives, renamed and pluralised.

## Exact types, files, validation points

```ts
// src/lib/lab/types.ts  — SHAPES ONLY (caps live next to their parser, matrix.ts precedent)
export const RENDERS = [...existing, 'app'] as const;

export interface AppPage  { id: string; title: string; html: string; dataset?: string }
export interface AppShell { style?: string; script?: string }
export interface AppSpec  { kind: 'app/v1'; entry: string; card?: string; pages: AppPage[]; shell?: AppShell }
export type   RawAppSpec  = { kind: 'app/v1' } & Record<string, unknown>;
export function isRawAppSpec(result: unknown): result is RawAppSpec;

export interface Dataset       { key: string; label?: string; unit?: string | null;
                                 dims: MatrixDim[]; rows: MatrixRow[]; total?: MatrixTotal }
export interface DatasetBundle { kind: 'dataset/v1'; primary?: string; datasets: Dataset[] }
export type   RawDatasetBundle = { kind: 'dataset/v1' } & Record<string, unknown>;
export function isRawDatasetBundle(result: unknown): result is RawDatasetBundle;

export interface AppCacheEntry     { spec: AppSpec;        notices: string[]; range: { fromISO: string; toISO: string } }
export interface DatasetCacheEntry { bundle: DatasetBundle; notices: string[]; range: { fromISO: string; toISO: string } }
export interface DatasetSnapshot   { at: string; range: { fromISO: string; toISO: string }; bundle: DatasetBundle }

export interface InsightCache {
  /* …existing… */
  app?: AppCacheEntry;                 // NEW
  datasets?: DatasetCacheEntry;        // NEW
  datasetHistory?: DatasetSnapshot[];  // NEW — the app's time axis (mirrors matrixHistory)
}
```

**Validation point — one place, exactly like funnel/matrix:** `syncInsight()` in `src/lib/lab/sync.ts` calls `parseAppSpec()` (new `src/lib/lab/app.ts`) and `parseDatasetBundle()` (new `src/lib/lab/dataset.ts`). `checkLab()` in `src/cli/commands/doctor.ts` re-validates the stored cache through the same two parsers.

**Loud rejects (LabError, no truncation, no half-write) at that point:**
- `app` present with no `data` → existing "data is mandatory" reject already fires.
- `app` **and** `html` both present → `"an insight declares one body contract — app/v1 or html/v1, not both"`.
- serialized `app` spec > `MAX_APP_BYTES` (300 000, same budget as `MAX_HTML_BYTES`).
- `pages.length > MAX_APP_PAGES` (12), duplicate page id, page id failing `/^[a-z0-9][a-z0-9-]{0,63}$/`, `entry`/`card`/`page.dataset` naming something absent.
- bundle > `MAX_MATRIX_BYTES` (200 000, reused) or `datasets.length > MAX_DATASETS` (12).
- Per-dataset dim/row/cardinality caps come back as **notices** (top-8 + "Other", ≤400 rows), never silent — `doctor` re-flags survivors.

## The bridge (the network-less guarantee is untouched)

`HTML_KIT_SANDBOX = 'allow-scripts'` and `HTML_KIT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"` are **imported and reused byte-identical** by the app srcdoc builder. No token added to the sandbox, no directive relaxed. `script-src 'unsafe-inline'` already permits the injected runtime shim.

Because the frame has no `allow-same-origin`, its origin is opaque (`event.origin === "null"`). So:

- **Host gate is identity, not origin:** accept a message only when `event.source === iframeRef.current?.contentWindow`. Never branch on `event.origin`.
- **Host posts with `targetOrigin: '*'`** — required for an opaque-origin frame; safe because the frame is our own srcdoc and receives only the insight cache it is already displaying.
- Unknown `type`/`v` → ignored (forward compatible). `height` clamped to `[80, 20000]`. `navigate` to an unknown page id → ignored + one console warn.

```ts
// dashboard/src/components/lab/labAppRuntime.ts
export const LAB_APP_PROTOCOL = 1;
export type LabAppOutbound =                       // iframe → host
  | { v: 1; type: 'ready';    page: string }
  | { v: 1; type: 'height';   px: number }
  | { v: 1; type: 'navigate'; page: string; params?: Record<string, string> }
  | { v: 1; type: 'data';     requestId: string; dataset: string | null };
export type LabAppInbound =                        // host → iframe
  | { v: 1; type: 'route';      page: string; params: Record<string, string> }
  | { v: 1; type: 'dataResult'; requestId: string; ok: true;  dataset: Dataset }
  | { v: 1; type: 'dataResult'; requestId: string; ok: false; error: string }
  | { v: 1; type: 'theme';      scheme: 'light' | 'dark'; tokens: Record<string, string> };
```

Author-facing API injected by the **host** (never authored by the script): `lab.navigate(id, params?)`, `lab.data(key?) → Promise<Dataset>`, `lab.onRoute(cb)`, `lab.page`, `lab.params`. Height is auto-reported by a `ResizeObserver` in the shim — the author does nothing.

**Data comes from the host, never the wire.** `lab.data()` is answered from `cache.datasets` (or a bundle synthesized from `cache.series` when the data half is legacy). This is also why the 300 KB html cap stays livable — the author stops embedding numbers twice.

**Theme flips over the bridge, not by srcdoc rebuild.** `HtmlInsightBody` rebuilds the srcdoc on `data-theme` change; for an app that would reset app state mid-interaction. The shim rewrites the `:root` block from a `theme` message instead.

## Height & full-screen

| mode | height |
|---|---|
| `card` | `clamp(reported, 120, 320)`, iframe `pointerEvents: 'none'` — the card is a preview and one click target that opens the app |
| `page` | `clamp(reported, 200, 20000)` — content-driven, the page scrolls |
| `full` | `100%` — the app scrolls internally |

Full-screen is a **URL-driven CSS overlay** (`?fs=1` → `.lab-app-page--fullscreen { position: fixed; inset: 0 }`, Escape exits), not the native Fullscreen API: deep-linkable, survives reload, and drivable from Playwright. Native fullscreen is rejected for exactly those three reasons.

## Routing

`/lab/<slug>` → entry page. `/lab/<slug>/p/<pageId>` → that page. Funnel's `/f/` grammar is untouched:

```ts
// labRoute.ts
export interface LabRoute { slug: string|null; funnelId: string|null; pageId: string|null; report: string|null }
// parseLabPath regex: /^\/lab\/([^/]+)(?:\/(f|p)\/([^/]+))?\/?$/
export function labAppPath(slug: string, pageId: string | null): string;
export function pushLabAppPath(slug: string, pageId: string | null, bus?: EventTarget): void;
```

---

# (b) File-by-file plan

### Engine — `src/lib/lab/`

**`types.ts`** — add `'app'` to `RENDERS`; add `AppPage`/`AppShell`/`AppSpec`/`RawAppSpec`/`isRawAppSpec`, `Dataset`/`DatasetBundle`/`RawDatasetBundle`/`isRawDatasetBundle`, `AppCacheEntry`/`DatasetCacheEntry`/`DatasetSnapshot`; extend `RawPayloadEnvelope.data` union with `RawDatasetBundle` and add `app?: RawAppSpec`; extend `AdapterResult`; add `app?`/`datasets?`/`datasetHistory?` to `InsightCache`. `MAX_HTML_BYTES` and `isRawPayloadEnvelope` unchanged.

**NEW `app.ts`** (modelled on `matrix.ts`) — `APP_SPEC_KIND`, `MAX_APP_PAGES=12`, `MAX_APP_BYTES=300_000`, `APP_PAGE_ID_RE`; `parseAppSpec(raw): { spec, notices }` (throws `LabError` on the loud rejects above, notices for coercions e.g. a missing `title` defaulting to the id); `findAppPage(spec, id|null): AppPage|null` (null → `entry`); `appPageIds(spec): string[]`; `makeAppSnapshot`-free by design (the spec is presentation; only data is trailed).

**NEW `dataset.ts`** — `DATASET_BUNDLE_KIND`, `MAX_DATASETS=12`, `DATASET_HISTORY_MAX=60`, `DATASET_HISTORY_MAX_BYTES=1_000_000`; `parseDatasetBundle(raw)` — per dataset delegates to `parseMatrixSet({kind:'matrix/v1', dims, rows, total, unit})` and prefixes its notices with the dataset key; `datasetToSeries(bundle)` (primary dataset → same synthesis `matrixToSeries` does); `datasetLatest(bundle)` (primary `total.v` only, `null` never fabricated — plus the same "bound but no total" warn matrix emits); `makeDatasetSnapshot`, `appendDatasetHistory` (count **and** byte cap together); `findDataset(bundle, key|null)`; `seriesToDatasetBundle(series): DatasetBundle` — a **read-side** adapter (dims `series` × `date`) so `lab query` and `lab.data()` have one surface over legacy caches. It is not an authoring path and the doc says so.

**`sync.ts`** (~lines 268–412) — in the envelope unwrap: read `fetched.app`, reject `app`+`html` together, reject over-cap; add an `isRawDatasetBundle(result)` branch beside the funnel/matrix branches (validate → `datasetToSeries` → `datasetLatest` → `granularity='daily'` → `appendDatasetHistory`), with the same "adapter returned X but render is Y" warn; write `cache.app`/`cache.datasets`/`cache.datasetHistory` **alongside** data on ok; an ok run without `app` clears a stale `cache.app` (same rule as `html`); the failure path preserves `prior.app`/`prior.datasets`/`prior.datasetHistory` beside the existing funnel/matrix keep-prior lines.

**`store.ts`** — new `appScriptTemplate(slug)`: a documented 3-page `app/v1` + `dataset/v1` scaffold using `lk-*` classes and `lab.navigate`/`lab.data`; extend the tweak block so `render === 'app'` also gets the `range` enum; extend the script-scaffold branch to `render === 'app'`; **remove `breakdown` from the scaffold branch** and delete `matrixScriptTemplate` (it is the authoring scaffold constraint 3 names — the parser/render/cache paths stay); `createInsight` emits a loud `console.warn` when `render === 'breakdown'`: *"matrix/v1 is deprecated — existing breakdown insights keep rendering; new dimensional insights should use `--render app` (app/v1 + dataset/v1). No script template scaffolded."*

**NEW `htmlText.ts`** — `htmlToText(html, { format?: 'text'|'md'; maxChars? }): string`. Dependency-free (no cheerio/jsdom/turndown — a ~120-line purpose-built extractor beats a supply-chain addition here): drop `<script>/<style>` contents, decode named + numeric entities, block tags → newlines, `<h1-6>` → `#`, `<li>` → `- `, `<table>` → markdown pipe table, collapse runs of blank lines.

**NEW `datasetQuery.ts`** —
```ts
export interface DatasetQuery { dataset?: string|null; where?: Record<string,string>; groupBy?: string|null; top?: number|null }
export interface DatasetQueryResult {
  dataset: string; label: string|null; unit: string|null; dims: string[];
  rows: { d: Record<string,string>; v: number|null; n: number|null; prev: number|null }[];
  total: { v: number|null; n: number|null } | null;
  notices: string[];   // e.g. `unknown dim "plan" in --where — ignored`
}
export function queryDataset(bundle: DatasetBundle, q: DatasetQuery): DatasetQueryResult;
export function resolveDatasetAsOf(cache: InsightCache, dateISO: string|null):
  { bundle: DatasetBundle; at: string; range: { fromISO: string; toISO: string } } | null;  // null = honest empty
```
`resolveDatasetAsOf` reuses the reports as-of rule exactly: latest snapshot at/before end of that date, **never interpolated**; `null` when none exists.

### CLI

**`src/cli/commands/lab.ts`** — add `printAppPages(app)` and `printDatasetBundle(entry)` (reuse the `printMatrixSet` pivot layout per dataset). Extend `show`: print `app: N page(s) — id (entry) · id · id`, the datasets pivot, and a pointer line to `lab body`. Two new subcommands:
- `lab body <slug> [--page <id>] [--format text|md|html] [--json]` — default `text`; `html` prints the raw source; `--json` emits `{ pages, page, html, text }`. Never fetches.
- `lab query <slug> [--dataset <key>] [--where k=v …] [--group-by <dim>] [--top <n>] [--date YYYY-MM-DD] [--json]` — cache-only; `--date` goes through `resolveDatasetAsOf` and prints the honest empty state when nothing qualifies; falls back to `seriesToDatasetBundle` when the insight has no `datasets`.

**`src/cli/commands/doctor.ts` `checkLab` (~593–616 is the template)** — add an `m.render === 'app'` block: re-parse `cache.app.spec` via `parseAppSpec` (invalid → warn naming the error), re-parse `cache.datasets.bundle` via `parseDatasetBundle` (each surviving notice → "violates a cap … re-run `lab sync --force`"), and check `datasetHistory` against **both** `DATASET_HISTORY_MAX` and `DATASET_HISTORY_MAX_BYTES`. Plus a render-agnostic warn when a cache carries **both** `app` and `html` (a pre-guard cache).

### Server

**`src/server/routes/lab.ts`** — rename `withoutFunnelHistory` → `withoutHistoryTrails`, stripping `funnelHistory` **and** `datasetHistory` (same 84.5%-of-payload lesson; the dashboard's bridge serves current datasets, dated ones are a CLI/report concern). `handleLabShow`'s response shape otherwise unchanged — `app`/`datasets` ride through.

### Dashboard — `dashboard/src/components/lab/`

**NEW `appModel.ts`** — dashboard-side mirror of `AppSpec`/`AppPage`/`AppShell`/`Dataset`/`DatasetBundle`/`AppCacheEntry`/`DatasetCacheEntry` (the `matrixModel.ts` / `funnelModel.ts` idiom; the dashboard cannot import from `src/`).

**NEW `labAppRuntime.ts`** — `LAB_APP_PROTOCOL`, `LabAppInbound`/`LabAppOutbound`, `LAB_APP_RUNTIME_JS` (the shim as a TS string, same reason `LAB_HTML_KIT_CSS` is one — vitest stubs `?raw`), and:
```ts
export function buildAppSrcdoc(input: {
  page: AppPage; shell?: AppShell; pages: { id: string; title: string }[];
  tokens: Record<string, string>; scheme: 'light'|'dark'; params: Record<string, string>;
}): string;
```
Order: CSP meta **first** → `:root` resolved tokens → `LAB_HTML_KIT_CSS` (imported from `labHtmlKit.ts`) → `shell.style` → runtime shim → page html → `shell.script`.

**NEW `lab-app-runtime.js`** — byte-identical reference copy of the shim for authors, pinned by a drift test (the `lab-html-kit.css` mirror-with-drift-test pattern).

**NEW `LabAppFrame.tsx`** — the host half of the bridge:
```tsx
export function LabAppFrame(props: {
  spec: AppSpec; pageId: string | null; params: Record<string, string>;
  datasets: DatasetBundle | null; mode: 'card' | 'page' | 'full'; title: string;
  onNavigate?: (pageId: string, params: Record<string, string>) => void;
}): JSX.Element;
```
Owns: the `message` listener with the `event.source` identity gate, height state + clamping per mode, `dataResult` answering from `datasets`, `route` pushes on `pageId`/`params` change, `theme` pushes on `data-theme` mutation (reusing the existing `useDataTheme` observer, lifted into this file), and the `sandbox={HTML_KIT_SANDBOX}` attribute imported unchanged.

**NEW `LabAppBody.tsx`** — the registry `CardBody` for `render: app`: reads `cache.app`/`cache.datasets`, renders `<LabAppFrame mode="card">` on the `card ?? entry` page, or `emptyHint` when unsynced.

**NEW `LabAppPage.tsx` + `LabAppPage.css`** — the routed page: back-to-board, title + staleness badge, Refresh, `RangeControl` (fused apply-and-sync via `useApplyTweaks`, the existing idiom), page tabs from `spec.pages` (each `pushLabAppPath`), Full-screen toggle (`?fs=1`), Copy-link, and `<LabAppFrame mode={fs ? 'full' : 'page'}>`.

**NEW `LabRoutedInsight.tsx`** — for `/lab/<slug>` with no sub-segment: `useLabInsight(slug)` (same react-query key the pages use — no extra fetch) and dispatch on `insight.render` → `FunnelOverviewPage` or `LabAppPage`.

**`labRoute.ts`** — `pageId` on `LabRoute`; `/^\/lab\/([^/]+)(?:\/(f|p)\/([^/]+))?\/?$/` in `parseLabPath`; `labAppPath` + `pushLabAppPath`. `labPath`, `pushLabPath`, `replaceSearch`, the URL-owner/parking machinery: untouched.

**`chartRegistry.ts`** — `'app'` in `RENDERS`; entry `{ CardBody: LabAppBody, defaultSpan: 2, supportsWindow: true, routed: true, emptyHint: 'No app body yet — sync to build it.', openHint: 'Open the app' }`.

**`InsightCard.tsx`** (~166–177) — body branch becomes `cache?.app ? <LabAppBody…> : cache?.html ? <HtmlInsightBody…> : <CardBody…>`.

**`dashboard/src/pages/LabPage.tsx`** (~64–93) — `route.slug && route.pageId` → `<LabAppPage>`; `route.slug` alone → `<LabRoutedInsight>`; funnel and report branches unchanged.

**`dashboard/src/hooks/useLab.ts`** — `app?: AppCacheEntry`, `datasets?: DatasetCacheEntry` on `InsightCache`, importing from `appModel.ts`.

### Tests & verify

- **NEW `tests/unit/lab-app.test.ts`** — envelope detection, `parseAppSpec` caps/rejects, `parseDatasetBundle` delegation + notices, `sync` writes app+datasets alongside data, ok-without-app clears, failure keeps prior, `app`+`html` rejected, data-mandatory still rejected.
- **NEW `tests/unit/lab-app-query.test.ts`** — `queryDataset` where/group-by/top, `resolveDatasetAsOf` honest empty, `htmlToText` text/md/table extraction, `seriesToDatasetBundle`.
- **NEW `tests/unit/lab-app-body.test.ts`** — srcdoc contains the **same** `HTML_KIT_CSP` string and the sandbox is exactly `allow-scripts`; runtime mirror drift (`labAppRuntime.ts` string ≡ `lab-app-runtime.js`); the host ignores a message whose `source` isn't the frame; height clamps per mode; `navigate` to an unknown page is ignored.
- **`tests/unit/lab-render-registry.test.ts`** — the RENDERS mirror now carries `app` (this test *fails* until both sides ship, so both sides are one lane).
- **`tests/unit/lab-doctor.test.ts`**, **`tests/unit/server-lab-routes.test.ts`** — new blocks / `datasetHistory` stripped.
- **NEW `scripts/verify/lab-app-insight.mjs`** + `package.json` `"verify:lab-app": "node scripts/verify/lab-app-insight.mjs"` — modelled on `lab-breakdown-reports.mjs` (real server, fake `HOME`, isolated scratch vault, collect-don't-fail-fast, screenshots). Checks in (d)'s T8 row.

### Docs (same change — constraint 4)

- **`skill/SKILL.md`** — Lab capabilities row gains the app sentence; Entity Router insight row gains the multi-page/app phrase triggers; Rule 13 read ladder gains `lab query` and `lab body`.
- **`skill/references/cli-reference.md`** — renders "eleven"→"twelve" + the `app` gloss; `breakdown` marked deprecated in that list; **decision-table row swap**: the dimensional row becomes `app` + `dataset/v1`, breakdown demoted to a grandfathered note; `lab create` row loses the breakdown scaffold sentence and gains the app one; `lab show` row updated; new `lab body` / `lab query` rows; the html/v1 paragraph gains the app/v1 pointer.
- **`skill/references/tasks-and-features.md`** — NEW `### App insights (render: app — the app/v1 + dataset/v1 contract)` covering how an insight is created, how it goes full-screen, how it goes multi-page, the bridge API, the network-less guarantee, the `lk-*` rule; `### Breakdown insights` gains a DEPRECATED banner (grandfathered, no migration forced); `### HTML card bodies` gains "single-page — for pages, use app/v1".
- **NEW `_dream_context/knowledge/patterns/sandboxed-app-bridge-pattern.md`** — the reusable shape: opaque-origin frame + `event.source` identity gate + host-served data + content-driven height + URL-owned routing, and why relaxing the sandbox is never the fix.
- **`tests/unit/taxonomy-markers.test.ts`** — pin the new router phrases, `lab body`, `lab query`, the app section heading, and the breakdown-deprecated marker.
- **`dreamcontext update`** — regenerate `.claude/skills/dreamcontext/**` from `skill/` (never edit installed copies).

---

# (c) Dependency map

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| **T1 — Contract & parsers** | `src/lib/lab/types.ts`, NEW `src/lib/lab/app.ts`, NEW `src/lib/lab/dataset.ts`, NEW `tests/unit/lab-app.test.ts` (parser half) | — | 1 | Exports exactly: `RENDERS` incl. `'app'`; `AppPage{id,title,html,dataset?}`, `AppShell{style?,script?}`, `AppSpec{kind:'app/v1',entry,card?,pages,shell?}`, `RawAppSpec`, `isRawAppSpec(u): u is RawAppSpec`; `Dataset{key,label?,unit?,dims:MatrixDim[],rows:MatrixRow[],total?}`, `DatasetBundle{kind:'dataset/v1',primary?,datasets}`, `RawDatasetBundle`, `isRawDatasetBundle`; `AppCacheEntry{spec,notices,range}`, `DatasetCacheEntry{bundle,notices,range}`, `DatasetSnapshot{at,range,bundle}`; `InsightCache.app?/datasets?/datasetHistory?`; `RawPayloadEnvelope{data:…|RawDatasetBundle, html?, app?}`. `app.ts`: `parseAppSpec(raw):{spec,notices}` (throws `LabError`), `findAppPage(spec,id\|null)`, `appPageIds`, `MAX_APP_PAGES=12`, `MAX_APP_BYTES=300_000`, `APP_PAGE_ID_RE`. `dataset.ts`: `parseDatasetBundle(raw):{bundle,notices}`, `datasetToSeries`, `datasetLatest`, `findDataset`, `seriesToDatasetBundle`, `makeDatasetSnapshot`, `appendDatasetHistory`, `MAX_DATASETS=12`, `DATASET_HISTORY_MAX=60`, `DATASET_HISTORY_MAX_BYTES=1_000_000`. **No behaviour change to funnel/matrix/html paths.** |
| **T2 — Engine wiring & scaffold** | `src/lib/lab/sync.ts`, `src/lib/lab/store.ts`, NEW `tests/unit/lab-app.test.ts` (sync half — appended to T1's file **after** T1 lands) | T1 | 2 | `syncInsight` writes `cache.app`/`cache.datasets`/`cache.datasetHistory` alongside `data`; ok-without-`app` clears a stale `cache.app`; failure preserves all three; `app`+`html` → `LabError`; over-`MAX_APP_BYTES` → `LabError`. `store.ts` exports `appScriptTemplate(slug: string): string`; `createInsight` scaffolds it for `render==='app' && adapter==='script'`, gives `app` the `range` enum tweak, **no longer scaffolds for `breakdown`**, deletes `matrixScriptTemplate`, and `console.warn`s the breakdown deprecation. |
| **T3 — CLI read & query** | NEW `src/lib/lab/htmlText.ts`, NEW `src/lib/lab/datasetQuery.ts`, `src/cli/commands/lab.ts`, NEW `tests/unit/lab-app-query.test.ts` | T1 | 2 | `htmlToText(html, {format?:'text'\|'md', maxChars?}): string` — zero new deps. `queryDataset(bundle, {dataset?,where?,groupBy?,top?}): DatasetQueryResult` (shape pinned in (b)). `resolveDatasetAsOf(cache, dateISO\|null)` → `{bundle,at,range}` or `null` (honest empty, never interpolated). CLI: `lab show` prints page list + datasets pivot; `lab body <slug> [--page][--format text\|md\|html][--json]`; `lab query <slug> [--dataset][--where k=v…][--group-by][--top][--date][--json]`. All cache-only, never fetch. |
| **T4 — Bridge & frame** | NEW `dashboard/src/components/lab/labAppRuntime.ts`, NEW `dashboard/src/components/lab/lab-app-runtime.js`, NEW `dashboard/src/components/lab/LabAppFrame.tsx`, NEW `tests/unit/lab-app-body.test.ts` | T1 (type shapes only) | 2 | Imports `HTML_KIT_CSP`, `HTML_KIT_SANDBOX`, `LAB_HTML_KIT_CSS` from `labHtmlKit.ts` **unchanged** (`labHtmlKit.ts` is NOT edited by anyone). Exports `LAB_APP_PROTOCOL=1`, `LabAppInbound`/`LabAppOutbound` (union pinned in (a)), `LAB_APP_RUNTIME_JS`, `buildAppSrcdoc({page,shell,pages,tokens,scheme,params}): string`, and `LabAppFrame(props{spec,pageId,params,datasets,mode:'card'\|'page'\|'full',title,onNavigate?})`. Host gate is `event.source === contentWindow`; posts use `targetOrigin:'*'`; height clamps card `[120,320]` / page `[200,20000]` / full `100%`; card mode sets `pointerEvents:'none'`. |
| **T5 — Routing & app page** | `dashboard/src/components/lab/funnel/labRoute.ts`, `dashboard/src/pages/LabPage.tsx`, NEW `dashboard/src/components/lab/LabRoutedInsight.tsx`, NEW `dashboard/src/components/lab/LabAppPage.tsx`, NEW `LabAppPage.css` | T1, T4 | 3 | `LabRoute` gains `pageId: string \| null`; `parseLabPath` accepts `/lab/<slug>/p/<pageId>`; new `labAppPath(slug, pageId\|null)` and `pushLabAppPath(slug, pageId\|null, bus?)`. `labPath`/`pushLabPath`/`replaceSearch`/URL-owner machinery unchanged (funnel must not regress). `LabAppPage({slug,pageId,onBack,onToast})` owns full-screen via `?fs=1` + `.lab-app-page--fullscreen`; Escape exits. `LabPage` dispatch: `report → ReportPage`, `slug+funnelId → FunnelDetailPage`, `slug+pageId → LabAppPage`, `slug → LabRoutedInsight`, else `LabBoard`. |
| **T6 — Card surface & registry** | `dashboard/src/components/lab/chartRegistry.ts`, NEW `dashboard/src/components/lab/LabAppBody.tsx`, NEW `dashboard/src/components/lab/appModel.ts`, `dashboard/src/components/lab/InsightCard.tsx`, `dashboard/src/hooks/useLab.ts`, `tests/unit/lab-render-registry.test.ts` | T1, T4 | 3 | `chartRegistry.RENDERS` mirrors engine `RENDERS` **exactly** (drift test); `app` entry `{CardBody: LabAppBody, defaultSpan: 2, supportsWindow: true, routed: true, emptyHint, openHint:'Open the app'}` — so `isRoutedRender('app')===true` and `LabBoard`'s existing `openInsight` routes with **no LabBoard edit**. `appModel.ts` mirrors T1's dashboard-visible types. `InsightCard` body precedence: `app → html → typed`. |
| **T7 — Doctor & route hygiene** | `src/cli/commands/doctor.ts`, `src/server/routes/lab.ts`, `tests/unit/lab-doctor.test.ts`, `tests/unit/server-lab-routes.test.ts` | T1, T2 | 3 | `checkLab` gains an `m.render === 'app'` block mirroring the matrix block: re-parse `cache.app.spec` and `cache.datasets.bundle`, emit one warn per surviving notice naming `lab sync --force`, check `datasetHistory` against both caps; plus a render-agnostic warn when a cache holds `app` **and** `html`. `withoutFunnelHistory` → `withoutHistoryTrails(cache)`, stripping `funnelHistory` **and** `datasetHistory`; `handleLabShow`'s other four response keys unchanged. |
| **T8 — Runtime verify** | NEW `scripts/verify/lab-app-insight.mjs`, `package.json` | T2, T3, T5, T6, T7 | 4 | `npm run verify:lab-app`, exit 0 only when every check passes. Proves in real Chromium, on a scratch vault: (1) sandbox is exactly `allow-scripts` and srcdoc carries `default-src 'none'`; (2) a fetch + `<img>` beacon to a sentinel host produce **zero** `requestfinished` and ≥1 `csp` failure (same accounting as `lab-breakdown-reports.mjs`); (3) the app card's iframe height **grows when content grows** and is not 232/420; (4) bridge round trip — `lab.data()` returns host-served rows the html never embedded; (5) `lab.navigate('steps')` changes the URL to `/lab/<slug>/p/steps` and Back returns to the entry page; (6) a cold deep-link to `/lab/<slug>/p/steps` lands on that page; (7) `?fs=1` deep-links into full-screen and Escape exits; (8) `lab query <slug> --where …` and `lab body <slug> --page steps --format md` answer from the CLI with no dashboard open. Screenshots to `<scratch>/shots`. |
| **T9 — Docs, pattern, propagate** | `skill/SKILL.md`, `skill/references/cli-reference.md`, `skill/references/tasks-and-features.md`, NEW `_dream_context/knowledge/patterns/sandboxed-app-bridge-pattern.md`, `tests/unit/taxonomy-markers.test.ts` | T2, T3, T5, T6, T7 | 4 | Applies `feature-integration-pattern.md` items 1–3, 7–9 (items 4–6 recorded as "considered — sleep does not run lab sync; no sub-agent or skill-pack touchpoint"). Edits `skill/` **only**, never `.claude/skills/`; finishes with `dreamcontext update`. Deprecation is docs-level: decision-table dimensional row → `app`+`dataset/v1`, breakdown demoted to a grandfathered note, `matrix/v1` contract section banner-marked DEPRECATED with "existing insights keep rendering; no migration forced". New marker assertions pin `lab body`, `lab query`, the app section heading, the app router phrases, and the deprecation banner. |

**Wave/lane check:** wave 1 = 1 implementer; waves 2–4 = 3, 3, 2. No file appears in two rows. `labHtmlKit.ts`, `HtmlInsightBody.tsx`, `InsightDetailPanel.tsx`, `LabBoard.tsx`, `matrix.ts`, `funnel.ts`, `reports-store.ts` are **deliberately unowned** — nobody edits them, which is what keeps html/v1, funnel and matrix/v1 non-regressing.

---

# (d) Assumptions & open questions

**Assumptions (stated, cheap to check — flagged where a task must verify before building on it):**

1. `postMessage` works both ways with `sandbox="allow-scripts"` and no `allow-same-origin`, with `event.origin === "null"` and `targetOrigin: '*'` required. Pre-flight asserts this. **T4 verifies it first** — if it were false the whole bridge design changes, and no other wave-2 task depends on it.
2. Reports resolve dated snapshots server-side from disk (`reports-store.resolveReport`), not through `handleLabShow` — so stripping `datasetHistory` in the route is safe. **T7 greps `resolveReport`'s call path before the rename.**
3. Nothing outside `store.ts:476` calls `matrixScriptTemplate` (confirmed by grep across `src/` and `tests/`), so deleting it breaks no test.
4. `useLabInsight(slug)` shares a react-query key across `LabRoutedInsight` and the page it dispatches to, so the dispatcher adds no network round trip.
5. `render: app` insights do **not** need to appear in My Reports for this goal. Reports keep composing `funnel`/`matrix`/series insights unchanged. Explicitly out of scope.
6. An `app` insight's `data` half may be any of the four kinds. `dataset/v1` is what the scaffold teaches; `Series[]` is served to `lab query` / `lab.data()` through `seriesToDatasetBundle`. That synthesis is a **read-side** convenience over legacy caches, not a blessing of dimensions-in-series-names — the doc says so in the same paragraph.
7. The 300 KB `MAX_APP_BYTES` covers the whole spec (all pages + shell), matching the existing `MAX_HTML_BYTES` budget. Host-served data is what makes that budget comfortable.
8. Chromium's `ResizeObserver` inside an opaque-origin srcdoc frame reports document height reliably. **T4 pins it; T8 proves it at runtime.** Fallback if it under-reports: poll `document.documentElement.scrollHeight` on an animation frame, same message shape — no contract change.

**Open questions — my recommendation in each case, none blocking:**

1. **Does `--render breakdown` still create a manifest at all?** Recommended: yes, with the loud deprecation warn and no script scaffold. Hard-failing it would break users mid-flight, and constraint 3 says "stop scaffolding", not "stop accepting". *Owner call if they want it to hard-fail.*
2. **Should `breakdown` be dropped from the `--render` enum help text?** Recommended: keep it listed with a `(deprecated)` marker. Removing it from `RENDERS` would break `doctor`'s validation of grandfathered manifests.
3. **Delete `matrixScriptTemplate` or keep it as dead-but-exported?** Recommended: delete. It is the authoring scaffold constraint 3 names, and dead exports rot. Everything else in `matrix.ts` stays.
4. **Card-mode interactivity.** Recommended: `pointerEvents: 'none'` — the card is a preview and one click target that opens the app. The alternative (interactive card) makes the card un-clickable, which is worse. *Reversible in one line if the owner disagrees.*
5. **Full-screen mechanism.** Recommended: URL-driven CSS overlay (`?fs=1`) over the native Fullscreen API, for deep-linkability, reload survival, and Playwright drivability.
6. **Does `lab.data()` get the full bundle or one dataset per call?** Recommended: one dataset per call (`lab.data(key?)`), keyed by `page.dataset` when omitted — smaller messages, and it keeps the page↔dataset binding explicit for the CLI's "pick a page's dataset".
7. **Should `dataset/v1` also render through the existing `breakdown` pivot** (so a dataset-only insight gets a typed render without writing html)? Recommended: **no** for this goal — YAGNI, and it would resurrect the path we are deprecating. Worth revisiting only if authors ask for typed dimensional rendering without an app body.