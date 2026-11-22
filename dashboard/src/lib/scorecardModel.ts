/**
 * The member Scorecard's pure math (plan uye-karnesi D1, D17, D18): the shapes the scorecard route
 * returns, the bar tones, the trend word, the goal's direction and change, and a run's goal move.
 * No React, so the card and its tests share one truth.
 */

export type ModelStateName = 'running' | 'done' | 'failed' | 'no_text';

export interface ScoreVerdict { id: string; text: string; met: boolean | null; why?: string; by: 'model' | 'owner' }
export interface ScoreCheck { state: ModelStateName; attempts: number; lastError?: string; at: string; verdicts: ScoreVerdict[]; costUsd: number }
export interface ScoreLesson {
  id: string; text: string; run: string; noteFold: string; at: string;
  status: 'active' | 'held' | 'undone' | 'replaced'; flags?: string[];
}
export interface ScoreRating {
  stars: number; note?: string; firstAt: string; at: string; by: 'owner' | 'super' | 'session';
  quote?: string; title: string; runAt: string; status: string;
  project: { key: string; vault: string; name: string };
  draft?: { state: ModelStateName; attempts: number; lastError?: string } | null;
}
export interface ScoreCriterion { id: string; text: string; at: string; removedAt?: string }
export interface ScoreRun {
  key: string; runKey: string; title: string; startedAt: string; lastAt: string; status: string | null;
  rating: ScoreRating | null; check: ScoreCheck | null; lessons: ScoreLesson[];
}
export interface ScorePoint { t: string; v: number }
export interface ScoreGoal {
  insight: string; project: { key: string; vault: string; name: string }; here: boolean;
  baseline?: number; target?: number; linkedAt?: string; gone?: boolean;
  title?: string; latest?: number; unit?: string | null; points?: ScorePoint[];
}
export interface ScorecardData {
  card: { criteria: ScoreCriterion[]; ratings: Record<string, ScoreRating>; checks: Record<string, ScoreCheck>; lessons: ScoreLesson[] };
  runs: ScoreRun[];
  nextBefore: string | null;
  trend: { average: number | null; before: number | null; bars: number[]; count: number };
  ownerBlockChars: number;
  blockWarnChars: number;
  goal: ScoreGoal | null;
  candidates: Array<{ slug: string; title: string; latest: number; unit: string | null }>;
  phone: boolean;
  damaged?: string;
}

/** Bars: 2 stars or less low (danger), 3 mid (muted), 4 or more high (accent). */
export function barTone(stars: number): 'low' | 'mid' | 'high' {
  return stars <= 2 ? 'low' : stars === 3 ? 'mid' : 'high';
}

/** "Up from X two weeks ago", or down, or same; null when there is no earlier set. */
export function trendWord(average: number | null, before: number | null): 'up' | 'down' | 'same' | null {
  if (average === null || before === null) return null;
  return average > before ? 'up' : average < before ? 'down' : 'same';
}

export const TERMINAL = new Set(['ok', 'failed', 'stopped', 'skipped']);

/** A finished run with no rating (the tile's "N to rate"). */
export function unratedCount(runs: readonly ScoreRun[]): number {
  return runs.filter((r) => !r.rating && r.status !== null && TERMINAL.has(r.status)).length;
}

/** The newest finished run: the one the empty tile offers to rate. */
export function latestRateable(runs: readonly ScoreRun[]): ScoreRun | null {
  return runs.find((r) => r.status !== null && TERMINAL.has(r.status)) ?? null;
}

/** Target below baseline: lower is better. */
export function lowerIsBetter(g: Pick<ScoreGoal, 'baseline' | 'target'>): boolean {
  return typeof g.baseline === 'number' && typeof g.target === 'number' && g.target < g.baseline;
}

/** The change against the baseline: in % (or the absolute change when the baseline is 0), and whether it is good. */
export function goalChange(g: ScoreGoal): { pct: number | null; abs: number; good: boolean } | null {
  if (typeof g.latest !== 'number' || typeof g.baseline !== 'number') return null;
  const abs = g.latest - g.baseline;
  const pct = g.baseline === 0 ? null : (abs / Math.abs(g.baseline)) * 100;
  return { pct, abs, good: lowerIsBetter(g) ? abs <= 0 : abs >= 0 };
}

/** A run's local calendar day, `YYYY-MM-DD`. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The goal's move across one run (D18): the value at the first daily point dated after the run's
 * local day, minus the value at the last point on or before it. Only for daily `YYYY-MM-DD`
 * points, and only when both exist. Never claims cause: the card says "goal ▼ $0.90".
 */
export function goalMoveForRun(points: readonly ScorePoint[], runAt: string, lowerBetter: boolean): { delta: number; good: boolean } | null {
  const day = localDay(runAt);
  if (!day) return null;
  const daily = points.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.t) && Number.isFinite(p.v)).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (daily.length !== points.length) return null;
  let before: ScorePoint | null = null;
  let after: ScorePoint | null = null;
  for (const p of daily) {
    if (p.t <= day) before = p;
    else if (!after) after = p;
  }
  if (!before || !after) return null;
  const delta = after.v - before.v;
  return { delta, good: lowerBetter ? delta <= 0 : delta >= 0 };
}

/** "3 of 3 checks met", counted on known verdicts only. */
export function checksMet(c: ScoreCheck | null): { met: number; total: number } | null {
  if (!c || c.state !== 'done') return null;
  const known = c.verdicts.filter((v) => v.met !== null);
  return { met: known.filter((v) => v.met === true).length, total: c.verdicts.length };
}

/** A tapped verdict chip cycles met, not met, unset (D14). */
export function nextVerdict(met: boolean | null): boolean | null {
  return met === true ? false : met === false ? null : true;
}

/** A number as the insight shows it: its unit (a leading currency sign) and at most two decimals. */
export function formatValue(v: number, unit: string | null | undefined): string {
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : String(Math.round(v * 100) / 100);
  if (!unit) return n;
  return /^[$€£₺¥]$/.test(unit) ? `${v < 0 ? '-' : ''}${unit}${n.replace('-', '')}` : `${n} ${unit}`;
}
