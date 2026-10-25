import { statSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import type * as ChildProcess from 'node:child_process';

/**
 * Windows child-process hygiene: no console window ever, and a kill that reaches the tree.
 *
 * WHY THIS EXISTS. On Windows every console program a GUI-less parent starts gets its OWN visible
 * console unless the spawn says otherwise. This codebase has ~105 `child_process` call sites and
 * none of them sets `windowsHide`, so each git/npm/claude/hook call flashed a terminal. Rather
 * than touch every site, `installHiddenWindowDefaults` patches the seven launchers once, at
 * startup, so each call defaults to `windowsHide: true`.
 *
 * Two facts about Windows shape the rest of the design:
 *  - `windowsHide` makes libuv pass CREATE_NO_WINDOW, and ONLY when no stdio entry is
 *    `'inherit'`. A spawn that inherits the parent's stdio shares the parent's console instead,
 *    so the flag is moot there (the parent's own console, if any, is the one you see).
 *  - A `detached: true` child is created with DETACHED_PROCESS: it has no console at all, so any
 *    console program IT starts opens a new visible one. That is harmless when the detached child
 *    is our own CLI (this patch runs first in `src/cli/index.ts`, so its spawns are hidden) and
 *    a flashing terminal when it is cmd, npm, claude or git. Do not detach those on win32.
 *
 * GUI exception: a program whose window you WANT (explorer, a browser) must pass
 * `windowsHide: false` explicitly; an explicit value is never overridden.
 *
 * Everything here is a no-op off Windows: `installHiddenWindowDefaults` does not patch, and
 * `killPortable` / `killChildTree` are exactly `process.kill` / `child.kill`.
 */

type CP = typeof ChildProcess;

const PATCHED = Symbol.for('dreamcontext.hiddenWindowDefaults');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `args` with `windowsHide: true` supplied as the options argument unless the caller already set
 * `windowsHide` (true OR false). Never mutates the input array or the caller's options object.
 * Handles `fn(file)`, `fn(file, args)`, `fn(file, opts)`, `fn(file, args, opts)` and the
 * callback forms `fn(file, cb)`, `fn(file, opts, cb)`, `fn(file, args, cb)`, `fn(file, args, null, cb)`.
 */
export function withHiddenWindow(args: readonly unknown[]): unknown[] {
  const out = [...args];
  // The options slot follows the optional args array: index 2 after an array (or after an
  // explicit null/undefined args with options behind it), otherwise index 1.
  const slot = Array.isArray(out[1]) || (out[1] == null && isPlainObject(out[2])) ? 2 : 1;
  const current = out[slot];
  if (typeof current === 'function') {
    out.splice(slot, 0, { windowsHide: true });
  } else if (isPlainObject(current)) {
    if (!('windowsHide' in current)) out[slot] = { ...current, windowsHide: true };
  } else if (current == null) {
    out[slot] = { windowsHide: true };
  }
  return out;
}

const LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
/** The launchers whose first argument is a program file run with no shell. */
const FILE_LAUNCHERS = new Set<string>(['spawn', 'spawnSync', 'execFile', 'execFileSync']);

/** `%SystemRoot%\System32`: on a normal install only an administrator can write here. */
export function win32System32(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
}

/** The PATH of `env` (any key case: `Path`) as drive-qualified or UNC directories only. A relative
 *  entry (`.`, `bin`) would make the lookup depend on the working folder again. With two spellings
 *  (`{ ...process.env, PATH: augmented }` keeps the inherited `Path` too) the one Node's win32
 *  spawn keeps wins: the first in sort order, so `PATH` over `Path`. */
export function win32AbsolutePathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const key = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').sort()[0];
  const raw = (key ? env[key] : undefined) ?? '';
  return raw.split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(d));
}

function defaultIsFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * The file a BARE program name (`git`, `claude`, `taskkill`) should run on win32, as an absolute
 * path. libuv searches the child's working folder BEFORE PATH, so a `git.exe` or `claude.exe`
 * committed to a project or brain root would run in place of the real one for every call made
 * there. Looked up the way libuv does (`.com`, then `.exe`, unless the name has an extension) but
 * on absolute PATH entries only. Not found: `System32\<name>`, which libuv then tries in that one
 * folder, so the call fails ENOENT exactly as a missing program did, and never reaches the working
 * folder. A name that carries a separator or a drive is returned unchanged.
 */
export function resolveBareWin32(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (p: string) => boolean = defaultIsFile,
): string {
  if (!file || /[\\/]/.test(file) || /^[A-Za-z]:/.test(file)) return file;
  const names = /\.[^.]+$/.test(file) ? [file] : [`${file}.com`, `${file}.exe`];
  for (const dir of win32AbsolutePathDirs(env)) {
    for (const name of names) {
      const candidate = win32.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return win32.join(win32System32(env), file);
}

/** `args` of a file launcher with a bare program name made absolute (see {@link resolveBareWin32}).
 *  A shell call is left alone: its first argument is a command line, not a file. */
export function withResolvedFile(
  args: readonly unknown[],
  resolveFile: (file: string, env: NodeJS.ProcessEnv) => string = resolveBareWin32,
): unknown[] {
  const out = [...args];
  if (typeof out[0] !== 'string') return out;
  const opts = out.slice(1, 4).find(isPlainObject);
  if (opts?.shell) return out;
  const env = isPlainObject(opts?.env) ? (opts.env as NodeJS.ProcessEnv) : process.env;
  out[0] = resolveFile(out[0], env);
  return out;
}

/**
 * Patch `child_process` so every launcher defaults to `windowsHide: true`, and every file
 * launcher (spawn, spawnSync, execFile, execFileSync) runs a bare program name from PATH, never
 * from the working folder ({@link resolveBareWin32}). Windows only; returns whether the module is
 * (now) patched. Idempotent. `resolveFile` is injectable for tests.
 */
export function installHiddenWindowDefaults(
  cp: CP = createRequire(import.meta.url)('node:child_process') as CP,
  platform: NodeJS.Platform = process.platform,
  resolveFile: (file: string, env: NodeJS.ProcessEnv) => string = resolveBareWin32,
): boolean {
  if (platform !== 'win32') return false;
  const target = cp as unknown as Record<string | symbol, unknown>;
  if (target[PATCHED]) return true;

  for (const name of LAUNCHERS) {
    const orig = target[name];
    if (typeof orig !== 'function') continue;
    const prepare = (args: unknown[]): unknown[] => {
      const hidden = withHiddenWindow(args);
      return FILE_LAUNCHERS.has(name) ? withResolvedFile(hidden, resolveFile) : hidden;
    };
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return (orig as (...a: unknown[]) => unknown).apply(this, prepare(args));
    };
    // `promisify(execFile)` / `promisify(exec)` resolve through this symbol, captured when the
    // caller's module loads (ensure-cli.ts, orphan-processes.ts, routes/*.ts). Without re-pointing
    // it the promisified form would bypass the wrapper and call the original with no default.
    const custom = (orig as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === 'function') {
      (wrapped as unknown as Record<symbol, unknown>)[promisify.custom] = function (this: unknown, ...args: unknown[]) {
        return (custom as (...a: unknown[]) => unknown).apply(this, prepare(args));
      };
    }
    target[name] = wrapped;
  }
  target[PATCHED] = true;
  // ESM named imports (`import { spawn } from 'node:child_process'`) are live bindings to the
  // builtin's export snapshot; refresh it so they see the wrappers.
  syncBuiltinESMExports();
  return true;
}

export interface KillOptions {
  platform?: NodeJS.Platform;
  /** `taskkill /PID n /T [/F]`; true when it exited 0. Injected by tests. */
  taskkill?: (pid: number, force: boolean) => boolean;
  /** Is the pid still running? Injected by tests. */
  isAlive?: (pid: number) => boolean;
}

function defaultTaskkill(pid: number, force: boolean): boolean {
  // Required lazily so merely importing this module on macOS never touches child_process.
  const { spawnSync } = createRequire(import.meta.url)('node:child_process') as CP;
  return spawnSync(win32.join(win32System32(), 'taskkill.exe'), ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
    stdio: 'ignore',
    windowsHide: true,
  }).status === 0;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killError(code: 'ESRCH' | 'EPERM', pid: number): Error {
  return Object.assign(new Error(`kill ${code}: ${pid}`), { code });
}

/**
 * `process.kill(pid, signal)` that also works for what the POSIX code means by a negative pid
 * ("the whole group") on Windows, where there are no process groups.
 *
 * Off win32 this IS `process.kill(pid, signal)`. On win32 the sign is dropped and the TREE under
 * `|pid|` is killed with `taskkill /T`:
 *  - signal 0: liveness probe (`process.kill(|pid|, 0)`, throws ESRCH when gone);
 *  - SIGKILL: `/T /F` straight away;
 *  - anything else: graceful `/T` first. That succeeds only when windows accepted the close
 *    request, and "accepted" is not "gone" (a process can ignore it), so the pid is probed and
 *    the kill escalates to `/T /F` unless it is really dead. Console processes with no window
 *    reject the graceful form outright, which takes the same escalation.
 * Throws like `process.kill` when it could not: ESRCH when the pid is gone, EPERM when it lives on.
 */
export function killPortable(pid: number, signal: NodeJS.Signals | 0, opts: KillOptions = {}): void {
  if ((opts.platform ?? process.platform) !== 'win32') {
    process.kill(pid, signal);
    return;
  }
  const target = Math.abs(pid);
  const alive = opts.isAlive ?? defaultIsAlive;
  if (signal === 0) {
    process.kill(target, 0);
    return;
  }
  const taskkill = opts.taskkill ?? defaultTaskkill;
  if (signal !== 'SIGKILL' && taskkill(target, false) && !alive(target)) return;
  if (taskkill(target, true)) return;
  throw killError(alive(target) ? 'EPERM' : 'ESRCH', target);
}

/**
 * Stop a child and everything it started. Off win32: `child.kill(signal)`. On win32 with a pid:
 * the tree via {@link killPortable}, falling back to `child.kill()` when taskkill cannot.
 */
export function killChildTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
  opts: Omit<KillOptions, 'platform'> = {},
): void {
  if (platform !== 'win32' || !child.pid) {
    child.kill(signal);
    return;
  }
  try {
    killPortable(-child.pid, signal, { ...opts, platform });
  } catch {
    child.kill();
  }
}

/**
 * Tree-kill `child` on win32, ONLY when it is a real `ChildProcess` with a pid; true when the
 * tree kill ran without throwing. Everywhere else (any other platform, a test double carrying a
 * made-up pid, no pid) it does nothing and returns false, so the caller's own `process.kill` /
 * `child.kill` path stays exactly as it was. The real-child rule exists because `taskkill` acts
 * on whatever process owns that pid on the machine: a fake `pid = 4242` must never reach it.
 */
export function treeKillRealChild(
  child: { pid?: number },
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  tree: (pid: number, signal: NodeJS.Signals) => void = killPortable,
): boolean {
  if (platform !== 'win32' || !child.pid) return false;
  const { ChildProcess: Real } = createRequire(import.meta.url)('node:child_process') as CP;
  if (!(child instanceof Real)) return false;
  try {
    tree(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, never a bare `powershell.exe`. */
export function win32PowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(win32System32(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** win32: the parent pid of `pid` from CIM, or null when the process is gone or unreadable. */
function defaultParentPid(pid: number): number | null {
  const { execFileSync } = createRequire(import.meta.url)('node:child_process') as CP;
  try {
    const out = execFileSync(win32PowerShell(), [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, windowsHide: true });
    const n = Number.parseInt(String(out).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * May a RECORDED child pid still be tree-killed? Off win32: always (a negative-pid kill only
 * reaches a process group with that id, so a recycled pid fails ESRCH harmlessly). On win32 the
 * kill is `taskkill /T` on whatever process now owns the pid, and Windows reuses pids quickly: it
 * is allowed only while that process's parent is still the recorded runner. Windows never
 * reparents, and a dead runner's children die with it (libuv's kill-on-close job), so a live pid
 * whose parent is not the runner is someone else's program.
 */
export function recordedChildIsOurs(
  childPid: number,
  runnerPid: number,
  platform: NodeJS.Platform = process.platform,
  parentOf: (pid: number) => number | null = defaultParentPid,
): boolean {
  if (platform !== 'win32') return true;
  if (!Number.isInteger(childPid) || childPid <= 0 || !Number.isInteger(runnerPid) || runnerPid <= 0) return false;
  return parentOf(childPid) === runnerPid;
}
