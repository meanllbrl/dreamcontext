import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code's own cached ACCOUNT usage — the 5-hour session cap and the weekly cap —
 * read from `~/.claude.json`'s `cachedUsageUtilization`.
 *
 * WHY this exists: the chat composer's usage popover draws three nested bars (context
 * window / 5-hour session / weekly). The context bar is derived from a transcript's token
 * usage (`computeSessionStats`), but the two account-level caps have no token source at
 * all — they are PERCENTAGES the CLI fetches from the API and caches here. This module is
 * the only reader of that cache.
 *
 * ── The file this points at ────────────────────────────────────────────────────────────
 * `~/.claude.json` also holds `oauthAccount`, `machineID`, `accountUuid` and spend history.
 * Two consequences are load-bearing and must not be "simplified" away:
 *
 *   1. `home` DEFAULTS to `homedir()` — which honours `$HOME`, so a verify script running
 *      under an isolated scratch HOME reads its own fixture and never the developer's real
 *      credentials. `os.userInfo().homedir` is deliberately NOT used: it ignores `$HOME`
 *      and would make a fixtured run read the real file.
 *   2. `home` is a TEST SEAM ONLY. The route handler calls `readUsageLimits()` with no
 *      argument, so no request-derived value can ever choose which file is read.
 *
 * Nothing from the blob is copied into the return value: every wire field below is built
 * field-by-field from a narrowed primitive, never spread from the parsed object. A key we
 * do not know about cannot ride out to the client.
 *
 * ── Shape notes (from the live 2026-08-23 sample) ──────────────────────────────────────
 *   • The SUMMARY keys carry their number under `utilization` — `five_hour.utilization`,
 *     `seven_day.utilization` — NOT under `percent`. Only the `limits[]` entries use
 *     `percent`. Reading the wrong one yields `undefined`, i.e. a silently missing bar.
 *   • `limits[]` is nested INSIDE `utilization`, not at the top of the cache object.
 *   • `resets_at` may be null or unparseable on either the summary or a `limits[]` entry.
 *     A window with no known reset cannot be labelled, so that entry is dropped.
 *
 * ── Totality ──────────────────────────────────────────────────────────────────────────
 * This module never throws, and it does not achieve that with a blanket `catch` around
 * everything (which would hide a programmer error as well as a bad file). The ONLY
 * throwing operation is the JSON read, which is guarded below; every step after it is
 * `typeof`/`Number.isFinite` narrowing that cannot throw. Total by construction.
 */

/** MIRRORED in `dashboard/src/lib/agentComposer.ts` (UsageLimitWire). Change one, change
 *  the other — `tests/unit/claude-usage.test.ts` asserts this shape at runtime, key by key,
 *  so a field that drifts in fails loudly instead of leaking to the client. */
export interface UsageLimitWire {
  key: 'session' | 'weekly';
  /** 0-100. The source is percent-based; there are no token counts behind these. */
  percent: number;
  /** Epoch ms when this window resets. */
  resetsAt: number;
  /** Present only when a per-model cap is the BINDING one, e.g. "Fable". */
  scope?: string;
}

/** MIRRORED in `dashboard/src/lib/agentComposer.ts` (UsageLimitsResponse). */
export interface UsageLimitsResponse {
  limits: UsageLimitWire[];
  /** When the CLI last refreshed the cache. The client labels or hides a stale reading. */
  fetchedAtMs: number | null;
}

export const EMPTY_USAGE_LIMITS: UsageLimitsResponse = { limits: [], fetchedAtMs: null };

/**
 * MIRRORED from `readJsonSafe` (src/server/routes/agent-terminal.ts:914) rather than
 * imported: `src/lib/` must not depend on `src/server/routes/`, which would invert the
 * layering (routes compose lib, never the reverse). Four lines is the right price for
 * keeping that direction one-way.
 */
function readJsonSafe(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/**
 * A percentage the source can be believed about: finite and inside [0,100].
 *
 * Out of range DROPS the entry rather than clamping. A clamped lie ("100%") is worse than
 * an absent bar: it would tell the user they are out of quota when what actually happened
 * is that the payload's shape changed under us.
 */
function asPercent(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/** `resets_at` → epoch ms, or null for absent / non-string / unparseable. */
function asResetsAt(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** One candidate bar, before it is proven complete. */
interface Candidate { percent: number | null; resetsAt: number | null; scope?: string }

/** A summary entry (`five_hour` / `seven_day`) — percent lives under `utilization`. */
function fromSummary(raw: unknown): Candidate {
  const o = asRecord(raw);
  if (!o) return { percent: null, resetsAt: null };
  return { percent: asPercent(o.utilization), resetsAt: asResetsAt(o.resets_at) };
}

/** A `limits[]` entry — percent lives under `percent`, and a scoped one names its model. */
function fromLimitEntry(raw: unknown): Candidate {
  const o = asRecord(raw);
  if (!o) return { percent: null, resetsAt: null };
  const model = asRecord(asRecord(o.scope)?.model);
  const display = typeof model?.display_name === 'string' ? model.display_name.trim() : '';
  return {
    percent: asPercent(o.percent),
    resetsAt: asResetsAt(o.resets_at),
    ...(display ? { scope: display } : {}),
  };
}

/** The first `limits[]` entry matching `kind`, as a candidate. */
function findLimit(limits: unknown[], kind: string): Candidate {
  const hit = limits.find((e) => asRecord(e)?.kind === kind);
  return hit === undefined ? { percent: null, resetsAt: null } : fromLimitEntry(hit);
}

/** A candidate is a bar only once BOTH halves are known — see `asResetsAt`'s note. */
function toWire(key: UsageLimitWire['key'], c: Candidate): UsageLimitWire | null {
  if (c.percent === null || c.resetsAt === null) return null;
  // Built field by field, never spread: this is the boundary where account data would leak.
  const wire: UsageLimitWire = { key, percent: c.percent, resetsAt: c.resetsAt };
  if (c.scope) wire.scope = c.scope;
  return wire;
}

/**
 * Read the cached account usage. Never throws; an absent file, an absent key, malformed
 * JSON, a percent outside [0,100] and an unparseable `resets_at` each yield an ABSENT bar
 * rather than a zeroed one — "show what's found, hide what isn't".
 *
 * `fetchedAtMs` is reported whenever the cache carries a finite one, independently of how
 * many bars survived: it describes when the CACHE was refreshed, not whether a particular
 * entry parsed.
 */
export function readUsageLimits(home: string = homedir()): UsageLimitsResponse {
  const blob = readJsonSafe(join(home, '.claude.json'));
  const cached = asRecord(blob?.cachedUsageUtilization);
  if (!cached) return { limits: [], fetchedAtMs: null };

  const fetchedAtMs = typeof cached.fetchedAtMs === 'number' && Number.isFinite(cached.fetchedAtMs)
    ? cached.fetchedAtMs
    : null;

  const util = asRecord(cached.utilization);
  if (!util) return { limits: [], fetchedAtMs };
  const entries = Array.isArray(util.limits) ? util.limits : [];

  // Session: the summary first, the `limits[]` entry as the fallback for a payload that
  // carries one and not the other.
  const session = pick(fromSummary(util.five_hour), () => findLimit(entries, 'session'));

  // Weekly: same fallback, then the BINDING-CAP rule.
  //
  // The account can carry two weekly numbers: `weekly_all` (every model) and
  // `weekly_scoped` (one model). In the observed sample they sit three points apart, and
  // two near-identical bars are noise rather than information. So ONE bar is drawn, and it
  // is whichever cap the user hits FIRST: the scoped one replaces the all-models one only
  // when its percent is strictly higher, and then it carries its model name so the user can
  // see which cap is binding. If only one of the two is readable, that one is the bar.
  const weeklyAll = pick(fromSummary(util.seven_day), () => findLimit(entries, 'weekly_all'));
  const scoped = findLimit(entries, 'weekly_scoped');
  const weekly = scoped.percent !== null
    && (weeklyAll.percent === null || scoped.percent > weeklyAll.percent)
    ? scoped
    : weeklyAll;

  const limits = [toWire('session', session), toWire('weekly', weekly)]
    .filter((w): w is UsageLimitWire => w !== null);
  return { limits, fetchedAtMs };
}

/** `primary` when it has a percent, else whatever the fallback finds. */
function pick(primary: Candidate, fallback: () => Candidate): Candidate {
  return primary.percent !== null ? primary : fallback();
}
