import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  asSwitchStrategy,
  sanitizeSwitchWeights,
  type SwitchStrategy,
  type SwitchWeights,
} from './claude-account-switch.js';
import {
  agentThresholdFor,
  autoSwitchEnabled,
  switchStrategyFor,
  switchWeightsFor,
} from './claude-accounts.js';

/**
 * Account LIMIT RULES per tool (Settings → Models → a tool's tab → Limit rules).
 *
 * ── Why a separate file ───────────────────────────────────────────────────────────────
 * Claude's rules live in `claude-accounts.json`, but `writeClaudeAccounts` rebuilds that
 * register from fixed keys on every account write, so a `codex` key stored there would be
 * dropped by the next reorder. Claude's file and every one of its readers stay exactly as
 * they were; this file holds what is new:
 *
 *   ~/.dreamcontext/account-rules.json
 *   { claude: { onExhausted }, codex: { autoSwitch, strategy, weights, agentThreshold, onExhausted } }
 *
 * ── Codex reads through to Claude until it is pinned ──────────────────────────────────
 * Before this file existed Codex obeyed Claude's switch rules. An ABSENT Codex value still
 * reads Claude's, so nothing changes on a machine that never opens the new tab. The first
 * time anyone edits a rule (either tool), {@link pinCodexRules} copies Claude's current
 * values into the Codex block, so from then on a Claude edit can never move Codex.
 *
 * ── When every account is out ─────────────────────────────────────────────────────────
 * `onExhausted` defaults to `stop` per tool: the chat reports and waits for the owner.
 * `continue` resumes the chat once at the reported reset, which spends tokens unattended,
 * so it is never the default.
 *
 * Cold, machine-local, human-written rarely: the same plain atomic temp+rename as
 * `claude-accounts.ts` (no lock).
 */

export type RulesTool = 'claude' | 'codex';
export type OnExhausted = 'stop' | 'continue';

export const DEFAULT_ON_EXHAUSTED: OnExhausted = 'stop';

export interface ToolRules {
  autoSwitch: boolean;
  strategy: SwitchStrategy;
  weights: SwitchWeights;
  agentThreshold: number;
  onExhausted: OnExhausted;
}

/** What a patch may carry; each key is applied on its own. */
export type ToolRulesPatch = Partial<ToolRules>;

interface StoredCodex {
  autoSwitch?: boolean;
  strategy?: SwitchStrategy;
  weights?: SwitchWeights;
  agentThreshold?: number;
  onExhausted?: OnExhausted;
}

interface StoredRules {
  claude?: { onExhausted?: OnExhausted };
  codex?: StoredCodex;
}

export class AccountRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountRulesError';
  }
}

export function accountRulesFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'account-rules.json');
}

export function isOnExhausted(v: unknown): v is OnExhausted {
  return v === 'stop' || v === 'continue';
}

export function isAgentThreshold(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The stored file, field by field; an unreadable file or a bad field reads as absent. Never throws. */
function readStored(home: string): StoredRules {
  const filePath = accountRulesFilePath(home);
  if (!existsSync(filePath)) return {};
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return {};
  }
  if (!parsed) return {};
  const out: StoredRules = {};
  const claude = asRecord(parsed.claude);
  if (claude && isOnExhausted(claude.onExhausted)) out.claude = { onExhausted: claude.onExhausted };
  const codex = asRecord(parsed.codex);
  if (codex) {
    const c: StoredCodex = {};
    if (typeof codex.autoSwitch === 'boolean') c.autoSwitch = codex.autoSwitch;
    const strategy = asSwitchStrategy(codex.strategy);
    if (strategy) c.strategy = strategy;
    if (asRecord(codex.weights)) c.weights = sanitizeSwitchWeights(codex.weights);
    if (isAgentThreshold(codex.agentThreshold)) c.agentThreshold = codex.agentThreshold;
    if (isOnExhausted(codex.onExhausted)) c.onExhausted = codex.onExhausted;
    if (Object.keys(c).length > 0) out.codex = c;
  }
  return out;
}

function writeStored(rules: StoredRules, home: string): void {
  const filePath = accountRulesFilePath(home);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(rules, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

/** Claude's rules: its switch policy from its own register, plus `onExhausted` from here. */
export function claudeRules(home: string = homedir()): ToolRules {
  return {
    autoSwitch: autoSwitchEnabled(home),
    strategy: switchStrategyFor(home),
    weights: switchWeightsFor(home),
    agentThreshold: agentThresholdFor(home),
    onExhausted: readStored(home).claude?.onExhausted ?? DEFAULT_ON_EXHAUSTED,
  };
}

/** Codex's rules: each stored value, else Claude's (today's behaviour), else the default. */
export function codexRules(home: string = homedir()): ToolRules {
  const c = readStored(home).codex ?? {};
  return {
    autoSwitch: c.autoSwitch ?? autoSwitchEnabled(home),
    strategy: c.strategy ?? switchStrategyFor(home),
    weights: c.weights ?? switchWeightsFor(home),
    agentThreshold: c.agentThreshold ?? agentThresholdFor(home),
    onExhausted: c.onExhausted ?? DEFAULT_ON_EXHAUSTED,
  };
}

export function rulesFor(tool: RulesTool, home: string = homedir()): ToolRules {
  return tool === 'codex' ? codexRules(home) : claudeRules(home);
}

/**
 * Copy Claude's current switch policy into every Codex key that is still absent, once.
 * Called before ANY Claude policy write, so the edit cannot drag Codex along. A no-op (no
 * write at all) when every Codex key is already stored.
 */
export function pinCodexRules(home: string = homedir()): void {
  const stored = readStored(home);
  const c = stored.codex ?? {};
  if (c.autoSwitch !== undefined && c.strategy !== undefined && c.weights !== undefined && c.agentThreshold !== undefined) return;
  const next: StoredCodex = {
    ...c,
    autoSwitch: c.autoSwitch ?? autoSwitchEnabled(home),
    strategy: c.strategy ?? switchStrategyFor(home),
    weights: c.weights ?? switchWeightsFor(home),
    agentThreshold: c.agentThreshold ?? agentThresholdFor(home),
  };
  writeStored({ ...stored, codex: next }, home);
}

/**
 * Validate a raw patch from the wire. A present-but-wrong value is refused with the rule it
 * broke (never silently replaced), the same contract as the Claude policy routes.
 */
export function parseRulesPatch(raw: unknown): ToolRulesPatch {
  const o = asRecord(raw);
  if (!o) throw new AccountRulesError('`patch` must be an object.');
  const patch: ToolRulesPatch = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(o, k);
  if (has('autoSwitch')) {
    if (typeof o.autoSwitch !== 'boolean') throw new AccountRulesError('`autoSwitch` must be true or false.');
    patch.autoSwitch = o.autoSwitch;
  }
  if (has('strategy')) {
    const s = asSwitchStrategy(o.strategy);
    if (!s) throw new AccountRulesError('`strategy` must be "score" or "sequential".');
    patch.strategy = s;
  }
  if (has('weights')) {
    const w = asRecord(o.weights);
    if (!w) throw new AccountRulesError('`weights` must be an object.');
    for (const key of ['session', 'weekly', 'order'] as const) {
      if (!Object.prototype.hasOwnProperty.call(w, key)) continue;
      const n = w[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new AccountRulesError(`\`weights.${key}\` must be a number of 0 or more.`);
    }
    patch.weights = w as unknown as SwitchWeights;
  }
  if (has('agentThreshold')) {
    if (!isAgentThreshold(o.agentThreshold)) throw new AccountRulesError('`agentThreshold` must be a whole number from 1 to 100.');
    patch.agentThreshold = o.agentThreshold;
  }
  if (has('onExhausted')) {
    if (!isOnExhausted(o.onExhausted)) throw new AccountRulesError('`onExhausted` must be "stop" or "continue".');
    patch.onExhausted = o.onExhausted;
  }
  if (Object.keys(patch).length === 0) throw new AccountRulesError('Send at least one rule to change.');
  return patch;
}

/**
 * Write a Codex patch into this file only. `claude-accounts.json` is never opened for
 * writing here, so a Codex edit leaves it byte-identical. Pins first, so the keys the patch
 * does not mention stop following Claude at the same moment.
 */
export function setCodexRules(patch: ToolRulesPatch, home: string = homedir()): ToolRules {
  pinCodexRules(home);
  const stored = readStored(home);
  const c: StoredCodex = { ...(stored.codex ?? {}) };
  if (patch.autoSwitch !== undefined) c.autoSwitch = patch.autoSwitch;
  if (patch.strategy !== undefined) c.strategy = patch.strategy;
  if (patch.weights !== undefined) c.weights = sanitizeSwitchWeights({ ...(c.weights ?? switchWeightsFor(home)), ...patch.weights });
  if (patch.agentThreshold !== undefined) c.agentThreshold = patch.agentThreshold;
  if (patch.onExhausted !== undefined) c.onExhausted = patch.onExhausted;
  writeStored({ ...stored, codex: c }, home);
  return codexRules(home);
}

/** Claude's `onExhausted` is the only Claude rule stored here; the rest stays in its register. */
export function setClaudeOnExhausted(value: OnExhausted, home: string = homedir()): void {
  pinCodexRules(home);
  const stored = readStored(home);
  writeStored({ ...stored, claude: { onExhausted: value } }, home);
}
