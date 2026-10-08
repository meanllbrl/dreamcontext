import { homedir } from 'node:os';
import {
  autoSwitchEnabled, listClaudeAccounts, resolveConfigDir, switchStrategyFor, switchWeightsFor,
  type ClaudeAccount,
} from '../claude-accounts.js';
import {
  chooseAccount, shouldProbe, shouldSwitchAway, SWITCH_THRESHOLD_PERCENT, type AccountReading,
} from '../claude-account-switch.js';
import { readAccountRejections } from '../claude-limit-rejections.js';
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
 * turn path otherwise: OFF / one account / `sequential` without a refusal keep the preferred
 * account; only a refusal or a CURRENT reading past the switch threshold moves it; and a blind
 * pick (`unmeasured`) is refused, since staying put lets the turn path probe properly.
 */
export function chatSpawnAccount(deps: Pick<PickDeps, 'home' | 'now'> & {
  /** Injectable so a test reads its own fixture, not a `.claude.json` under the real HOME. */
  readUsage?: (configDir: string) => UsageLimitsResponse;
} = {}): AutomationAccount {
  try {
    const c = contextFor(deps);
    const { home, now, accounts, preferred, fallback, rejectedUntil } = c;
    if (accounts.length < 2 || !autoSwitchEnabled(home) || !preferred) return fallback;
    const dirOf = (a: ClaudeAccount): string => a.configDir ?? home;
    const read = deps.readUsage ?? cachedUsage;
    if (!rejectedUntil[preferred.id]) {
      if (switchStrategyFor(home) === 'sequential') return fallback;
      const cached = read(dirOf(preferred));
      if (!usageReadingIsCurrent(cached, now) || !shouldSwitchAway(cached, undefined, now)) return fallback;
    }
    const readings = accounts.map((a): AccountReading => {
      const cached = read(dirOf(a));
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
    });
    const winner = choice.accountId === null || choice.unmeasured
      ? null
      : accounts.find((a) => a.id === choice.accountId);
    return winner ? toAccount(winner, home) : fallback;
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
