import {
  LabError,
  type FunnelBenchmark,
  type FunnelCacheEntry,
  type FunnelDef,
  type FunnelDimension,
  type FunnelMetricFormat,
  type FunnelMetricValue,
  type FunnelSegment,
  type FunnelSet,
  type FunnelSnapshot,
  type FunnelStep,
  type RawFunnelSet,
  type Series,
} from './types.js';

/**
 * Funnel-set contract (`funnel-set/v1`) — validation, caps, snapshots, deltas.
 *
 * A funnel insight's adapter returns ONE funnel-set object instead of Series[].
 * This module is the contract's enforcement point: `parseFunnelSet` validates
 * the shape, applies every cap (funnels, steps, dimensions, segment cardinality
 * → top-N + "Other", total bytes), and reports every truncation as a NOTICE —
 * caps are never silent. `makeFunnelSnapshot`/`appendFunnelHistory` keep a
 * bounded per-sync trail for `previousPeriodPrev` (the Δ-vs-previous-period
 * source when the adapter doesn't provide `prev` itself).
 *
 * Everything here is pure — no fs, no fetch — so the CLI, the sync engine, the
 * routes, and tests all share one implementation.
 */

export const FUNNEL_SET_KIND = 'funnel-set/v1';

// ─── Caps (structural — enforced, not advised; every hit produces a notice) ──
export const MAX_FUNNELS = 40;
/** Real quiz funnels run 40-60 steps — the cap exists to bound pathological
 *  payloads, not to truncate legitimate long funnels. */
export const MAX_STEPS = 64;
export const MAX_DIMENSIONS = 8;
/** Per dimension: values beyond the top-N (by users) collapse into "Other". */
export const MAX_DIMENSION_VALUES = 8;
/** Per funnel: segment cells beyond this (after value collapse) merge into one "Other" cell. */
export const MAX_SEGMENTS = 64;
/** Byte cap on the stored funnel-set JSON. Segments are dropped first; a set
 *  still over the cap after that is rejected. */
export const MAX_FUNNEL_BYTES = 400_000;
/** Bounded per-sync snapshot trail (compact: metrics + step users only). */
export const FUNNEL_HISTORY_MAX = 40;
/** Default low-sample threshold (first-step users) when the payload sets none. */
export const DEFAULT_LOW_SAMPLE_THRESHOLD = 30;
/** Collapsed-value label for over-cap dimension values / segment cells. */
export const OTHER_VALUE = 'Other';

const FORMATS: readonly FunnelMetricFormat[] = ['count', 'pct', 'usd', 'x', 'seconds', 'number'];

export interface ParsedFunnelSet {
  set: FunnelSet;
  /** Human-readable cap/coercion notices — surface them, never swallow. */
  notices: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseDimension(raw: unknown, notices: string[]): FunnelDimension | null {
  if (!isRecord(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const mode = raw.mode === 'refetch' ? 'refetch' : 'client';
  const dim: FunnelDimension = {
    key,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : key,
    mode,
  };
  if (typeof raw.tweak === 'string' && raw.tweak.trim()) dim.tweak = raw.tweak.trim();
  if (Array.isArray(raw.values)) {
    const values: { value: string; count?: number }[] = [];
    for (const v of raw.values) {
      if (typeof v === 'string') values.push({ value: v });
      else if (isRecord(v) && typeof v.value === 'string') {
        const count = toFiniteOrNull(v.count);
        values.push(count === null ? { value: v.value } : { value: v.value, count });
      }
    }
    if (values.length > 0) dim.values = values;
  }
  if (raw.mode !== undefined && raw.mode !== 'client' && raw.mode !== 'refetch') {
    notices.push(`dimension "${key}": unknown mode "${String(raw.mode)}" — treated as client.`);
  }
  return dim;
}

function parseMetric(key: string, raw: unknown): FunnelMetricValue {
  if (!isRecord(raw)) return { v: toFiniteOrNull(raw), format: 'number' };
  const format = typeof raw.format === 'string' && (FORMATS as readonly string[]).includes(raw.format)
    ? (raw.format as FunnelMetricFormat)
    : 'number';
  const metric: FunnelMetricValue = { v: toFiniteOrNull(raw.v), format };
  if (typeof raw.label === 'string' && raw.label.trim()) metric.label = raw.label.trim();
  if ('prev' in raw) metric.prev = toFiniteOrNull(raw.prev);
  void key;
  return metric;
}

function parseStep(raw: unknown): FunnelStep | null {
  if (!isRecord(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const users = toFiniteOrNull(raw.users);
  const step: FunnelStep = {
    key,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : key,
    users: users === null ? 0 : Math.max(0, users),
  };
  if ('prev' in raw) step.prev = toFiniteOrNull(raw.prev);
  const median = toFiniteOrNull(raw.median_seconds);
  if (median !== null) step.median_seconds = median;
  return step;
}

function parseSegment(raw: unknown, stepKeys: Set<string>): FunnelSegment | null {
  if (!isRecord(raw) || !isRecord(raw.dims)) return null;
  const dims: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.dims)) dims[k] = String(v);
  if (Object.keys(dims).length === 0) return null;
  const steps: { key: string; users: number }[] = [];
  if (Array.isArray(raw.steps)) {
    for (const s of raw.steps) {
      if (!isRecord(s) || typeof s.key !== 'string') continue;
      if (!stepKeys.has(s.key)) continue; // a segment step must exist on the funnel
      const users = toFiniteOrNull(s.users);
      steps.push({ key: s.key, users: users === null ? 0 : Math.max(0, users) });
    }
  }
  const users = toFiniteOrNull(raw.users);
  return { dims, users: users === null ? (steps[0]?.users ?? 0) : Math.max(0, users), steps };
}

/** Merge segment cells that share identical dims (sums users + per-step users). */
function mergeSegments(segments: FunnelSegment[]): FunnelSegment[] {
  const byDims = new Map<string, FunnelSegment>();
  for (const seg of segments) {
    const key = Object.keys(seg.dims).sort().map((k) => `${k}=${seg.dims[k]}`).join('|');
    const prior = byDims.get(key);
    if (!prior) {
      byDims.set(key, { dims: { ...seg.dims }, users: seg.users, steps: seg.steps.map((s) => ({ ...s })) });
      continue;
    }
    prior.users += seg.users;
    const byStep = new Map(prior.steps.map((s) => [s.key, s]));
    for (const s of seg.steps) {
      const p = byStep.get(s.key);
      if (p) p.users += s.users;
      else prior.steps.push({ ...s });
    }
  }
  return [...byDims.values()];
}

/** Collapse over-cap dimension values to "Other", then over-cap cells to one "Other" cell. */
function capSegments(
  funnelId: string,
  segments: FunnelSegment[],
  dimensions: FunnelDimension[],
  notices: string[],
): FunnelSegment[] {
  let out = segments;

  // Per-dimension value cardinality: keep the top MAX_DIMENSION_VALUES by users.
  for (const dim of dimensions) {
    if (dim.mode !== 'client') continue;
    const usersByValue = new Map<string, number>();
    for (const seg of out) {
      const v = seg.dims[dim.key];
      if (v === undefined) continue;
      usersByValue.set(v, (usersByValue.get(v) ?? 0) + seg.users);
    }
    if (usersByValue.size <= MAX_DIMENSION_VALUES) continue;
    const kept = new Set(
      [...usersByValue.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIMENSION_VALUES).map(([v]) => v),
    );
    const collapsed = usersByValue.size - kept.size;
    out = out.map((seg) => {
      const v = seg.dims[dim.key];
      if (v === undefined || kept.has(v)) return seg;
      return { ...seg, dims: { ...seg.dims, [dim.key]: OTHER_VALUE } };
    });
    out = mergeSegments(out);
    notices.push(`funnel ${funnelId}: dimension "${dim.key}" had ${usersByValue.size} values — kept top ${MAX_DIMENSION_VALUES}, collapsed ${collapsed} into "${OTHER_VALUE}".`);
  }

  // Total cell cap: merge the tail (by users) into one all-Other cell.
  if (out.length > MAX_SEGMENTS) {
    const sorted = [...out].sort((a, b) => b.users - a.users);
    const kept = sorted.slice(0, MAX_SEGMENTS - 1);
    const tail = sorted.slice(MAX_SEGMENTS - 1);
    const otherDims: Record<string, string> = {};
    for (const k of Object.keys(tail[0].dims)) otherDims[k] = OTHER_VALUE;
    notices.push(`funnel ${funnelId}: ${out.length} segment cells — kept top ${MAX_SEGMENTS - 1}, merged ${tail.length} into "${OTHER_VALUE}".`);
    // One final merge so a kept all-Other cell and the merged tail can't coexist.
    out = mergeSegments([...kept, ...tail.map((seg) => ({ ...seg, dims: otherDims }))]);
  }

  return out;
}

function parseFunnel(raw: unknown, index: number, dimensions: FunnelDimension[], notices: string[]): FunnelDef | null {
  if (!isRecord(raw)) {
    notices.push(`funnels[${index}] is not an object — skipped.`);
    return null;
  }
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id).trim() : '';
  if (!id) {
    notices.push(`funnels[${index}] has no id — skipped.`);
    return null;
  }

  const steps: FunnelStep[] = [];
  const seenKeys = new Set<string>();
  if (Array.isArray(raw.steps)) {
    for (const s of raw.steps) {
      const step = parseStep(s);
      if (!step) continue;
      if (seenKeys.has(step.key)) {
        notices.push(`funnel ${id}: duplicate step key "${step.key}" — later occurrence dropped.`);
        continue;
      }
      seenKeys.add(step.key);
      steps.push(step);
    }
  }
  if (steps.length === 0) {
    notices.push(`funnel ${id} has no valid steps — skipped.`);
    return null;
  }
  if (steps.length > MAX_STEPS) {
    // Keep the first MAX-1 AND the last step: the final step (Finish) carries
    // the funnel's outcome — dropping it would fabricate a different funnel.
    const last = steps[steps.length - 1];
    notices.push(`funnel ${id}: ${steps.length} steps — kept the first ${MAX_STEPS - 1} + the final step "${last.key}".`);
    steps.length = MAX_STEPS - 1;
    steps.push(last);
  }

  const metrics: Record<string, FunnelMetricValue> = {};
  if (isRecord(raw.metrics)) {
    for (const [key, v] of Object.entries(raw.metrics)) metrics[key] = parseMetric(key, v);
  }

  const meta: Record<string, string> = {};
  if (isRecord(raw.meta)) {
    for (const [key, v] of Object.entries(raw.meta)) {
      if (v !== null && v !== undefined) meta[key] = String(v);
    }
  }

  const funnel: FunnelDef = { id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id, meta, metrics, steps };

  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    const stepKeys = new Set(steps.map((s) => s.key));
    const segments = raw.segments
      .map((s) => parseSegment(s, stepKeys))
      .filter((s): s is FunnelSegment => s !== null);
    if (segments.length > 0) {
      funnel.segments = capSegments(id, mergeSegments(segments), dimensions, notices);
    }
  }

  return funnel;
}

function parseBenchmarks(raw: unknown): Record<string, FunnelBenchmark> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, FunnelBenchmark> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue;
    const bench: FunnelBenchmark = {};
    const floor = toFiniteOrNull(v.floor);
    const target = toFiniteOrNull(v.target);
    if (floor !== null) bench.floor = floor;
    if (target !== null) bench.target = target;
    if (bench.floor !== undefined || bench.target !== undefined) out[key] = bench;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate + cap a raw funnel-set payload. Throws `LabError` only when the
 * payload is fundamentally not a funnel-set (wrong kind, funnels not an array,
 * or irrecoverably over the byte cap); individual malformed funnels/segments
 * degrade to notices, mirroring the store's lenient-read philosophy.
 */
export function parseFunnelSet(raw: unknown): ParsedFunnelSet {
  if (!isRecord(raw) || raw.kind !== FUNNEL_SET_KIND) {
    throw new LabError(`Funnel payload must be an object with kind "${FUNNEL_SET_KIND}".`);
  }
  if (!Array.isArray(raw.funnels)) {
    throw new LabError('Funnel payload must have a `funnels` array.');
  }

  const notices: string[] = [];

  const dimensions: FunnelDimension[] = [];
  if (Array.isArray(raw.dimensions)) {
    const seen = new Set<string>();
    for (const d of raw.dimensions) {
      const dim = parseDimension(d, notices);
      if (!dim || seen.has(dim.key)) continue;
      seen.add(dim.key);
      dimensions.push(dim);
    }
  }
  if (dimensions.length > MAX_DIMENSIONS) {
    notices.push(`${dimensions.length} dimensions declared — kept the first ${MAX_DIMENSIONS}.`);
    dimensions.length = MAX_DIMENSIONS;
  }

  let rawFunnels = raw.funnels;
  if (rawFunnels.length > MAX_FUNNELS) {
    notices.push(`${rawFunnels.length} funnels — kept the first ${MAX_FUNNELS}.`);
    rawFunnels = rawFunnels.slice(0, MAX_FUNNELS);
  }
  const funnels: FunnelDef[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawFunnels.length; i++) {
    const funnel = parseFunnel(rawFunnels[i], i, dimensions, notices);
    if (!funnel) continue;
    if (seenIds.has(funnel.id)) {
      notices.push(`duplicate funnel id "${funnel.id}" — later occurrence dropped.`);
      continue;
    }
    seenIds.add(funnel.id);
    funnels.push(funnel);
  }

  const set: FunnelSet = { kind: FUNNEL_SET_KIND, dimensions, funnels };
  if (typeof raw.primary === 'string' && raw.primary.trim()) set.primary = raw.primary.trim();
  const lowSample = toFiniteOrNull(raw.low_sample_threshold);
  if (lowSample !== null && lowSample >= 0) set.low_sample_threshold = lowSample;
  const benchmarks = parseBenchmarks(raw.benchmarks);
  if (benchmarks) set.benchmarks = benchmarks;

  // ── Byte cap: drop segments first (largest funnels first), then reject. ──
  if (JSON.stringify(set).length > MAX_FUNNEL_BYTES) {
    const withSegments = set.funnels
      .filter((f) => f.segments && f.segments.length > 0)
      .sort((a, b) => JSON.stringify(b.segments).length - JSON.stringify(a.segments).length);
    for (const funnel of withSegments) {
      delete funnel.segments;
      notices.push(`funnel ${funnel.id}: segments dropped to fit the ${MAX_FUNNEL_BYTES}-byte cache cap.`);
      if (JSON.stringify(set).length <= MAX_FUNNEL_BYTES) break;
    }
  }
  if (JSON.stringify(set).length > MAX_FUNNEL_BYTES) {
    throw new LabError(`Funnel payload exceeds the ${MAX_FUNNEL_BYTES}-byte cap even without segments — return fewer funnels/steps (Lab stores insights, not raw dumps).`);
  }

  return { set, notices };
}

// ─── Series synthesis + latest (backward compat with every series consumer) ──

/** Synthesize legacy `Series[]` from step users — one series per funnel, one
 *  point per step (t = step label). Keeps NumberCard/binding/snapshot working. */
export function funnelToSeries(set: FunnelSet): Series[] {
  return set.funnels.map((f) => ({
    name: f.name || f.id,
    points: f.steps.map((s) => ({ t: s.label || s.key, v: s.users })),
  }));
}

/** The card/binding `latest` for a funnel-set: the primary metric of the first
 *  funnel, else its first-step (top) users. */
export function funnelLatest(set: FunnelSet): number | null {
  const first = set.funnels[0];
  if (!first) return null;
  if (set.primary) {
    const primary = first.metrics[set.primary];
    if (primary && primary.v !== null && Number.isFinite(primary.v)) return primary.v;
  }
  return first.steps[0]?.users ?? null;
}

// ─── History snapshots + previous-period deltas ─────────────────────────────

/** Compact snapshot of one sync (metrics + step users only — no segments/meta). */
export function makeFunnelSnapshot(
  set: FunnelSet,
  range: { fromISO: string; toISO: string },
  at: string,
): FunnelSnapshot {
  return {
    at,
    range,
    funnels: set.funnels.map((f) => ({
      id: f.id,
      metrics: Object.fromEntries(Object.entries(f.metrics).map(([k, m]) => [k, m.v])),
      steps: f.steps.map((s) => ({ key: s.key, users: s.users })),
    })),
  };
}

/** Append one snapshot, keeping the newest FUNNEL_HISTORY_MAX. Tolerates a
 *  malformed prior trail (non-array) — mirrors appendHistory in sync.ts. */
export function appendFunnelHistory(
  prior: FunnelSnapshot[] | undefined,
  snapshot: FunnelSnapshot,
): FunnelSnapshot[] {
  const priorTrail = Array.isArray(prior) ? prior : [];
  const trail = [...priorTrail, snapshot];
  return trail.length > FUNNEL_HISTORY_MAX ? trail.slice(trail.length - FUNNEL_HISTORY_MAX) : trail;
}

const DAY_MS = 86_400_000;

function spanDays(range: { fromISO: string; toISO: string }): number | null {
  const from = Date.parse(`${range.fromISO}T00:00:00Z`);
  const to = Date.parse(`${range.toISO}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / DAY_MS);
}

/** Previous-period values per funnel, derived per metric/step. Precedence:
 *  adapter-provided `prev` on the metric/step wins; else the best history
 *  snapshot — one covering an equal-length (±25%) window ending at/before the
 *  current window's start, closest to it. Null when neither source exists. */
export interface FunnelPrev {
  /** funnel id → metric key → previous value (null = unknown). */
  metrics: Record<string, Record<string, number | null>>;
  /** funnel id → step key → previous users (null = unknown). */
  steps: Record<string, Record<string, number | null>>;
  /** Which snapshot fed the history-derived values (null = adapter-only/none). */
  source: { at: string; range: { fromISO: string; toISO: string } } | null;
}

/** Pick the history snapshot that best represents "the previous equal-length period". */
export function pickPreviousSnapshot(
  current: { fromISO: string; toISO: string },
  history: FunnelSnapshot[] | undefined,
): FunnelSnapshot | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const currentSpan = spanDays(current);
  const currentFrom = Date.parse(`${current.fromISO}T00:00:00Z`);
  if (currentSpan === null || !Number.isFinite(currentFrom)) return null;

  let best: FunnelSnapshot | null = null;
  let bestDistance = Infinity;
  for (const snap of history) {
    if (!snap || !snap.range) continue;
    const snapSpan = spanDays(snap.range);
    const snapTo = Date.parse(`${snap.range.toISO}T00:00:00Z`);
    if (snapSpan === null || !Number.isFinite(snapTo)) continue;
    // Equal-length within ±25% (history cadence rarely aligns perfectly).
    const tolerance = Math.max(1, currentSpan * 0.25);
    if (Math.abs(snapSpan - currentSpan) > tolerance) continue;
    // Must END at or before the current window's start (a genuinely previous period).
    if (snapTo > currentFrom) continue;
    const distance = currentFrom - snapTo;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = snap;
    }
  }
  return best;
}

/** Compute previous-period values for every funnel/metric/step in the set. */
export function computeFunnelPrev(entry: FunnelCacheEntry, history: FunnelSnapshot[] | undefined): FunnelPrev {
  const snapshot = pickPreviousSnapshot(entry.range, history);
  const snapById = new Map((snapshot?.funnels ?? []).map((f) => [f.id, f]));

  const metrics: Record<string, Record<string, number | null>> = {};
  const steps: Record<string, Record<string, number | null>> = {};
  for (const funnel of entry.set.funnels) {
    const snap = snapById.get(funnel.id);
    const m: Record<string, number | null> = {};
    for (const [key, metric] of Object.entries(funnel.metrics)) {
      if (metric.prev !== undefined) m[key] = metric.prev;
      else m[key] = snap?.metrics[key] ?? null;
    }
    metrics[funnel.id] = m;

    const snapSteps = new Map((snap?.steps ?? []).map((s) => [s.key, s.users]));
    const st: Record<string, number | null> = {};
    for (const step of funnel.steps) {
      if (step.prev !== undefined) st[step.key] = step.prev;
      else st[step.key] = snapSteps.get(step.key) ?? null;
    }
    steps[funnel.id] = st;
  }

  return {
    metrics,
    steps,
    source: snapshot ? { at: snapshot.at, range: snapshot.range } : null,
  };
}

// ─── Step math (shared by CLI `lab show` and tests; the dashboard mirrors it) ──

export interface StepRow {
  key: string;
  label: string;
  users: number;
  /** % of the first (top) step, 0-100. Null when top is 0. */
  ofTop: number | null;
  /** % of the previous step, 0-100. Null on the first step or when prev is 0. */
  ofPrev: number | null;
  /** Absolute drop from the previous step (negative = users increased). */
  drop: number | null;
}

/** Per-step rates + drops for one funnel. Honest about weird data: a 0-user
 *  mid-step yields null ofPrev on the next step (no divide-by-zero), and users
 *  INCREASING between steps yields a negative drop (rendered as ↑, not clamped). */
export function computeStepRows(steps: FunnelStep[]): StepRow[] {
  const top = steps[0]?.users ?? 0;
  return steps.map((step, i) => {
    const prev = i > 0 ? steps[i - 1].users : null;
    return {
      key: step.key,
      label: step.label,
      users: step.users,
      ofTop: top > 0 ? (step.users / top) * 100 : null,
      ofPrev: prev === null ? null : prev > 0 ? (step.users / prev) * 100 : null,
      drop: prev === null ? null : prev - step.users,
    };
  });
}

/** Index (1-based, the arriving step) of the worst adjacent drop by RATE, or null. */
export function worstDropIndex(rows: StepRow[]): number | null {
  let worst: number | null = null;
  let worstRate = Infinity;
  for (let i = 1; i < rows.length; i++) {
    const rate = rows[i].ofPrev;
    if (rate === null) continue;
    if (rate < worstRate) {
      worstRate = rate;
      worst = i;
    }
  }
  return worst;
}
