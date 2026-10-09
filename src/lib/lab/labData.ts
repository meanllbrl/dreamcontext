import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parseDatasetBundle } from './dataset.js';
import { FUNNEL_SET_KIND, parseFunnelSet } from './funnel.js';
import { isSafeInsightSlug, labDir } from './store.js';
import { LabError, type FunnelSet } from './types.js';

/**
 * The snapshot store: `lab/data/<slug>.json`, shaped `{source, data}`.
 *
 * A snapshot-fed insight (the funnel explorer) never touches the network. An
 * agent pulls the numbers through the KB MCP, builds the snapshot, and writes it
 * with `lab data write`, which goes through `writeLabSnapshot` here. That is the
 * guarantee a refresh needs: a snapshot is validated BEFORE it replaces the old
 * one, and a refused write leaves the file on disk byte-identical (or absent).
 *
 * `source` is copied from the query responses (applied filters, freshness, the
 * pull time), so a later reader can see which filters produced the numbers.
 * Every query must send an explicit date window (`op: between`); a product
 * filter is expected and its absence is a notice.
 */

export const LAB_DATA_DIR = 'data';
/** Byte cap on the snapshot file (the parsed set keeps its own 400 KB cap). */
export const MAX_LAB_DATA_BYTES = 2_000_000;

export type SnapshotKind = 'funnel-set/v1' | 'dataset/v1' | 'series';

export interface SnapshotSummary {
  /** Bytes of the snapshot as written (compact JSON). */
  bytes: number;
  /** Bytes of the funnel set as the cache stores it, or null when there is none. */
  storedBytes: number | null;
  funnels: number;
  dims: { key: string; values: number }[];
  segments: number;
  intersections: number;
  /** Funnels that carry a daily series. */
  dailyFunnels: number;
  /** Funnels that carry segments. */
  segmentFunnels: number;
  payment: boolean;
  access: boolean;
  ladderStages: number;
  window: { from: string; to: string } | null;
  pulledAt: string | null;
}

export interface SnapshotCheck {
  ok: boolean;
  /** Why the snapshot is refused (empty when ok). */
  problems: string[];
  /** Parse notices and warnings that do not refuse it. */
  notices: string[];
  kind: SnapshotKind | null;
  summary: SnapshotSummary | null;
}

export interface SnapshotCheckOptions {
  /** The insight is a funnel explorer: its data must carry a funnel set. */
  requireFunnel?: boolean;
}

interface DateFilter {
  from: string;
  to: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isIsoDay(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

/** The snapshot's path. Throws on an unsafe slug; the path itself is checked by the read/write callers. */
export function labDataPath(contextRoot: string, slug: string): string {
  if (typeof slug !== 'string' || !isSafeInsightSlug(slug)) {
    throw new LabError(`Invalid insight slug "${String(slug)}": use kebab-case (e.g. weekly-active-users).`);
  }
  return join(labDir(contextRoot), LAB_DATA_DIR, `${slug}.json`);
}

/**
 * The snapshot path when it is safe to use: not a symlink, and inside
 * `<realpath(contextRoot)>/lab/data/` (a symlinked `lab/` or `lab/data/` is refused).
 * `exists` says whether a regular file is there now.
 */
function containedDataPath(contextRoot: string, slug: string): { path: string; exists: boolean } {
  const path = labDataPath(contextRoot, slug);
  let exists = false;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new LabError(`lab/data/${slug}.json is a symlink: refusing to read or write it.`);
    if (!st.isFile()) throw new LabError(`lab/data/${slug}.json is not a regular file.`);
    exists = true;
  } catch (err) {
    if (err instanceof LabError) throw err;
  }
  const dir = join(labDir(contextRoot), LAB_DATA_DIR);
  if (existsSync(dir)) {
    const expected = join(realpathSync(contextRoot), 'lab', LAB_DATA_DIR);
    if (realpathSync(dir) !== expected) {
      throw new LabError(`lab/${LAB_DATA_DIR}/ resolves outside the vault: refusing to read or write snapshots there.`);
    }
  }
  return { path, exists };
}

/** The snapshot on disk, parsed as JSON, or null when there is none. Throws on an unsafe path or invalid JSON. */
export function readLabSnapshot(contextRoot: string, slug: string): unknown | null {
  const { path, exists } = containedDataPath(contextRoot, slug);
  if (!exists) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // A fixed message: a parse error would echo the file's first characters.
    throw new LabError(`lab/data/${slug}.json is not valid JSON.`);
  }
}

/**
 * Make sure `lab/` and `lab/data/` are real directories inside the vault,
 * creating each one only after its parent is verified: a symlinked `lab/`
 * never gets a `data/` created outside the vault.
 */
function prepareDataDir(contextRoot: string): void {
  const rootReal = realpathSync(contextRoot);
  const steps: [string, string, string][] = [
    [labDir(contextRoot), join(rootReal, 'lab'), 'lab/'],
    [join(labDir(contextRoot), LAB_DATA_DIR), join(rootReal, 'lab', LAB_DATA_DIR), `lab/${LAB_DATA_DIR}/`],
  ];
  for (const [dir, expected, name] of steps) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      mkdirSync(dir); // its parent was verified one step earlier (or is the vault root)
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory() || realpathSync(dir) !== expected) {
      throw new LabError(`${name} resolves outside the vault (or is not a plain directory): refusing to write snapshots there.`);
    }
  }
}

/** Every filter the snapshot's source carries: `source.applied_filters` and `source.queries[].applied_filters`. */
function collectFilters(source: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const take = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const f of list) {
      const r = asRecord(f);
      if (r) out.push(r);
    }
  };
  take(source.applied_filters);
  if (Array.isArray(source.queries)) {
    for (const q of source.queries) take(asRecord(q)?.applied_filters);
  }
  return out;
}

function dateFilters(filters: readonly Record<string, unknown>[]): DateFilter[] {
  const out: DateFilter[] = [];
  for (const f of filters) {
    if (f.op !== 'between' || !Array.isArray(f.values) || f.values.length !== 2) continue;
    const [from, to] = f.values;
    if (isIsoDay(from) && isIsoDay(to)) out.push({ from, to });
  }
  return out;
}

function hasProductFilter(filters: readonly Record<string, unknown>[]): boolean {
  return filters.some((f) => typeof f.field === 'string' && /product/i.test(f.field) && f.source === 'request');
}

function isSeriesArray(data: unknown): boolean {
  return Array.isArray(data) && data.every((s) => {
    const r = asRecord(s);
    return !!r && typeof r.name === 'string' && Array.isArray(r.points)
      && r.points.every((p) => {
        const pt = asRecord(p);
        return !!pt && typeof pt.t === 'string' && typeof pt.v === 'number' && Number.isFinite(pt.v);
      });
  });
}

/** The raw funnel set inside `data`: a bare funnel-set, or a dataset bundle's `funnel` member. */
function rawFunnelOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;
  if (data.kind === FUNNEL_SET_KIND) return data;
  return asRecord(data.funnel);
}

/** What the parsed set holds, read through a loose view so newer optional fields count when present. */
function summarize(
  raw: Record<string, unknown>,
  set: FunnelSet | null,
  window: DateFilter | null,
  pulledAt: string | null,
): SnapshotSummary {
  const loose = (set ?? {}) as unknown as Record<string, unknown>;
  const funnels = set ? set.funnels : [];
  const intersections = Array.isArray(loose.intersections) ? loose.intersections.length : 0;
  const ladder = asRecord(loose.ladder);
  const ladderStages = ladder && Array.isArray(ladder.stages) ? ladder.stages.length : 0;
  const access = asRecord(loose.access);
  const funnelPayment = funnels.some((f) => asRecord((f as unknown as Record<string, unknown>).payment) !== null);
  const valueCounts = (key: string): number => {
    const values = new Set<string>();
    for (const f of funnels) for (const seg of f.segments ?? []) if (seg.dims[key] !== undefined) values.add(seg.dims[key]);
    return values.size;
  };
  return {
    bytes: JSON.stringify(raw).length,
    storedBytes: set ? JSON.stringify(set).length : null,
    funnels: funnels.length,
    dims: set ? set.dimensions.map((d) => ({ key: d.key, values: d.values?.length ?? valueCounts(d.key) })) : [],
    segments: funnels.reduce((n, f) => n + (f.segments?.length ?? 0), 0),
    intersections,
    dailyFunnels: funnels.filter((f) => (f.daily?.length ?? 0) > 0).length,
    segmentFunnels: funnels.filter((f) => (f.segments?.length ?? 0) > 0).length,
    payment: funnelPayment || asRecord(loose.payment) !== null,
    access: !!access && Array.isArray(access.rows) && access.rows.length > 0,
    ladderStages,
    window,
    pulledAt,
  };
}

/**
 * Validate a snapshot without touching the disk. A problem refuses it; a notice
 * does not. The data part goes through its own contract's parser (funnel-set,
 * dataset bundle or Series[]), so whatever `lab sync` would refuse is refused here.
 */
export function checkLabSnapshot(raw: unknown, opts: SnapshotCheckOptions = {}): SnapshotCheck {
  const problems: string[] = [];
  const notices: string[] = [];
  const root = asRecord(raw);
  const source = asRecord(root?.source);
  if (!root || !source || !('data' in root)) {
    return { ok: false, problems: ['a snapshot is an object { source, data }: copy `source` from the query responses and put the payload in `data`.'], notices, kind: null, summary: null };
  }

  const bytes = JSON.stringify(raw).length;
  if (bytes > MAX_LAB_DATA_BYTES) {
    problems.push(`the snapshot is ${bytes} bytes, over the ${MAX_LAB_DATA_BYTES}-byte cap: carry fewer funnels, paths or days.`);
  }

  const pulledAt = typeof source.pulled_at === 'string' && Number.isFinite(Date.parse(source.pulled_at)) ? source.pulled_at : null;
  if (!pulledAt) problems.push('source.pulled_at must be the ISO time of the pull (e.g. 2026-10-08T14:33:48Z).');

  const filters = collectFilters(source);
  const dates = dateFilters(filters);
  if (filters.length === 0) {
    problems.push('source carries no applied filters: copy `applied filters` from every query response into source.applied_filters (or source.queries[].applied_filters).');
  } else if (dates.length === 0) {
    problems.push('no explicit date filter: every query must send its date window as { op: "between", values: [from, to] } with YYYY-MM-DD days.');
  }
  if (filters.length > 0 && !hasProductFilter(filters)) {
    notices.push('no product filter found among the applied filters: send the product filter on every query.');
  }

  const data = root.data;
  const dataRec = asRecord(data);
  let kind: SnapshotKind | null = null;
  let set: FunnelSet | null = null;
  if (dataRec && dataRec.kind === FUNNEL_SET_KIND) {
    kind = 'funnel-set/v1';
    try {
      const parsed = parseFunnelSet(data);
      set = parsed.set;
      for (const n of parsed.notices) notices.push(n);
    } catch (err) {
      problems.push(`data: ${(err as Error).message}`);
    }
  } else if (dataRec && dataRec.kind === 'dataset/v1') {
    kind = 'dataset/v1';
    try {
      const parsed = parseDatasetBundle(data);
      set = parsed.funnel?.set ?? null;
      for (const n of parsed.notices) notices.push(n);
    } catch (err) {
      problems.push(`data: ${(err as Error).message}`);
    }
  } else if (isSeriesArray(data)) {
    kind = 'series';
  } else {
    problems.push('data is not a funnel-set/v1, a dataset/v1 bundle or a Series[] array.');
  }

  if (opts.requireFunnel && kind !== null && !(kind === 'funnel-set/v1' || (kind === 'dataset/v1' && rawFunnelOf(dataRec) !== null))) {
    problems.push('this insight is a funnel explorer: data must be a funnel-set/v1 (or a dataset/v1 bundle with a `funnel` member).');
  }

  let window: DateFilter | null = null;
  const rawWindow = asRecord(rawFunnelOf(dataRec)?.window);
  if (rawWindow) {
    const from = rawWindow.from;
    const to = rawWindow.to;
    if (isIsoDay(from) && isIsoDay(to)) {
      window = { from, to };
      if (dates.length > 0 && !dates.some((d) => d.from === from && d.to === to)) {
        problems.push(`data.window ${from}..${to} matches no query's date filter: the window must be the one the queries were sent with.`);
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    notices,
    kind,
    summary: summarize(root, set, window, pulledAt),
  };
}

/**
 * Validate, then replace `lab/data/<slug>.json` atomically. A refused snapshot
 * throws a `LabError` naming every problem and leaves the file on disk exactly
 * as it was.
 *
 * The write never follows a planted link: `lab/` and `lab/data/` are verified
 * before anything is created; the temp file has a unique name and is created
 * with O_EXCL (`wx`), which refuses any existing entry, a symlink included;
 * containment is checked again just before the rename; the temp file is
 * removed on any failure.
 */
export function writeLabSnapshot(contextRoot: string, slug: string, raw: unknown, opts: SnapshotCheckOptions = {}): SnapshotCheck {
  const path = labDataPath(contextRoot, slug);
  const check = checkLabSnapshot(raw, opts);
  if (!check.ok) {
    throw new LabError(`Snapshot refused for ${slug}, nothing written:\n${check.problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  prepareDataDir(contextRoot);
  containedDataPath(contextRoot, slug);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    const fd = openSync(tmp, 'wx', 0o644);
    created = true;
    try {
      writeSync(fd, JSON.stringify(raw, null, 1) + '\n', null, 'utf-8');
    } finally {
      closeSync(fd);
    }
    // The tree may have changed while we wrote: check again right before the rename.
    containedDataPath(contextRoot, slug);
    renameSync(tmp, path);
    created = false;
  } finally {
    if (created) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  }
  return check;
}
