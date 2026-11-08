/**
 * Codex accounts in the shared switch (plan r5 §4d "Usage readings" / "Decision"): readings in
 * the chooser's `AccountReading` shape, where a new Codex chat opens, and the decision a running
 * Codex chat takes near or at a limit. The rules are Claude's, through the same functions
 * (`chooseTarget` → `chooseAccount`, `shouldSwitchAway`, the 80/90 % thresholds); only the
 * readings and the stores are Codex's.
 */
import { homedir } from 'node:os';
import {
  chooseTarget, poolReadings, provenPastThreshold, readToolRejections, readToolSignedOut, readingFor,
  SWITCH_THRESHOLD_PERCENT, type AccountReading, type ChooseTargetResult, type FallbackPolicy,
} from './account-switch.js';
import { codexRules } from './account-rules.js';
import {
  CODEX_PRIMARY_ID, codexLimitsFor, listCodexAccounts, probeCodexAccount, readCodexUsage, type CodexAccount, type CodexAccountDeps,
} from './codex-accounts.js';

/** What we hold for one account right now, without a probe. */
export function codexCachedReading(acc: CodexAccount, home: string = homedir(), now: number = Date.now()): AccountReading {
  const signedOut = !acc.signedIn || acc.id in readToolSignedOut('codex', home, now);
  return readingFor(acc.id, codexLimitsFor(readCodexUsage(acc.id, home)), signedOut);
}

/**
 * The account a NEW Codex chat opens on: the first in the owner's order that is signed in, not
 * refused and not proven past the threshold; else the first signed-in one; else #0.
 */
export function codexSpawnAccount(home: string = homedir(), now: number = Date.now()): string {
  const accounts = listCodexAccounts(home);
  const refused = readToolRejections('codex', home, now);
  const signedOut = readToolSignedOut('codex', home, now);
  const usable = accounts.filter((a) => a.signedIn && !(a.id in signedOut));
  const clear = usable.find((a) => !(a.id in refused) && !provenPastThreshold(codexLimitsFor(readCodexUsage(a.id, home)), SWITCH_THRESHOLD_PERCENT, now));
  return (clear ?? usable[0] ?? accounts[0])?.id ?? CODEX_PRIMARY_ID;
}

export interface CodexDecisionInput {
  /** The account the chat runs on. */
  activeId: string;
  /** The active account's reading, already in hand (not re-probed). */
  active: AccountReading;
  home?: string;
  now?: number;
  /** Probe the OTHER accounts before choosing (a decision is worth one probe each). */
  probe?: (id: string) => Promise<AccountReading>;
  policy?: FallbackPolicy;
}

/** A probe outcome in the chooser's shape. */
export async function probeReading(id: string, deps: CodexAccountDeps): Promise<AccountReading> {
  const out = await probeCodexAccount(id, deps);
  if (out.status === 'needs-relogin') return { id, problem: 'needs-relogin' };
  if (out.status !== 'ok' || !out.reading) return { id, problem: 'unknown' };
  const limits = codexLimitsFor(out.reading);
  return limits.limits.length ? { id, limits } : { id, problem: 'healthy-unmeasured' };
}

/** Where a Codex chat's next turn should go: the same chooser, over Codex readings. */
export async function decideCodexTarget(input: CodexDecisionInput): Promise<ChooseTargetResult> {
  const home = input.home ?? homedir();
  const now = input.now ?? Date.now();
  const accounts = listCodexAccounts(home);
  const signedOut = readToolSignedOut('codex', home, now);
  const readings = await Promise.all(accounts.map(async (acc): Promise<AccountReading> => {
    if (acc.id === input.activeId) return { ...input.active, id: acc.id };
    if (!acc.signedIn || acc.id in signedOut) return { id: acc.id, problem: 'needs-relogin' };
    return input.probe ? input.probe(acc.id) : codexCachedReading(acc, home, now);
  }));
  return chooseTarget(poolReadings({ codex: readings }), 'codex', {
    threshold: SWITCH_THRESHOLD_PERCENT,
    currentId: input.activeId,
    preferredId: accounts[0]?.id ?? null,
    orderedIds: accounts.map((a) => a.id),
    rejectedUntil: readToolRejections('codex', home, now),
    // Codex's OWN rules (Settings → Models → Codex); they read Claude's until first edited.
    strategy: codexRules(home).strategy,
    weights: codexRules(home).weights,
    now,
  }, input.policy);
}

/** The Codex account a pane opens on: the one asked for when registered, else the spawn default. */
export function codexPaneAccount(asked: string, home: string = homedir()): string {
  if (asked && listCodexAccounts(home).some((a) => a.id === asked)) return asked;
  return codexSpawnAccount(home);
}
