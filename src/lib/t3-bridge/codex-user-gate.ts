/**
 * One write gate for the whole Mac: our PreToolUse hook in `~/.codex/hooks.json`, which Codex loads
 * in every folder with no project trust (seen on 0.164: `hooks/list` says `source: user`).
 *
 * Codex still skips the hook until its exact definition is trusted. Both directions go through
 * Codex's own app-server, never through its files:
 *  - is it live? `hooks/list` answers, in the env a child really gets. A hash we do not compute,
 *    a Codex that changes how it hashes, `features.hooks = false`: all read as "not live", and a
 *    child is refused.
 *  - approving: `config/batchWrite` of `hooks.state."<key>".trusted_hash`, the key Codex's `/hooks`
 *    writes, with the key and hash Codex itself reported, for OUR hook only.
 *
 * An account home is a folder of symlinks, and Codex keys the hook by that folder, so one approval
 * does not reach it by itself. Just before a child starts there, the owner's approval is carried
 * over: same definition (Codex's own hash), same trust, no second card (`carryGateToAccount`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexChildEnv, codexCommand } from '../codex-bin.js';
import { isCodexAccountId, codexAccountHome } from './accounts.js';

/** A hook's command, in the file Codex reads. Its text is part of the hash Codex trusts. */
export function codexHookCommand(event: string): string {
  return `command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook ${event} --format codex || exec npx dreamcontext hook ${event} --format codex`;
}

/**
 * The Mac-wide gate has no `npx` fallback: `npx` resolves from the working directory, so a cloned
 * repo's own `node_modules/.bin/dreamcontext` would run on every tool call, in any folder. A
 * missing CLI fails visibly instead, and a child is refused before that (`globalHookAnswers`).
 */
export const CODEX_USER_GATE_COMMAND = 'dreamcontext hook pre-tool-use --format codex';
export const CODEX_GATE_SPEC = { event: 'PreToolUse', name: 'pre-tool-use', timeout: 5, command: CODEX_USER_GATE_COMMAND } as const;

export interface CodexHook {
  readonly key: string;
  readonly eventName: string;
  readonly handlerType: string;
  readonly command?: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly enabled: boolean;
  readonly currentHash: string;
  readonly trustStatus: string;
}

type Call = { method: string; params: unknown };
export type Rpc = (calls: readonly Call[], cwd: string, codexHome: string) => Array<{ result?: unknown; error?: unknown }> | null;

/**
 * `codex app-server` answers only while its stdin is open, so a one-shot spawnSync loses the
 * replies: a small Node child holds the pipe and asks in turn. The gate check runs on a sync path.
 */
const RPC_CHILD = `
const { spawn } = require('node:child_process');
const [bin, raw] = process.argv.slice(1);
const calls = JSON.parse(raw);
const p = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const out = [];
const send = (o) => p.stdin.write(JSON.stringify(o) + '\\n');
const next = () => { if (out.length === calls.length) { process.stdout.write(JSON.stringify(out), () => { p.kill(); process.exit(0); }); return; } send({ id: 100 + out.length, ...calls[out.length] }); };
let buf = '';
p.on('error', () => process.exit(1));
p.on('exit', () => process.exit(1));
p.stdin.on('error', () => process.exit(1));
p.stdout.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) { send({ method: 'initialized' }); next(); }
    else if (m.id === 100 + out.length) { out.push({ result: m.result, error: m.error }); next(); }
  }
});
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dreamcontext', title: 'dreamcontext', version: '0' }, capabilities: { experimentalApi: true } } });
`;

export const codexRpc: Rpc = (calls, cwd, codexHome) => {
  const r = spawnSync(process.execPath, ['-e', RPC_CHILD, codexCommand(), JSON.stringify(calls)], { cwd, env: { ...codexChildEnv(process.env), CODEX_HOME: codexHome }, encoding: 'utf-8', timeout: 15_000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as Array<{ result?: unknown; error?: unknown }>; } catch { return null; }
};

/** What Codex itself says it would run in this folder. Null: it would not say. */
export function listCodexHooks(cwd: string, codexHome: string, rpc: Rpc = codexRpc): CodexHook[] | null {
  const reply = rpc([{ method: 'hooks/list', params: { cwds: [cwd] } }], cwd, codexHome)?.[0];
  const data = (reply?.result as { data?: Array<{ hooks?: CodexHook[] }> } | undefined)?.data;
  return Array.isArray(data) ? data.flatMap((d) => d.hooks ?? []) : null;
}

const realOf = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

/** Exactly our hook, in exactly this home's user file: never a look-alike from anywhere else. */
function ourGate(hooks: readonly CodexHook[], codexHome: string): CodexHook[] {
  const file = join(realOf(codexHome), 'hooks.json');
  return hooks.filter((h) => h.source === 'user' && h.sourcePath === file && h.eventName === 'preToolUse' && h.handlerType === 'command' && h.command === CODEX_USER_GATE_COMMAND);
}

/** This folder's own opted-in hook: the per-project way, in exactly this folder. */
function projectGate(hooks: readonly CodexHook[], cwd: string): CodexHook[] {
  const file = join(realOf(cwd), '.codex', 'hooks.json');
  return hooks.filter((h) => h.source === 'project' && h.sourcePath === file && h.eventName === 'preToolUse' && h.handlerType === 'command' && h.command === codexHookCommand(CODEX_GATE_SPEC.name));
}

const live = (h: CodexHook): boolean => h.enabled && h.trustStatus === 'trusted';

export function codexGateLive(hooks: readonly CodexHook[], codexHome: string, cwd: string): boolean {
  return [...ourGate(hooks, codexHome), ...projectGate(hooks, cwd)].some(live);
}

/** The Codex home a child of this account runs from: `~/.codex`, or the account's own. */
export function codexHomeFor(home: string, accountId?: string | null): string {
  return accountId && isCodexAccountId(accountId) ? codexAccountHome(home, accountId) : join(home, '.codex');
}

/** Did this project opt in itself? `~/.codex` is the Mac-wide file, which opts in nothing. */
export function codexProjectOptedIn(from: string, home: string = homedir()): boolean {
  const userFile = join(home, '.codex', 'hooks.json');
  for (let dir = from; ; dir = dirname(dir)) {
    const file = join(dir, '.codex', 'hooks.json');
    if (file !== userFile && existsSync(file)) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** A key we hand back inside a TOML path, a hash we hand back as a value. */
const writable = (h: CodexHook): boolean => !/["\\\n]/.test(h.key) && /^sha256:[0-9a-f]{64}$/.test(h.currentHash);

const recordTrust = (hook: CodexHook, cwd: string, primary: string, rpc: Rpc) => rpc([{ method: 'config/batchWrite', params: { edits: [{ keyPath: `hooks.state."${hook.key}".trusted_hash`, value: hook.currentHash, mergeStrategy: 'upsert' }], reloadUserConfig: false } }], cwd, primary)?.[0];

export interface GateApproval {
  /** The hook key Codex recorded now; null when it was already trusted or nothing was written. */
  readonly approved: string | null;
  /** Why the gate is not live after this; empty = it is. */
  readonly problems: string[];
}

/**
 * Trust OUR hook in `~/.codex/hooks.json`. Every other hook stays as it is: nothing reaches the
 * write but `ourGate`, and a disabled gate stays the owner's. The answer is Codex's own, read back.
 */
export function approveCodexGate(cwd: string, home: string = homedir(), rpc: Rpc = codexRpc): GateApproval {
  const primary = join(home, '.codex');
  const hooks = listCodexHooks(cwd, primary, rpc);
  if (!hooks) return { approved: null, problems: ['Codex did not answer.'] };
  const ours = ourGate(hooks, primary);
  if (ours.length !== 1) return { approved: null, problems: [`Codex lists ${ours.length} dreamcontext gates, expected 1.`] };
  const hook = ours[0]!;
  if (!hook.enabled) return { approved: null, problems: ['The gate hook is switched off in Codex; turn it on with /hooks.'] };
  if (hook.trustStatus === 'trusted') return { approved: null, problems: [] };
  if (!writable(hook)) return { approved: null, problems: ['Codex reported a hook key or hash this version cannot write safely.'] };
  const wrote = recordTrust(hook, cwd, primary, rpc);
  if (!wrote || wrote.error) return { approved: null, problems: [`Codex refused the approval: ${JSON.stringify(wrote?.error ?? 'no answer')}`] };
  const after = listCodexHooks(cwd, primary, rpc);
  return after && ourGate(after, primary).some(live) ? { approved: hook.key, problems: [] } : { approved: null, problems: ['Codex does not report the gate as trusted after the write.'] };
}

/**
 * The owner approved the gate for every account. An account that signed in later has no approval
 * line, and its home may lack the link to the hooks file, because T3 lays it out only when a
 * session opens, which is after this check. So, just before a child starts there: link the file
 * the way T3 would, and record trust for exactly what `~/.codex` already trusts, by Codex's own
 * hash. Anything else stays untrusted and the child is refused.
 */
export function carryGateToAccount(cwd: string, home: string, codexHome: string, rpc: Rpc = codexRpc): void {
  const primary = join(home, '.codex');
  const trusted = ourGate(listCodexHooks(cwd, primary, rpc) ?? [], primary).find(live);
  if (!trusted) return;
  const link = join(codexHome, 'hooks.json');
  try { lstatSync(link); } catch {
    try { symlinkSync(join(primary, 'hooks.json'), link); } catch { return; }
  }
  const ours = ourGate(listCodexHooks(cwd, codexHome, rpc) ?? [], codexHome);
  const hook = ours.length === 1 ? ours[0]! : null;
  if (hook && hook.enabled && hook.trustStatus !== 'trusted' && hook.currentHash === trusted.currentHash && writable(hook)) recordTrust(hook, cwd, primary, rpc);
}
