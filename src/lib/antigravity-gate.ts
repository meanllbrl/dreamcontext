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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { anchors, dropHeredocBodies, expandHome, segmentsOf, shellReadings } from './agents/member-file-guard.js';
import { antigravityProfileDir } from './antigravity-accounts.js';
import { resolveContextRoot } from './context-path.js';

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
  return gate.test(lower(abs)) || gate.test(lower(nearestReal(abs)));
}

/** One spelling to compare: forward slashes (on Windows `resolve` and `realpath` answer with
 *  backslashes, and every rule here is written with `/`), lower case, no trailing slash. */
function lower(p: string): string { return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') || '/'; }
/** The gate's folders by name, in any HOME: up to and including `.dreamcontext`. */
const GATE_CHAIN = /\/\.dreamcontext(?:\/t3(?:\/state(?:\/providers(?:\/antigravity)?)?)?)?$/;
/** Any brain's token folder or file, by name. */
const TOKEN_CHAIN = /\/_dream_context\/marketing(?:\/\.env)?$/;
/** A spelling names a protected place (the gate's folders, a token folder or file), in any
 *  separator and case. Exported for the unit test, which pins it on Windows spellings. */
export const guardedByName = (p: string): boolean => GATE_CHAIN.test(lower(p)) || TOKEN_CHAIN.test(lower(p));
const aboveOrSelf = (dir: string, file: string): boolean => dir === '/' || file === dir || file.startsWith(`${dir}/`);

/**
 * Is `abs` a protected file, or a folder above one? Protected: the token file (`_dream_context/
 * marketing/.env`, this project's and any brain's by name) and the gate's hook file with its folders
 * up to and including `.dreamcontext`. Moving, removing or copying over such a place takes the file
 * with it, so the rule is on the place, not on the file's own name.
 */
function holdsGuarded(abs: string, cwd: string): boolean {
  const spelled = [lower(resolve(abs)), lower(nearestReal(resolve(abs)))];
  if (isAntigravityGateFile(abs) || spelled.some(guardedByName)) return true;
  const root = resolveContextRoot(cwd);
  if (!root) return false;
  const token = lower(join(nearestReal(root), 'marketing', '.env'));
  return spelled.some((p) => aboveOrSelf(p, token));
}

const MOVERS = new Set(['mv', 'rm', 'rmdir', 'unlink', 'cp', 'ln', 'rsync']);
const LEADERS = new Set(['sudo', 'command', 'exec', 'env', 'time', 'nohup', 'nice', 'timeout']);
const isDir = (p: string): boolean => { try { return lstatSync(nearestReal(p)).isDirectory(); } catch { return false; } };

/** A shell move, removal or copy whose source, or the place it lands, holds a protected file. */
function shellMovesGuarded(command: string, cwd: string, home: string): boolean {
  const dirs = anchors(command, cwd.replace(/\\/g, '/'), home);
  return segmentsOf(dropHeredocBodies(command)).some((segment) => shellReadings(segment).some((reading) => {
    const words = reading.filter(Boolean);
    while (words.length > 0 && (LEADERS.has(words[0]) || /^[A-Za-z_]\w*=/.test(words[0]) || /^-|^\d+[smhd]?$/.test(words[0]))) words.shift();
    if (words[0] === 'git' && (words[1] === 'mv' || words[1] === 'rm')) words.shift();
    const verb = (words[0] ?? '').split('/').pop() ?? '';
    if (!MOVERS.has(verb)) return false;
    const operands = words.slice(1).flatMap((w) => (w.startsWith('--') && w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : w.startsWith('-') ? [] : [w]));
    const places = (word: string): string[] => {
      const raw = expandHome(word.replace(/\\/g, '/'), home);
      return isAbsolute(raw) ? [raw] : dirs.map((d) => resolve(d, raw));
    };
    const guarded = (word: string): boolean => places(word).some((p) => holdsGuarded(p, cwd));
    if (verb.startsWith('rm') || verb === 'unlink' || operands.length < 2) return operands.some(guarded);
    const dest = operands[operands.length - 1];
    const sources = operands.slice(0, -1);
    if (sources.some(guarded)) return true;
    // Into a folder a copy lands at folder/name, or on the folder itself for `src/` and `src/.`.
    return places(dest).some((d) => (!isDir(d) ? holdsGuarded(d, cwd) : sources.some((src) => {
      const contents = /\/\.?$/.test(src) || src === '.';
      return holdsGuarded(contents ? d : join(d, basename(src.replace(/\/+$/, ''))), cwd);
    })));
  }));
}

const CLAUDE_READS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const CLAUDE_WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function stringsIn(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return value.length <= 1024 && !value.includes('\n') ? [value] : [];
  if (!value || typeof value !== 'object' || depth > 4) return [];
  return Object.values(value as Record<string, unknown>).flatMap((v) => stringsIn(v, depth + 1));
}

/**
 * THE rule, for the hook and for the unattended layer alike: a move, rename, delete or copy-over
 * whose source or destination is a protected file or any folder above it is refused. The shell is
 * read for `mv`, `rm`, `cp`, `ln`, `rsync`; a file tool by its path; a tool this gate does not know,
 * by every string it carries (its project folder and above excepted, so a `.` stays a `.`).
 */
export function movesGuardedPlace(tool: string, input: Record<string, unknown>, cwd: string, home: string = homedir()): boolean {
  if (tool === 'Bash') return typeof input.command === 'string' && shellMovesGuarded(input.command, cwd, home);
  if (READ_TOOLS.has(tool) || CLAUDE_READS.has(tool)) return false;
  const at = (s: string): string => { const raw = expandHome(s.replace(/\\/g, '/'), home); return isAbsolute(raw) ? raw : resolve(cwd, raw); };
  const path = ['file_path', ...PATH_KEYS].map((k) => input[k]).find((v): v is string => typeof v === 'string' && !!v);
  if (path && holdsGuarded(at(path), cwd)) return true;
  if (WRITE_TOOLS.has(tool) || CLAUDE_WRITES.has(tool)) return false;
  const here = lower(nearestReal(resolve(cwd)));
  return stringsIn(input).some((s) => {
    const abs = at(s);
    if (!holdsGuarded(abs, cwd)) return false;
    const p = lower(nearestReal(resolve(abs)));
    return GATE_CHAIN.test(p) || TOKEN_CHAIN.test(p) || isAntigravityGateFile(abs) || !aboveOrSelf(p, here);
  });
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
