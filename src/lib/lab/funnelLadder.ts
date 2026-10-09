import type { FunnelBenchmark, FunnelLadder, FunnelLadderStage, FunnelSet, FunnelWeek } from './types.js';

/**
 * The benchmark ladder: per-stage inputs a funnel set carries (a book value
 * and weekly history) turned into hybrid bands by the engine, never typed by
 * hand.
 *
 *   floor  = max(book floor,  own p25)
 *   target = max(book target, own p75)
 *
 * "Own" is the level's own percentile over its usable weeks: weeks that start
 * before the window the band judges (a band never includes the window it
 * judges), with enough users, the newest `max_weeks` of them. A level needs
 * `min_weeks` usable weeks before it has an own percentile. Each derived bound
 * records which input won (`floor_from` / `target_from`) and how many weeks
 * stood behind the percentile, so the screen can say "floor: book, target:
 * own p75, 8 weeks" instead of a bare number.
 *
 * Levels: the whole set (its `weekly` history) and each funnel (its own).
 * The set level emits a band when it has a book value or its own percentiles;
 * a funnel emits one only with its own percentiles, otherwise it inherits the
 * set's band (the frame says so per metric). Paths never get ladder bands:
 * they inherit from their funnel, then the set. Higher is better only:
 * a lower-is-better metric keeps an explicit `benchmarks` entry with
 * `better: 'lower'`, as before. An explicit benchmark at a level always wins
 * over the ladder there, with a notice.
 *
 * Pure: no fs, no fetch.
 */

export const LADDER_DEFAULTS = { minWeeks: 4, minWeekUsers: 300, maxWeeks: 12 } as const;

/** A ladder with its defaults applied. */
export interface ResolvedLadder {
  stages: FunnelLadderStage[];
  minWeeks: number;
  minWeekUsers: number;
  maxWeeks: number;
}

export function resolveLadder(ladder: FunnelLadder): ResolvedLadder {
  return {
    stages: ladder.stages,
    minWeeks: ladder.min_weeks ?? LADDER_DEFAULTS.minWeeks,
    minWeekUsers: ladder.min_week_users ?? LADDER_DEFAULTS.minWeekUsers,
    maxWeeks: ladder.max_weeks ?? LADDER_DEFAULTS.maxWeeks,
  };
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** The q-quantile (0..1) of ascending `sorted` values by linear interpolation, rounded to 4 decimals. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return round4(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

/**
 * The values of `metric` over the usable weeks, oldest first: a repeated week
 * keeps its later entry; a week counts only when it starts before `beforeISO`
 * (when given), has at least `minWeekUsers` users and a finite value; the
 * newest `maxWeeks` are kept.
 */
export function usableWeeks(
  weeks: readonly FunnelWeek[],
  metric: string,
  resolved: Pick<ResolvedLadder, 'minWeekUsers' | 'maxWeeks'>,
  beforeISO: string | null,
): number[] {
  const byWeek = new Map<string, FunnelWeek>();
  for (const w of weeks) byWeek.set(w.t, w);
  const kept = [...byWeek.values()]
    .filter((w) => (beforeISO === null || w.t < beforeISO)
      && w.users >= resolved.minWeekUsers
      && typeof w.m[metric] === 'number' && Number.isFinite(w.m[metric] as number))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return kept.slice(Math.max(0, kept.length - resolved.maxWeeks)).map((w) => w.m[metric] as number);
}

/** The tighter of a book value and an own percentile (the max); a tie goes to the book. */
export function pickBound(book: number | undefined, own: number | null): { v: number; from: 'book' | 'own' } | null {
  const hasBook = typeof book === 'number' && Number.isFinite(book);
  const hasOwn = own !== null && Number.isFinite(own);
  if (!hasBook && !hasOwn) return null;
  if (!hasOwn) return { v: book as number, from: 'book' };
  if (!hasBook) return { v: own as number, from: 'own' };
  return (own as number) > (book as number) ? { v: own as number, from: 'own' } : { v: book as number, from: 'book' };
}

/**
 * One stage's band at one level. `values` are the level's usable weekly
 * values (null when the level has no history). The set level emits a band
 * from a book value alone; a funnel level only from its own percentiles.
 */
export function ladderBand(
  stage: FunnelLadderStage,
  values: readonly number[] | null,
  resolved: Pick<ResolvedLadder, 'minWeeks'>,
  isSetLevel: boolean,
): FunnelBenchmark | null {
  const own = values !== null && values.length >= resolved.minWeeks ? [...values].sort((a, b) => a - b) : null;
  if (!own && !isSetLevel) return null;
  const floor = pickBound(stage.book_floor, own ? percentile(own, 0.25) : null);
  const target = pickBound(stage.book_target, own ? percentile(own, 0.75) : null);
  if (!floor && !target) return null;
  const band: FunnelBenchmark = { better: 'higher' };
  if (floor) {
    band.floor = floor.v;
    band.floor_from = floor.from;
    if (floor.from === 'book' && stage.book_source) band.floor_source = stage.book_source;
  }
  if (target) {
    band.target = target.v;
    band.target_from = target.from;
    if (target.from === 'book' && stage.book_source) band.target_source = stage.book_source;
  }
  if (own) band.weeks = own.length;
  return band;
}

/** The weekly inputs a parse collected (they are never stored on the set). */
export interface LadderWeekly {
  set?: FunnelWeek[];
  funnels: Map<string, FunnelWeek[]>;
}

/**
 * Fill `set.benchmarks` and each funnel's `benchmarks` for the ladder's
 * metrics (mutates `set`). An explicit benchmark already at a level wins
 * there, with a notice. Weeks at or after `set.window.from` never count.
 */
export function deriveLadderBands(set: FunnelSet, weekly: LadderWeekly, notices: string[]): void {
  if (!set.ladder || set.ladder.stages.length === 0) return;
  const resolved = resolveLadder(set.ladder);
  const before = set.window?.from ?? null;

  const apply = (
    target: Record<string, FunnelBenchmark>,
    weeks: FunnelWeek[] | undefined,
    isSetLevel: boolean,
    level: string,
  ): void => {
    for (const stage of resolved.stages) {
      const values = weeks ? usableWeeks(weeks, stage.metric, resolved, before) : null;
      const band = ladderBand(stage, values, resolved, isSetLevel);
      if (!band) continue;
      if (target[stage.metric]) {
        notices.push(`explicit benchmark "${stage.metric}" at ${level} overrides the ladder.`);
        continue;
      }
      target[stage.metric] = band;
    }
  };

  const setBands: Record<string, FunnelBenchmark> = { ...(set.benchmarks ?? {}) };
  apply(setBands, weekly.set, true, 'set');
  if (Object.keys(setBands).length > 0) set.benchmarks = setBands;

  for (const funnel of set.funnels) {
    const weeks = weekly.funnels.get(funnel.id);
    if (!weeks) continue;
    const own: Record<string, FunnelBenchmark> = { ...(funnel.benchmarks ?? {}) };
    apply(own, weeks, false, `funnel ${funnel.id}`);
    if (Object.keys(own).length > 0) funnel.benchmarks = own;
  }
}
