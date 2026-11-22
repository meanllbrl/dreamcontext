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
  /** Absent: the rating's note; `c:<id>`: a correction's (W3 C17). */
  slot?: string;
}
/** W3 E13: his words an agent recorded beside his own note. */
export interface ScoreCorrection {
  id: string; note: string; quoteTurn: string; at: string;
  draft?: { state: ModelStateName; attempts: number; lastError?: string } | null;
}
export interface ScoreRating {
  stars: number; note?: string; firstAt: string; at: string; by: 'owner' | 'super' | 'session';
  quote?: string; title: string; runAt: string; status: string;
  project: { key: string; vault: string; name: string };
  draft?: { state: ModelStateName; attempts: number; lastError?: string } | null;
  /** W3 E5: where his rating came from; only Telegram is shown. */
  via?: 'mac' | 'telegram' | 'super';
  /** W3 E12: the Super's reading of his words, never his own number. */
  judged?: true;
  /** W3 E9: a job the main Super handed the member. */
  viaSuper?: true;
  corrections?: ScoreCorrection[];
}
export interface ScoreCriterion { id: string; text: string; at: string; removedAt?: string }
export interface ScoreRun {
  key: string; runKey: string; title: string; startedAt: string; lastAt: string; status: string | null;
  rating: ScoreRating | null; check: ScoreCheck | null; lessons: ScoreLesson[];
  /** W3 E2: the run's request state now (`open` draws the chat row; past its window `none`). */
  ask?: AskState;
  /** W3 E9: a rated job of the main Super, from its snapshot. */
  viaSuper?: true;
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
  /** W3 C9: runs that ask to be rated right now ("N to rate"), counted on the server. */
  toRate?: number;
  /** The card's run-key prefix: '' for a project member, `<projectKey>/` for a global one. */
  prefix?: string;
}

// ─── Rating requests (W3 E2): MIRROR of src/lib/agents/scorecard.ts, held equal by a drift test ──

/** A run asks to be rated for 72 hours from its end. */
export const RATE_ASK_TTL_MS = 72 * 3_600_000;

export type AskState = 'open' | 'rated' | 'none';

/** THE rule every request surface reads (MIRROR of `askState` in src/lib/agents/scorecard.ts). */
export function askState(facts: { eligible: boolean; endedAt: string } | null | undefined, rating: unknown, nowMs: number): AskState {
  if (rating) return 'rated';
  if (!facts || !facts.eligible) return 'none';
  const end = Date.parse(facts.endedAt);
  return Number.isFinite(end) && nowMs < end + RATE_ASK_TTL_MS ? 'open' : 'none';
}

/** The card's key for a chat run (`<source>::<runId>`): a global member's carry its project prefix. */
export function ratingKeyOf(sessionKey: string, prefix: string | undefined): string {
  return `${prefix ?? ''}${sessionKey}`;
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

/** "3 of 3 checks met", counted on judged lines only: a line left unset (his tap) is in neither number. */
export function checksMet(c: ScoreCheck | null): { met: number; total: number } | null {
  if (!c || c.state !== 'done') return null;
  const known = c.verdicts.filter((v) => v.met !== null);
  if (known.length === 0) return null;
  return { met: known.filter((v) => v.met === true).length, total: known.length };
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
