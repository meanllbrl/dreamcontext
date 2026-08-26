import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter } from '../frontmatter.js';
import { today } from '../id.js';
import { snapshotAsOf } from './matrix.js';
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

/** One insight reference inside a report section. */
export interface ReportItem {
  /** The insight slug this item draws from. */
  insight: string;
  /** Optional render override hint for the report surface. */
  view?: string;
  /** Optional breakdown view config (matrix insights): pivot axes + filter. */
  breakdown?: { rows?: string; cols?: string; filter?: Record<string, string> };
}

export interface ReportSection {
  title: string;
  /** Free prose above the section's charts. */
  prose?: string;
  items: ReportItem[];
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

/** LENIENT item parse: needs an insight slug, else null (skipped). */
function parseItem(raw: unknown): ReportItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  const insight = typeof r.insight === 'string' ? r.insight.trim() : '';
  if (!insight) return null;
  const item: ReportItem = { insight };
  if (typeof r.view === 'string' && r.view.trim()) item.view = r.view.trim();
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
    out.push(section);
  }
  return out;
}

export function readReportFile(filePath: string): ReportManifest {
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  const slug = basename(filePath, '.md');
  return {
    slug,
    title: typeof data.title === 'string' && data.title.trim() ? data.title : slug,
    description: strOrNull(data.description),
    date_nav: toDateNav(data.date_nav),
    sections: parseSections(data.sections),
    path: filePath,
    notes: content.trim(),
  };
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

// ─── Date resolution (shared by the API and `lab report show`) ──────────────

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

/** Resolve one item: live (date=null) or as-of a calendar date (YYYY-MM-DD). */
export function resolveReportItem(
  contextRoot: string,
  item: ReportItem,
  date: string | null,
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
  };
  if (!manifest) return base;

  const cache = readCache(contextRoot, item.insight);
  if (!cache) return base;

  if (date === null) {
    // Live: the current cache, stamped with its own fetch time.
    base.cache = cache;
    base.asOf = cache.fetchedAt || null;
    base.latest = cache.latest;
    base.matrixSnapshot = cache.matrixHistory ? cache.matrixHistory[cache.matrixHistory.length - 1] ?? null : null;
    return base;
  }

  // Dated: the latest snapshot AT OR BEFORE the end of that date — per source.
  const matrixSnap = snapshotAsOf(cache.matrixHistory, date);
  if (matrixSnap) {
    base.matrixSnapshot = matrixSnap;
    base.asOf = matrixSnap.at;
    base.latest = matrixSnap.total?.v ?? null;
    return base;
  }
  const funnelSnap = funnelSnapshotAsOf(cache.funnelHistory, date);
  if (funnelSnap) {
    base.funnelSnapshot = funnelSnap;
    base.asOf = funnelSnap.at;
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

/** Resolve a whole report for a date (null = live). */
export function resolveReport(
  contextRoot: string,
  report: ReportManifest,
  date: string | null,
): ResolvedReportSection[] {
  return report.sections.map((section) => ({
    title: section.title,
    prose: section.prose ?? null,
    items: section.items.map((item) => resolveReportItem(contextRoot, item, date)),
  }));
}

/** Every distinct insight slug a report references (the sync-job subset). */
export function reportInsightSlugs(report: ReportManifest): string[] {
  const out = new Set<string>();
  for (const section of report.sections) {
    for (const item of section.items) out.add(item.insight);
  }
  return [...out];
}
