import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertConfinedConfigDir } from './claude-accounts.js';
import { mergeUsageReadings, readUsageMeter } from './claude-usage-meter.js';

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
 *   2. `home` IS REAL IN PRODUCTION — multi-account made it so, and leaving the old
 *      "TEST SEAM ONLY" note here would now MISLEAD rather than protect. An account's usage
 *      cache lives in its own `<configDir>/.claude.json`, which is the same shape as
 *      `~/.claude.json`, so this reader needs no refactor to serve N accounts. What replaces
 *      the old guarantee is a NARROWER one: the only values that can reach this parameter
 *      come from `resolveConfigDir` (slug-shaped id, resolved path asserted to be either
 *      `homedir()` or inside `~/.dreamcontext/claude-accounts/`) — and that assertion is
 *      REPEATED inside this function, so the guarantee does not rest on a caller remembering
 *      it. A request-derived ACCOUNT ID can choose which account is read; a request-derived
 *      PATH still cannot.
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
  /** Present only when the CLI reports this window as ALREADY LOCKED (`five_hour` /
   *  `seven_day` summary `locked_reason`). Read from the SUMMARY objects, never from a
   *  `limits[]` entry. An account with a locked window is never an auto-switch candidate,
   *  and the surface can say "locked" instead of drawing a bar at some percentage. */
  lockedReason?: string;
}

/** MIRRORED in `dashboard/src/lib/agentComposer.ts` (UsageLimitsResponse). */
export interface UsageLimitsResponse {
  limits: UsageLimitWire[];
  /** When the CLI last refreshed the cache. The client labels or hides a stale reading. */
  fetchedAtMs: number | null;
}

export const EMPTY_USAGE_LIMITS: UsageLimitsResponse = { limits: [], fetchedAtMs: null };

/**
 * The CLI's own WRITE THROTTLE on this cache, read out of the 2.1.259 bundle (`Uso = 300000`):
 * it refuses to rewrite `cachedUsageUtilization` while the existing entry for the same account
 * is younger than 5 minutes, however fresh the numbers it just fetched are.
 *
 * Two consequences, and both are load-bearing:
 *   • "the file did not move" is NOT evidence that a probe failed — see claude-usage-report.ts;
 *   • a cache younger than this IS current, because the only thing standing between it and a
 *     rewrite is the throttle. So a reading this fresh needs no probe to be trusted.
 */
export const USAGE_CACHE_WRITE_THROTTLE_MS = 5 * 60_000;

/**
 * The CLI's own READ ceiling on this cache, from the same bundle (`Bso = 3600000`): past an
 * hour it discards its cached utilization and returns nothing rather than show it.
 *
 * Mirrored here so nothing in this codebase presents as a MEASUREMENT what Claude Code itself
 * would refuse to use. The surfaces may still LABEL an older reading ("read 3h ago"); what they
 * must not do is let it decide which account gets billed for the next turn.
 */
export const USAGE_CACHE_MAX_AGE_MS = 60 * 60_000;

/**
 * Which weekly cap BINDS — the one rule, in one place, because two readers apply it: the cache
 * reader below and the live-report parser in `claude-usage-report.ts`.
 *
 * An account can carry two weekly numbers: `weekly_all` (every model) and `weekly_scoped` (one
 * model). Two near-identical bars are noise, so ONE is drawn: whichever cap is hit FIRST. The
 * scoped one replaces the all-models one only when it is strictly higher, and then it carries
 * its model name so the user can see which cap is binding.
 */
export function weeklyBindsOnScoped(allPercent: number | null, scopedPercent: number | null): boolean {
  return scopedPercent !== null && (allPercent === null || scopedPercent > allPercent);
}

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
interface Candidate { percent: number | null; resetsAt: number | null; scope?: string; lockedReason?: string }

/** A summary entry (`five_hour` / `seven_day`) — percent lives under `utilization`. */
function fromSummary(raw: unknown): Candidate {
  const o = asRecord(raw);
  if (!o) return { percent: null, resetsAt: null };
  // SNAKE_CASE — `locked_reason`, like every other field in this payload (`resets_at`,
  // `limit_dollars`, `used_dollars`). Read from a REAL cache written by CLI 2.1.260, not
  // from a hand-written fixture: the first version of this line read `lockedReason` and
  // therefore never fired at all, which would have let a LOCKED account be chosen as an
  // auto-switch candidate. The camelCase spelling is still accepted, so a future CLI that
  // renames it does not silently turn the guard off again.
  const rawLocked = o.locked_reason ?? o.lockedReason;
  const locked = typeof rawLocked === 'string' ? rawLocked.trim() : '';
  return {
    percent: asPercent(o.utilization),
    resetsAt: asResetsAt(o.resets_at),
    ...(locked ? { lockedReason: locked } : {}),
  };
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
  if (c.lockedReason) wire.lockedReason = c.lockedReason;
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
  // Repeated here on purpose — see note 2 in the header. A directory that is neither the real
  // HOME nor an account sandbox never gets read, whatever the caller believed.
  const dir = assertConfinedConfigDir(home);
  // The CLI's cache is rewritten at most every five minutes and only on demand; every turn this
  // app runs states the account's usage exactly (claude-usage-meter.ts). Newest window wins.
  return mergeUsageReadings(readCliUsageCache(dir), readUsageMeter(dir));
}

/** The CLI's own cache alone — what `readUsageLimits` was before the per-turn meter joined it. */
export function readCliUsageCache(home: string = homedir()): UsageLimitsResponse {
  return usageFromBlob(readJsonSafe(join(assertConfinedConfigDir(home), '.claude.json')));
}

/** Who a registered account is, as far as proving a directory holds it goes. */
export interface AccountIdentity {
  accountUuid: string;
  email: string;
  organizationUuid: string;
  /** `null` = the real HOME (account #0). */
  configDir: string | null;
}

function trimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Is `blob` (a parsed `<configDir>/.claude.json`) signed in as `account`?
 *
 * The register's `accountUuid` is empty on machines that connected their accounts before it was
 * recorded (all four on the owner's machine, 2026-10-18), so the email decides when the uuid
 * cannot. The organization is checked whenever both sides carry one: one email can hold seats
 * in two organizations, and each seat is its own quota pool.
 */
function signedInAs(blob: Record<string, unknown> | null, account: AccountIdentity): boolean {
  const oauth = asRecord(blob?.oauthAccount);
  const uuid = trimmedString(oauth?.accountUuid);
  if (!uuid) return false;
  if (account.accountUuid) {
    if (account.accountUuid !== uuid) return false;
  } else {
    const email = trimmedString(oauth?.emailAddress).toLowerCase();
    if (!email || !account.email || email !== account.email.trim().toLowerCase()) return false;
  }
  const org = trimmedString(oauth?.organizationUuid);
  return !account.organizationUuid || !org || account.organizationUuid === org;
}

/** Is `account`'s own directory signed in as that account right now? Never throws. */
export function configDirSignedInAs(account: AccountIdentity, home: string = homedir()): boolean {
  try {
    const dir = assertConfinedConfigDir(account.configDir ?? home, home);
    return signedInAs(readJsonSafe(join(dir, '.claude.json')), account);
  } catch {
    return false;
  }
}

/**
 * The CLI's cache for ONE registered account — or null unless it provably measured THAT account.
 *
 * Two checks, both on the raw blob, neither reaching the wire: the directory is signed in as the
 * account the register names ({@link signedInAs}), and the cache was written for that same
 * credential (`cachedUsageUtilization.accountUuid`). A cache that names no account is not
 * vouched for. This is the reading a remembered refusal may be ended on
 * (`claude-limit-rejections.ts`), so "probably this account" is not enough.
 */
export function readAccountUsageCache(account: AccountIdentity, home: string = homedir()): UsageLimitsResponse | null {
  let blob: Record<string, unknown> | null;
  try {
    blob = readJsonSafe(join(assertConfinedConfigDir(account.configDir ?? home, home), '.claude.json'));
  } catch {
    return null;
  }
  if (!signedInAs(blob, account)) return null;
  const measured = trimmedString(asRecord(blob?.cachedUsageUtilization)?.accountUuid);
  if (!measured || measured !== trimmedString(asRecord(blob?.oauthAccount)?.accountUuid)) return null;
  return usageFromBlob(blob);
}

/** `cachedUsageUtilization` out of a parsed `.claude.json`, as wire bars. */
function usageFromBlob(blob: Record<string, unknown> | null): UsageLimitsResponse {
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

  // Weekly: same fallback, then the BINDING-CAP rule — see `weeklyBindsOnScoped`. In the
  // observed sample the two weekly numbers sit three points apart, and if only one of them is
  // readable, that one is the bar.
  const weeklyAll = pick(fromSummary(util.seven_day), () => findLimit(entries, 'weekly_all'));
  const scoped = findLimit(entries, 'weekly_scoped');
  const weekly = weeklyBindsOnScoped(weeklyAll.percent, scoped.percent) ? scoped : weeklyAll;

  const limits = [toWire('session', session), toWire('weekly', weekly)]
    .filter((w): w is UsageLimitWire => w !== null);
  return { limits, fetchedAtMs };
}

/** `primary` when it has a percent, else whatever the fallback finds. */
function pick(primary: Candidate, fallback: () => Candidate): Candidate {
  return primary.percent !== null ? primary : fallback();
}

/**
 * Is this reading something we may DECIDE on — as opposed to something we may only display?
 *
 * True when it carries at least one window and its stamp is inside {@link USAGE_CACHE_MAX_AGE_MS},
 * the ceiling Claude Code itself applies. Anything else means "we do not know", and the honest
 * response to not knowing is to spend a (free) probe, never to act on the last number seen.
 */
export function usageReadingIsCurrent(reading: UsageLimitsResponse, now: number = Date.now()): boolean {
  if (reading.limits.length === 0 || reading.fetchedAtMs === null) return false;
  return Math.max(0, now - reading.fetchedAtMs) <= USAGE_CACHE_MAX_AGE_MS;
}
