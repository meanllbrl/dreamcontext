import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LimitSignal, LimitWindow } from './claude-limit-signal.js';

/**
 * Which accounts the API has actually REFUSED, and until when.
 *
 * ── Why remembering matters more than reacting ────────────────────────────────────────
 * A post-hoc switch that forgets is a switch that has to be re-earned by a second visible
 * error: the next turn re-reads the same lying percent, decides the walled account is fine,
 * and walks into the wall again. That is the exact loop the screenshot on 2026-09-05
 * captured — "devam" came back with a byte-identical limit message.
 *
 * So a rejection is WRITTEN DOWN. `chooseAccount` then disqualifies that account until its
 * window reopens, on every session on this machine, regardless of what the usage cache
 * claims. The forecast is still read; it just no longer gets to overrule an observation.
 *
 * ── Why on disk and not in the route's memory ─────────────────────────────────────────
 * One chat pane is not the unit that hits a limit — the ACCOUNT is. Two panes, an
 * automation run and a terminal session all share one quota, so a wall one of them found is
 * news to all of them. A module-level Map would also die with the server, which is exactly
 * when a user restarts the app and walks into the wall a third time.
 *
 * The file is machine-local, tiny, and disposable: losing it costs one avoidable limit
 * error, so this deliberately uses the same atomic temp+rename as the account register and
 * no lockfile. It is never read for anything but eligibility.
 *
 * ── Why an unknown reset still records ────────────────────────────────────────────────
 * The text reader (`syntheticText`) yields no reset time. Recording nothing in that case
 * would make the weakest signal also the most useless one. Instead an unknown reset gets
 * `DEFAULT_COOLDOWN_MS` — long enough to move the conversation off a walled account, short
 * enough that a wrong guess costs one delayed return rather than an hour of exile. A real
 * `resetsAt` always wins over the guess.
 */

export interface AccountRejection {
  /** Epoch ms until which this account is disqualified. */
  until: number;
  /** Which cap refused, when the frame said. */
  window: LimitWindow;
  /** Epoch ms when the rejection was observed. */
  at: number;
  /** The CLI's own explanation, when it gave one. */
  detail?: string;
  /** True when `until` is the fallback guess rather than a reset the API stated. */
  estimated?: boolean;
}

/** How long an account stays disqualified when the frame does not say when it reopens. */
export const DEFAULT_COOLDOWN_MS = 20 * 60_000;

/**
 * Ceiling on a stated reset. A `resetsAt` far in the future would exile an account for days
 * on one frame; the weekly cap is the longest real window and a week is its natural bound.
 */
const MAX_COOLDOWN_MS = 8 * 86_400_000;

export function claudeRejectionsFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-account-limits.json');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function asWindow(v: unknown): LimitWindow {
  return v === 'session' || v === 'weekly' ? v : 'unknown';
}

/**
 * Every rejection still in force, keyed by account id. Expired entries are dropped on the
 * way out, so a caller can never act on a window that has already reopened.
 *
 * Never throws: a missing or corrupt file reads as "nothing is rejected", which degrades to
 * exactly the behaviour that existed before this module.
 */
export function readAccountRejections(
  home: string = homedir(),
  now: number = Date.now(),
): Record<string, AccountRejection> {
  const filePath = claudeRejectionsFilePath(home);
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
  const raw = asRecord(asRecord(parsed)?.rejected);
  if (!raw) return {};

  const out: Record<string, AccountRejection> = {};
  for (const [id, value] of Object.entries(raw)) {
    const entry = asRecord(value);
    const until = entry?.until;
    if (typeof until !== 'number' || !Number.isFinite(until) || until <= now) continue;
    out[id] = {
      until,
      window: asWindow(entry?.window),
      at: typeof entry?.at === 'number' && Number.isFinite(entry.at) ? entry.at : now,
      ...(typeof entry?.detail === 'string' && entry.detail ? { detail: entry.detail } : {}),
      ...(entry?.estimated === true ? { estimated: true } : {}),
    };
  }
  return out;
}

/**
 * Write down that `accountId` was refused, and return the entry.
 *
 * The LATER of the existing and the new `until` wins: two panes hitting the same wall
 * seconds apart must not let the second one, whose text reader produced only a guess,
 * shorten an exile the first one learned from a real `resetsAt`.
 */
export function recordAccountRejection(
  accountId: string,
  signal: LimitSignal,
  home: string = homedir(),
  now: number = Date.now(),
): AccountRejection {
  const stated = signal.resetsAtMs !== null && signal.resetsAtMs > now
    ? Math.min(signal.resetsAtMs, now + MAX_COOLDOWN_MS)
    : null;
  const entry: AccountRejection = {
    until: stated ?? now + DEFAULT_COOLDOWN_MS,
    window: signal.window,
    at: now,
    ...(signal.detail ? { detail: signal.detail } : {}),
    ...(stated === null ? { estimated: true } : {}),
  };

  const current = readAccountRejections(home, now);
  const previous = current[accountId];

  // Keep the LONGER exile, but describe the wall that was just hit: `window`/`detail` come
  // from the new observation, while `until` — and therefore `estimated`, which is a claim
  // ABOUT `until` — come from whichever entry reaches further.
  let merged = entry;
  if (previous && previous.until > entry.until) {
    const { estimated: _fromNew, ...rest } = entry;
    merged = { ...rest, until: previous.until, ...(previous.estimated ? { estimated: true } : {}) };
  }

  writeRejections({ ...current, [accountId]: merged }, home);
  return merged;
}

/**
 * Forget one account's rejection — used when a probe proves the window has reopened.
 *
 * The read that backs it takes `now` too, so expiring an entry is never a function of when
 * the test happens to run.
 */
export function clearAccountRejection(
  accountId: string,
  home: string = homedir(),
  now: number = Date.now(),
): void {
  const current = readAccountRejections(home, now);
  if (!(accountId in current)) return;
  delete current[accountId];
  writeRejections(current, home);
}

/** Atomic temp+rename, mirroring `writeClaudeAccounts`. Best-effort: never throws. */
function writeRejections(rejected: Record<string, AccountRejection>, home: string): void {
  const filePath = claudeRejectionsFilePath(home);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ rejected }, null, 2) + '\n', 'utf-8');
    renameSync(tmp, filePath);
  } catch {
    // A machine that cannot write this file still auto-switches; it just re-learns each
    // wall. Failing the turn over a cache write would be the worse trade.
  }
}
