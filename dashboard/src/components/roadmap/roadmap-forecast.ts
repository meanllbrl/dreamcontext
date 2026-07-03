/**
 * Roadmap forecast cascade — the pure scheduling engine under the interactive
 * timeline. Given each objective's committed window (start_date → target_date) and
 * its dependencies, it computes a FORECAST window by propagating finish-to-start
 * constraints along the dependency DAG (topologically sorted, Kahn):
 *
 *   forecast_start = max(committed start, max(forecast_end of dependencies))
 *   forecast_end   = forecast_start + committed duration
 *   slipping       = forecast_end > committed target
 *
 * This is what makes the roadmap live: drag one objective's committed dates (via
 * `overrides`) and every dependent's forecast bar shifts to stay after it — turning
 * red the moment a forecast overruns its own committed target. Mirrors the server's
 * `roadmap-model.ts` cascade, but keyed off PO-committed dates (draggable) rather
 * than member-task dates, so it stays meaningful before any tasks are linked.
 *
 * An objective with no dates at all is "unforecastable" — it imposes no constraint
 * on its dependents (non-blocking), exactly like the null-forecast rule server-side.
 */

// ── calendar-safe date utils (shared by the timeline; never touches tasks utils) ──
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAY_MS = 86_400_000;

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
export function formatISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function diffDays(a: string, b: string): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / DAY_MS);
}
export const addISO = (iso: string, n: number) => formatISO(addDays(parseISO(iso), n));
export const todayISO = () => formatISO(new Date());
export const fmtShort = (iso: string) => { const d = parseISO(iso); return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`; };
const maxISO = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

/**
 * Defense-in-depth: a committed date that isn't a real YYYY-MM-DD is treated as
 * absent. The server already coerces bad dates on read, but this keeps the pure
 * cascade robust — a malformed value degrades an objective to "unforecastable"
 * rather than producing NaN dates that would win maxISO and corrupt dependents.
 */
export function validISO(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? v : null;
}

export interface ForecastInput {
  slug: string;
  start_date: string | null;
  target_date: string | null;
  depends_on: string[];
}

export type Signal = 'on_track' | 'slipping' | 'unforecastable';

export interface Forecast {
  slug: string;
  forecastable: boolean;
  /** Committed window (coalesced): the bar's authored anchor. */
  committedStart: string | null;
  committedEnd: string | null;
  /** Computed cascade window (what the bar actually renders at). */
  forecast_start: string | null;
  forecast_end: string | null;
  /** Committed target date — the ◆ diamond marker. */
  target: string | null;
  slipping: boolean;
  /** forecast_end − target in days; >0 = slip, <0 = buffer. */
  slipDays: number;
  /** Computed reverse edges (objectives that depend on this one). */
  dependents: string[];
  signal: Signal;
}

/** Kahn topological sort by depends_on (dependencies first); cycles fall back to input order. */
function topoOrder(inputs: ForecastInput[]): ForecastInput[] {
  const bySlug = new Map(inputs.map((o) => [o.slug, o]));
  const inDeg = new Map<string, number>();
  const dependentsOf = new Map<string, string[]>();
  for (const o of inputs) {
    const deps = o.depends_on.filter((d) => bySlug.has(d));
    inDeg.set(o.slug, deps.length);
    for (const dep of deps) {
      const arr = dependentsOf.get(dep) ?? [];
      arr.push(o.slug);
      dependentsOf.set(dep, arr);
    }
  }
  const queue = inputs.filter((o) => (inDeg.get(o.slug) ?? 0) === 0).map((o) => o.slug).sort();
  const sorted: ForecastInput[] = [];
  while (queue.length) {
    const slug = queue.shift()!;
    sorted.push(bySlug.get(slug)!);
    for (const dep of (dependentsOf.get(slug) ?? []).sort()) {
      const d = (inDeg.get(dep) ?? 0) - 1;
      inDeg.set(dep, d);
      if (d === 0) queue.push(dep);
    }
  }
  if (sorted.length < inputs.length) {
    for (const o of inputs) if (!sorted.includes(o)) sorted.push(o);
  }
  return sorted;
}

/**
 * Build the forecast for every objective. `overrides` swaps in a live (dragged)
 * committed window for a slug so the whole cascade recomputes against the preview.
 */
export function buildForecasts(
  inputs: ForecastInput[],
  overrides?: Map<string, { start: string | null; target: string | null }>,
): Map<string, Forecast> {
  const known = new Set(inputs.map((o) => o.slug));
  const dependentsOf = new Map<string, string[]>();
  for (const o of inputs) {
    for (const dep of o.depends_on) {
      if (!known.has(dep)) continue;
      const arr = dependentsOf.get(dep) ?? [];
      arr.push(o.slug);
      dependentsOf.set(dep, arr);
    }
  }

  const out = new Map<string, Forecast>();
  const forecastEndOf = new Map<string, string | null>();

  for (const o of topoOrder(inputs)) {
    const ov = overrides?.get(o.slug);
    // Sanitize: a non-calendar date is treated as absent (never NaN-propagated).
    const startRaw = validISO(ov ? ov.start : o.start_date);
    const targetRaw = validISO(ov ? ov.target : o.target_date);
    // Coalesce a committed window: either date alone anchors a zero-length window.
    const committedStart = startRaw ?? targetRaw;
    const committedEnd = targetRaw ?? startRaw;
    const target = targetRaw ?? committedEnd;
    const forecastable = committedStart !== null && committedEnd !== null;

    let forecast_start: string | null = null;
    let forecast_end: string | null = null;
    if (forecastable) {
      const duration = Math.max(0, diffDays(committedStart!, committedEnd!));
      // Dependencies push the start; unforecastable deps impose no constraint.
      let depEnd: string | null = null;
      for (const dep of o.depends_on) {
        if (!known.has(dep)) continue;
        depEnd = maxISO(depEnd, forecastEndOf.get(dep) ?? null);
      }
      forecast_start = maxISO(committedStart, depEnd)!;
      forecast_end = addISO(forecast_start, duration);
    }
    forecastEndOf.set(o.slug, forecast_end);

    const slipDays = forecast_end && target ? diffDays(target, forecast_end) : 0;
    const slipping = forecastable && slipDays > 0;
    const signal: Signal = !forecastable ? 'unforecastable' : slipping ? 'slipping' : 'on_track';

    out.set(o.slug, {
      slug: o.slug,
      forecastable,
      committedStart,
      committedEnd,
      forecast_start,
      forecast_end,
      target,
      slipping,
      slipDays,
      dependents: (dependentsOf.get(o.slug) ?? []).slice().sort(),
      signal,
    });
  }
  return out;
}
