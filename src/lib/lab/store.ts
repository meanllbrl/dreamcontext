import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from '../frontmatter.js';
import { today } from '../id.js';
import { writeCredentialsExample } from './required-credentials.js';
import { parseRelativeRange } from './tweaks.js';
import {
  INSIGHT_SIZES,
  LabError,
  RENDERS,
  TWEAK_TYPES,
  type Agg,
  type Binding,
  type ExtractConfig,
  type InsightCache,
  type InsightManifest,
  type InsightSize,
  type InsightSource,
  type Render,
  type TweakDecl,
} from './types.js';

/**
 * Lab insight store — mirrors objectives-store.ts. Markdown-first: one manifest
 * per insight under `lab/insights/<slug>.md`, cache snapshot under
 * `lab/cache/<slug>.json`. Reads are LENIENT (a malformed sub-block degrades to
 * null / a skip, never throws — mirrors parseMetric); writes are STRICT.
 */

const DEFAULT_TTL_MINUTES = 1440;

export function labDir(contextRoot: string): string {
  return join(contextRoot, 'lab');
}
export function insightsDir(contextRoot: string): string {
  return join(labDir(contextRoot), 'insights');
}
export function cacheDir(contextRoot: string): string {
  return join(labDir(contextRoot), 'cache');
}
export function insightPath(contextRoot: string, slug: string): string {
  return join(insightsDir(contextRoot), `${slug}.md`);
}
export function cachePath(contextRoot: string, slug: string): string {
  return join(cacheDir(contextRoot), `${slug}.json`);
}

/** Kebab-case, path-safe insight slug (same shape objectives/tasks use). */
export function isSafeInsightSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes('--') && !slug.endsWith('-');
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toRender(v: unknown): Render {
  const s = typeof v === 'string' ? v.trim() : '';
  return (RENDERS as readonly string[]).includes(s) ? (s as Render) : 'number';
}

/** LENIENT size parse: absent or unrecognised → null (the render's own default
 *  span decides), never a throw — same contract `category` has. */
function toSize(v: unknown): InsightSize | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (INSIGHT_SIZES as readonly string[]).includes(s) ? (s as InsightSize) : null;
}

function toAgg(v: unknown): Agg {
  const s = typeof v === 'string' ? v.trim() : '';
  return (['last', 'sum', 'mean', 'max'] as const as readonly string[]).includes(s) ? (s as Agg) : 'last';
}

/** LENIENT tweak parse: malformed entries are skipped, never fatal. */
export function parseTweaks(v: unknown): TweakDecl[] {
  if (!Array.isArray(v)) return [];
  const out: TweakDecl[] = [];
  for (const raw of v) {
    const r = asRecord(raw);
    if (!r) continue;
    const key = typeof r.key === 'string' ? r.key.trim() : '';
    const type = typeof r.type === 'string' ? r.type.trim() : '';
    if (!key || !(TWEAK_TYPES as readonly string[]).includes(type)) continue;
    const decl: TweakDecl = { key, type: type as TweakDecl['type'] };
    if (typeof r.label === 'string') decl.label = r.label;
    if (Array.isArray(r.options)) decl.options = r.options.map((o) => String(o));
    if (r.default !== undefined && r.default !== null) decl.default = String(r.default);
    if (r.value !== undefined && r.value !== null) decl.value = String(r.value);
    out.push(decl);
  }
  return out;
}

/** LENIENT binding parse: needs a non-empty objective slug, else null. */
export function parseBinding(v: unknown): Binding | null {
  const r = asRecord(v);
  if (!r) return null;
  const objective = typeof r.objective === 'string' ? r.objective.trim() : '';
  if (!objective) return null;
  const value = typeof r.value === 'string' && r.value.trim() ? r.value.trim() : 'latest';
  return { objective, value };
}

/** LENIENT extract parse: missing sub-fields fall back to sensible defaults. */
export function parseExtract(v: unknown): ExtractConfig {
  const r = asRecord(v) ?? {};
  return {
    seriesPath: typeof r.seriesPath === 'string' ? r.seriesPath.trim() : '',
    seriesKey: strOrNull(r.seriesKey),
    x: typeof r.x === 'string' && r.x.trim() ? r.x.trim() : 'x',
    y: typeof r.y === 'string' && r.y.trim() ? r.y.trim() : 'y',
    agg: toAgg(r.agg),
  };
}

/** LENIENT source parse: an unrecognised/malformed source block → null. */
export function parseSource(v: unknown): InsightSource | null {
  const r = asRecord(v);
  if (!r) return null;
  const adapter = typeof r.adapter === 'string' ? r.adapter.trim() : '';
  if (adapter === 'http') {
    const http = asRecord(r.http) ?? {};
    const endpoint = typeof http.endpoint === 'string' ? http.endpoint.trim() : '';
    if (!endpoint) return null;
    const method = http.method === 'POST' ? 'POST' : 'GET';
    const headers: Record<string, string> = {};
    const rawHeaders = asRecord(http.headers);
    if (rawHeaders) {
      for (const [k, val] of Object.entries(rawHeaders)) headers[k] = String(val);
    }
    return {
      adapter: 'http',
      endpoint,
      method,
      headers,
      body: typeof http.body === 'string' ? http.body : null,
      extract: parseExtract(http.extract),
    };
  }
  if (adapter === 'script') {
    const script = asRecord(r.script) ?? {};
    const file = typeof script.file === 'string' ? script.file.trim() : '';
    if (!file) return null;
    return { adapter: 'script', file };
  }
  return null;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

export function readInsightFile(filePath: string): InsightManifest {
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  const slug = basename(filePath, '.md');
  const refresh = asRecord(data.refresh);
  const ttlRaw = refresh ? Number(refresh.ttl_minutes) : NaN;
  return {
    slug,
    title: typeof data.title === 'string' && data.title.trim() ? data.title : slug,
    description: strOrNull(data.description),
    category: strOrNull(data.category),
    group: strOrNull(data.group),
    render: toRender(data.render),
    size: toSize(data.size),
    source: parseSource(data.source),
    refresh: { ttl_minutes: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MINUTES },
    tweaks: parseTweaks(data.tweaks),
    binding: parseBinding(data.binding),
    credentials_used: toStringArray(data.credentials_used),
    unit: strOrNull(data.unit),
    path: filePath,
    body: content.trim(),
  };
}

/** All insights, sorted by slug (stable). Missing directory → empty list. */
export function listInsights(contextRoot: string): InsightManifest[] {
  const dir = insightsDir(contextRoot);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true }).sort();
  const out: InsightManifest[] = [];
  for (const file of files) {
    try {
      out.push(readInsightFile(file));
    } catch {
      // skip a manifest that won't even parse as frontmatter
    }
  }
  return out;
}

export function getInsight(contextRoot: string, slug: string): InsightManifest | null {
  const path = insightPath(contextRoot, slug);
  if (!isSafeInsightSlug(slug) || !existsSync(path)) return null;
  try {
    return readInsightFile(path);
  } catch {
    return null;
  }
}

// ─── Cache read/write (atomic) ──────────────────────────────────────────────

export function readCache(contextRoot: string, slug: string): InsightCache | null {
  const path = cachePath(contextRoot, slug);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as InsightCache;
  } catch {
    return null;
  }
}

export function writeCache(contextRoot: string, slug: string, cache: InsightCache): void {
  mkdirSync(cacheDir(contextRoot), { recursive: true });
  const path = cachePath(contextRoot, slug);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path); // atomic replace
}

// ─── Create / edit ──────────────────────────────────────────────────────────

/** The documented funnel-payload script scaffold (`lab create --render funnel --adapter script`). */
export function funnelScriptTemplate(slug: string): string {
  return `/**
 * Funnel-set adapter for the "${slug}" insight.
 *
 * Return ONE \`funnel-set/v1\` object (not Series[]). The engine validates it,
 * applies caps (funnels/steps/segment cardinality/bytes — over-cap data is
 * collapsed into "Other" or dropped with a loud notice), synthesizes legacy
 * series from step users, and records a per-sync snapshot for Δ-vs-previous-
 * period. Runs LOCALLY with your credentials (ctx.credentials) — same trust
 * level as the repo; the script-hash tripwire warns when this file changes.
 *
 * ctx = { manifest, resolvedTweaks: { values, range: { fromISO, toISO }, spanDays },
 *         credentials }
 * Use ctx.resolvedTweaks.range to scope your query — the dashboard's date-range
 * control writes the \`range\` tweak and re-syncs.
 */
export default async function fetchFunnels(ctx) {
  const { fromISO, toISO } = ctx.resolvedTweaks.range;
  void fromISO; void toISO; // scope your real query with these

  return {
    kind: 'funnel-set/v1',

    // Declared breakdowns/filters. mode 'client' = segments below carry the
    // data (instant filtering); 'refetch' = the chosen value is written into
    // the tweak named by \`tweak\` (default: the dimension key) and re-synced.
    dimensions: [
      { key: 'language', label: 'Language', mode: 'client' },
      // { key: 'country', label: 'Country', mode: 'refetch', tweak: 'country' },
    ],

    // Optional: metric key driving the card value, default sort, and preview.
    primary: 'users',
    // Optional: rows with first-step users below this render de-emphasized (default 30).
    low_sample_threshold: 30,
    // Optional: per-metric thresholds that tint cells (omit = benchmarks off).
    // benchmarks: { finish_rate: { floor: 1, target: 3 } },

    funnels: [
      {
        id: '516',
        name: 'en-start-516',
        meta: { url: 'https://example.com/f/516', hypothesis: 'shorter intro' },
        // Overview-table columns. format: count | pct | usd | x | seconds | number.
        // prev (optional) = previous equal-length period value — wins over the
        // engine's history-derived delta.
        metrics: {
          users: { v: 33, format: 'count' },
          spend: { v: 831, format: 'usd' },
          finish_rate: { v: 3.03, format: 'pct' },
        },
        // ORDER = step order; \`key\` aligns steps across funnels and periods.
        steps: [
          { key: 'session_start', label: 'session_start', users: 33 },
          { key: 'email_input', label: 'Step 01 email_input', users: 23 },
          { key: 'finish', label: 'Finish', users: 1 },
        ],
        // Optional DISJOINT cells for client-mode filter/breakdown.
        segments: [
          {
            dims: { language: 'en' },
            users: 21,
            steps: [
              { key: 'session_start', users: 21 },
              { key: 'email_input', users: 15 },
              { key: 'finish', users: 1 },
            ],
          },
        ],
      },
    ],
  };
}
`;
}

/** The documented app-payload script scaffold (`lab create --render app --adapter script`). */
export function appScriptTemplate(slug: string): string {
  // Every page's `html` below is written as an ESCAPED backtick template
  // literal (\` ... \`) so it survives into the generated .mjs file AS a
  // template literal — that lets the embedded <script> use single- AND
  // double-quoted JS strings freely (e.g. HTML attributes) with no nested
  // escaping at all. Only backticks and `${` need escaping here; everything
  // else in the page bodies is copied through verbatim.
  return `/**
 * App adapter for the "${slug}" insight.
 *
 * Return { data, app } — TWO INDEPENDENT halves, never conflate them:
 *
 *   data — a \`dataset/v1\` bundle (or Series[] / a funnel-set / a matrix): the
 *          QUERYABLE numbers. MANDATORY. Feeds \`latest\`, KR bindings,
 *          \`lab show\`, \`lab query\`, and the Rule-13 read ladder.
 *   app  — an \`app/v1\` spec: an ordered list of PAGES, each a sandboxed html
 *          fragment. The dashboard draws every page in a network-less
 *          sandboxed iframe (no fetch, no beacon — see labHtmlKit.ts) and
 *          wires it to the host over a postMessage bridge, so a page's own
 *          inline script can call:
 *
 *            lab.navigate(pageId, params)   // switch page / deep-link
 *            lab.data(datasetKey)           // ask the HOST for a named
 *                                            // dataset from \`data\` above —
 *                                            // never embed numbers twice
 *            lab.onRoute(callback)          // react to navigation
 *            lab.page / lab.params          // this page's id + params
 *
 * Style with the lk-* class kit (lk-title/value/label/stat/chip/table/bar-row/
 * low-sample) — don't write your own CSS; the kit resolves the current
 * theme's tokens for you, light and dark. Runs LOCALLY with your credentials
 * (ctx.credentials) — same trust level as the repo; the script-hash tripwire
 * warns when this file changes.
 *
 * ctx = { manifest, resolvedTweaks: { values, range: { fromISO, toISO }, spanDays },
 *         credentials }
 * Use ctx.resolvedTweaks.range to scope your query — the dashboard's date-range
 * control writes the \`range\` tweak and re-syncs.
 */
export default async function fetchApp(ctx) {
  const { fromISO, toISO } = ctx.resolvedTweaks.range;
  void fromISO; void toISO; // scope your real query with these

  return {
    data: {
      kind: 'dataset/v1',

      // Dataset key lab.data() / lab query resolve to when a page or call
      // names no key. Give every page its own dataset key when they differ.
      primary: 'breakdown',
      datasets: [
        {
          key: 'breakdown',
          // 1-3 dimensions, same grammar as matrix/v1: dims[0] = pivot rows,
          // dims[1] = columns, dims[2] = filter chips.
          dims: [
            { key: 'funnel', label: 'Funnel' },
            { key: 'language', label: 'Language' },
          ],
          // One row per dim-value combination. v = the metric value; n
          // (optional) = the sample size behind it (rows with n < 30 render
          // de-emphasized).
          rows: [
            { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 },
            { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100 },
            { d: { funnel: 'F4000', language: 'TR' }, v: 52000, n: 1800 },
          ],
          // Optional grand total — feeds the card value and any KR binding.
          total: { v: 255000, n: 9100 },
        },
      ],
    },

    app: {
      kind: 'app/v1',
      entry: 'overview', // page shown at /lab/${slug}
      // card: 'overview', // optional — the CARD body's page, defaults to entry

      pages: [
        {
          id: 'overview',
          title: 'Overview',
          dataset: 'breakdown', // this page's lab.data() default
          html: \`
            <div class="lk-stat">
              <span class="lk-label">Total</span>
              <span class="lk-value" id="total">—</span>
            </div>
            <button class="lk-chip" id="open-detail" type="button" style="margin-top:8px;cursor:pointer;border:none;">
              View breakdown →
            </button>
            <script>
              lab.data().then(function (ds) {
                document.getElementById('total').textContent = ds.total ? String(ds.total.v) : '—';
              });
              document.getElementById('open-detail').addEventListener('click', function () {
                lab.navigate('detail');
              });
            </script>
          \`,
        },
        {
          id: 'detail',
          title: 'Breakdown',
          dataset: 'breakdown',
          html: \`
            <table class="lk-table" id="rows"></table>
            <p class="lk-muted" style="margin-top:10px;"><a href="#" id="back">← Overview</a></p>
            <script>
              lab.data().then(function (ds) {
                var rows = ds.rows.map(function (r) {
                  return '<tr><td>' + r.d.funnel + '</td><td>' + r.d.language + '</td><td class="lk-num">' + r.v + '</td></tr>';
                }).join('');
                document.getElementById('rows').innerHTML =
                  '<tr><th>Funnel</th><th>Language</th><th class="lk-num">Value</th></tr>' + rows;
              });
              document.getElementById('back').addEventListener('click', function (e) {
                e.preventDefault();
                lab.navigate('overview');
              });
            </script>
          \`,
        },
        {
          id: 'about',
          title: 'About',
          html: \`
            <div class="lk-callout">
              This app has three pages — edit lab/scripts/${slug}.mjs to change them.
              Every page reads data via lab.data(); nothing is fetched from the network
              inside the sandboxed body.
            </div>
          \`,
        },
      ],
    },
  };
}
`;
}

export interface CreateInsightInput {
  slug: string;
  title: string;
  render?: Render;
  /** Board footprint override (`s`/`m` = 1 column, `l` = 2). Omit for the default. */
  size?: InsightSize;
  adapter?: 'http' | 'script';
  category?: string | null;
  group?: string | null;
  description?: string | null;
  unit?: string | null;
  ttl_minutes?: number;
}

/** STRICT validation for writes (throws LabError). Reads stay lenient. */
export function validateManifestForWrite(input: CreateInsightInput): void {
  if (!isSafeInsightSlug(input.slug.trim())) {
    throw new LabError(`Invalid insight slug "${input.slug}" — use kebab-case (e.g. weekly-active-users).`);
  }
  if (!input.title || !input.title.trim()) {
    throw new LabError('An insight title is required.');
  }
  if (input.render && !(RENDERS as readonly string[]).includes(input.render)) {
    throw new LabError(`render must be one of: ${RENDERS.join(', ')}.`);
  }
  if (input.size && !(INSIGHT_SIZES as readonly string[]).includes(input.size)) {
    throw new LabError(`size must be one of: ${INSIGHT_SIZES.join(', ')}.`);
  }
  if (input.adapter && input.adapter !== 'http' && input.adapter !== 'script') {
    throw new LabError('adapter must be "http" or "script".');
  }
  if (input.ttl_minutes !== undefined && (!Number.isFinite(input.ttl_minutes) || input.ttl_minutes <= 0)) {
    throw new LabError('ttl_minutes must be a positive number.');
  }
}

/**
 * Scaffold a new insight manifest (lazy mkdir, like createObjective — no init or
 * migration needed). The body is a `## Meaning` prose stub (recall-indexed).
 */
export function createInsight(contextRoot: string, input: CreateInsightInput): InsightManifest {
  validateManifestForWrite(input);
  const slug = input.slug.trim();
  const path = insightPath(contextRoot, slug);
  if (existsSync(path)) throw new LabError(`Insight already exists: ${slug}`);

  const adapter = input.adapter ?? 'http';
  const render = input.render ?? 'number';
  // matrix/v1 is DEPRECATED as an authoring path (2026-08-26): existing
  // `breakdown` insights keep rendering — this is docs/scaffold steering
  // only, never a hard block, so a grandfathered manifest can still be
  // recreated or edited without erroring.
  if (render === 'breakdown') {
    console.warn('[lab] matrix/v1 is deprecated — existing breakdown insights keep rendering; new dimensional insights should use --render app. No script template scaffolded.');
  }
  const source: Record<string, unknown> = adapter === 'script'
    ? { adapter: 'script', script: { file: `scripts/${slug}.mjs` } }
    : {
        adapter: 'http',
        http: {
          endpoint: 'https://example.com/api/metric',
          method: 'GET',
          headers: {},
          body: null,
          extract: { seriesPath: 'data', seriesKey: null, x: 'date', y: 'value', agg: 'last' },
        },
      };

  // Funnel/breakdown/app insights ship with the overview date-range control
  // pre-declared — the presets the dashboard's range picker offers (custom =
  // from/to tweaks).
  const tweaks: TweakDecl[] = render === 'funnel' || render === 'breakdown' || render === 'app'
    ? [{
        key: 'range',
        type: 'enum',
        label: 'Date range',
        options: ['last_7_days', 'last_28_days', 'last_90_days'],
        default: 'last_28_days',
      }]
    : [];

  const frontmatter: Record<string, unknown> = {
    title: input.title,
    description: input.description ?? null,
    category: input.category ?? null,
    group: input.group ?? null,
    render,
    size: input.size ?? null,
    unit: input.unit ?? null,
    source,
    refresh: { ttl_minutes: input.ttl_minutes ?? DEFAULT_TTL_MINUTES },
    tweaks,
    binding: null,
    credentials_used: [],
    created_at: today(),
    updated_at: today(),
  };

  const body = [
    '## Meaning',
    '',
    input.description?.trim()
      || '(What does this number MEAN? Why does it matter, and how should a reader interpret a move?)',
    '',
  ].join('\n');

  mkdirSync(insightsDir(contextRoot), { recursive: true });
  writeFrontmatter(path, frontmatter, body);
  // Funnel/app + script: scaffold a documented payload template so the author
  // starts from the contract, not a blank file. Never overwrites an existing
  // script. breakdown (matrix/v1) is deprecated and no longer scaffolded —
  // grandfathered insights still sync and render, they just start from a
  // blank script file now (the manifest itself is unaffected).
  if ((render === 'funnel' || render === 'app') && adapter === 'script') {
    const scriptPath = join(labDir(contextRoot), 'scripts', `${slug}.mjs`);
    if (!existsSync(scriptPath)) {
      mkdirSync(join(labDir(contextRoot), 'scripts'), { recursive: true });
      writeFileSync(scriptPath, render === 'funnel' ? funnelScriptTemplate(slug) : appScriptTemplate(slug), 'utf-8');
    }
  }
  // Keep the tracked lab/credentials.example.json current with the new
  // manifest's required keys (best-effort — the insight itself is written).
  try { writeCredentialsExample(contextRoot); } catch { /* never fail the create */ }
  return readInsightFile(path);
}

/**
 * Persist (or clear) an insight's objective binding. STRICT on shape: the
 * objective slug must be kebab-safe and `value` must be `latest` or
 * `series:<name>`. Objective EXISTENCE is checked by the caller (`bindInsight`
 * in sync.ts) — the store stays free of roadmap imports.
 */
export function writeInsightBinding(
  contextRoot: string,
  slug: string,
  binding: Binding | null,
): InsightManifest {
  const manifest = getInsight(contextRoot, slug);
  if (!manifest) throw new LabError(`Insight not found: ${slug}`);
  if (binding) {
    const objective = binding.objective.trim();
    if (!isSafeInsightSlug(objective)) {
      throw new LabError(`Invalid objective slug "${binding.objective}" — use kebab-case.`);
    }
    const value = binding.value.trim() || 'latest';
    if (value !== 'latest' && !(value.startsWith('series:') && value.slice('series:'.length).trim())) {
      throw new LabError(`Binding value must be "latest" or "series:<name>" (got "${binding.value}").`);
    }
    updateFrontmatterFields(manifest.path, { binding: { objective, value }, updated_at: today() });
  } else {
    updateFrontmatterFields(manifest.path, { binding: null, updated_at: today() });
  }
  return readInsightFile(manifest.path);
}

/**
 * Tweak keys the ENGINE understands on every insight, declared or not.
 *
 * `resolveTweaks` computes a time window for every insight (relative `range`
 * enum, overridden by explicit `from`/`to` dates), so the window exists whether
 * or not the manifest author remembered to declare knobs for it. Requiring a
 * declaration meant the dashboard could only offer the ranges an author had
 * hand-listed — the "this funnel only has last 7 days" report. These three keys
 * are therefore always writable; a first write appends an implicit declaration.
 */
export const WELL_KNOWN_TWEAK_KEYS = ['range', 'from', 'to'] as const;
export type WellKnownTweakKey = (typeof WELL_KNOWN_TWEAK_KEYS)[number];

/** Presets offered when a manifest declares no `range` options of its own.
 *  Mirrored by the dashboard's RangeControl (guarded by a unit test). */
export const DEFAULT_RANGE_OPTIONS = [
  'last_7_days',
  'last_28_days',
  'last_30_days',
  'last_90_days',
  'last_1_year',
] as const;

export function isWellKnownTweakKey(key: string): key is WellKnownTweakKey {
  return (WELL_KNOWN_TWEAK_KEYS as readonly string[]).includes(key);
}

function isCalendarDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/** The declaration written when a well-known key is set on a manifest that never
 *  declared it. `range` deliberately carries NO `options`: an absent list means
 *  "the default presets", so an author who later curates one wins. */
function implicitTweakDecl(key: WellKnownTweakKey, value: string): TweakDecl {
  return key === 'range'
    ? { key, type: 'enum', value }
    : { key, type: 'date', value };
}

/** Validate one incoming tweak value against its declaration (or, for an
 *  undeclared well-known key, against the shape the engine will read back). */
function validateTweakValue(key: string, value: string, decl: TweakDecl | undefined): void {
  const type = decl?.type ?? (key === 'range' ? 'enum' : 'date');
  // Clearing an explicit window is how you go back to the preset — an empty
  // from/to is ignored by resolveTweaks, which is exactly "unset".
  if ((key === 'from' || key === 'to') && value === '') return;

  if (type === 'enum') {
    if (decl?.options && decl.options.length > 0) {
      if (!decl.options.includes(value)) {
        throw new LabError(`Tweak "${key}" must be one of: ${decl.options.join(', ')} (got "${value}").`);
      }
      return;
    }
    // An options-less `range` still has a grammar — the one resolveTweaks parses.
    if (key === 'range' && parseRelativeRange(value) === null) {
      throw new LabError(`Tweak "range" must be a relative range like last_30_days (got "${value}").`);
    }
    return;
  }
  if (type === 'date' && !isCalendarDate(value)) {
    throw new LabError(`Tweak "${key}" must be a valid YYYY-MM-DD date (got "${value}").`);
  }
}

/**
 * Persist new tweak VALUES onto an insight. Each key must be a declared tweak or
 * one of the WELL-KNOWN range keys; the value is validated against its type
 * (enum → one of options; date → calendar date; string → any). Unknown keys and
 * type violations throw.
 *
 * Setting `range` CLEARS any stored `from`/`to`: `resolveTweaks` lets an explicit
 * window override the enum, so a leftover custom window would silently pin every
 * later preset to the old dates ("the preset buttons do nothing").
 */
export function writeInsightTweaks(
  contextRoot: string,
  slug: string,
  values: Record<string, string>,
): InsightManifest {
  const manifest = getInsight(contextRoot, slug);
  if (!manifest) throw new LabError(`Insight not found: ${slug}`);
  const byKey = new Map(manifest.tweaks.map((t) => [t.key, t]));

  const next = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    const decl = byKey.get(key);
    if (!decl && !isWellKnownTweakKey(key)) throw new LabError(`Unknown tweak "${key}" for insight ${slug}.`);
    const v = String(value);
    validateTweakValue(key, v, decl);
    next.set(key, v);
  }

  const rangeSet = (next.get('range') ?? '').trim() !== '';
  if (rangeSet && !next.has('from') && !next.has('to')) {
    for (const key of ['from', 'to'] as const) {
      if (byKey.has(key)) next.set(key, '');
    }
  }

  // An inverted custom window is not a window. `resolveTweaks` clamps spanDays
  // to 0 and hands `from > to` straight to the adapter, where every source
  // answers differently — empty rows, a provider error, or (worst) a silently
  // swapped range. Reject it at the one place a window is written, and judge the
  // MERGED pair: a PATCH may carry only one half.
  const stored = (key: 'from' | 'to'): string => String(byKey.get(key)?.value ?? '').trim();
  const mergedFrom = next.has('from') ? next.get('from')!.trim() : stored('from');
  const mergedTo = next.has('to') ? next.get('to')!.trim() : stored('to');
  if (mergedFrom && mergedTo && mergedFrom > mergedTo) {
    throw new LabError(`Tweak window is inverted: "from" (${mergedFrom}) is after "to" (${mergedTo}).`);
  }

  const nextTweaks: TweakDecl[] = manifest.tweaks.map((t) =>
    next.has(t.key) ? { ...t, value: next.get(t.key)! } : t,
  );
  for (const [key, value] of next) {
    // A cleared, never-declared key has nothing to persist — don't grow the
    // manifest with empty knobs.
    if (byKey.has(key) || value.trim() === '') continue;
    nextTweaks.push(implicitTweakDecl(key as WellKnownTweakKey, value));
  }
  updateFrontmatterFields(manifest.path, { tweaks: nextTweaks, updated_at: today() });
  return readInsightFile(manifest.path);
}
