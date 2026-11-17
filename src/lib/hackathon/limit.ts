/**
 * The run's limit (plan C3): the end time plus at most a share of the account's weekly usage,
 * and a pause when the 5-hour window passes the guard. Never money: no amount appears anywhere.
 *
 * Usage is read from the account's own percent readings (`readUsageLimits`, read-only). An empty
 * reading, including another account signed in, is "no reading": the limit is the end time only.
 */
import type { UsageLimitsResponse } from '../claude-usage.js';
import type { LimitDesign } from './designer.js';
import type { UsageReading } from './run-store.js';

export const SINCE_LABEL = 'başladığından beri, senin işin dahil';
export const ONLY_TIME = 'yalnız süre';

export function readingOf(u: UsageLimitsResponse, at: number = Date.now()): UsageReading | null {
  const weekly = u.limits.find((l) => l.key === 'weekly' && !l.scope) ?? u.limits.find((l) => l.key === 'weekly');
  const session = u.limits.find((l) => l.key === 'session');
  if (!weekly && !session) return null;
  return {
    weeklyPercent: weekly ? weekly.percent : null,
    weeklyResetsAt: weekly ? weekly.resetsAt : null,
    sessionPercent: session ? session.percent : null,
    sessionResetsAt: session ? session.resetsAt : null,
    ...(u.noSessionWindow ? { noSessionWindow: true } : {}),
    at,
  };
}

/**
 * Weekly share points used since `start`. Across a weekly reset (`resetsAt` moved on) the climb
 * seen before the reset (`lastBeforeReset - start`, the conductor keeps the last reading) is
 * added to the new window's percent.
 */
export function shareUsed(start: UsageReading | null | undefined, now: UsageReading | null, lastBeforeReset?: number | null): number | null {
  if (!start || !now || start.weeklyPercent == null || now.weeklyPercent == null) return null;
  const reset = start.weeklyResetsAt != null && now.weeklyResetsAt != null && now.weeklyResetsAt > start.weeklyResetsAt + 60_000;
  if (!reset) return Math.max(0, now.weeklyPercent - start.weeklyPercent);
  const before = Math.max(0, (lastBeforeReset ?? start.weeklyPercent) - start.weeklyPercent);
  return before + now.weeklyPercent;
}

export interface LimitVerdict {
  /** A new round may start. */
  newRound: boolean;
  /** A new team turn may start. */
  newTurn: boolean;
  /** The strip's reason line, or null when nothing holds the run. */
  reason: string | null;
  /** What the strip shows about the reading. */
  reading: 'ok' | 'no-reading' | 'no-session-window';
  used: number | null;
}

export function judgeLimit(input: {
  limit: LimitDesign;
  start: UsageReading | null | undefined;
  now: UsageReading | null;
  lastBeforeReset?: number | null;
  at?: number;
  guardOverride?: boolean;
}): LimitVerdict {
  const at = input.at ?? Date.now();
  const pastEnd = at >= Date.parse(input.limit.endsAt);
  const used = shareUsed(input.start, input.now, input.lastBeforeReset);
  const reading: LimitVerdict['reading'] = used == null ? 'no-reading' : input.now?.noSessionWindow ? 'no-session-window' : 'ok';
  if (pastEnd) return { newRound: false, newTurn: true, reason: 'bitiş saati geldi: yeni tur yok, sunumlar başlar', reading, used };
  if (used != null && used >= input.limit.weeklyShareCeiling) {
    return { newRound: false, newTurn: true, reason: `haftalık payın %${input.limit.weeklyShareCeiling}'i doldu: yeni tur yok, bu tur süresinde biter`, reading, used };
  }
  const sess = input.now?.sessionPercent;
  if (!input.guardOverride && sess != null && !input.now?.noSessionWindow && sess >= input.limit.sessionGuard) {
    return { newRound: true, newTurn: false, reason: `5 saatlik pencere %${Math.round(sess)}: ekipler bu turdan sonra bekliyor (Devam ile sürer)`, reading, used };
  }
  return { newRound: true, newTurn: true, reason: null, reading, used };
}

/** The strip's reading label. */
export function readingLabel(v: Pick<LimitVerdict, 'reading' | 'used'>, ceiling: number): string {
  if (v.reading === 'no-reading') return `kullanım okunamadı: ${ONLY_TIME}`;
  const share = `haftalık pay %${(v.used ?? 0).toFixed(1)} / %${ceiling} (${SINCE_LABEL})`;
  return v.reading === 'no-session-window' ? `${share}; 5 saatlik pencere yok` : share;
}
