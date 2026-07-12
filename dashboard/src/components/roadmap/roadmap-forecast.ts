/**
 * Roadmap forecast cascade — the pure scheduling engine under the interactive
 * timeline. Given each objective's committed window (start_date → target_date), its
 * effort estimate, and its dependencies, it computes a FORECAST by propagating
 * finish-to-start constraints along the dependency DAG (topologically sorted, Kahn).
 *
 * The model is EFFORT-AWARE and ENVELOPE-CLAMPED — it never invents a delay:
 *
 *   effortDays     = effort ? effort * 7 : 0        (effort is prioritization weeks)
 *   forecast_start = max(committed start, max(forecast_end of dependencies))
 *   workEnd        = forecast_start + effortDays     (when the actual work finishes)
 *   forecast_end   = max(committed end, workEnd)      (bar never shrinks below the window)
 *   slipping       = target set AND workEnd > target
 *   slipDays       = workEnd − target  (>0 = slip, <0 = buffer/runway)
 *
 * The committed window (start→target) is a DEADLINE PLAN, not a rigid block of work
 * that slides: a dependency finishing on time consumes the objective's *slack*, not
 * its deadline. With no effort set, `workEnd == forecast_start`, so an objective only
 * slips when a dependency (or its own committed start) pushes past its target — it is
 * never postponed just for having a wide window. Set an effort estimate and it drives
 * a real, sized forecast: `effort` weeks of work that can't fit before the target
 * shows a proportionate slip. This mirrors the server's `roadmap-model.ts` cascade
 * (kept in lock-step); the frontend is keyed off PO-committed dates (draggable) so it
 * stays meaningful before any tasks are linked.
 *
 * A dependency's contribution to its dependents' start is its `forecast_end` — i.e.
 * its committed deadline (or later, if it overshoots), NOT its instantaneous workEnd:
 * a predecessor isn't "done" until its own target passes.
 *
 * DATED MEMBER TASKS ARE THE SCHEDULE OF RECORD. When an objective has member tasks
 * carrying real start/due dates, those dates drive the forecast (span = earliest start →
 * latest due, still clamped to dependency finishes) and effort is NOT re-added on top —
 * the tasks already encode the duration. The committed window remains an ENVELOPE here
 * too: the bar starts no later than the committed start and ends no earlier than the
 * committed end (start-only tasks must not collapse the bar to a point and erase the
 * PO's window from the timeline), while slip is still measured on the task-derived
 * finish. This mirrors `roadmap-model.ts` exactly and is
 * what keeps a ROLLUP objective honest: one that BOTH `depends_on` its sub-objectives
 * AND shares their member tasks must not stack its own effort after the dependency's
 * finish (the tasks it shares ARE that work). Without this rule the committed-window
 * branch stacked effort past the dependency, inflating the bar into a phantom slip that
 * disagreed with the CLI forecast. Only when an objective has no dated tasks does the
 * committed-window (start→target + effort) or pure-milestone (inherited-finish + effort)
 * basis apply.
 *
 * An objective with no dated tasks, no dates and no forecastable dependency is
 * "unforecastable" — it imposes no constraint on its dependents (non-blocking), like
 * the server-side rule.
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
const minISO = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a < b ? a : b;

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
  /** Prioritization effort in WEEKS (Impact × Effort). Drives the work duration; null = unknown (0 days, no invented delay). */
  effort?: number | null;
  depends_on: string[];
  /**
   * Member tasks (from the computed model). When ANY carries a real start/due date the
   * task span becomes the SCHEDULE OF RECORD — the objective forecasts from those dates
   * (earliest start → latest due, clamped to dep finishes) and effort is NOT re-added,
   * mirroring `roadmap-model.ts`. Undated/omitted → the committed-window/effort basis is
   * used. `RoadmapItem.tasks` is structurally assignable here (extra fields are ignored).
   */
  tasks?: Array<{ start_date: string | null; due_date: string | null }>;
}

/** Whole calendar days of work for an effort estimate (weeks → days); null/≤0 = 0. */
export function effortToDays(effort: number | null | undefined): number {
  return effort != null && effort > 0 ? Math.round(effort * 7) : 0;
}

export type Signal = 'on_track' | 'slipping' | 'unforecastable';

export interface Forecast {
  slug: string;
  forecastable: boolean;
  /** Committed window (coalesced): the bar's authored anchor. */
  committedStart: string | null;
  committedEnd: string | null;
  /** Computed cascade window the bar renders at: forecast_start → forecast_end (= max of committed end, workEnd). */
  forecast_start: string | null;
  forecast_end: string | null;
  /** Committed target date — the ◆ diamond marker. */
  target: string | null;
  slipping: boolean;
  /** workEnd − target in days (workEnd = forecast_start + effort); >0 = slip, <0 = buffer/runway. 0 when no target. */
  slipDays: number;
  /** Computed reverse edges (objectives that depend on this one). */
  dependents: string[];
  signal: Signal;
  /**
   * Which input drove the forecast: `tasks` (dated member tasks = schedule of record,
   * no effort re-added), `window` (committed start→target + effort), `milestone`
   * (finish inherited from dependencies + effort), or `none` (unforecastable).
   */
  basis: 'tasks' | 'window' | 'milestone' | 'none';
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
  // Bar end (= committed deadline, or later if it overshoots): what dependents consume.
  const forecastEndOf = new Map<string, string | null>();

  for (const o of topoOrder(inputs)) {
    const ov = overrides?.get(o.slug);
    // Sanitize: a non-calendar date is treated as absent (never NaN-propagated).
    const startRaw = validISO(ov ? ov.start : o.start_date);
    const targetRaw = validISO(ov ? ov.target : o.target_date);
    // Coalesce a committed window: either date alone anchors a zero-length window.
    const committedStart = startRaw ?? targetRaw;
    const committedEnd = targetRaw ?? startRaw;
    const effortDays = effortToDays(o.effort);

    // Dependencies push the start to their finish (their bar end); an
    // unforecastable dep imposes no constraint (non-blocking, never "now").
    let depFinish: string | null = null;
    for (const dep of o.depends_on) {
      if (!known.has(dep)) continue;
      depFinish = maxISO(depFinish, forecastEndOf.get(dep) ?? null);
    }

    // Dated member tasks (start and/or due) are the SCHEDULE OF RECORD — sanitized so a
    // malformed date is treated as absent. See the top-of-file docstring.
    const taskStart = (o.tasks ?? []).reduce<string | null>((acc, t) => minISO(acc, validISO(t.start_date)), null);
    const taskDue = (o.tasks ?? []).reduce<string | null>((acc, t) => maxISO(acc, validISO(t.due_date)), null);
    const hasDatedTasks = taskStart !== null || taskDue !== null;

    let forecast_start: string | null = null;
    let forecast_end: string | null = null;
    let workEnd: string | null = null;
    let basis: Forecast['basis'] = 'none';
    if (hasDatedTasks) {
      // Task-date basis (mirrors roadmap-model.ts): span = earliest start → latest due,
      // clamped to the dependency finish. Effort is NOT re-added — the task dates already
      // encode the duration, so a rollup sharing its deps' tasks can't double-count. The
      // committed window is still the ENVELOPE: the bar starts no later than the committed
      // start and never ends before the committed end (start-only tasks would otherwise
      // collapse the bar to a point and erase the PO's window from the timeline — and a
      // predecessor isn't "done" for its dependents until its own target passes). Slip is
      // measured on the task-derived finish (workEnd), not the envelope end.
      forecast_start = maxISO(minISO(taskStart, startRaw), depFinish) ?? taskDue;
      workEnd = maxISO(taskDue, forecast_start);
      forecast_end = maxISO(committedEnd, workEnd);
      basis = 'tasks';
    } else if (committedStart !== null) {
      // Committed-window basis: the start→target window is a deadline plan, not a rigid
      // block that slides. A dependency pushes the achievable start; effort weeks of work
      // run from there; the bar never renders shorter than the committed window the PO drew.
      forecast_start = maxISO(committedStart, depFinish)!;
      workEnd = addISO(forecast_start, effortDays);
      forecast_end = maxISO(committedEnd ?? forecast_start, workEnd)!;
      basis = 'window';
    } else if (depFinish !== null) {
      // Pure MILESTONE (no dated tasks, no own committed start): inherits its finish from
      // its latest dependency plus any own effort, so an upstream slip cascades in.
      forecast_start = depFinish;
      workEnd = addISO(depFinish, effortDays);
      forecast_end = workEnd;
      basis = 'milestone';
    }
    const forecastable = basis !== 'none';
    forecastEndOf.set(o.slug, forecast_end);

    // Slip / buffer is measured against the real committed TARGET only (a deadline).
    // No target → nothing to miss. Positive = slip; negative = days of buffer/runway.
    const slipDays = targetRaw !== null && workEnd !== null ? diffDays(targetRaw, workEnd) : 0;
    const slipping = forecastable && targetRaw !== null && slipDays > 0;
    // Diamond marker: the committed target (falls back to the lone committed date).
    const target = targetRaw ?? committedEnd;
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
      basis,
    });
  }
  return out;
}
