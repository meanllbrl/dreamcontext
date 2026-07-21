/**
 * Funnel-set client model — types mirroring the backend contract
 * (src/lib/lab/funnel.ts) plus every PURE view computation the funnel pages
 * share: step math, metric formatting, client-side filtering over segments,
 * breakdown grouping, compare alignment, and URL view-state codecs.
 *
 * No React, no fetch — keep this importable from any component.
 */

// ─── Types (mirror src/lib/lab/types.ts — the API returns these shapes) ─────

export type FunnelMetricFormat = 'count' | 'pct' | 'usd' | 'x' | 'seconds' | 'number';

export interface FunnelMetricValue {
  v: number | null;
  format: FunnelMetricFormat;
  label?: string;
  prev?: number | null;
}

export interface FunnelStep {
  key: string;
  label: string;
  users: number;
  prev?: number | null;
  median_seconds?: number | null;
}

export interface FunnelSegment {
  dims: Record<string, string>;
  users: number;
  steps: { key: string; users: number }[];
}

export interface FunnelDimension {
  key: string;
  label: string;
  mode: 'client' | 'refetch';
  tweak?: string;
  values?: { value: string; count?: number }[];
}

export interface FunnelDef {
  id: string;
  name: string;
  meta: Record<string, string>;
  metrics: Record<string, FunnelMetricValue>;
  steps: FunnelStep[];
  segments?: FunnelSegment[];
}

export interface FunnelBenchmark {
  floor?: number;
  target?: number;
}

export interface FunnelSet {
  kind: 'funnel-set/v1';
  dimensions: FunnelDimension[];
  funnels: FunnelDef[];
  primary?: string;
  low_sample_threshold?: number;
  benchmarks?: Record<string, FunnelBenchmark>;
}

export interface FunnelCacheEntry {
  set: FunnelSet;
  notices: string[];
  range: { fromISO: string; toISO: string };
}

export interface FunnelSnapshot {
  at: string;
  range: { fromISO: string; toISO: string };
  funnels: {
    id: string;
    metrics: Record<string, number | null>;
    steps: { key: string; users: number }[];
  }[];
}

export interface FunnelPrev {
  metrics: Record<string, Record<string, number | null>>;
  steps: Record<string, Record<string, number | null>>;
  source: { at: string; range: { fromISO: string; toISO: string } } | null;
}

export const DEFAULT_LOW_SAMPLE_THRESHOLD = 30;

/** Shared multi-series palette (same as LineChart/PieChart — the lab chart set). */
export const FUNNEL_COLORS = ['#7b68ee', '#0091ff', '#ff5b36', '#4ade80', '#ffae3b', '#f472b6', '#22d3ee', '#a3e635'];

// ─── Step math ──────────────────────────────────────────────────────────────

export interface StepRow {
  key: string;
  label: string;
  users: number;
  /** % of the first (top) step, 0-100. Null when top is 0. */
  ofTop: number | null;
  /** % of the previous step. Null on the first step or when prev is 0. */
  ofPrev: number | null;
  /** Absolute drop from the previous step (negative = users increased). */
  drop: number | null;
}

/** Per-step rates + drops. Honest math: 0-user prev → null rate (no ∞), users
 *  increasing between steps → negative drop (rendered ↑, never clamped). */
export function computeStepRows(steps: { key: string; label?: string; users: number }[]): StepRow[] {
  const top = steps[0]?.users ?? 0;
  return steps.map((step, i) => {
    const prev = i > 0 ? steps[i - 1].users : null;
    return {
      key: step.key,
      label: step.label ?? step.key,
      users: step.users,
      ofTop: top > 0 ? (step.users / top) * 100 : null,
      ofPrev: prev === null ? null : prev > 0 ? (step.users / prev) * 100 : null,
      drop: prev === null ? null : prev - step.users,
    };
  });
}

/** Index (the arriving step) of the worst adjacent drop by rate, or null. */
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

/** Drop severity for badge tinting (drop RATE = 100 − ofPrev). */
export type DropSeverity = 'low' | 'mid' | 'high';
export function dropSeverity(ofPrev: number | null): DropSeverity {
  if (ofPrev === null) return 'low';
  const dropRate = 100 - ofPrev;
  if (dropRate >= 70) return 'high';
  if (dropRate >= 40) return 'mid';
  return 'low';
}

// ─── Metric formatting ──────────────────────────────────────────────────────

export function formatMetricValue(v: number | null, format: FunnelMetricFormat): string {
  if (v === null || !Number.isFinite(v)) return '—';
  switch (format) {
    case 'count':
      return Math.round(v).toLocaleString('en-US');
    case 'pct':
      return `${v >= 10 || v === 0 ? v.toFixed(v >= 100 ? 0 : 1) : v.toFixed(2)}%`;
    case 'usd':
      return `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
    case 'x':
      return `${v.toFixed(2)}×`;
    case 'seconds': {
      if (v < 60) return `${Math.round(v)}s`;
      if (v < 3600) return `${Math.round(v / 60)}m`;
      return `${(v / 3600).toFixed(1)}h`;
    }
    default:
      return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
}

/** Δ current vs prev: pct metrics → percentage points; others → relative %. */
export function formatDelta(current: number, prev: number, format: FunnelMetricFormat): { text: string; direction: 'up' | 'down' | 'flat' } {
  if (format === 'pct') {
    const pp = current - prev;
    if (Math.abs(pp) < 0.005) return { text: '±0pp', direction: 'flat' };
    return { text: `${pp > 0 ? '▲' : '▼'}${Math.abs(pp).toFixed(Math.abs(pp) >= 10 ? 0 : 1)}pp`, direction: pp > 0 ? 'up' : 'down' };
  }
  if (prev === 0) {
    if (current === 0) return { text: '±0%', direction: 'flat' };
    return { text: current > 0 ? '▲new' : '▼new', direction: current > 0 ? 'up' : 'down' };
  }
  const rel = ((current - prev) / Math.abs(prev)) * 100;
  if (Math.abs(rel) < 0.05) return { text: '±0%', direction: 'flat' };
  return { text: `${rel > 0 ? '▲' : '▼'}${Math.abs(rel).toFixed(Math.abs(rel) >= 10 ? 0 : 1)}%`, direction: rel > 0 ? 'up' : 'down' };
}

/** Prettify a metric key when no label is declared (finish_rate → Finish Rate). */
export function prettifyKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface MetricColumn {
  key: string;
  label: string;
  format: FunnelMetricFormat;
}

/** Ordered union of metric keys across all funnels (first-seen order). */
export function metricColumns(set: FunnelSet): MetricColumn[] {
  const cols: MetricColumn[] = [];
  const seen = new Set<string>();
  for (const funnel of set.funnels) {
    for (const [key, metric] of Object.entries(funnel.metrics)) {
      if (seen.has(key)) continue;
      seen.add(key);
      cols.push({ key, label: metric.label ?? prettifyKey(key), format: metric.format });
    }
  }
  return cols;
}

/** Top-N funnels for the card preview, sorted by the primary metric (desc),
 *  falling back to top-step users. */
export function funnelPreviewRows(set: FunnelSet, n: number): FunnelDef[] {
  const value = (f: FunnelDef): number => {
    if (set.primary) {
      const m = f.metrics[set.primary];
      if (m && m.v !== null && Number.isFinite(m.v)) return m.v;
    }
    return f.steps[0]?.users ?? 0;
  };
  return [...set.funnels].sort((a, b) => value(b) - value(a)).slice(0, n);
}

/** The low-sample check: first-step users below the payload threshold. */
export function isLowSample(funnel: FunnelDef, set: FunnelSet): boolean {
  const threshold = set.low_sample_threshold ?? DEFAULT_LOW_SAMPLE_THRESHOLD;
  return (funnel.steps[0]?.users ?? 0) < threshold;
}

/** Benchmark tint for a metric value (benchmarks are opt-in via the payload). */
export function benchmarkClass(value: number | null, bench: FunnelBenchmark | undefined): 'below-floor' | 'at-target' | null {
  if (!bench || value === null) return null;
  if (bench.floor !== undefined && value < bench.floor) return 'below-floor';
  if (bench.target !== undefined && value >= bench.target) return 'at-target';
  return null;
}

// ─── Client-side filtering over segments ────────────────────────────────────

/** dim key → selected values (empty/missing key = no filter on that dim). */
export type FilterState = Record<string, string[]>;

export function hasActiveFilters(filters: FilterState): boolean {
  return Object.values(filters).some((v) => v.length > 0);
}

/** The client-mode subset of active filters (refetch dims resolve via tweaks). */
export function clientFilters(filters: FilterState, dimensions: FunnelDimension[]): FilterState {
  const clientDims = new Set(dimensions.filter((d) => d.mode === 'client').map((d) => d.key));
  const out: FilterState = {};
  for (const [key, values] of Object.entries(filters)) {
    if (clientDims.has(key) && values.length > 0) out[key] = values;
  }
  return out;
}

export interface FilteredFunnel {
  /** Steps with users summed over the matching segment cells. */
  steps: { key: string; label: string; users: number }[];
  /** Top-step users after filtering. */
  users: number;
}

/**
 * Apply client-dim filters to one funnel by summing its matching segment cells.
 * Null when the funnel carries no segments (client filtering impossible) —
 * callers must surface that, not silently show unfiltered data.
 */
export function applyClientFilters(funnel: FunnelDef, filters: FilterState): FilteredFunnel | null {
  const active = Object.entries(filters).filter(([, values]) => values.length > 0);
  if (active.length === 0) {
    return { steps: funnel.steps.map((s) => ({ key: s.key, label: s.label, users: s.users })), users: funnel.steps[0]?.users ?? 0 };
  }
  if (!funnel.segments || funnel.segments.length === 0) return null;

  const matching = funnel.segments.filter((seg) =>
    active.every(([dim, values]) => {
      const v = seg.dims[dim];
      return v !== undefined && values.includes(v);
    }),
  );
  const byStep = new Map<string, number>();
  for (const seg of matching) {
    for (const s of seg.steps) byStep.set(s.key, (byStep.get(s.key) ?? 0) + s.users);
  }
  const steps = funnel.steps.map((s) => ({ key: s.key, label: s.label, users: byStep.get(s.key) ?? 0 }));
  return { steps, users: steps[0]?.users ?? 0 };
}

/** Distinct values for one dimension: declared values first, else observed in
 *  segments (with users as count). Sorted by count desc, then value. */
export function dimensionValues(set: FunnelSet, dim: FunnelDimension): { value: string; count: number | null }[] {
  if (dim.values && dim.values.length > 0) {
    return dim.values.map((v) => ({ value: v.value, count: v.count ?? null }));
  }
  const counts = new Map<string, number>();
  for (const funnel of set.funnels) {
    for (const seg of funnel.segments ?? []) {
      const v = seg.dims[dim.key];
      if (v === undefined) continue;
      counts.set(v, (counts.get(v) ?? 0) + seg.users);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

// ─── Breakdown (one dimension → per-value lanes or stacked bands) ───────────

export const BREAKDOWN_TOP_N = 6;
export const OTHER_VALUE = 'Other';
export const REMAINDER_VALUE = 'Unsegmented';

export interface BreakdownLane {
  value: string;
  users: number;
  /** Users per step key (aligned to the funnel's step order by the caller). */
  steps: Map<string, number>;
}

/**
 * Group one funnel's segments by ONE dimension value: top-N by users + "Other",
 * plus an "Unsegmented" remainder when segment sums fall short of the funnel
 * totals (sampling) — the remainder is shown, never hidden.
 */
export function breakdownLanes(funnel: FunnelDef, dimKey: string, topN: number = BREAKDOWN_TOP_N): BreakdownLane[] {
  if (!funnel.segments || funnel.segments.length === 0) return [];

  const byValue = new Map<string, BreakdownLane>();
  for (const seg of funnel.segments) {
    const value = seg.dims[dimKey];
    if (value === undefined) continue;
    let lane = byValue.get(value);
    if (!lane) {
      lane = { value, users: 0, steps: new Map() };
      byValue.set(value, lane);
    }
    lane.users += seg.users;
    for (const s of seg.steps) lane.steps.set(s.key, (lane.steps.get(s.key) ?? 0) + s.users);
  }
  if (byValue.size === 0) return [];

  let lanes = [...byValue.values()].sort((a, b) => b.users - a.users);
  if (lanes.length > topN) {
    const kept = lanes.slice(0, topN);
    const other: BreakdownLane = { value: OTHER_VALUE, users: 0, steps: new Map() };
    for (const lane of lanes.slice(topN)) {
      other.users += lane.users;
      for (const [k, v] of lane.steps) other.steps.set(k, (other.steps.get(k) ?? 0) + v);
    }
    lanes = [...kept, other];
  }

  // Unsegmented remainder per step (funnel total − segmented sum), when positive.
  const remainder: BreakdownLane = { value: REMAINDER_VALUE, users: 0, steps: new Map() };
  let hasRemainder = false;
  for (const step of funnel.steps) {
    const segmented = lanes.reduce((sum, lane) => sum + (lane.steps.get(step.key) ?? 0), 0);
    const rest = step.users - segmented;
    if (rest > 0) {
      remainder.steps.set(step.key, rest);
      hasRemainder = true;
    }
  }
  if (hasRemainder) {
    remainder.users = remainder.steps.get(funnel.steps[0]?.key ?? '') ?? 0;
    lanes = [...lanes, remainder];
  }
  return lanes;
}

// ─── Significant-change collapse (user-set threshold) ───────────────────────

export interface CollapsedStep {
  /** The LAST member's key — the group's boundary state; arcs anchor here. */
  key: string;
  label: string;
  /** Users LEAVING the group (last member's users). */
  users: number;
  /** Present only for a real group (2+ members). */
  collapsed: {
    count: number;
    /** Users ENTERING the group (first member's users) — shown as start → end. */
    startUsers: number;
    firstLabel: string;
    lastLabel: string;
    memberKeys: string[];
  } | null;
}

/**
 * Collapse runs of INSIGNIFICANT change: a step joins the previous group when
 * its relative user change vs the previous step is below `thresholdPct`
 * (absolute — an insignificant increase collapses too). A significant change
 * starts a new node. Group nodes carry start → end users so a long run of
 * small drops that ADD UP to a big one stays visible, never hidden.
 */
export function collapseSteps(
  steps: { key: string; label: string; users: number }[],
  thresholdPct: number,
): CollapsedStep[] {
  const plain = (s: { key: string; label: string; users: number }): CollapsedStep =>
    ({ key: s.key, label: s.label, users: s.users, collapsed: null });
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || steps.length === 0) {
    return steps.map(plain);
  }
  const groups: { key: string; label: string; users: number }[][] = [];
  for (let i = 0; i < steps.length; i++) {
    if (i === 0) { groups.push([steps[0]]); continue; }
    const prev = steps[i - 1].users;
    const cur = steps[i].users;
    const change = prev > 0 ? Math.abs(1 - cur / prev) * 100 : cur === prev ? 0 : 100;
    if (change < thresholdPct) groups[groups.length - 1].push(steps[i]);
    else groups.push([steps[i]]);
  }
  return groups.map((members) => {
    if (members.length === 1) return plain(members[0]);
    const first = members[0];
    const last = members[members.length - 1];
    return {
      key: last.key,
      label: `${first.label} … ${last.label}`,
      users: last.users,
      collapsed: {
        count: members.length,
        startUsers: first.users,
        firstLabel: first.label,
        lastLabel: last.label,
        memberKeys: members.map((m) => m.key),
      },
    };
  });
}

// ─── Compare (align steps by KEY across funnels) ────────────────────────────

/** Union of step keys: first funnel's order, then unseen keys from the rest in
 *  their own order. NEVER aligned by index. */
export function alignStepKeys(funnels: FunnelDef[]): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const funnel of funnels) {
    for (const step of funnel.steps) {
      if (seen.has(step.key)) continue;
      seen.add(step.key);
      out.push({ key: step.key, label: step.label });
    }
  }
  return out;
}

// ─── URL view-state codecs (A13 — the whole view round-trips) ───────────────

export interface FunnelViewState {
  filters: FilterState;
  breakdown: string | null;
  breakdownMode: 'stack' | 'lanes';
  compare: string[];
  /** Pinned arcs: [fromStepKey, toStepKey] pairs. */
  arcs: [string, string][];
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  /** Significant-change collapse threshold in % (null = mode off). */
  collapse: number | null;
}

export const EMPTY_VIEW_STATE: FunnelViewState = {
  filters: {},
  breakdown: null,
  breakdownMode: 'stack',
  compare: [],
  arcs: [],
  sort: null,
  collapse: null,
};

const enc = encodeURIComponent;
const dec = decodeURIComponent;

/** Write the view state into a URLSearchParams (mutates + returns it). */
export function writeViewState(params: URLSearchParams, state: FunnelViewState): URLSearchParams {
  const filterEntries = Object.entries(state.filters).filter(([, v]) => v.length > 0);
  if (filterEntries.length > 0) {
    params.set('flt', filterEntries.map(([k, v]) => `${enc(k)}:${v.map(enc).join('|')}`).join(';'));
  } else params.delete('flt');

  if (state.breakdown) params.set('bd', state.breakdown);
  else params.delete('bd');
  if (state.breakdown && state.breakdownMode === 'lanes') params.set('bdm', 'lanes');
  else params.delete('bdm');

  if (state.compare.length > 0) params.set('cmp', state.compare.map(enc).join(','));
  else params.delete('cmp');

  if (state.arcs.length > 0) params.set('arcs', state.arcs.map(([a, b]) => `${enc(a)}~${enc(b)}`).join(','));
  else params.delete('arcs');

  if (state.sort) params.set('sort', `${state.sort.dir === 'desc' ? '-' : ''}${state.sort.key}`);
  else params.delete('sort');

  if (state.collapse !== null && Number.isFinite(state.collapse) && state.collapse > 0) {
    params.set('clt', String(state.collapse));
  } else params.delete('clt');

  return params;
}

/** Parse the view state back out of a URLSearchParams. Tolerates junk. */
export function readViewState(params: URLSearchParams): FunnelViewState {
  const filters: FilterState = {};
  const flt = params.get('flt');
  if (flt) {
    for (const part of flt.split(';')) {
      const [rawKey, rawValues] = part.split(':');
      if (!rawKey || !rawValues) continue;
      try {
        const values = rawValues.split('|').map(dec).filter(Boolean);
        if (values.length > 0) filters[dec(rawKey)] = values;
      } catch { /* malformed component — skip */ }
    }
  }

  const arcs: [string, string][] = [];
  const rawArcs = params.get('arcs');
  if (rawArcs) {
    for (const pair of rawArcs.split(',')) {
      const [a, b] = pair.split('~');
      if (!a || !b) continue;
      try { arcs.push([dec(a), dec(b)]); } catch { /* skip */ }
    }
  }

  const rawSort = params.get('sort');
  let sort: FunnelViewState['sort'] = null;
  if (rawSort) {
    sort = rawSort.startsWith('-')
      ? { key: rawSort.slice(1), dir: 'desc' }
      : { key: rawSort, dir: 'asc' };
  }

  const rawCmp = params.get('cmp');
  const rawClt = Number(params.get('clt'));
  return {
    filters,
    breakdown: params.get('bd'),
    breakdownMode: params.get('bdm') === 'lanes' ? 'lanes' : 'stack',
    compare: rawCmp ? rawCmp.split(',').map((s) => { try { return dec(s); } catch { return ''; } }).filter(Boolean) : [],
    arcs,
    sort,
    collapse: Number.isFinite(rawClt) && rawClt > 0 ? Math.min(50, rawClt) : null,
  };
}

// ─── Copy-as-Markdown (A14) ─────────────────────────────────────────────────

export function stepTableMarkdown(name: string, rows: StepRow[]): string {
  const lines = [
    `### ${name}`,
    '',
    '| Step | Users | % of top | % of prev | Drop |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const row of rows) {
    const ofTop = row.ofTop === null ? '—' : `${row.ofTop.toFixed(1)}%`;
    const ofPrev = row.ofPrev === null ? '—' : `${row.ofPrev.toFixed(1)}%`;
    const drop = row.drop === null ? '—' : row.drop < 0 ? `↑${-row.drop}` : `−${row.drop}`;
    lines.push(`| ${row.label} | ${row.users.toLocaleString('en-US')} | ${ofTop} | ${ofPrev} | ${drop} |`);
  }
  return lines.join('\n');
}

export function overviewRowMarkdown(funnel: FunnelDef, cols: MetricColumn[]): string {
  const header = `| Funnel | ${cols.map((c) => c.label).join(' | ')} |`;
  const sep = `| --- | ${cols.map(() => '---:').join(' | ')} |`;
  const row = `| ${funnel.name} | ${cols.map((c) => formatMetricValue(funnel.metrics[c.key]?.v ?? null, c.format)).join(' | ')} |`;
  return [header, sep, row].join('\n');
}

export function overviewTableMarkdown(funnels: FunnelDef[], cols: MetricColumn[]): string {
  const lines = [
    `| Funnel | ${cols.map((c) => c.label).join(' | ')} |`,
    `| --- | ${cols.map(() => '---:').join(' | ')} |`,
  ];
  for (const funnel of funnels) {
    lines.push(`| ${funnel.name} | ${cols.map((c) => formatMetricValue(funnel.metrics[c.key]?.v ?? null, c.format)).join(' | ')} |`);
  }
  return lines.join('\n');
}
