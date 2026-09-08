import { USAGE_CACHE_MAX_AGE_MS, weeklyBindsOnScoped, type UsageLimitWire, type UsageLimitsResponse } from './claude-usage.js';

/**
 * The CLI's LIVE answer to `/usage`, parsed out of the report it prints.
 *
 * ── Why this exists: the cache cannot be the primary source ───────────────────────────
 * `claude -p "/usage" --output-format json` was originally trusted to REFRESH
 * `<configDir>/.claude.json`'s `cachedUsageUtilization`, and the probe treated a moved
 * `fetchedAtMs` as its success criterion. MEASURED 2026-09-07 on CLI 2.1.259, that criterion
 * is wrong most of the time, and the CLI's own bundle says why — its writer is:
 *
 *     let age = cache && cache.accountUuid === uuid ? Date.now() - cache.fetchedAtMs : Infinity;
 *     if (age >= 0 && age < 300000) return;              // Uso = 300000
 *
 * A WRITE THROTTLE of 5 minutes. So an account whose cache was written in the last 5 minutes
 * — which is EVERY account with a live session, and every account probed twice in a row —
 * answers `/usage` with fresh numbers on stdout and deliberately leaves the file alone. The
 * probe read that as "no numbers came back", every account degraded to `healthy-unmeasured`,
 * Settings drew "not measured", and auto-switch fell through to a last-resort pick in
 * register order while real percentages sat unread in the caches beside it.
 *
 * Reproduced both ways on the same account minutes apart: with a 3-minute-old cache the file
 * did not move (exit 0, `num_turns: 0`, `total_cost_usd: 0`, ~4.1s); with `fetchedAtMs`
 * backdated 6 hours the very same command rewrote it. Nothing about the account changed —
 * only the age of the file.
 *
 * The report on stdout is throttled by nothing. It is the reading; the cache is the fallback.
 *
 * ── The shape being parsed (verbatim, CLI 2.1.259) ────────────────────────────────────
 *     You are currently using your subscription to power your Claude Code usage
 *
 *     Current session: 2% used · resets Sep 7 at 4:39pm (Europe/Istanbul)
 *     Current week (all models): 0% used · resets Sep 9 at 2:59am (Europe/Istanbul)
 *     Current week (Fable): 0% used · resets Sep 9 at 2:59am (Europe/Istanbul)
 *
 *     What's contributing to your limits usage?
 *     ...
 *
 * Only those three lines are read. Everything below them is behaviour commentary — request
 * counts, top skills, top MCP servers — and a 2026-09-05 note in this codebase mistook that
 * tail for the WHOLE report and concluded such accounts "publish no percentages at all".
 * They do; the percentages are the first three lines.
 *
 * ── Totality ──────────────────────────────────────────────────────────────────────────
 * Never throws. Every step is a regex or a `Number.isFinite` narrowing, and the one call that
 * can throw on bad input (`Intl.DateTimeFormat` with an unknown zone) is caught at its own
 * site. A line that does not match yields an ABSENT window, never a zeroed one.
 */

/** A percentage the report can be believed about: finite, inside [0,100]. Out of range DROPS
 *  the window — a clamped "100%" would claim an exhausted account where the truth is that the
 *  format changed under us. */
function asPercent(v: number): number | null {
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A named zone's offset from UTC at `at`, in ms, or null when the zone is not resolvable.
 *
 * `longOffset` renders as `GMT+03:00` (and bare `GMT` at zero), which is why it is preferred
 * over `short` — `shortOffset` can render civil abbreviations that carry no arithmetic.
 */
function zoneOffsetMs(at: number, timeZone: string): number | null {
  let name = '';
  try {
    name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return null;                                  // an unknown zone — the caller falls back
  }
  if (/^GMT$|^UTC$/i.test(name.trim())) return 0;
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/i.exec(name);
  if (!m) return null;
  const hours = Number(m[2]);
  const mins = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + mins) * 60_000;
}

/**
 * A wall-clock reading in `timeZone` → epoch ms. `timeZone` empty/unresolvable means the
 * host's own zone, which is what the CLI prints in practice anyway.
 *
 * The offset is applied TWICE because the offset itself depends on the instant: the first
 * pass converts using the offset at the naive UTC guess, the second re-reads it at the
 * corrected instant, which settles the hour on either side of a DST boundary.
 */
function epochFromWallClock(
  year: number, monthIdx: number, day: number, hour: number, minute: number, timeZone: string,
): number | null {
  if (!timeZone) {
    const local = new Date(year, monthIdx, day, hour, minute, 0, 0).getTime();
    return Number.isFinite(local) ? local : null;
  }
  const naive = Date.UTC(year, monthIdx, day, hour, minute);
  let at = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const off = zoneOffsetMs(at, timeZone);
    if (off === null) return epochFromWallClock(year, monthIdx, day, hour, minute, '');
    at = naive - off;
  }
  return Number.isFinite(at) ? at : null;
}

/** A reset further from now than this is not a reset — it is a misparse. Windows are 5 hours
 *  and 7 days; the widest honest gap is a week plus a timezone, so a month is generous. */
const RESET_SANITY_MS = 40 * 24 * 60 * 60_000;

/**
 * `resets Sep 7 at 4:39pm (Europe/Istanbul)` → epoch ms, or null when the tail does not match.
 *
 * THE MINUTES GO MISSING ON THE HOUR. Measured on three accounts the same minute:
 * `resets Sep 7 at 2:30pm`, but `resets Sep 7 at 11pm` and `resets Sep 9 at 3am` — the CLI
 * drops `:00`. A parser that demands `H:MM` loses the reset on exactly the windows whose
 * reset is a round hour, which is most weekly windows. So `:MM` is optional and absent means
 * zero. `am`/`pm` is optional too, for a 24-hour locale; without it the hour is read as-is.
 *
 * THE YEAR IS NOT PRINTED, so it is inferred: of the three candidate years around `now`, the
 * one whose instant lands nearest to `now` wins. A reset is always within days of now, so
 * only a December→January report is actually ambiguous, and that is exactly the case this
 * resolves. A percent whose reset cannot be parsed is still a percent — the caller keeps it.
 */
export function parseResetAt(tail: string, now: number): number | null {
  const m = /([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?/i.exec(tail);
  if (!m) return null;
  const monthIdx = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  if (monthIdx < 0) return null;
  const day = Number(m[2]);
  const clock = Number(m[4]);
  const minute = m[5] ? Number(m[5]) : 0;
  const meridiem = m[6]?.toLowerCase() ?? '';
  if (day < 1 || day > 31 || minute > 59) return null;
  if (meridiem ? clock < 1 || clock > 12 : clock > 23) return null;
  const hour = meridiem ? (clock % 12) + (meridiem === 'p' ? 12 : 0) : clock;
  const zone = /\(([A-Za-z]+(?:\/[A-Za-z_+-]+)+|UTC|GMT)\)/.exec(tail)?.[1] ?? '';

  const thisYear = new Date(now).getFullYear();
  const years = m[3] ? [Number(m[3])] : [thisYear - 1, thisYear, thisYear + 1];
  let best: number | null = null;
  for (const year of years) {
    const at = epochFromWallClock(year, monthIdx, day, hour, minute, zone);
    if (at === null) continue;
    if (best === null || Math.abs(at - now) < Math.abs(best - now)) best = at;
  }
  if (best === null || Math.abs(best - now) > RESET_SANITY_MS) return null;
  return best;
}

/** One window as the report states it, before the binding-cap rule runs. */
interface ReportWindow { percent: number; resetsAt: number | null; scope?: string }

/**
 * Parse the report. Returns null when NOT ONE window could be read — the caller must then
 * fall back to the cache rather than treat an unreadable report as an empty account.
 *
 * `fetchedAtMs` is `now`: unlike the cache's stamp, this reading was taken by the process that
 * is returning it, so its age is zero by construction and the surfaces that label staleness
 * label it correctly.
 */
export function parseUsageReport(text: string, now: number = Date.now()): UsageLimitsResponse | null {
  if (typeof text !== 'string' || !text) return null;

  let session: ReportWindow | null = null;
  let weeklyAll: ReportWindow | null = null;
  let weeklyScoped: ReportWindow | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // `Current session:` / `Current week (all models):` / `Current week (Fable):`
    const m = /^current\s+(session|week)\s*(?:\(([^)]*)\))?\s*:\s*([\d.]+)\s*%/i.exec(line);
    if (!m) continue;
    const percent = asPercent(Number(m[3]));
    if (percent === null) continue;
    const resetsAt = parseResetAt(line, now);
    const label = (m[2] ?? '').trim();

    if (m[1]!.toLowerCase() === 'session') {
      session ??= { percent, resetsAt };
      continue;
    }
    // "all models" is the account-wide week; anything else names the model whose cap it is.
    if (!label || /^all\b/i.test(label)) weeklyAll ??= { percent, resetsAt };
    else weeklyScoped ??= { percent, resetsAt, scope: label };
  }

  // Same BINDING-CAP rule the cache reader applies, from the same helper: one weekly bar, and
  // it is whichever cap the user hits FIRST.
  const weekly = weeklyBindsOnScoped(weeklyAll?.percent ?? null, weeklyScoped?.percent ?? null)
    ? weeklyScoped
    : weeklyAll;

  const limits: UsageLimitWire[] = [];
  if (session) limits.push(toWire('session', session));
  if (weekly) limits.push(toWire('weekly', weekly));
  return limits.length > 0 ? { limits, fetchedAtMs: now } : null;
}

/**
 * Built field by field, never spread — the same rule `claude-usage.ts` follows, for the same
 * reason: this shape crosses to the client.
 *
 * `resetsAt` is 0 when the line carried no parseable reset. A percent is worth reporting
 * without one — dropping a MEASURED number because a DATE did not parse is how an account
 * becomes unmeasurable, which is the whole bug this file exists to end. Surfaces already
 * treat a non-future reset as "no reset to show" and keep the bar.
 */
function toWire(key: UsageLimitWire['key'], w: ReportWindow): UsageLimitWire {
  const wire: UsageLimitWire = { key, percent: w.percent, resetsAt: w.resetsAt ?? 0 };
  if (w.scope) wire.scope = w.scope;
  return wire;
}

/**
 * Carry `lockedReason` from a CACHED reading onto a LIVE one, per window.
 *
 * The report states percentages; only the cache carries `locked_reason`, and a lock is the one
 * fact that outranks a percentage (`chooseAccount` refuses a locked account whatever the number
 * beside it says). A lock does not lapse inside an hour without the window resetting, so the
 * cache's own read TTL is the honest ceiling for borrowing it: past
 * {@link USAGE_CACHE_MAX_AGE_MS} the CLI itself discards that cache, and so do we.
 *
 * Nothing else is borrowed — never a percent, never a reset.
 */
export function withLockedReasons(
  live: UsageLimitsResponse, cached: UsageLimitsResponse, now: number,
): UsageLimitsResponse {
  if (cached.fetchedAtMs === null || now - cached.fetchedAtMs > USAGE_CACHE_MAX_AGE_MS) return live;
  const locks = new Map(
    cached.limits.filter((l) => l.lockedReason).map((l) => [l.key, l.lockedReason!]),
  );
  if (locks.size === 0) return live;
  return {
    fetchedAtMs: live.fetchedAtMs,
    limits: live.limits.map((l) => {
      const locked = locks.get(l.key);
      return locked ? { ...l, lockedReason: locked } : l;
    }),
  };
}
