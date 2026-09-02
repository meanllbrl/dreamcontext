import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter } from '../frontmatter.js';
import { today } from '../id.js';
import { snapshotAsOf } from './matrix.js';
import { parseRelativeRange } from './tweaks.js';
import { readWindowCache, type WindowRange } from './window-cache.js';
import { getInsight, insightPath, isSafeInsightSlug, readCache } from './store.js';
import {
  LabError,
  type FunnelSnapshot,
  type InsightCache,
  type InsightManifest,
  type MatrixSnapshot,
} from './types.js';

/**
 * Lab reports store — the "My Reports" entity (`lab/reports/<slug>.md`).
 *
 * A report OWNS NO DATA and has no sync path of its own: it composes existing
 * insight caches and their DATED history snapshots (matrixHistory /
 * funnelHistory / sync events) into a navigable document. Reads are LENIENT
 * (a malformed section degrades to a skip, a missing insight to a warning —
 * never a throw); writes are STRICT. Mirrors store.ts throughout.
 *
 * Date honesty: `resolveReportItem(date)` returns the LATEST snapshot taken at
 * or before the END of that calendar date, stamped with its sync time ("as
 * of …"), or an honest empty — never an interpolation, never a reach-forward.
 */

export const DATE_NAVS = ['none', 'daily', 'weekly', 'monthly'] as const;
export type DateNav = (typeof DATE_NAVS)[number];

/**
 * A window spec on a report/section/item: `'own'` (keep the tile's own
 * window — exempt from inheritance) or a relative range (`last_30_days`)
 * anchored at the report's selected date. Most specific wins: item > section
 * > report > the date_nav default (daily/weekly/monthly → 1/7/30 days).
 */
export type WindowSpec = 'own' | string;

/** One insight reference inside a report section. */
export interface ReportItem {
  /** The insight slug this item draws from. */
  insight: string;
  /** Optional render override hint for the report surface. */
  view?: string;
  /** Optional breakdown view config (matrix insights): pivot axes + filter. */
  breakdown?: { rows?: string; cols?: string; filter?: Record<string, string> };
  /** Pinned window ('own' or last_N_unit) — overrides the inherited one. */
  window?: WindowSpec;
}

export interface ReportSection {
  title: string;
  /** Free prose above the section's charts. */
  prose?: string;
  items: ReportItem[];
  /** Section-level window ('own' or last_N_unit) — overrides the report's. */
  window?: WindowSpec;
}

export interface ReportManifest {
  slug: string;
  title: string;
  description: string | null;
  date_nav: DateNav;
  sections: ReportSection[];
  /** Absolute path of the report file. */
  path: string;
  /** The `## Notes` prose. */
  notes: string;
  /** Report default window ('own' or last_N_unit); absent → date_nav default. */
  window?: WindowSpec;
  /** AI commentary surface: `false` removes it entirely — a report without an
   *  agent reading is first-class (owner, 2026-09-01). Absent/true = the
   *  Analyze button is offered; nothing generates without an explicit click. */
  commentary?: boolean;
}

export function reportsDir(contextRoot: string): string {
  return join(contextRoot, 'lab', 'reports');
}
export function reportPath(contextRoot: string, slug: string): string {
  return join(reportsDir(contextRoot), `${slug}.md`);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function toDateNav(v: unknown): DateNav {
  const s = typeof v === 'string' ? v.trim() : '';
  return (DATE_NAVS as readonly string[]).includes(s) ? (s as DateNav) : 'none';
}

/** LENIENT window-spec parse: 'own' or a valid relative range, else undefined. */
function toWindowSpec(v: unknown): WindowSpec | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s === 'own') return 'own';
  return parseRelativeRange(s) !== null ? s : undefined;
}

/** LENIENT item parse: needs an insight slug, else null (skipped). */
function parseItem(raw: unknown): ReportItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  const insight = typeof r.insight === 'string' ? r.insight.trim() : '';
  if (!insight) return null;
  const item: ReportItem = { insight };
  if (typeof r.view === 'string' && r.view.trim()) item.view = r.view.trim();
  const windowSpec = toWindowSpec(r.window);
  if (windowSpec) item.window = windowSpec;
  const breakdown = asRecord(r.breakdown);
  if (breakdown) {
    const b: ReportItem['breakdown'] = {};
    if (typeof breakdown.rows === 'string' && breakdown.rows.trim()) b.rows = breakdown.rows.trim();
    if (typeof breakdown.cols === 'string' && breakdown.cols.trim()) b.cols = breakdown.cols.trim();
    const filter = asRecord(breakdown.filter);
    if (filter) {
      b.filter = Object.fromEntries(Object.entries(filter).map(([k, v]) => [k, String(v)]));
    }
    if (Object.keys(b).length > 0) item.breakdown = b;
  }
  return item;
}

/** LENIENT sections parse: malformed sections/items are skipped, never fatal. */
export function parseSections(v: unknown): ReportSection[] {
  if (!Array.isArray(v)) return [];
  const out: ReportSection[] = [];
  for (const raw of v) {
    const r = asRecord(raw);
    if (!r) continue;
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : `Section ${out.length + 1}`;
    const items = Array.isArray(r.items)
      ? r.items.map(parseItem).filter((i): i is ReportItem => i !== null)
      : [];
    const section: ReportSection = { title, items };
    const prose = strOrNull(r.prose);
    if (prose) section.prose = prose;
    const windowSpec = toWindowSpec(r.window);
    if (windowSpec) section.window = windowSpec;
    out.push(section);
  }
  return out;
}

export function readReportFile(filePath: string): ReportManifest {
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  const slug = basename(filePath, '.md');
  const manifest: ReportManifest = {
    slug,
    title: typeof data.title === 'string' && data.title.trim() ? data.title : slug,
    description: strOrNull(data.description),
    date_nav: toDateNav(data.date_nav),
    sections: parseSections(data.sections),
    path: filePath,
    notes: content.trim(),
  };
  const windowSpec = toWindowSpec(data.window);
  if (windowSpec) manifest.window = windowSpec;
  if (data.commentary === false) manifest.commentary = false;
  return manifest;
}

/** All reports, sorted by slug (stable). Missing directory → empty list. */
export function listReports(contextRoot: string): ReportManifest[] {
  const dir = reportsDir(contextRoot);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true }).sort();
  const out: ReportManifest[] = [];
  for (const file of files) {
    try {
      out.push(readReportFile(file));
    } catch {
      // skip a report that won't even parse as frontmatter
    }
  }
  return out;
}

export function getReport(contextRoot: string, slug: string): ReportManifest | null {
  const path = reportPath(contextRoot, slug);
  if (!isSafeInsightSlug(slug) || !existsSync(path)) return null;
  try {
    return readReportFile(path);
  } catch {
    return null;
  }
}

export interface CreateReportInput {
  slug: string;
  title: string;
  description?: string | null;
  date_nav?: DateNav;
  /** Insight slugs to seed the first section with (each becomes one item). */
  insights?: string[];
}

/** STRICT validation for writes (throws LabError). Reads stay lenient. */
export function validateReportForWrite(contextRoot: string, input: CreateReportInput): void {
  if (!isSafeInsightSlug(input.slug.trim())) {
    throw new LabError(`Invalid report slug "${input.slug}" — use kebab-case (e.g. daily-product-report).`);
  }
  if (!input.title || !input.title.trim()) {
    throw new LabError('A report title is required.');
  }
  if (input.date_nav && !(DATE_NAVS as readonly string[]).includes(input.date_nav)) {
    throw new LabError(`date_nav must be one of: ${DATE_NAVS.join(', ')}.`);
  }
  for (const slug of input.insights ?? []) {
    if (!existsSync(insightPath(contextRoot, slug))) {
      throw new LabError(`Insight not found: ${slug} — a report composes EXISTING insights.`);
    }
  }
}

/** Scaffold a new report (lazy mkdir, like createInsight). */
export function createReport(contextRoot: string, input: CreateReportInput): ReportManifest {
  validateReportForWrite(contextRoot, input);
  const slug = input.slug.trim();
  const path = reportPath(contextRoot, slug);
  if (existsSync(path)) throw new LabError(`Report already exists: ${slug}`);

  const items = (input.insights ?? []).map((insight) => ({ insight }));
  const frontmatter: Record<string, unknown> = {
    title: input.title,
    description: input.description ?? null,
    date_nav: input.date_nav ?? 'daily',
    sections: [
      {
        title: 'Overview',
        prose: null,
        items,
      },
    ],
    created_at: today(),
    updated_at: today(),
  };

  const notes = [
    '## Notes',
    '',
    '(What should a reader take away from this report? Context, caveats, links.)',
    '',
  ].join('\n');

  mkdirSync(reportsDir(contextRoot), { recursive: true });
  writeFrontmatter(path, frontmatter, notes);
  return readReportFile(path);
}

// ─── Window inheritance (owner decision, 2026-09-01) ────────────────────────
//
// The report's date navigator IS its measurement window: the date_nav
// granularity sets the default span (daily/weekly/monthly → the 1/7/30 days
// ending at the selected date; live = ending today), and every item measures
// that period unless a report/section/item `window` spec says otherwise.
// `'own'` opts an item out (the tile keeps its own window and SAYS so).

const DAY_MS = 86_400_000;

/** The date_nav default span in days (none → no inheritance). */
const NAV_SPAN_DAYS: Record<DateNav, number | null> = {
  none: null,
  daily: 1,
  weekly: 7,
  monthly: 30,
};

function isoMinusDays(toISO: string, days: number): string {
  return new Date(Date.parse(`${toISO}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The concrete window one item should measure over, or null = 'own' (keep the
 * tile's window). Most specific spec wins: item > section > a view-time CUSTOM
 * range (the navigator's free from→to) > report > nav default. `anchorISO` =
 * the selected date (or today for live). A custom range deliberately loses to
 * item/section pins — a lagging metric pinned to 30 days stays pinned — but
 * beats the report default: it IS the reader's explicit window ask.
 */
export function reportTargetWindow(
  report: Pick<ReportManifest, 'date_nav' | 'window'>,
  section: Pick<ReportSection, 'window'>,
  item: Pick<ReportItem, 'window'>,
  anchorISO: string,
  custom: WindowRange | null = null,
): WindowRange | null {
  const pinned = item.window ?? section.window;
  if (pinned === 'own') return null;
  if (pinned) {
    const span = parseRelativeRange(pinned);
    return span === null ? null : { fromISO: isoMinusDays(anchorISO, span), toISO: anchorISO };
  }
  if (custom) return custom;
  const navSpan = NAV_SPAN_DAYS[report.date_nav];
  const spec = report.window ?? (navSpan !== null ? `last_${navSpan}_days` : 'own');
  if (spec === 'own') return null;
  const span = parseRelativeRange(spec);
  if (span === null) return null;
  return { fromISO: isoMinusDays(anchorISO, span), toISO: anchorISO };
}

// ─── Date resolution (shared by the API and `lab report show`) ──────────────

/** How one item's shown data relates to its target window. */
export type WindowStatus =
  /** No target (spec 'own' / date_nav none): the tile's own window, today's behavior. */
  | 'own'
  /** The canonical cache already measures exactly the target window — no extra fetch. */
  | 'aligned'
  /** Served from a fresh transient window-cache measurement. */
  | 'window'
  /** A window-cache entry exists but is past the insight's TTL — shown, refetch due. */
  | 'stale'
  /** No measurement for this window yet — a window sync is needed. */
  | 'missing'
  /** The insight has no source (manual tile) — it cannot re-measure a window. */
  | 'cannot';

/** What one report item resolves to for a given date (or live, date=null). */
export interface ResolvedReportItem {
  insight: string;
  /** The referenced insight no longer exists — render a warning, not a crash. */
  missing: boolean;
  title: string | null;
  render: string | null;
  unit: string | null;
  view: string | null;
  breakdown: ReportItem['breakdown'] | null;
  /** ISO sync time the shown data was taken at, or null (honest empty). */
  asOf: string | null;
  /** Bound value at that time (series insights; live = cache.latest). */
  latest: number | null;
  /** Matrix snapshot at/before the date (breakdown insights), or null. */
  matrixSnapshot: MatrixSnapshot | null;
  /** Funnel snapshot at/before the date (funnel insights), or null. */
  funnelSnapshot: FunnelSnapshot | null;
  /** Live cache — attached only when resolving WITHOUT a date. */
  cache: InsightCache | null;
  /**
   * The measurement window of the SHOWN data, or null when the source recorded
   * none. Honesty rules: the engine's silent 30-day default is NEVER reported
   * as a window (no declaration = null), and a dated series event carries no
   * window at all — the current tweak must not relabel history (the tweak may
   * have changed since; see the 2026-08-31 window-mix report).
   */
  window: { fromISO: string; toISO: string } | null;
  /** The `range` tweak value that produced the live cache (e.g. `last_7_days`), or null. */
  rangeKey: string | null;
  /** The window this item SHOULD measure (inheritance), or null = 'own'. */
  targetWindow: WindowRange | null;
  /** How the shown data relates to the target window. */
  windowStatus: WindowStatus;
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * Derive the live cache's measurement window from the tweak values that
 * produced it: explicit `from`/`to` win, else a relative `range` anchored at
 * the cache's own fetch date (the window ended when the sync ran, not today).
 * No declaration → null — never the engine's fallback span.
 */
export function windowFromTweaks(
  tweaks: Record<string, string> | undefined,
  fetchedAt: string,
): { fromISO: string; toISO: string } | null {
  if (!tweaks) return null;
  const from = typeof tweaks.from === 'string' ? tweaks.from.trim() : '';
  const to = typeof tweaks.to === 'string' ? tweaks.to.trim() : '';
  if (isCalendarDate(from) && isCalendarDate(to)) return { fromISO: from, toISO: to };
  const rangeVal = typeof tweaks.range === 'string' ? tweaks.range.trim() : '';
  const span = rangeVal ? parseRelativeRange(rangeVal) : null;
  if (span === null) return null;
  const anchor = Date.parse(fetchedAt);
  if (!Number.isFinite(anchor)) return null;
  const toISO = new Date(anchor).toISOString().slice(0, 10);
  const fromISO = new Date(Date.parse(`${toISO}T00:00:00Z`) - span * 86_400_000).toISOString().slice(0, 10);
  return { fromISO, toISO };
}

/** The newest ok sync event at/before the end of `date`, or null. */
function latestEventAsOf(cache: InsightCache | null, date: string): { at: string; latest: number | null } | null {
  if (!cache || !Array.isArray(cache.history)) return null;
  const cutoff = Date.parse(`${date}T23:59:59.999Z`);
  if (!Number.isFinite(cutoff)) return null;
  let best: { at: string; latest: number | null } | null = null;
  for (const ev of cache.history) {
    if (!ev || ev.status !== 'ok') continue;
    const at = Date.parse(ev.at);
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (!best || at > Date.parse(best.at)) best = { at: ev.at, latest: ev.latest };
  }
  return best;
}

/** The newest funnel snapshot at/before the end of `date`, or null. */
function funnelSnapshotAsOf(history: FunnelSnapshot[] | undefined, date: string): FunnelSnapshot | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const cutoff = Date.parse(`${date}T23:59:59.999Z`);
  if (!Number.isFinite(cutoff)) return null;
  let best: FunnelSnapshot | null = null;
  for (const snap of history) {
    const at = snap ? Date.parse(snap.at) : NaN;
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (!best || at > Date.parse(best.at)) best = snap;
  }
  return best;
}

/** The measurement window a cache's data covers (typed range first, else tweaks). */
function cacheShownWindow(cache: InsightCache): WindowRange | null {
  return (
    cache.matrix?.range ??
    cache.funnel?.range ??
    cache.datasets?.range ??
    cache.app?.range ??
    windowFromTweaks(cache.tweaks, cache.fetchedAt)
  );
}

function sameWindow(a: WindowRange | null, b: WindowRange | null): boolean {
  return !!a && !!b && a.fromISO === b.fromISO && a.toISO === b.toISO;
}

/** Fill the live-cache fields of a resolved item from one cache object. */
function fillFromCache(base: ResolvedReportItem, cache: InsightCache): void {
  base.cache = cache;
  base.asOf = cache.fetchedAt || null;
  base.latest = cache.latest;
  base.matrixSnapshot = cache.matrixHistory ? cache.matrixHistory[cache.matrixHistory.length - 1] ?? null : null;
  base.rangeKey = typeof cache.tweaks?.range === 'string' && cache.tweaks.range.trim() ? cache.tweaks.range.trim() : null;
  base.window = cacheShownWindow(cache);
}

/**
 * Resolve one item: live (date=null) or as-of a calendar date (YYYY-MM-DD).
 * `target` is the inherited measurement window (null = 'own' — the tile's own
 * window, the pre-inheritance behavior). Priority with a target: canonical
 * cache already aligned → transient window cache (fresh, then stale) →
 * missing (a window sync is owed). A source-less insight cannot re-measure —
 * it falls back to its own resolution and says so.
 */
export function resolveReportItem(
  contextRoot: string,
  item: ReportItem,
  date: string | null,
  target: WindowRange | null = null,
): ResolvedReportItem {
  const manifest: InsightManifest | null = getInsight(contextRoot, item.insight);
  const base: ResolvedReportItem = {
    insight: item.insight,
    missing: manifest === null,
    title: manifest?.title ?? null,
    render: manifest?.render ?? null,
    unit: manifest?.unit ?? null,
    view: item.view ?? null,
    breakdown: item.breakdown ?? null,
    asOf: null,
    latest: null,
    matrixSnapshot: null,
    funnelSnapshot: null,
    cache: null,
    window: null,
    rangeKey: null,
    targetWindow: target,
    windowStatus: target ? 'missing' : 'own',
  };
  if (!manifest) return base;

  const cache = readCache(contextRoot, item.insight);

  if (target) {
    if (!manifest.source) {
      // A manual tile has nothing to fetch — it keeps its own window, honestly.
      base.windowStatus = 'cannot';
      base.targetWindow = target;
    } else {
      // 1. The canonical cache may already measure exactly the target window
      //    (the aligned live case) — no extra fetch, no duplicate storage.
      if (cache && sameWindow(cacheShownWindow(cache), target)) {
        fillFromCache(base, cache);
        base.windowStatus = 'aligned';
        return base;
      }
      // 2. The transient window cache.
      const winCache = readWindowCache(contextRoot, item.insight, target);
      if (winCache) {
        fillFromCache(base, winCache);
        const ageMin = (Date.now() - Date.parse(winCache.fetchedAt)) / 60_000;
        base.windowStatus =
          Number.isFinite(ageMin) && ageMin >= 0 && ageMin < manifest.refresh.ttl_minutes
            ? 'window'
            : 'stale';
        return base;
      }
      // 3. Nothing measured for this window yet — the honest empty until the
      //    window sync lands (never a silently substituted other window).
      base.windowStatus = 'missing';
      return base;
    }
  }

  if (!cache) return base;

  if (date === null) {
    // Live ('own' and manual-tile fallback both land here): the current
    // cache, stamped with its own fetch time.
    fillFromCache(base, cache);
    return base;
  }

  // Dated 'own' (and the manual tile's dated fallback): the latest snapshot
  // AT OR BEFORE the end of that date — per source.
  const matrixSnap = snapshotAsOf(cache.matrixHistory, date);
  if (matrixSnap) {
    base.matrixSnapshot = matrixSnap;
    base.asOf = matrixSnap.at;
    base.latest = matrixSnap.total?.v ?? null;
    base.window = matrixSnap.range ?? null;
    return base;
  }
  const funnelSnap = funnelSnapshotAsOf(cache.funnelHistory, date);
  if (funnelSnap) {
    base.funnelSnapshot = funnelSnap;
    base.asOf = funnelSnap.at;
    base.window = funnelSnap.range ?? null;
    return base;
  }
  const event = latestEventAsOf(cache, date);
  if (event) {
    base.asOf = event.at;
    base.latest = event.latest;
  }
  // No snapshot at/before the date → asOf stays null: the honest empty state.
  return base;
}

export interface ResolvedReportSection {
  title: string;
  prose: string | null;
  items: ResolvedReportItem[];
}

/** Resolve a whole report for a date (null = live), with window inheritance:
 *  each item gets its target window (item > section > custom > report > nav
 *  default) anchored at the selected date (or today). `customFrom` is the
 *  navigator's free range start — with the anchor date it forms an explicit
 *  from→to window for every non-pinned item. */
export function resolveReport(
  contextRoot: string,
  report: ReportManifest,
  date: string | null,
  customFrom: string | null = null,
): ResolvedReportSection[] {
  const anchor = date ?? today();
  const custom: WindowRange | null =
    customFrom && customFrom <= anchor ? { fromISO: customFrom, toISO: anchor } : null;
  return report.sections.map((section) => ({
    title: section.title,
    prose: section.prose ?? null,
    items: section.items.map((item) =>
      resolveReportItem(contextRoot, item, date, reportTargetWindow(report, section, item, anchor, custom)),
    ),
  }));
}

/** The window syncs a resolved report still owes: slug → target window for
 *  every missing/stale item (first window wins on a rare duplicate slug — the
 *  caller re-plans after the job settles, so the second one lands next). */
export function reportWindowPlan(sections: ResolvedReportSection[]): Record<string, WindowRange> {
  const plan: Record<string, WindowRange> = {};
  for (const section of sections) {
    for (const item of section.items) {
      if (item.missing || !item.targetWindow) continue;
      if (item.windowStatus !== 'missing' && item.windowStatus !== 'stale') continue;
      if (!plan[item.insight]) plan[item.insight] = item.targetWindow;
    }
  }
  return plan;
}

/** Every distinct insight slug a report references (the sync-job subset). */
export function reportInsightSlugs(report: ReportManifest): string[] {
  const out = new Set<string>();
  for (const section of report.sections) {
    for (const item of section.items) out.add(item.insight);
  }
  return [...out];
}
