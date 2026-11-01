/**
 * One account surface per tool, for the chat server's switch (plan r5 §4d): the same questions on
 * Codex's accounts and on accounts that are T3 instances. The rules live in `account-switch.ts`
 * (`chooseTarget`, the 80/90 % thresholds) and are the same for every tool; only the readings and
 * the rows differ.
 */
import { homedir } from 'node:os';
import {
  chooseTarget, poolReadings, provenPastThreshold, readToolRejections, readToolSignedOut, readingFor,
  SWITCH_THRESHOLD_PERCENT, type AccountReading, type ChooseTargetResult,
} from './account-switch.js';
import { switchStrategyFor, switchWeightsFor } from './claude-accounts.js';
import {
  codexAccountDeps, codexAccountSignedIn, codexLimitsFor, defaultCodexRunner, getCodexAccount, listCodexAccounts,
  readCodexUsage, recordCodexUsage,
} from './codex-accounts.js';
import { codexPaneAccount, decideCodexTarget, probeReading } from './codex-switch.js';
import type { UsageLimitsResponse } from './claude-usage.js';
import {
  INSTANCE_PRIMARY_ID, getInstanceAccount, instanceLimitsFor, isInstanceTool, listInstanceAccounts,
  readInstanceUsage, recordInstanceUsage, type InstanceTool,
} from './instance-accounts.js';

export type AccountTool = 'codex' | InstanceTool;

export function isAccountTool(tool: string | null | undefined): tool is AccountTool {
  return tool === 'codex' || isInstanceTool(tool);
}

export interface ToolAccountRow { id: string; email: string; signedIn: boolean }

export interface ToolSwitch {
  readonly tool: AccountTool;
  list(): ToolAccountRow[];
  get(id: string): ToolAccountRow | null;
  signedIn(id: string): boolean;
  limits(id: string): UsageLimitsResponse;
  /** A live window update from the chat. Tools with no such update never send one. */
  recordUsage(id: string, windows: unknown[], checkedAt: string): void;
  paneAccount(asked: string): string;
  probe(id: string): Promise<AccountReading>;
  decide(input: { activeId: string; active: AccountReading; probe: (id: string) => Promise<AccountReading> }): Promise<ChooseTargetResult>;
  /** Called when a turn ended: a tool with no live windows re-reads a stale one, out of the turn's way. */
  afterTurn(id: string): void;
  /** What a pane moved off a refused account is told after the restart. */
  readonly limitContinueText: string;
}

function lastJsonLine(text: string): Record<string, unknown> | null {
  for (const line of text.trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not this line */ }
  }
  return null;
}

const PROBE_TIMEOUT_MS = 40_000;
/** The probe starts a Node child and calls Google: at most this often per account. */
export const INSTANCE_USAGE_STALE_MS = 5 * 60_000;

/** One account's quota through T3's probe (a short child). Never a model call. */
export async function probeInstanceReading(tool: InstanceTool, id: string, home: string = homedir()): Promise<AccountReading> {
  const deps = codexAccountDeps();
  const cli = deps.cli ?? (process.env.DREAMCONTEXT_CLI || process.argv[1] || '');
  if (!deps.node || !cli) return { id, problem: 'unknown' };
  const args = [cli, 't3-account', 'probe', '--tool', tool, ...(id === INSTANCE_PRIMARY_ID ? [] : ['--account', id])];
  const r = await (deps.run ?? defaultCodexRunner)(deps.node, args, { env: deps.env ?? process.env, timeoutMs: PROBE_TIMEOUT_MS, keepStdout: true });
  const out = r.spawned ? lastJsonLine(r.stdout) : null;
  if (!out?.ok) return { id, problem: 'unknown' };
  if (out.signedIn === false) return { id, problem: 'needs-relogin' };
  const reading = recordInstanceUsage(tool, id, Array.isArray(out.windows) ? out.windows : [], typeof out.checkedAt === 'string' ? out.checkedAt : new Date().toISOString(), home);
  const limits = instanceLimitsFor(reading);
  return limits.limits.length ? { id, limits } : { id, problem: 'healthy-unmeasured' };
}

/** The account a new chat opens on: the first in order that is signed in, not refused and not full. */
export function instanceSpawnAccount(tool: InstanceTool, home: string = homedir(), now: number = Date.now()): string {
  const accounts = listInstanceAccounts(tool, home);
  const refused = readToolRejections(tool, home, now);
  const signedOut = readToolSignedOut(tool, home, now);
  const usable = accounts.filter((a) => a.signedIn && !(a.id in signedOut));
  const clear = usable.find((a) => !(a.id in refused) && !provenPastThreshold(instanceLimitsFor(readInstanceUsage(tool, a.id, home)), SWITCH_THRESHOLD_PERCENT, now));
  return (clear ?? usable[0] ?? accounts[0])?.id ?? INSTANCE_PRIMARY_ID;
}

export async function decideInstanceTarget(tool: InstanceTool, input: { activeId: string; active: AccountReading; probe: (id: string) => Promise<AccountReading>; home?: string; now?: number }): Promise<ChooseTargetResult> {
  const home = input.home ?? homedir();
  const now = input.now ?? Date.now();
  const accounts = listInstanceAccounts(tool, home);
  const signedOut = readToolSignedOut(tool, home, now);
  const readings = await Promise.all(accounts.map(async (acc): Promise<AccountReading> => {
    if (acc.id === input.activeId) return { ...input.active, id: acc.id };
    if (!acc.signedIn || acc.id in signedOut) return { id: acc.id, problem: 'needs-relogin' };
    return input.probe(acc.id).catch(() => readingFor(acc.id, instanceLimitsFor(readInstanceUsage(tool, acc.id, home)), false));
  }));
  return chooseTarget(poolReadings({ [tool]: readings }), tool, {
    threshold: SWITCH_THRESHOLD_PERCENT,
    currentId: input.activeId,
    preferredId: accounts[0]?.id ?? null,
    orderedIds: accounts.map((a) => a.id),
    rejectedUntil: readToolRejections(tool, home, now),
    strategy: switchStrategyFor(home),
    weights: switchWeightsFor(home),
    now,
  });
}

export const CODEX_LIMIT_CONTINUE_TEXT =
  'The previous turn was cut off by a Codex usage limit, and this chat has moved to another ChatGPT account. '
  + 'Continue exactly where you stopped; do not redo finished work.';

const codexSwitch: ToolSwitch = {
  tool: 'codex',
  list: () => listCodexAccounts(),
  get: (id) => getCodexAccount(id),
  signedIn: (id) => codexAccountSignedIn(id),
  limits: (id) => codexLimitsFor(readCodexUsage(id)),
  recordUsage: (id, windows, checkedAt) => { recordCodexUsage(id, windows, checkedAt, 'session'); },
  paneAccount: (asked) => codexPaneAccount(asked),
  probe: (id) => probeReading(id, codexAccountDeps()),
  decide: (input) => decideCodexTarget(input),
  afterTurn: () => undefined,
  limitContinueText: CODEX_LIMIT_CONTINUE_TEXT,
};

function instanceSwitch(tool: InstanceTool): ToolSwitch {
  const name = tool === 'antigravity' ? 'Antigravity' : tool;
  return {
    tool,
    list: () => listInstanceAccounts(tool),
    get: (id) => getInstanceAccount(tool, id),
    signedIn: (id) => !!getInstanceAccount(tool, id)?.signedIn,
    limits: (id) => instanceLimitsFor(readInstanceUsage(tool, id)),
    recordUsage: () => undefined,
    paneAccount: (asked) => (asked && getInstanceAccount(tool, asked) ? asked : instanceSpawnAccount(tool)),
    probe: (id) => probeInstanceReading(tool, id),
    decide: (input) => decideInstanceTarget(tool, input),
    afterTurn: (id) => {
      const checked = Date.parse(readInstanceUsage(tool, id)?.checkedAt ?? '');
      if (Number.isFinite(checked) && Date.now() - checked < INSTANCE_USAGE_STALE_MS) return;
      void probeInstanceReading(tool, id).catch(() => undefined);
    },
    limitContinueText: `The previous turn was cut off by a ${name} usage limit, and this chat has moved to another account, which starts a fresh thread. Continue from the earlier conversation if its end is attached, otherwise from the task log, and do not redo finished work.`,
  };
}

export function toolSwitchFor(tool: AccountTool): ToolSwitch {
  return tool === 'codex' ? codexSwitch : instanceSwitch(tool);
}

