/**
 * Account switching keyed by TOOL (plan r5 §4b, §4d, §4e; Track T W2).
 *
 * One decision for every tool: the pure chooser (`chooseAccount`, `shouldSwitchAway`, the 80/90 %
 * thresholds) lives in `claude-account-switch.ts` and is used here unchanged. What this module adds
 * is the tool in the key:
 *   - the refusal and signed-out stores per tool. Claude keeps its own files and modules exactly as
 *     they were (`claude-limit-rejections.ts`, `claude-signed-out.ts`); every other tool gets the
 *     same shape in its own file, so one tool's wall never disqualifies another tool's account;
 *   - the readings pool, keyed by `(tool, accountId)`: the one place a later cross-tool rule scans;
 *   - `chooseTarget()`, which wraps `chooseAccount` and answers `{tool, accountId}`;
 *   - `FallbackPolicy`, a stub that is `'never'` by default and has no other value yet.
 *
 * The direction is deliberate: the Claude modules are re-exported from here rather than moved,
 * so not one line of today's Claude switch changes (W2 criterion 1).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chooseAccount, type AccountReading, type ChooseOptions, type ChooseResult } from './claude-account-switch.js';
import { readAccountRejections, recordAccountRejection, clearAccountRejection, DEFAULT_COOLDOWN_MS, type AccountRejection } from './claude-limit-rejections.js';
import { clearSignedOut, readSignedOut, recordSignedOut, SIGNED_OUT_FOR_MS } from './claude-signed-out.js';
import type { LimitSignal } from './claude-limit-signal.js';
import type { UsageLimitsResponse } from './claude-usage.js';

export {
  chooseAccount, shouldSwitchAway, shouldProbe, provenPastThreshold,
  PROBE_THRESHOLD_PERCENT, SWITCH_THRESHOLD_PERCENT,
  type AccountReading, type ChooseOptions, type ChooseResult,
} from './claude-account-switch.js';

/** A tool whose accounts can be switched. Mirrors `t3-bridge/registry.ts` `ToolId`. */
export type SwitchTool = 'claude' | 'codex';

/** Where a chat should run next. Today `tool` is always the chat's own tool (§4e). */
export interface SwitchTarget {
  tool: SwitchTool;
  accountId: string;
}

/** One account's reading in the shared pool. */
export interface PooledReading extends AccountReading {
  tool: SwitchTool;
}

/**
 * What happens when every account of a chat's own tool is out of room. `'never'` is the only
 * value in this task: no chat changes tool through policy. The later cross-tool rule adds values
 * here and nothing in the account or driver layer (plan §4e, "Later").
 */
export type FallbackPolicy = 'never';
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = 'never';

/** `agent-ui.json`'s `fallbackPolicy`, read leniently: anything unknown is `'never'`. */
export function asFallbackPolicy(_value: unknown): FallbackPolicy {
  return 'never';
}

/** The pool keyed by `(tool, accountId)`. A key never collides across tools. */
export function poolKey(tool: SwitchTool, accountId: string): string {
  return `${tool}:${accountId}`;
}

export function poolReadings(byTool: Partial<Record<SwitchTool, AccountReading[]>>): Map<string, PooledReading> {
  const pool = new Map<string, PooledReading>();
  for (const [tool, readings] of Object.entries(byTool) as Array<[SwitchTool, AccountReading[] | undefined]>) {
    for (const r of readings ?? []) pool.set(poolKey(tool, r.id), { ...r, tool });
  }
  return pool;
}

export interface ChooseTargetResult extends ChooseResult {
  /** `null` exactly when `accountId` is null. */
  target: SwitchTarget | null;
}

/**
 * The account the chat's next turn should run on, as a target. `chooseAccount` decides inside
 * the chat's own tool, with its options unchanged. Only when that finds nothing would the
 * fallback policy be asked, and under `'never'` the answer stays null: the chat waits for its
 * own tool's reset, as Claude chats do today.
 */
export function chooseTarget(
  pool: ReadonlyMap<string, PooledReading>,
  chatTool: SwitchTool,
  opts: ChooseOptions,
  policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
): ChooseTargetResult {
  const own = [...pool.values()].filter((r) => r.tool === chatTool).map(({ tool: _tool, ...r }) => r);
  const choice = chooseAccount(own, opts);
  if (choice.accountId !== null) return { ...choice, target: { tool: chatTool, accountId: choice.accountId } };
  void policy; // 'never': no other tool is consulted.
  return { ...choice, target: null };
}

// ── Refusal and signed-out stores, per tool ───────────────────────────────────────────

/** Never longer than a week: one frame must not exile an account for days (Claude's rule). */
const MAX_COOLDOWN_MS = 8 * 86_400_000;

function toolFile(tool: Exclude<SwitchTool, 'claude'>, what: 'limits' | 'signedout', home: string): string {
  return join(home, '.dreamcontext', `${tool}-account-${what}.json`);
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best effort: the next refusal records it again */ }
}

function storedRejections(tool: Exclude<SwitchTool, 'claude'>, home: string, now: number): Record<string, AccountRejection> {
  const raw = readJson(toolFile(tool, 'limits', home)).rejected;
  const out: Record<string, AccountRejection> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<AccountRejection> | null;
    if (!r || typeof r.until !== 'number' || typeof r.at !== 'number' || r.until <= now) continue;
    out[id] = {
      until: r.until,
      at: r.at,
      window: r.window === 'session' || r.window === 'weekly' ? r.window : 'unknown',
      ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
      ...(r.estimated ? { estimated: true } : {}),
    };
  }
  return out;
}

/** Every refusal still in force for one tool's accounts. Never throws. */
export function readToolRejections(tool: SwitchTool, home: string = homedir(), now: number = Date.now()): Record<string, AccountRejection> {
  if (tool === 'claude') return readAccountRejections(home, now);
  return storedRejections(tool, home, now);
}

/** Write a refusal down for one tool's account. The later `until` wins, as for Claude. */
export function recordToolRejection(
  tool: SwitchTool, accountId: string, signal: LimitSignal, home: string = homedir(), now: number = Date.now(),
): AccountRejection {
  if (tool === 'claude') return recordAccountRejection(accountId, signal, home, now);
  const stated = signal.resetsAtMs !== null && signal.resetsAtMs > now ? Math.min(signal.resetsAtMs, now + MAX_COOLDOWN_MS) : null;
  const entry: AccountRejection = {
    until: stated ?? now + DEFAULT_COOLDOWN_MS,
    window: signal.window,
    at: now,
    ...(signal.detail ? { detail: signal.detail } : {}),
    ...(stated === null ? { estimated: true } : {}),
  };
  const current = storedRejections(tool, home, now);
  const previous = current[accountId];
  let merged = entry;
  if (previous && previous.until > entry.until) {
    const { estimated: _fromNew, ...rest } = entry;
    merged = { ...rest, until: previous.until, ...(previous.estimated ? { estimated: true } : {}) };
  }
  writeJson(toolFile(tool, 'limits', home), { rejected: { ...current, [accountId]: merged } });
  return merged;
}

export function clearToolRejection(tool: SwitchTool, accountId: string, home: string = homedir(), now: number = Date.now()): void {
  if (tool === 'claude') return clearAccountRejection(accountId, home, now);
  const current = storedRejections(tool, home, now);
  if (!(accountId in current)) return;
  delete current[accountId];
  writeJson(toolFile(tool, 'limits', home), { rejected: current });
}

export function readToolSignedOut(tool: SwitchTool, home: string = homedir(), now: number = Date.now()): Record<string, number> {
  if (tool === 'claude') return readSignedOut(home, now);
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(readJson(toolFile(tool, 'signedout', home)))) {
    if (typeof at === 'number' && Number.isFinite(at) && now - at <= SIGNED_OUT_FOR_MS) out[id] = at;
  }
  return out;
}

export function recordToolSignedOut(tool: SwitchTool, accountId: string, home: string = homedir(), now: number = Date.now()): void {
  if (!accountId) return;
  if (tool === 'claude') return recordSignedOut(accountId, home, now);
  writeJson(toolFile(tool, 'signedout', home), { ...readToolSignedOut(tool, home, now), [accountId]: now });
}

export function clearToolSignedOut(tool: SwitchTool, accountId: string, home: string = homedir()): boolean {
  if (tool === 'claude') return clearSignedOut(accountId, home);
  const all = readToolSignedOut(tool, home);
  if (!(accountId in all)) return false;
  delete all[accountId];
  writeJson(toolFile(tool, 'signedout', home), all);
  return true;
}

/** The reading the chooser gets for an account we hold limits for (no probe here). */
export function readingFor(id: string, limits: UsageLimitsResponse | null, signedOut: boolean): AccountReading {
  if (signedOut) return { id, problem: 'needs-relogin' };
  if (!limits || limits.limits.length === 0) return { id, problem: 'unknown' };
  return { id, limits };
}
