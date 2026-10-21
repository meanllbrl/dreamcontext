/**
 * What a small tile can say about a task without opening it (owner 2026-10-20: "kart küçük olsa
 * bile kartlar gösterilmeli"): how far its acceptance criteria are, how many are open, and the
 * next one. Pure: read from the task's own `acceptance_criteria` markdown, the list the task page
 * already has in the window (0 requests of its own).
 */

const BOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+)$/;

export interface CriteriaProgress {
  done: number;
  total: number;
  /** The first open criterion, as plain text (markdown marks dropped); null when none is open. */
  next: string | null;
}

/** A criterion's text for one line: no bold/italic/code marks, links read as their text. */
export function plainCriterion(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function criteriaProgress(md: string | null | undefined): CriteriaProgress {
  let done = 0;
  let total = 0;
  let next: string | null = null;
  for (const line of (md ?? '').split('\n')) {
    const m = BOX.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== ' ') done += 1;
    else if (next === null) next = plainCriterion(m[2]) || null;
  }
  return { done, total, next };
}

/**
 * What a small tile can say about a Lab insight without opening it (owner 2026-10-21: the tile was
 * the last point of the first series and a red change from the one before, which for a funnel is
 * the last step and a drop nobody asked for). Pure: read from the insight's cached detail, the
 * one the large card reads (0 requests of its own).
 *
 *  - a funnel reads as a funnel: the share of the top that reaches the last step, the two counts
 *    behind it, and one bar per step (its silhouette);
 *  - anything with a series of two or more points is the latest figure, its change from the point
 *    before and the trend (the last 24 points);
 *  - one figure and no series is the figure alone; nothing at all is `empty`.
 *
 * `fresh` is the dot's word: a failed sync, never synced, stale, or up to date. "Stale" is the
 * server's own verdict (`stale` on the insight's summary, which counts from the newer of the last
 * fetch and the last "upstream unchanged" check, as the Lab board does), never re-derived here.
 * An unmeasured funnel step is not a zero: it is left out, as the Lab card leaves it out, and a
 * funnel never falls back to a trend (its series is the steps, so a "change" would be a drop).
 */
export type InsightFresh = 'fresh' | 'stale' | 'failed' | 'never';

export interface InsightTileView {
  shape: 'funnel' | 'trend' | 'figure' | 'empty';
  fresh: InsightFresh;
  unit: string | null;
  /** The figure: the latest value, or for a funnel the last step's share of the top (0..100). */
  value: number | null;
  /** Trend only: the change from the previous point. */
  delta: number | null;
  /** Trend only: the last points, oldest first. */
  points: { t: string; v: number }[];
  /** Funnel only: users at the top and at the last step. */
  top: number | null;
  last: number | null;
  /** Funnel only: each step's share of the top (0..1), at most `MAX_LANE` of them. */
  lane: number[];
}

export const MAX_LANE = 24;
const MAX_TREND = 24;

interface InsightDetailLike {
  insight: { render: string; unit?: string | null };
  cache: {
    latest?: number | null;
    fetchedAt?: string | null;
    error?: string | null;
    unit?: string | null;
    series?: readonly { points: readonly { t: string; v: number }[] }[];
    funnel?: { set?: { funnels?: readonly { id: string; steps: readonly { users: number; measured?: boolean }[] }[] } };
  } | null;
}

/** Steps squeezed to at most `MAX_LANE` bars; each bar is the LOWEST of its run, so a drop never vanishes. */
function laneOf(users: readonly number[]): number[] {
  const top = users[0];
  if (!(top > 0)) return [];
  const shares = users.map((u) => Math.max(0, Math.min(1, u / top)));
  if (shares.length <= MAX_LANE) return shares;
  const out: number[] = [];
  for (let i = 0; i < MAX_LANE; i += 1) {
    const from = Math.floor((i * shares.length) / MAX_LANE);
    const to = Math.max(from + 1, Math.floor(((i + 1) * shares.length) / MAX_LANE));
    out.push(Math.min(...shares.slice(from, to)));
  }
  return out;
}

export function insightTile(detail: InsightDetailLike | null | undefined, stale: boolean | null | undefined = false): InsightTileView | null {
  if (!detail) return null;
  const cache = detail.cache;
  const unit = cache?.unit ?? detail.insight.unit ?? null;
  const fresh: InsightFresh = cache?.error ? 'failed'
    : !Number.isFinite(cache?.fetchedAt ? Date.parse(cache.fetchedAt) : NaN) ? 'never'
      : stale ? 'stale' : 'fresh';
  const base: Omit<InsightTileView, 'shape' | 'value'> = { fresh, unit, delta: null, points: [], top: null, last: null, lane: [] };
  const series = cache?.series?.[0]?.points ?? [];

  if (detail.insight.render === 'funnel') {
    // The first funnel of the set (what the engine's own headline reads); `set.primary` names a metric.
    const funnel = cache?.funnel?.set?.funnels?.[0];
    const measured = funnel ? funnel.steps.filter((s) => s.measured !== false) : [];
    const users = measured.length > 0 ? measured.map((s) => s.users) : funnel ? [] : series.map((p) => p.v);
    const lane = laneOf(users);
    if (lane.length > 0) {
      return { ...base, shape: 'funnel', value: users.length > 1 ? (users[users.length - 1] / users[0]) * 100 : 100, top: users[0], last: users[users.length - 1], lane };
    }
    return { ...base, shape: 'empty', value: null };
  }
  if (series.length >= 2) {
    const latest = cache?.latest ?? series[series.length - 1].v;
    return { ...base, shape: 'trend', value: latest, delta: latest - series[series.length - 2].v, points: series.slice(-MAX_TREND).map((p) => ({ t: p.t, v: p.v })) };
  }
  const latest = cache?.latest ?? series[series.length - 1]?.v ?? null;
  return { ...base, shape: latest === null ? 'empty' : 'figure', value: latest };
}
