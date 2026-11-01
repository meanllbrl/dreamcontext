/**
 * The write gate on Antigravity: our PreToolUse hook in the account profile's `config/hooks.json`.
 * Measured on agent 1.4.1 with a real turn (2026-11-01):
 *  - the agent runs it before every tool, in every mode, Bypass included; a `deny` stops a shell write
 *    and the agent's own file tools; no trust step, because it is the global file (GEMINI_HOME);
 *  - it fails closed: a hook that exits non-zero, times out or prints something not JSON is a deny.
 *    Empty stdout is an allow;
 *  - a project's `.agents/hooks.json` cannot take it away: a hook of the same name with `enabled:
 *    false` loses to the global file, and an `allow` from it does not stop ours running. Untrusted,
 *    that file is suppressed and the agent asks the owner first (a card, or nobody, for a child);
 *  - `command` is split by `shlex` and run with no shell, in the project's folder.
 *
 * There is no way to ask the agent which hooks it loaded, so readiness is the file plus the hook
 * answering, and a Super child also proves the gate ran before anything it does is allowed (the beat).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { antigravityProfileDir } from './antigravity-accounts.js';

export const ANTIGRAVITY_GATE_NAME = 'dreamcontext-gate';
/** The hook touches this file each time it runs, so a child can prove it did. */
export const GATE_BEAT_ENV = 'DREAMCONTEXT_GATE_BEAT';
const GATE_TIMEOUT_SECONDS = 15;

/** One argument for the agent's `shlex.split` (no shell runs it). */
const shlexQuote = (word: string): string => `'${word.replace(/'/g, `'"'"'`)}'`;

export function antigravityGateCommand(node: string, cli: string): string {
  return [node, cli, 'hook', 'pre-tool-use', '--format', 'antigravity'].map(shlexQuote).join(' ');
}

export const antigravityHooksFile = (accountId: string, home: string = homedir()): string =>
  join(antigravityProfileDir(accountId, home), 'config', 'hooks.json');

const nearestReal = (abs: string): string => {
  for (let at = abs, rest = ''; ; rest = `/${basename(at)}${rest}`, at = dirname(at)) {
    try { return realpathSync.native(at) + rest; } catch { if (dirname(at) === at) return abs; }
  }
};

/**
 * The gate's hook file, or a folder that holds it, in any account's profile, however it is spelled:
 * `..`, a link, another case. The agent must not change its own gate, or move it away.
 */
export function isAntigravityGateFile(path: string): boolean {
  const gate = /\/providers\/antigravity\/[0-9a-f]{64}(?:\/config(?:\/hooks\.json)?)?$/;
  const abs = resolve(path.replace(/\\/g, '/'));
  return gate.test(abs.toLowerCase()) || gate.test(nearestReal(abs).toLowerCase());
}

const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'wc', 'ls', 'stat', 'file', 'diff', 'cd', 'echo', 'pwd', 'true']);
const GUARDED_WORDS = /\/providers\/antigravity\/|\bconfig\/+hooks\.json\b|marketing\b[\s\S]*\.env\b/i;

/**
 * This agent has no sandbox, so for the token file and its own gate the shell is judged by what it
 * names: a command that names either passes only as plain reads with no redirect. Stricter than the
 * member-file reading, which must not refuse a sentence; a path in a variable still passes.
 */
export function shellTouchesGuarded(command: string): boolean {
  if (!GUARDED_WORDS.test(command)) return false;
  if (/>/.test(command)) return true;
  return command.split(/&&|\|\||[;|\n]/).some((part) => !READ_VERBS.has((part.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? ''));
}

const plainDir = (p: string): boolean => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

function readHooks(file: string): Record<string, unknown> {
  try {
    if (!lstatSync(file).isFile()) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export type GateResult = { ok: true } | { ok: false; reason: string };

/** Put our hook in this account's profile as a chat opens; another named hook in the file stays. */
export function syncAntigravityGate(accountId: string, o: { node: string; cli: string; home?: string }): GateResult {
  if (!o.node || !o.cli) return { ok: false, reason: 'the path of dreamcontext is not known' };
  const home = o.home ?? homedir();
  const profile = antigravityProfileDir(accountId, home);
  const config = join(profile, 'config');
  const file = join(config, 'hooks.json');
  try {
    mkdirSync(config, { recursive: true, mode: 0o700 });
    if (!plainDir(profile) || !plainDir(config)) return { ok: false, reason: 'the profile folder is not a plain folder' };
    const hooks = readHooks(file);
    const wanted = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: antigravityGateCommand(o.node, o.cli), timeout: GATE_TIMEOUT_SECONDS }] }] };
    const text = `${JSON.stringify({ ...hooks, [ANTIGRAVITY_GATE_NAME]: wanted }, null, 2)}\n`;
    let held = '';
    try { held = lstatSync(file).isFile() ? readFileSync(file, 'utf-8') : ''; } catch { /* not there yet */ }
    if (held === text) return { ok: true };
    // By rename: it replaces a link planted here instead of writing through it.
    const staged = `${file}.${process.pid}.tmp`;
    writeFileSync(staged, text, { mode: 0o600 });
    try {
      renameSync(staged, file);
    } catch (err) {
      rmSync(staged, { force: true });
      throw err;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

/** Does the hook itself refuse what it must? A call that writes nothing: it only asks. */
function hookRefuses(cwd: string, node: string, cli: string, home: string): boolean {
  const probe = { toolCall: { name: 'create_file', args: { TargetFile: join(home, '.dreamcontext', 'agents', 'gate-check.md') } }, workspacePaths: [cwd] };
  const r = spawnSync(node, [cli, 'hook', 'pre-tool-use', '--format', 'antigravity'], { cwd, input: JSON.stringify(probe), env: { ...process.env, [GATE_BEAT_ENV]: '' }, encoding: 'utf-8', timeout: GATE_TIMEOUT_SECONDS * 1000 });
  try {
    return r.status === 0 && (JSON.parse(r.stdout) as { decision?: unknown }).decision === 'deny';
  } catch {
    return false;
  }
}

/** What is missing for a child with nobody watching, in the owner's words; null when ready. */
export function antigravityGateGap(cwd: string, o: { node: string; cli: string; accountId?: string | null; home?: string; hookAnswers?: (cwd: string) => boolean }): string | null {
  const home = o.home ?? homedir();
  const accountId = o.accountId || 'primary';
  const synced = syncAntigravityGate(accountId, { node: o.node, cli: o.cli, home });
  if (!synced.ok) return `dreamcontext could not put its gate hook in this Antigravity account: ${synced.reason}.`;
  const file = antigravityHooksFile(accountId, home);
  if (!existsSync(file) || !readFileSync(file, 'utf-8').includes(ANTIGRAVITY_GATE_NAME)) return 'dreamcontext\'s gate hook is not in this Antigravity account.';
  return (o.hookAnswers ?? ((at) => hookRefuses(at, o.node, o.cli, home)))(cwd) ? null : 'dreamcontext\'s gate hook did not refuse a test write.';
}

export const NO_ANTIGRAVITY_GATE = 'Antigravity would run here without the gate on marketing tokens and agent files, so no child starts.';

const READ_TOOLS: ReadonlySet<string> = new Set(['view_file', 'list_directory', 'search_directory', 'find_file', 'read_url_content', 'search_web', 'ask_question', 'finish']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['create_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'delete_file', 'run_command']);
const PATH_KEYS = ['TargetFile', 'FilePath', 'Path', 'path', 'file_path', 'AbsolutePath'];

export interface GateCall { readonly toolName: string; readonly toolInput: Record<string, unknown>; readonly cwd: string }

/**
 * A tool call from the agent's hook input, in the Claude shape the gates read. Measured:
 * `run_command {CommandLine, Cwd}`, `create_file` and `edit_file {TargetFile}`. A tool we do not know
 * that names a path is read as a write, so a new write tool is judged, never waved through.
 */
export function antigravityCallAsClaude(input: Record<string, unknown>): GateCall | null {
  const call = input.toolCall as { name?: unknown; args?: unknown } | undefined;
  if (typeof call?.name !== 'string') return null;
  // A write tool whose target we cannot read is refused, never waved through.
  if (WRITE_TOOLS.has(call.name) && (!call.args || typeof call.args !== 'object')) return null;
  const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
  const paths = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  const root = typeof paths[0] === 'string' ? paths[0] : process.cwd();
  const cwd = typeof args.Cwd === 'string' && args.Cwd ? args.Cwd : root;
  if (call.name === 'run_command') return typeof args.CommandLine === 'string' ? { toolName: 'Bash', toolInput: { command: args.CommandLine }, cwd } : null;
  if (call.name === 'send_command_input') return { toolName: 'Bash', toolInput: { command: String(args.Input ?? '') }, cwd };
  if (READ_TOOLS.has(call.name)) return { toolName: call.name, toolInput: args, cwd };
  const key = PATH_KEYS.find((k) => typeof args[k] === 'string' && args[k]);
  if (!key && WRITE_TOOLS.has(call.name)) return null;
  if (key) return { toolName: call.name === 'create_file' ? 'Write' : 'Edit', toolInput: { file_path: args[key] }, cwd };
  return { toolName: call.name, toolInput: args, cwd };
}
