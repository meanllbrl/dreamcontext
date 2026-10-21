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
 * `fresh` is the dot's word: a failed sync, never synced, older than twice its refresh window, or
 * up to date.
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
  insight: { render: string; unit?: string | null; refresh?: { ttl_minutes?: number | null } };
  cache: {
    latest?: number | null;
    fetchedAt?: string | null;
    error?: string | null;
    unit?: string | null;
    series?: readonly { points: readonly { t: string; v: number }[] }[];
    funnel?: { set?: { primary?: string; funnels?: readonly { id: string; steps: readonly { users: number }[] }[] } };
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

export function insightTile(detail: InsightDetailLike | null | undefined, now: number = Date.now()): InsightTileView | null {
  if (!detail) return null;
  const cache = detail.cache;
  const unit = cache?.unit ?? detail.insight.unit ?? null;
  const fetched = cache?.fetchedAt ? Date.parse(cache.fetchedAt) : NaN;
  const ttl = detail.insight.refresh?.ttl_minutes;
  const fresh: InsightFresh = cache?.error ? 'failed'
    : !Number.isFinite(fetched) ? 'never'
      : typeof ttl === 'number' && ttl > 0 && now - fetched > 2 * ttl * 60_000 ? 'stale' : 'fresh';
  const base: Omit<InsightTileView, 'shape' | 'value'> = { fresh, unit, delta: null, points: [], top: null, last: null, lane: [] };
  const series = cache?.series?.[0]?.points ?? [];

  if (detail.insight.render === 'funnel') {
    const set = cache?.funnel?.set;
    const funnel = set ? (set.primary ? set.funnels?.find((f) => f.id === set.primary) : undefined) ?? set.funnels?.[0] : undefined;
    const users = funnel && funnel.steps.length > 0 ? funnel.steps.map((s) => s.users) : series.map((p) => p.v);
    const lane = laneOf(users);
    if (lane.length > 0) {
      return { ...base, shape: 'funnel', value: users.length > 1 ? (users[users.length - 1] / users[0]) * 100 : 100, top: users[0], last: users[users.length - 1], lane };
    }
  }
  if (series.length >= 2) {
    const latest = cache?.latest ?? series[series.length - 1].v;
    return { ...base, shape: 'trend', value: latest, delta: latest - series[series.length - 2].v, points: series.slice(-MAX_TREND).map((p) => ({ t: p.t, v: p.v })) };
  }
  const latest = cache?.latest ?? series[series.length - 1]?.v ?? null;
  return { ...base, shape: latest === null ? 'empty' : 'figure', value: latest };
}
