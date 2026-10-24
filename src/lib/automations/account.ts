import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  agentThresholdFor, autoSwitchEnabled, claudeAccountsFilePath, listClaudeAccounts, resolveConfigDir, switchStrategyFor, switchWeightsFor,
  type ClaudeAccount,
} from '../claude-accounts.js';
import {
  chooseAccount, provenPastThreshold, shouldProbe, shouldSwitchAway, SWITCH_THRESHOLD_PERCENT,
  type AccountReading,
} from '../claude-account-switch.js';
import { readAccountRejections } from '../claude-limit-rejections.js';
import { SIGNED_OUT_FOR_MS, readSignedOut } from '../claude-signed-out.js';
import { sandboxHasIdentity } from '../claude-account-sandbox.js';
import { probeAccountUsage, type ProbeOutcome } from '../claude-usage-probe.js';
import {
  EMPTY_USAGE_LIMITS, readUsageLimits, usageReadingIsCurrent, type UsageLimitsResponse,
} from '../claude-usage.js';

/**
 * Which Claude account an automation run goes out on.
 *
 * An automation is a session nobody is watching, so it gets the SAME decision a chat turn
 * gets (`chooseAccount`, the same strategy, weights, register order and recorded refusals),
 * made once before the spawn instead of once per message. Before this, every run went out
 * on the preferred account whatever its state: on 2026-09-28 two Monday-morning runs both
 * died at the 5-hour limit while a second signed-in account sat idle.
 *
 * The chat path's contract is kept on purpose:
 * - auto-switch OFF, or fewer than two accounts, is exactly the old behaviour: the preferred
 *   account, no probe, no subprocess.
 * - `sequential` never forecasts: the preferred account serves until the API has refused it.
 * - `score` probes only when the cached reading is near the threshold or too old to trust.
 * - nothing eligible is NOT a reason to skip the run: it goes out on the preferred account and
 *   the usage-limit gate reports the refusal honestly.
 */

export interface AutomationAccount {
  /** Register id, or null on a machine with no register (the real `~/.claude`). */
  id: string | null;
  /** What `accountEnvFor` takes. Always confined (it comes from `resolveConfigDir`). */
  configDir: string;
  /** Display only: the email, when the register has one. */
  label: string | null;
}

export interface PickDeps {
  home?: string;
  /** Injectable so no test spawns a real `claude /usage`. */
  probe?: (configDir: string) => Promise<ProbeOutcome>;
  now?: number;
  /**
   * Accounts already tried by THIS run. Treated as refused whatever the rejection file says,
   * so a retry loop can never pick the same account twice even when the refusal could not be
   * written down.
   */
  exclude?: string[];
}

/** How long an excluded account is treated as refused inside one decision. Only its sign matters. */
const EXCLUDED_FOR_MS = 60 * 60_000;

function toAccount(a: ClaudeAccount, home: string): AutomationAccount {
  return { id: a.id, configDir: resolveConfigDir(a.id, home), label: a.email || null };
}

interface Context {
  home: string;
  now: number;
  exclude: Set<string>;
  accounts: ClaudeAccount[];
  preferred: ClaudeAccount | null;
  fallback: AutomationAccount;
  rejectedUntil: Record<string, { until: number; window?: string }>;
}

function contextFor(deps: PickDeps): Context {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now();
  const exclude = new Set(deps.exclude ?? []);
  const accounts = listClaudeAccounts(home);
  const preferred = accounts.find((a) => a.preferred) ?? accounts.find((a) => a.configDir === null) ?? null;
  const fallback: AutomationAccount = preferred
    ? toAccount(preferred, home)
    : { id: null, configDir: resolveConfigDir(null, home), label: null };
  const rejectedUntil: Context['rejectedUntil'] = { ...readAccountRejections(home, now) };
  for (const id of exclude) rejectedUntil[id] = { until: now + EXCLUDED_FOR_MS };
  return { home, now, exclude, accounts, preferred, fallback, rejectedUntil };
}

/** The cached reading, or none. `readUsageLimits` refuses an unconfined dir by throwing, and
 *  an unreadable cache is simply a reading we do not have (the probe decides then). */
function cachedUsage(dir: string): UsageLimitsResponse {
  try {
    return readUsageLimits(dir);
  } catch {
    return EMPTY_USAGE_LIMITS;
  }
}

/** Accounts that cannot serve: no credential in the sandbox, or recorded signed out. */
export function signedOutAccounts(accounts: readonly ClaudeAccount[], home: string, now: number): Set<string> {
  const recorded = readSignedOut(home, now);
  const out = new Set<string>();
  for (const a of accounts) {
    if (recorded[a.id] !== undefined) { out.add(a.id); continue; }
    try { if (!sandboxHasIdentity(a.configDir ?? home, home)) out.add(a.id); } catch { /* unknown: not proven out */ }
  }
  return out;
}

/** The account the run used before auto-switch reached automations: never throws. */
function preferredOnly(deps: PickDeps): AutomationAccount {
  const home = deps.home ?? homedir();
  try {
    const preferred = listClaudeAccounts(home).find((a) => a.preferred);
    if (preferred) return toAccount(preferred, home);
  } catch { /* fall through to the machine's own account */ }
  return { id: null, configDir: home, label: null };
}

/** Is the preferred account's current reading enough to keep it, with no probe? */
function preferredServesWithoutProbe(c: Context): boolean {
  if (c.accounts.length < 2 || !autoSwitchEnabled(c.home)) return true;
  if (!c.preferred || c.rejectedUntil[c.preferred.id]) return false;
  if (switchStrategyFor(c.home) === 'sequential') return true;
  const cached = cachedUsage(c.preferred.configDir ?? c.home);
  return usageReadingIsCurrent(cached, c.now) && !shouldProbe(cached, undefined, c.now);
}

/**
 * The answer when it needs no subprocess, else null. SYNCHRONOUS on purpose: the runner
 * spawns in the same tick it was called on when nothing stands in the way, and the common
 * case (one account, or a preferred account with room) must not add a microtask to that.
 */
export function automationAccountWithoutProbe(deps: PickDeps = {}): AutomationAccount | null {
  try {
    const c = contextFor(deps);
    return preferredServesWithoutProbe(c) ? c.fallback : null;
  } catch {
    return preferredOnly(deps);
  }
}

/**
 * The account a NEW chat opens on when nobody picked one — decided from what is already on
 * disk (each account's cached usage and the recorded refusals), with NO probe.
 *
 * Before this a chat with no `account` always opened on the preferred account, whatever its
 * state; the per-turn check then found it full on the FIRST message and restarted the session
 * elsewhere. Observed 2026-10-06: the preferred account at 97% of its 5-hour window, three
 * others with room, and every new chat still opened on the full one, showed it in the picker,
 * and moved only after the user had already typed.
 *
 * No probe on purpose: this runs inside the socket upgrade, and a probe can take seconds (its
 * ceiling is 20s). The per-turn check (`maybeSwitchAccount`) is still the safety net, so a
 * cache that is wrong here costs the same restart as before, never worse. Same rules as the
 * turn path otherwise: OFF / one account keep the preferred account; only a refusal, a CURRENT
 * reading past the switch threshold, or an older one whose window has not reset yet and already
 * shows it past (`provenPastThreshold`) moves it — under `sequential` too since 2026-10-16, which
 * used to open every new chat on the top account however full (a chat opened at 98% and was
 * refused seven minutes later). A blind pick (`unmeasured`) is refused under `score`, since
 * staying put lets the turn path probe properly; under `sequential` it is the mode's own rule.
 */
export function chatSpawnAccount(deps: Pick<PickDeps, 'home' | 'now'> & {
  /** Injectable so a test reads its own fixture, not a `.claude.json` under the real HOME. */
  readUsage?: (configDir: string) => UsageLimitsResponse;
  /** Injectable: the accounts known signed out (default: {@link signedOutAccounts}). */
  signedOut?: ReadonlySet<string>;
} = {}): AutomationAccount {
  try {
    const c = contextFor(deps);
    const { home, now, accounts, preferred, fallback, rejectedUntil } = c;
    if (accounts.length < 2 || !preferred) return fallback;
    const dirOf = (a: ClaudeAccount): string => a.configDir ?? home;
    // A SIGNED-OUT account is not a forecast, it cannot serve at all (claude-signed-out.ts):
    // no credential in its sandbox, or a turn on it was refused for sign-in. A new chat never
    // opens there while a signed-in account exists, whatever auto-switch says.
    const out = deps.signedOut ?? signedOutAccounts(accounts, home, now);
    // Where to go when the preferred account is signed out and nothing better is proven: the
    // first signed-in one in the owner's order (one with no standing refusal first).
    const next = out.has(preferred.id)
      ? accounts.find((a) => !out.has(a.id) && !rejectedUntil[a.id]) ?? accounts.find((a) => !out.has(a.id)) ?? null
      : null;
    const orFallback = (): AutomationAccount => (next ? toAccount(next, home) : fallback);
    if (next && !autoSwitchEnabled(home)) return orFallback();
    for (const id of out) rejectedUntil[id] = { until: now + SIGNED_OUT_FOR_MS };
    if (!autoSwitchEnabled(home)) return fallback;
    const read = deps.readUsage ?? cachedUsage;
    const sequential = switchStrategyFor(home) === 'sequential';
    if (!rejectedUntil[preferred.id]) {
      const cached = read(dirOf(preferred));
      // A current reading decides as usual. An OLD one still decides when it proves the
      // account full (`provenPastThreshold`): usage cannot fall before the reset, so "too old
      // to trust" only ever hides an account that is even fuller.
      const full = usageReadingIsCurrent(cached, now)
        ? shouldSwitchAway(cached, undefined, now)
        : provenPastThreshold(cached, undefined, now);
      if (!full) return fallback;
    }
    const readings = accounts.map((a): AccountReading => {
      const cached = read(dirOf(a));
      // `sequential` weighs no percentage, so an old reading is not a problem to it; what it
      // needs is the reading itself, to pass over an account it PROVES full (`skipProvenFull`).
      if (sequential) return cached.limits.length > 0 ? { id: a.id, limits: cached } : { id: a.id, problem: 'stale' };
      return usageReadingIsCurrent(cached, now) ? { id: a.id, limits: cached } : { id: a.id, problem: 'stale' };
    });
    const choice = chooseAccount(readings, {
      threshold: SWITCH_THRESHOLD_PERCENT,
      currentId: preferred.id,
      preferredId: preferred.id,
      orderedIds: accounts.map((a) => a.id),
      rejectedUntil,
      strategy: switchStrategyFor(home),
      weights: switchWeightsFor(home),
      now,
      // A NEW chat should open where it can live, not where it will be refused in minutes.
      skipProvenFull: true,
    });
    // `unmeasured` is a blind pick under `score`; under `sequential` it is the mode's own rule
    // (no percentage is consulted), so it stands.
    const winner = choice.accountId === null || (choice.unmeasured && !sequential)
      ? null
      : accounts.find((a) => a.id === choice.accountId);
    return winner ? toAccount(winner, home) : orFallback();
  } catch {
    return preferredOnly(deps);
  }
}

/**
 * The full decision, probing where the cache cannot answer. NEVER rejects: a register or
 * probe that breaks leaves the run on the preferred account, which is what it did before
 * this existed, rather than failing a job nobody is watching.
 */
export async function pickAutomationAccount(deps: PickDeps = {}): Promise<AutomationAccount> {
  try {
    return await decide(deps);
  } catch {
    return preferredOnly(deps);
  }
}

async function decide(deps: PickDeps): Promise<AutomationAccount> {
  const c = contextFor(deps);
  if (preferredServesWithoutProbe(c)) return c.fallback;
  const { home, now, accounts, preferred, fallback, rejectedUntil, exclude } = c;
  const probe = deps.probe ?? ((dir: string) => probeAccountUsage(dir, { home }));
  const dirOf = (a: ClaudeAccount): string => a.configDir ?? home;

  // The preferred account's forecast, when it was not refused outright: a probe that clears
  // it keeps the run where it is (`score` only reaches here; `sequential` never forecasts).
  let preferredReading: AccountReading | null = null;
  if (preferred && !rejectedUntil[preferred.id]) {
    let active: UsageLimitsResponse = cachedUsage(dirOf(preferred));
    const outcome = await probe(dirOf(preferred));
    if (outcome.status === 'ok') active = outcome.limits;
    if (outcome.status !== 'needs-relogin' && !shouldSwitchAway(active, undefined, now)) return fallback;
    preferredReading = outcome.status === 'ok'
      ? { id: preferred.id, limits: outcome.limits }
      : { id: preferred.id, problem: outcome.status };
  }

  const readings = await Promise.all(accounts.map(async (a): Promise<AccountReading> => {
    if (preferredReading && a.id === preferredReading.id) return preferredReading;
    // A refused account is disqualified by `rejectedUntil` before its reading is looked at,
    // so probing it would be a subprocess spent on nothing.
    if (rejectedUntil[a.id]) return { id: a.id, problem: 'unknown' };
    const outcome = await probe(dirOf(a));
    return outcome.status === 'ok' ? { id: a.id, limits: outcome.limits } : { id: a.id, problem: outcome.status };
  }));

  const choice = chooseAccount(readings, {
    threshold: SWITCH_THRESHOLD_PERCENT,
    currentId: preferred?.id ?? null,
    preferredId: preferred?.id ?? null,
    orderedIds: accounts.map((a) => a.id),
    rejectedUntil,
    strategy: switchStrategyFor(home),
    weights: switchWeightsFor(home),
    now,
  });
  const winner = choice.accountId === null ? null : accounts.find((a) => a.id === choice.accountId);
  if (!winner || exclude.has(winner.id)) return fallback;
  return toAccount(winner, home);
}

// ─── Account protection for UNATTENDED agent work (owner, 2026-10-24) ─────────────────────
//
// A routine or a task job nobody is watching starts only on the first account in the owner's
// order whose 5-hour AND weekly windows are both under the threshold (machine setting, default
// 80%), never on an account marked "Only mine", never on one signed out or refused. A FILTER over
// the picker's own pieces (the register order, the recorded refusals and sign-outs, the cached
// reading, the probe and its rollover rule: a reading older than its reset counts as 0%), not a
// second chooser. Nothing left: the start waits until the earliest window reset or refusal end.
// Owner-typed messages never pass through here: a person at the keyboard decides for themself.

export type ProtectedPick = { account: AutomationAccount } | { waitUntil: number };

/** When nothing at all says when an account frees up (every one is "Only mine" or signed out). */
const UNKNOWN_WAIT_MS = 30 * 60_000;

/** Future resets of the windows that keep `reading` from serving at `threshold`. */
function blockingResets(reading: UsageLimitsResponse, threshold: number, now: number): number[] {
  return reading.limits
    .filter((l) => (l.lockedReason || l.percent >= threshold) && Number.isFinite(l.resetsAt) && l.resetsAt > now)
    .map((l) => l.resetsAt);
}

export async function protectedAutomationAccount(deps: PickDeps & { threshold?: number } = {}): Promise<ProtectedPick> {
  const c = contextFor(deps);
  const { home, now, rejectedUntil } = c;
  const threshold = deps.threshold ?? agentThresholdFor(home);
  const probe = deps.probe ?? ((dir: string) => probeAccountUsage(dir, { home }));
  const wakes: number[] = [];

  /** The reading to decide on: the cache when it is current, else a probe; null = cannot serve. */
  const readingFor = async (dir: string): Promise<UsageLimitsResponse | null> => {
    const cached = cachedUsage(dir);
    if (usageReadingIsCurrent(cached, now)) return cached;
    const outcome = await probe(dir);
    if (outcome.status === 'ok') return outcome.limits;
    if (outcome.status === 'needs-relogin') return null;
    // A probe that failed leaves the old reading, read through the rollover rule.
    return cached;
  };
  const serves = async (dir: string): Promise<boolean> => {
    const reading = await readingFor(dir);
    if (!reading) return false;
    if (!shouldSwitchAway(reading, threshold, now)) return true;
    wakes.push(...blockingResets(reading, threshold, now));
    return false;
  };

  if (c.accounts.length === 0) {
    // No register: the machine's own `~/.claude` is the only account there is.
    if (await serves(c.fallback.configDir)) return { account: c.fallback };
  } else {
    const out = signedOutAccounts(c.accounts, home, now);
    // Auto-switch off means "never change accounts": the preferred one is the only candidate.
    const order = autoSwitchEnabled(home) ? c.accounts : c.preferred ? [c.preferred] : c.accounts.slice(0, 1);
    for (const a of order) {
      if (a.ownerOnly || out.has(a.id) || c.exclude.has(a.id)) continue;
      const refused = rejectedUntil[a.id];
      if (refused) {
        if (refused.until > now) wakes.push(refused.until);
        continue;
      }
      if (await serves(a.configDir ?? home)) return { account: toAccount(a, home) };
    }
  }
  return { waitUntil: wakes.length > 0 ? Math.min(...wakes) : now + UNKNOWN_WAIT_MS };
}

/**
 * The account a RESUME of an agent's session goes out on (an answer, a reply): the usual pick,
 * moved off an "Only mine" account to the first other signed-in one when one exists. Never
 * gated by the threshold: a person typed the message that resumes it.
 */
export function withoutOwnerOnly(account: AutomationAccount, deps: Pick<PickDeps, 'home' | 'now'> = {}): AutomationAccount {
  try {
    const home = deps.home ?? homedir();
    const accounts = listClaudeAccounts(home);
    if (!accounts.find((a) => a.id === account.id)?.ownerOnly) return account;
    const out = signedOutAccounts(accounts, home, deps.now ?? Date.now());
    const other = accounts.find((a) => !a.ownerOnly && !out.has(a.id));
    return other ? toAccount(other, home) : account;
  } catch {
    return account;
  }
}

// ─── The wait, machine-wide ────────────────────────────────────────────────────────────────
//
// `~/.dreamcontext/automations-account-wait.json`: when unattended work last found no account
// to start on, and when the earliest one frees up. Machine-local (accounts are this machine's).
// The tick skips every unattended start until `wakeAt`, so a full machine is not probed every
// five minutes, and the fire stays owed (its watermark is never advanced) and runs on the first
// tick after. Changing the threshold or an "Only mine" mark clears it.

export function accountWaitPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'automations-account-wait.json');
}

/**
 * `wakeAt` (epoch ms) while it is still in the future, else null. Never throws.
 *
 * A wait is a conclusion about the accounts AS THEY WERE: when the account register changed after
 * it was recorded (an account added, removed, reordered or signed in again, auto-switch, the
 * threshold or an "Only mine" mark), the wait no longer holds and reads as none, so the next
 * start decides afresh.
 */
export function readAccountWait(home: string = homedir(), now: number = Date.now()): number | null {
  try {
    const path = accountWaitPath(home);
    if (!lstatSync(path).isFile()) return null;
    const rec = JSON.parse(readFileSync(path, 'utf-8')) as { wakeAt?: unknown; at?: unknown };
    const v = rec.wakeAt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= now) return null;
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0;
    if (registerChangedSince(home, at)) return null;
    return v;
  } catch {
    return null;
  }
}

/** Did the account register (`claude-accounts.json`) change after `at`? Missing ⇒ no. */
function registerChangedSince(home: string, at: number): boolean {
  try {
    return statSync(claudeAccountsFilePath(home)).mtimeMs > at;
  } catch {
    return false;
  }
}

export function recordAccountWait(wakeAt: number, home: string = homedir(), now: number = Date.now()): void {
  const path = accountWaitPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ wakeAt, at: now }) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

export function clearAccountWait(home: string = homedir()): void {
  try { rmSync(accountWaitPath(home), { force: true }); } catch { /* nothing to clear */ }
}
