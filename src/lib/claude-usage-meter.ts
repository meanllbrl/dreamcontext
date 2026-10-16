import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { UsageLimitsResponse, UsageLimitWire } from './claude-usage.js';

/**
 * Every turn's OWN usage reading — the per-turn `rate_limit_event` frame, kept.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────
 * The account panel and the switch chooser read each account's usage from the CLI's cache
 * (`cachedUsageUtilization` in `<configDir>/.claude.json`). The CLI rewrites that cache at most
 * every five minutes, only when something asks it to, and discards it after an hour — so an
 * account in steady use still drew numbers an hour old, and a quiet one drew nothing at all.
 * Owner, 2026-10-16: "this part is almost always wrong, always stale", with two accounts at
 * 100% and the top row still labelled "new sessions start here".
 *
 * Meanwhile the CLI emits, on EVERY turn, a frame that carries both windows exactly:
 *
 *   { "type": "rate_limit_event",
 *     "rate_limit_info": { "status": "allowed", "rateLimitType": "five_hour", …,
 *       "unifiedWindows": { "five_hour": { "utilization": 0.09, "resetsAt": 1792183800 },
 *                           "seven_day": { "utilization": 0.16, "resetsAt": 1792440000 } } } }
 *
 * (verbatim shape, captured on claude 2.1.301 on 2026-10-16). That is a measurement taken by the
 * account itself at the moment it served a turn — free, current, and already on our stream. It
 * used to be read only as "was this a refusal" and then thrown away.
 *
 * ── The store ─────────────────────────────────────────────────────────────────────────
 * `~/.dreamcontext/claude-account-usage.json`, keyed by the account's RESOLVED config dir (the
 * same key `readUsageLimits` is called with, so no caller has to map ids). Written temp+rename,
 * so a reader in another process sees the old file or the new one and never half of either.
 * `readUsageLimits` merges it with the CLI's cache window by window, newest first — every
 * reader of account usage (the panel, the chooser, the probe, the composer) gets the fresher
 * truth without being told this file exists.
 */

/** One account's last per-turn reading, as stored. */
interface MeterEntry {
  limits: UsageLimitWire[];
  fetchedAtMs: number;
}

export function usageMeterFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-account-usage.json');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** Epoch SECONDS on this frame (milliseconds tolerated); null for anything unusable. */
function asResetMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1_000_000_000_000 ? v * 1000 : v;
}

function windowFrom(key: UsageLimitWire['key'], raw: unknown): UsageLimitWire | null {
  const w = asRecord(raw);
  const util = w?.utilization;
  if (typeof util !== 'number' || !Number.isFinite(util) || util < 0) return null;
  const resetsAt = asResetMs(w?.resetsAt);
  // A window without a reset cannot be labelled or discounted; the cache reader drops the same.
  if (resetsAt === null) return null;
  // A fraction on this frame (0.09 = 9%). Clamped: past 100 is still "full", never more.
  return { key, percent: Math.min(100, Math.round(util * 1000) / 10), resetsAt };
}

/**
 * The usage a `rate_limit_event` frame states, or null when the frame is anything else or
 * carries no readable window. An unrecognized shape returns null rather than a guess — a wrong
 * number here would decide which account bills the next turn.
 */
export function readUsageMeterFrame(frame: unknown, now: number = Date.now()): UsageLimitsResponse | null {
  const f = asRecord(frame);
  if (!f || f.type !== 'rate_limit_event') return null;
  const windows = asRecord(asRecord(f.rate_limit_info)?.unifiedWindows);
  if (!windows) return null;
  const limits = [windowFrom('session', windows.five_hour), windowFrom('weekly', windows.seven_day)]
    .filter((w): w is UsageLimitWire => w !== null);
  return limits.length > 0 ? { limits, fetchedAtMs: now } : null;
}

/** Did the API ALLOW the turn this frame describes? `allowed` and `allowed_warning` both serve. */
export function meterFrameAllowed(frame: unknown): boolean {
  const status = asRecord(asRecord(frame)?.rate_limit_info)?.status;
  return typeof status === 'string' && status.startsWith('allowed');
}

/** A refusal younger than this is never ended by a meter: the frames of the turn that was just
 *  refused (a sub-agent's, the main turn's) still arrive around it. */
export const REFUSAL_SETTLE_MS = 2 * 60_000;

/**
 * Does this frame prove a remembered refusal is OVER?
 *
 * Narrow on purpose — a refusal cleared wrongly sends new chats straight back into the wall:
 *   • a WEEKLY refusal is never ended here. It can be a per-model cap (`scope`), and an
 *     `allowed` turn on another model says nothing about it; its stated reset is reliable.
 *   • the frame must be `allowed` AND show the refused window with room in it (session: the
 *     five-hour window; a refusal whose window is unknown: both);
 *   • and the refusal must be older than {@link REFUSAL_SETTLE_MS}.
 */
export function meterEndsRefusal(
  frame: unknown,
  refusal: { window?: string; at?: number },
  now: number = Date.now(),
): boolean {
  if (!meterFrameAllowed(frame) || refusal.window === 'weekly') return false;
  if (typeof refusal.at !== 'number' || now - refusal.at < REFUSAL_SETTLE_MS) return false;
  const windows = asRecord(asRecord(asRecord(frame)?.rate_limit_info)?.unifiedWindows);
  const room = (raw: unknown): boolean => {
    const util = asRecord(raw)?.utilization;
    return typeof util === 'number' && Number.isFinite(util) && util < 0.99;
  };
  if (!room(windows?.five_hour)) return false;
  return refusal.window === 'session' || room(windows?.seven_day);
}

function readStore(home: string): Record<string, MeterEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(usageMeterFilePath(home), 'utf-8'));
  } catch {
    return {};
  }
  const raw = asRecord(asRecord(parsed)?.accounts);
  if (!raw) return {};
  const out: Record<string, MeterEntry> = {};
  for (const [dir, value] of Object.entries(raw)) {
    const e = asRecord(value);
    const at = e?.fetchedAtMs;
    if (typeof at !== 'number' || !Number.isFinite(at) || !Array.isArray(e?.limits)) continue;
    // Rebuilt field by field: nothing from the file rides out to a client unnarrowed.
    const limits = (e.limits as unknown[]).flatMap((l): UsageLimitWire[] => {
      const r = asRecord(l);
      const key = r?.key;
      if ((key !== 'session' && key !== 'weekly') || typeof r?.percent !== 'number' || !Number.isFinite(r.percent)
        || typeof r.resetsAt !== 'number' || !Number.isFinite(r.resetsAt)) return [];
      return [{ key, percent: r.percent, resetsAt: r.resetsAt }];
    });
    if (limits.length > 0) out[dir] = { limits, fetchedAtMs: at };
  }
  return out;
}

/** The last per-turn reading for this config dir, or null when none was ever recorded. */
export function readUsageMeter(configDir: string, home: string = homedir()): UsageLimitsResponse | null {
  const entry = readStore(home)[resolve(configDir)];
  return entry ? { limits: entry.limits, fetchedAtMs: entry.fetchedAtMs } : null;
}

/**
 * Below this, an UNCHANGED reading is not rewritten. A turn can emit several frames (one per API
 * request inside it), and rewriting identical numbers only to move the stamp a few seconds would
 * be disk churn for nothing; a changed number is always written at once.
 */
const UNCHANGED_REWRITE_MS = 30_000;

/** Two readings of one window name the same window when their resets are this close. */
const SAME_WINDOW_SLACK_MS = 60_000;

/**
 * Record one per-turn reading. Best-effort: a machine that cannot write still works.
 *
 * Several writers share the file — every chat pane, and one dashboard server per open vault —
 * so the last rename wins. Inside ONE window usage only climbs until the reset, so a lower
 * number for the window already on file is a late or stale writer, never the account getting
 * emptier: the higher one is kept. A new window (another reset) starts over. Read and rename are
 * back to back and synchronous, so the remaining race (two processes writing two different
 * accounts in the same instant) can only drop the other account's newest frame, which its next
 * turn writes again.
 */
export function recordUsageMeter(configDir: string, reading: UsageLimitsResponse, home: string = homedir()): void {
  if (reading.limits.length === 0 || reading.fetchedAtMs === null) return;
  const key = resolve(configDir);
  const store = readStore(home);
  const prev = store[key];
  const limits = reading.limits.map((l) => {
    const before = prev?.limits.find((p) => p.key === l.key && Math.abs(p.resetsAt - l.resetsAt) <= SAME_WINDOW_SLACK_MS);
    return before && before.percent > l.percent ? { ...l, percent: before.percent } : l;
  });
  if (prev && reading.fetchedAtMs - prev.fetchedAtMs < UNCHANGED_REWRITE_MS
    && JSON.stringify(prev.limits) === JSON.stringify(limits)) return;
  store[key] = { limits, fetchedAtMs: Math.max(reading.fetchedAtMs, prev?.fetchedAtMs ?? 0) };
  const filePath = usageMeterFilePath(home);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ accounts: store }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, filePath);
  } catch {
    // The CLI's own cache still answers; this file only makes it fresher.
  }
}

/**
 * Has this account served a turn SINCE `since` and shown clear room doing it?
 *
 * What lets a pane return to an account it was forced off before that window resets. "Served a
 * turn" alone is not enough: the forced pane's own turn, still finishing there, writes frames
 * after the move; and a reading that sits just under the threshold (89.6%, where the live probe
 * that forced the move read 90%) would bring the pane back only to force it off again. So every
 * window still open must be at least `margin` points under the threshold.
 */
export function meterShowsRoomSince(
  reading: UsageLimitsResponse | null,
  since: number,
  threshold: number,
  margin: number,
  now: number = Date.now(),
): boolean {
  if (!reading || reading.fetchedAtMs === null || reading.fetchedAtMs <= since) return false;
  const open = reading.limits.filter((l) => l.resetsAt > now);
  return open.length > 0 && open.every((l) => l.percent < threshold - margin);
}

/**
 * The CLI's cache and the per-turn meter, merged WINDOW BY WINDOW, newest first.
 *
 * Per window rather than whole-reading because the two sources do not carry the same things:
 *   • the meter is fresher, but knows only the all-models week;
 *   • the cache can carry a per-model weekly cap (`scope`, e.g. "Fable") and a `lockedReason`.
 *
 * So: each window comes from whichever source read it more recently. One exception, from the
 * one fact that holds inside a window — usage only CLIMBS until the reset: a scoped weekly cap
 * from the cache whose reset is still ahead and whose percent is higher than the meter's
 * all-models week is still binding, so it is kept even when older. A `lockedReason` survives
 * only on a window the cache wins; a newer meter means the API has served a turn since.
 */
export function mergeUsageReadings(
  cache: UsageLimitsResponse,
  meter: UsageLimitsResponse | null,
  now: number = Date.now(),
): UsageLimitsResponse {
  if (!meter || meter.fetchedAtMs === null || meter.limits.length === 0) return cache;
  const meterNewer = cache.fetchedAtMs === null || meter.fetchedAtMs > cache.fetchedAtMs;
  const pick = (key: UsageLimitWire['key']): UsageLimitWire | undefined => {
    const fromCache = cache.limits.find((l) => l.key === key);
    const fromMeter = meter.limits.find((l) => l.key === key);
    if (!fromMeter) return fromCache;
    if (!fromCache || meterNewer) {
      if (key === 'weekly' && fromCache?.scope && fromCache.resetsAt > now && fromCache.percent > fromMeter.percent) {
        return fromCache;
      }
      return fromMeter;
    }
    return fromCache;
  };
  const limits = [pick('session'), pick('weekly')].filter((l): l is UsageLimitWire => l !== undefined);
  return {
    limits,
    fetchedAtMs: Math.max(cache.fetchedAtMs ?? 0, meter.fetchedAtMs),
  };
}
