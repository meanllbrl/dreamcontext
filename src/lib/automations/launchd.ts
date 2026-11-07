import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AutomationError, DISPATCHER_LABEL, LOG_ROTATE_BYTES, TICK_INTERVAL_SECONDS } from './types.js';
import { inspectWindowsDispatcher, installWindowsDispatcher, uninstallWindowsDispatcher } from './schtasks.js';

/**
 * The launchd dispatcher — install/uninstall lifecycle for the ONE global
 * `com.dreamcontext.automations` LaunchAgent that ticks every automations
 * project on this machine every `TICK_INTERVAL_SECONDS`.
 *
 * The load-bearing decision here is HOW the generated wrapper resolves
 * `dreamcontext`. Measured on this machine (macOS, zsh): `$SHELL -lc` and
 * `$SHELL -ilc` can resolve to TWO DIFFERENT installs, because `~/.zprofile`/
 * `~/.zshenv` are empty and nvm + `~/.local/bin` are exported from `~/.zshrc`,
 * which zsh sources for INTERACTIVE shells only. A `-lc` dispatcher plist
 * installs cleanly and then silently runs the wrong build (or nothing) — the
 * worst failure mode this feature has. So the generated wrapper bakes the
 * resolved absolute path as a fast path, and falls back to an INTERACTIVE
 * login shell (`-ilc`, never `-lc`) only when that baked path is gone or
 * cannot actually execute. See `renderDispatcherWrapper` for the exact script
 * and why the fallback is reached with a real `--version` invocation, not a
 * bare `[ -x ]` check (a `+x` binary can still fail to `exec` — a dangling
 * shebang after an nvm node bump, a signing/sandbox refusal — and a failed
 * `exec` TERMINATES the shell, so `[ -x ]` alone would make the fallback
 * unreachable).
 *
 * All `launchctl` calls and the shell-resolution spawn go through an
 * injectable `ExecRunner` — tests must NEVER invoke real `launchctl`.
 */

// ─── Exec injection ──────────────────────────────────────────────────────────

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export type ExecRunner = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

/** Real exec via `child_process.spawn` — no shell interpretation, argv only. */
export const defaultExecRunner: ExecRunner = (file, args, opts) => {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  return new Promise<ExecResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done({ ok: false, stdout, stderr: stderr || 'timed out', code: null });
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', (err) => {
      done({ ok: false, stdout, stderr: err.message, code: null });
    });
    child.on('close', (code) => {
      done({ ok: code === 0, stdout, stderr, code });
    });
  });
};

// ─── Shell quoting ───────────────────────────────────────────────────────────

/**
 * POSIX single-quote a value for safe embedding in a generated shell script:
 * wrap in `'…'`, and end-quote/escape/re-quote each embedded `'`. Mirrors the
 * `src/server/routes/agent-terminal.ts:219,221` idiom exactly.
 */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function atomicWrite(filePath: string, content: string, mode?: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
  renameSync(tmp, filePath);
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export interface DispatcherTarget {
  bin: string | null;
  path: string;
  shell: string;
}

/**
 * Resolve `dreamcontext` the same way `resolveTitleCli` (agent-terminal.ts:727)
 * resolves `claude`: one interactive-login-shell spawn that prints the binary
 * path and the shell's real PATH in one shot, so the wrapper can bake both.
 * `bin: null` means nothing resolved — the caller must refuse to install.
 */
export function resolveDispatcherTarget(
  opts: { runner?: ExecRunner; timeoutMs?: number } = {},
): Promise<DispatcherTarget> {
  const shell = process.env.SHELL || '/bin/zsh';
  const runner = opts.runner ?? defaultExecRunner;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return runner(shell, ['-ilc', 'command -v dreamcontext; printf "%s" "$PATH"'], { timeoutMs }).then(
    (res) => {
      const out = res.stdout;
      const nl = out.indexOf('\n');
      const bin = nl > 0 ? out.slice(0, nl).trim() : '';
      const path = nl > 0 ? out.slice(nl + 1).trim() : out.trim();
      return { bin: bin || null, path: path || process.env.PATH || '', shell };
    },
  );
}

/**
 * The absolute, symlink-resolved path of the CLI entry script currently
 * executing — i.e. the build `automations install` is being run FROM. Read
 * fresh from `process.argv[1]` on every call (no caching) so tests can stub it.
 * Compared against `resolveDispatcherTarget()`'s result to catch the "installs
 * cleanly, runs the wrong build" case (e.g. a worktree's CLI installing a
 * dispatcher that would resolve the main tree's `dreamcontext`, or vice versa).
 */
export function runningCliBin(): string | null {
  const argv1 = process.argv[1];
  if (!argv1) return null;
  return safeRealpath(argv1);
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function dispatcherWrapperPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', 'automations-dispatch.sh');
}

export function dispatcherPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${DISPATCHER_LABEL}.plist`);
}

export function automationsLogPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'logs', 'automations.log');
}

// ─── Pure renderers ───────────────────────────────────────────────────────────

const GENERATED_AT_RE = /^# Generated by `dreamcontext automations install` at (.+)\.$/m;

/**
 * The generated dispatcher script launchd actually runs (`/bin/sh <wrapper>`).
 * PURE — no I/O, same input always produces the same output.
 *
 * Preflight is a REAL invocation (`"$DC_BIN" --version`), never `[ -x ]` alone:
 * a `+x` binary can still fail to `exec` (a dangling shebang after an nvm node
 * bump, a signing/sandbox refusal), and a failed `exec` TERMINATES the shell —
 * so with `[ -x ]` alone the fallback below it would NEVER run and the
 * scheduler would die silently. `dreamcontext --version` short-circuits at the
 * very top of `main()` (`src/cli/index.ts:174-182`) before Commander is even
 * constructed, so it is a cheap, valid liveness probe.
 *
 * The fallback re-resolves through the INTERACTIVE login shell (`-ilc`) —
 * NEVER `-lc`, which can silently resolve a completely different install.
 */
export function renderDispatcherWrapper(target: DispatcherTarget, generatedAt: string): string {
  const bin = target.bin ?? '';
  return `#!/bin/sh
# Generated by \`dreamcontext automations install\` at ${generatedAt}.
# Regenerate with: dreamcontext automations install
DC_BIN=${shq(bin)}
DC_SHELL=${shq(target.shell)}
export PATH=${shq(target.path)}

# Preflight with a REAL invocation, never \`[ -x ]\` alone. A binary can be +x and
# still fail to exec (dangling shebang after an nvm node bump, signing/sandbox
# refusal) — and a failed \`exec\` TERMINATES this shell, so the fallback below
# would never run. Reproduced: \`[ -x ]\`-only exits 1 and never falls through.
if [ -x "$DC_BIN" ] && "$DC_BIN" --version >/dev/null 2>&1; then
  exec "$DC_BIN" automations tick --all < /dev/null
fi

# Baked path gone or unrunnable — re-resolve through the INTERACTIVE login shell.
# nvm and ~/.local/bin come from ~/.zshrc, which only \`-i\` sources. Never \`-lc\`:
# it silently resolves a DIFFERENT install.
exec "$DC_SHELL" -ilc 'exec dreamcontext automations tick --all' < /dev/null
`;
}

/**
 * launchd's `ProcessType` for the dispatcher. NEVER `Background`: that type puts the tick and
 * every run it spawns (claude, its hooks, its tools) under macOS's background policy, which
 * throttles CPU, disk and network for the whole process tree. Measured on a busy Mac
 * (2026-11-07): `dreamcontext snapshot` took 10s at normal priority and 701s under that policy,
 * a tick with nothing due ran 30+ minutes, and routines hit their timeout before their first turn.
 * `Standard` is the same as no ProcessType: the run gets the priority of anything the owner starts.
 */
export const DISPATCHER_PROCESS_TYPE = 'Standard';

/**
 * The LaunchAgent plist. PURE — no I/O. `ProgramArguments` points at
 * `/bin/sh <wrapperPath>` rather than baking `dreamcontext` directly, so an
 * npm upgrade or a nvm node bump needs no plist change (the wrapper handles
 * it via `renderDispatcherWrapper`'s fallback) — the CLI's own "no baked
 * node/CLI paths" constraint, honored via wrapper indirection.
 */
export function renderDispatcherPlist(wrapperPath: string, logPath: string): string {
  const wrapper = xmlEscape(wrapperPath);
  const log = xmlEscape(logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DISPATCHER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${wrapper}</string>
  </array>
  <key>StartInterval</key>
  <integer>${TICK_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>${DISPATCHER_PROCESS_TYPE}</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

// ─── Inspect ──────────────────────────────────────────────────────────────────

export interface InstallCheck {
  resolved: DispatcherTarget;
  runningBin: string | null;
  mismatch: boolean;
  plistPresent: boolean;
  plistCurrent: boolean;
  wrapperPresent: boolean;
  wrapperCurrent: boolean;
  bootstrapped: boolean;
  logPath: string;
  logSizeBytes: number;
}

/**
 * Read-only inspection — resolves the target, diffs it against what's on disk
 * and against `launchctl print`, and NEVER writes anything. Powers both
 * `install --check` and `installDispatcher`'s own idempotency/mismatch gates.
 *
 * `mismatch` compares the resolved dispatcher target against the CLI currently
 * executing (`runningCliBin()`) — e.g. a worktree build installing a
 * dispatcher that would actually run the main tree's `dreamcontext`. When
 * either side can't be determined, `mismatch` is conservatively `false`
 * (never block an install just because introspection failed).
 *
 * `wrapperCurrent`/`plistCurrent` mean "regenerating right now, from the
 * currently-resolved target, reproduces the file on disk byte-for-byte" — the
 * wrapper's only non-deterministic byte is its `generatedAt` comment, so that
 * value is read back off the installed file before re-rendering for the
 * comparison (an unrelated timestamp must never make an unchanged install
 * look stale).
 */
export async function inspectDispatcher(
  opts: { home?: string; runner?: ExecRunner; uid?: number } = {},
): Promise<InstallCheck> {
  const home = opts.home ?? homedir();
  const runner = opts.runner ?? defaultExecRunner;

  // Windows: the Task Scheduler twin in schtasks.ts (same InstallCheck shape).
  if (process.platform === 'win32') {
    return inspectWindowsDispatcher({ home, runner, logPath: automationsLogPath(home), runningBin: runningCliBin() });
  }

  const resolved = await resolveDispatcherTarget({ runner });
  const runningBin = runningCliBin();
  const mismatch =
    resolved.bin !== null &&
    runningBin !== null &&
    safeRealpath(resolved.bin) !== safeRealpath(runningBin);

  const wrapperPath = dispatcherWrapperPath(home);
  const plistPath = dispatcherPlistPath(home);
  const logPath = automationsLogPath(home);

  const wrapperPresent = existsSync(wrapperPath);
  let wrapperCurrent = false;
  if (wrapperPresent) {
    try {
      const onDisk = readFileSync(wrapperPath, 'utf-8');
      const generatedAt = GENERATED_AT_RE.exec(onDisk)?.[1] ?? null;
      wrapperCurrent = generatedAt !== null && onDisk === renderDispatcherWrapper(resolved, generatedAt);
    } catch {
      wrapperCurrent = false;
    }
  }

  const plistPresent = existsSync(plistPath);
  let plistCurrent = false;
  if (plistPresent) {
    try {
      plistCurrent = readFileSync(plistPath, 'utf-8') === renderDispatcherPlist(wrapperPath, logPath);
    } catch {
      plistCurrent = false;
    }
  }

  let bootstrapped = false;
  if (process.platform === 'darwin') {
    const uid = opts.uid ?? process.getuid?.() ?? 501;
    const printRes = await runner('launchctl', ['print', `gui/${uid}/${DISPATCHER_LABEL}`]);
    bootstrapped = printRes.ok;
  }

  let logSizeBytes = 0;
  try {
    logSizeBytes = statSync(logPath).size;
  } catch {
    /* no log yet */
  }

  return {
    resolved,
    runningBin,
    mismatch,
    plistPresent,
    plistCurrent,
    wrapperPresent,
    wrapperCurrent,
    bootstrapped,
    logPath,
    logSizeBytes,
  };
}

// ─── Install / uninstall ──────────────────────────────────────────────────────

export interface InstallResult {
  check: InstallCheck;
  wroteWrapper: boolean;
  wrotePlist: boolean;
  bootstrapped: boolean;
  method: 'bootstrap' | 'load' | 'schtasks' | 'none';
  warnings: string[];
}

/**
 * Write (or refresh) the wrapper + plist and bootstrap the LaunchAgent.
 * Refuses outright (throws) when nothing resolves or the platform isn't
 * macOS — there is nothing safe to install. Refuses more softly (returns,
 * writes nothing) on a resolution MISMATCH unless `force` is set, because a
 * mismatch alone doesn't mean the request is wrong, just that it deserves a
 * human's confirmation before silently baking in a different build than the
 * one running the install.
 */
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 1_000;

export async function installDispatcher(
  opts: { home?: string; runner?: ExecRunner; uid?: number; force?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<InstallResult> {
  if (process.platform === 'win32') {
    const home = opts.home ?? homedir();
    return installWindowsDispatcher({
      home,
      runner: opts.runner ?? defaultExecRunner,
      logPath: automationsLogPath(home),
      runningBin: runningCliBin(),
      force: opts.force,
    });
  }
  if (process.platform !== 'darwin') {
    throw new AutomationError(
      'The launchd dispatcher is macOS-only; Linux cron is a later backend behind this same seam.',
    );
  }
  const home = opts.home ?? homedir();
  const runner = opts.runner ?? defaultExecRunner;
  const uid = opts.uid ?? process.getuid?.() ?? 501;
  const force = opts.force ?? false;

  const check = await inspectDispatcher({ home, runner, uid });
  const warnings: string[] = [];

  if (check.resolved.bin === null) {
    throw new AutomationError(
      'Could not resolve `dreamcontext` through a login shell. Install it (npm i -g dreamcontext) and try again.',
    );
  }

  if (check.mismatch && !force) {
    warnings.push(
      `Resolution mismatch: the dispatcher would run "${check.resolved.bin}", but this install is ` +
        `running from "${check.runningBin}". Pass --force to install anyway, or re-run from the CLI ` +
        `you want the scheduler to use.`,
    );
    return { check, wroteWrapper: false, wrotePlist: false, bootstrapped: false, method: 'none', warnings };
  }
  if (check.mismatch && force) {
    warnings.push(`Resolution mismatch overridden with --force: installing to run "${check.resolved.bin}".`);
  }

  const alreadyCurrent =
    check.wrapperPresent && check.wrapperCurrent && check.plistPresent && check.plistCurrent && check.bootstrapped;
  if (alreadyCurrent && !force) {
    return { check, wroteWrapper: false, wrotePlist: false, bootstrapped: true, method: 'none', warnings };
  }

  const wrapperPath = dispatcherWrapperPath(home);
  const plistPath = dispatcherPlistPath(home);
  const logPath = automationsLogPath(home);
  const generatedAt = new Date().toISOString();

  mkdirSync(dirname(logPath), { recursive: true });
  atomicWrite(wrapperPath, renderDispatcherWrapper(check.resolved, generatedAt), 0o700);
  atomicWrite(plistPath, renderDispatcherPlist(wrapperPath, logPath));

  // Best-effort — an agent that was never bootstrapped fails this harmlessly.
  await runner('launchctl', ['bootout', `gui/${uid}/${DISPATCHER_LABEL}`]);

  let bootstrapped = false;
  let method: InstallResult['method'] = 'none';
  // `bootout` returns before launchd has finished tearing the old job down, and a bootstrap in
  // that window fails with "5: Input/output error" (seen on this Mac, 2026-11-07). Without a retry
  // the job is left unloaded and no routine runs at all; `update` now refreshes by itself, so the
  // window is hit routinely, not only by a human re-running install.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let bootstrapRes = await runner('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  for (let attempt = 1; !bootstrapRes.ok && attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
    await sleep(BOOTSTRAP_RETRY_MS);
    bootstrapRes = await runner('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  }
  if (bootstrapRes.ok) {
    bootstrapped = true;
    method = 'bootstrap';
  } else {
    // `load` is deprecated (macOS 26.3 `launchctl help`: "Recommended
    // alternatives: bootstrap | enable") but still present — legacy fallback.
    const loadRes = await runner('launchctl', ['load', '-w', plistPath]);
    if (loadRes.ok) {
      bootstrapped = true;
      method = 'load';
    } else {
      warnings.push(
        `launchctl bootstrap and the legacy load -w fallback both failed: ${bootstrapRes.stderr || loadRes.stderr}`,
      );
    }
  }

  const finalCheck = await inspectDispatcher({ home, runner, uid });
  return { check: finalCheck, wroteWrapper: true, wrotePlist: true, bootstrapped, method, warnings };
}

/** Boots the agent out, then deletes the plist and wrapper. Registry approvals
 *  are left untouched — uninstall removes the scheduler, not the automations. */
export async function uninstallDispatcher(
  opts: { home?: string; runner?: ExecRunner; uid?: number } = {},
): Promise<{ bootedOut: boolean; removedPlist: boolean; removedWrapper: boolean }> {
  if (process.platform === 'win32') {
    return uninstallWindowsDispatcher({ home: opts.home ?? homedir(), runner: opts.runner ?? defaultExecRunner });
  }
  if (process.platform !== 'darwin') {
    throw new AutomationError(
      'The launchd dispatcher is macOS-only; Linux cron is a later backend behind this same seam.',
    );
  }
  const home = opts.home ?? homedir();
  const runner = opts.runner ?? defaultExecRunner;
  const uid = opts.uid ?? process.getuid?.() ?? 501;

  const bootoutRes = await runner('launchctl', ['bootout', `gui/${uid}/${DISPATCHER_LABEL}`]);

  const plistPath = dispatcherPlistPath(home);
  const wrapperPath = dispatcherWrapperPath(home);
  let removedPlist = false;
  let removedWrapper = false;
  try {
    unlinkSync(plistPath);
    removedPlist = true;
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(wrapperPath);
    removedWrapper = true;
  } catch {
    /* already gone */
  }

  return { bootedOut: bootoutRes.ok, removedPlist, removedWrapper };
}

export type RefreshDispatcherResult =
  | { action: 'refreshed'; warnings: string[] }
  | { action: 'skipped'; reason: 'not-macos' | 'not-installed' | 'current' | 'inside-scheduler' | 'tick-running' | 'mismatch' | 'failed'; detail?: string };

/**
 * Re-install the scheduler when it IS installed but its files are stale (an older release wrote
 * them: the `ProcessType` fix above only reaches launchd through a fresh bootstrap). Called by
 * `dreamcontext update`. Never installs a scheduler the owner did not install, never bakes a
 * different CLI than the one running (`mismatch`), and never boots the job out from under work:
 * not from inside a scheduler run (launchd marks its job's tree with `XPC_SERVICE_NAME`), and not
 * while the running tick has a child (a run, a host): the bootout would kill its runner. A tick
 * with no child is only reading manifests, and ending it costs nothing: the re-bootstrap starts
 * a fresh one (RunAtLoad), now at normal priority.
 */
export async function refreshStaleDispatcher(
  opts: {
    home?: string;
    runner?: ExecRunner;
    uid?: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    install?: typeof installDispatcher;
  } = {},
): Promise<RefreshDispatcherResult> {
  if ((opts.platform ?? process.platform) !== 'darwin') return { action: 'skipped', reason: 'not-macos' };
  const env = opts.env ?? process.env;
  if (env.XPC_SERVICE_NAME === DISPATCHER_LABEL) return { action: 'skipped', reason: 'inside-scheduler' };
  const home = opts.home ?? homedir();
  // Cheap first: `update` runs once per project, and the full inspect spawns a login shell.
  // Only a plist that differs from today's render is worth that.
  const plistPath = dispatcherPlistPath(home);
  let onDisk: string;
  try {
    onDisk = readFileSync(plistPath, 'utf-8');
  } catch {
    return { action: 'skipped', reason: 'not-installed' };
  }
  if (onDisk === renderDispatcherPlist(dispatcherWrapperPath(home), automationsLogPath(home))) {
    return { action: 'skipped', reason: 'current' };
  }
  const check = await inspectDispatcher({ home, runner: opts.runner, uid: opts.uid });
  // Only a LIVE scheduler is refreshed: one the owner booted out stays out.
  if (!check.plistPresent || !check.bootstrapped) return { action: 'skipped', reason: 'not-installed' };
  if (check.mismatch) return { action: 'skipped', reason: 'mismatch', detail: check.resolved.bin ?? undefined };
  if (await tickHasWorkInFlight(opts.runner ?? defaultExecRunner, opts.uid ?? process.getuid?.() ?? 501)) {
    return { action: 'skipped', reason: 'tick-running' };
  }
  try {
    const result = await (opts.install ?? installDispatcher)({ home, runner: opts.runner, uid: opts.uid });
    if (!result.bootstrapped) return { action: 'skipped', reason: 'failed', detail: result.warnings.join(' ') };
    return { action: 'refreshed', warnings: result.warnings };
  } catch (err) {
    return { action: 'skipped', reason: 'failed', detail: (err as Error).message };
  }
}

/** Asks launchd and the process table, never the heartbeat file: a tick killed mid-pass never
 *  writes its completion, so the file can say "running" for hours after the tick is gone. */
async function tickHasWorkInFlight(runner: ExecRunner, uid: number): Promise<boolean> {
  const printed = await runner('launchctl', ['print', `gui/${uid}/${DISPATCHER_LABEL}`]);
  const pid = printed.ok ? /^\s*pid = (\d+)\s*$/m.exec(printed.stdout)?.[1] ?? null : null;
  if (pid === null) return false;
  // `pgrep -P` exits 1 when the tick has no child and 0 when it has one. Anything else (no
  // pgrep, a timeout) cannot prove the tick is idle, so it counts as busy.
  const children = await runner('pgrep', ['-P', pid]);
  return children.ok || children.code !== 1;
}

/** Rotate `automations.log` to `.log.1` once it exceeds `maxBytes`. Returns
 *  whether a rotation happened (false when absent or still under the cap). */
export function rotateLogIfLarge(home: string = homedir(), maxBytes: number = LOG_ROTATE_BYTES): boolean {
  const logPath = automationsLogPath(home);
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  try {
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
}
