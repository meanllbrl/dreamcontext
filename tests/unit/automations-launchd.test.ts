/**
 * Unit tests for src/lib/automations/launchd.ts — the launchd dispatcher
 * lifecycle. NEVER invokes real `launchctl`; every exec goes through an
 * injected fake `ExecRunner`. The one place real processes ARE spawned is
 * proving the generated wrapper's shell control-flow actually works — that is
 * the whole point of the critical fall-through test below, and it only ever
 * spawns `/bin/sh` against harmless local fixtures, never a real
 * `dreamcontext`/`claude`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationError } from '../../src/lib/automations/types.js';
import {
  automationsLogPath,
  defaultExecRunner,
  dispatcherPlistPath,
  dispatcherWrapperPath,
  inspectDispatcher,
  installDispatcher,
  renderDispatcherPlist,
  renderDispatcherWrapper,
  resolveDispatcherTarget,
  rotateLogIfLarge,
  runningCliBin,
  shq,
  uninstallDispatcher,
  type DispatcherTarget,
  type ExecRunner,
} from '../../src/lib/automations/launchd.js';

const tmpDirs: string[] = [];
function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-launchd-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void> | void): Promise<void> {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    });
}

function withArgv1(path: string, fn: () => void): void {
  const orig = process.argv[1];
  process.argv[1] = path;
  try {
    fn();
  } finally {
    process.argv[1] = orig;
  }
}

// ─── shq ──────────────────────────────────────────────────────────────────────

describe('shq', () => {
  it('produces a shell-safe single-quoted literal, verified via real execution', async () => {
    const value = "it's a test with a ' quote and $(danger) `backticks`";
    const quoted = shq(value);
    const out = await new Promise<string>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', `printf '%s' ${quoted}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let acc = '';
      child.stdout.on('data', (c: Buffer) => (acc += c.toString('utf-8')));
      child.on('close', () => resolvePromise(acc));
    });
    expect(out).toBe(value);
  });

  it('round-trips a plain value with no embedded quotes', async () => {
    const out = await new Promise<string>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', `printf '%s' ${shq('/usr/local/bin/dreamcontext')}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let acc = '';
      child.stdout.on('data', (c: Buffer) => (acc += c.toString('utf-8')));
      child.on('close', () => resolvePromise(acc));
    });
    expect(out).toBe('/usr/local/bin/dreamcontext');
  });
});

// ─── renderDispatcherWrapper ─────────────────────────────────────────────────

describe('renderDispatcherWrapper', () => {
  const target: DispatcherTarget = {
    bin: '/Users/x/.nvm/versions/node/v20.19.0/bin/dreamcontext',
    path: '/usr/local/bin:/usr/bin:/bin',
    shell: '/bin/zsh',
  };

  it('is pure — identical input always produces identical output', () => {
    const a = renderDispatcherWrapper(target, '2026-01-01T00:00:00.000Z');
    const b = renderDispatcherWrapper(target, '2026-01-01T00:00:00.000Z');
    expect(a).toBe(b);
  });

  it('never contains a bare -lc flag (only -ilc)', () => {
    const wrapper = renderDispatcherWrapper(target, '2026-01-01T00:00:00.000Z');
    expect(wrapper).toContain('-ilc');
    // A bare `-lc` token would be whitespace/start-of-string immediately
    // followed by "-lc" then whitespace/end-of-string. This does NOT match
    // inside "-ilc" (there the char before "lc" is "i", not a boundary).
    expect(/(?:^|\s)-lc(?:\s|$)/.test(wrapper)).toBe(false);
  });

  it('preflights with a real --version invocation, never `[ -x ]` alone', () => {
    const wrapper = renderDispatcherWrapper(target, '2026-01-01T00:00:00.000Z');
    expect(wrapper).toContain('"$DC_BIN" --version >/dev/null 2>&1');
    expect(wrapper).not.toMatch(/if \[ -x "\$DC_BIN" \] ; then/);
  });

  it('bakes bin/shell/path through shq and closes stdin on both paths', () => {
    const wrapper = renderDispatcherWrapper(target, '2026-01-01T00:00:00.000Z');
    expect(wrapper).toContain(`DC_BIN=${shq(target.bin!)}`);
    expect(wrapper).toContain(`DC_SHELL=${shq(target.shell)}`);
    expect(wrapper).toContain(`export PATH=${shq(target.path)}`);
    expect(wrapper).toContain('exec "$DC_BIN" automations tick --all < /dev/null');
    expect(wrapper).toContain(`exec "$DC_SHELL" -ilc 'exec dreamcontext automations tick --all' < /dev/null`);
  });

  it('CRITICAL: falls through to the interactive-shell fallback when the baked bin is +x but cannot exec', async () => {
    // Reproduces the exact bug this design exists to fix: a +x binary with a
    // dangling shebang. `exec`ing it inside the `if` FAILS AND TERMINATES the
    // shell under the naive `[ -x ]`-only guard — the real implementation
    // guards with a real `--version` invocation instead, so this must fall
    // through to the fallback branch, not die at the `if`.
    const dir = mkdtempSync(join(tmpdir(), 'dc-launchd-broken-'));
    tmpDirs.push(dir);
    const brokenBin = join(dir, 'broken-dreamcontext');
    writeFileSync(brokenBin, '#!/nonexistent/interpreter\necho nope\n');
    chmodSync(brokenBin, 0o755); // +x, but the interpreter doesn't exist -> exec fails

    const brokenTarget: DispatcherTarget = { bin: brokenBin, path: '/usr/bin:/bin', shell: '/bin/sh' };
    const wrapper = renderDispatcherWrapper(brokenTarget, '2026-01-01T00:00:00.000Z');

    // Assert the REAL fallback line is exactly what we expect BEFORE
    // neutralizing it — the substitution below targets this literal string.
    const REAL_FALLBACK = `exec "$DC_SHELL" -ilc 'exec dreamcontext automations tick --all' < /dev/null`;
    expect(wrapper).toContain(REAL_FALLBACK);

    // Neutralize ONLY the fallback's payload command — never the `if`/exec
    // preflight under test — so this test never spawns a real interactive
    // shell, a real `dreamcontext`, or a real `claude` session.
    const marker = 'FALLBACK_REACHED_MARKER';
    const safeScript = wrapper.replace(REAL_FALLBACK, `echo ${marker}`);
    expect(safeScript).not.toBe(wrapper); // the replace actually matched something real

    const result = await new Promise<{ code: number | null; stdout: string }>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', safeScript], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf-8')));
      child.on('close', (code) => resolvePromise({ code, stdout }));
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(marker);
  });

  it('CONTRAST: a naive `[ -x ]`-only guard (the plan defect) does NOT fall through on the same fixture', async () => {
    // Documents WHY the real implementation must probe with `--version`: this
    // is the exact broken shape the approved-plan defect described, run
    // against the SAME broken binary the test above proves the real
    // implementation escapes.
    const dir = mkdtempSync(join(tmpdir(), 'dc-launchd-broken-contrast-'));
    tmpDirs.push(dir);
    const brokenBin = join(dir, 'broken-dreamcontext');
    writeFileSync(brokenBin, '#!/nonexistent/interpreter\necho nope\n');
    chmodSync(brokenBin, 0o755);

    const naiveScript = `#!/bin/sh
DC_BIN='${brokenBin}'
if [ -x "$DC_BIN" ]; then exec "$DC_BIN" automations tick --all < /dev/null; fi
echo FALLBACK_REACHED_MARKER
`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', naiveScript], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf-8')));
      child.on('close', (code) => resolvePromise({ code, stdout }));
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('FALLBACK_REACHED_MARKER');
  });

  it('handles a null bin (nothing resolved) without throwing', () => {
    const nullTarget: DispatcherTarget = { bin: null, path: '/usr/bin:/bin', shell: '/bin/zsh' };
    const wrapper = renderDispatcherWrapper(nullTarget, '2026-01-01T00:00:00.000Z');
    expect(wrapper).toContain("DC_BIN=''");
  });
});

// ─── renderDispatcherPlist ───────────────────────────────────────────────────

describe('renderDispatcherPlist', () => {
  it('is pure and contains the expected keys/values', () => {
    const a = renderDispatcherPlist('/h/.dreamcontext/bin/automations-dispatch.sh', '/h/.dreamcontext/logs/automations.log');
    const b = renderDispatcherPlist('/h/.dreamcontext/bin/automations-dispatch.sh', '/h/.dreamcontext/logs/automations.log');
    expect(a).toBe(b);
    expect(a).toContain('<string>com.dreamcontext.automations</string>');
    expect(a).toContain('<string>/bin/sh</string>');
    expect(a).toContain('<string>/h/.dreamcontext/bin/automations-dispatch.sh</string>');
    expect(a).toContain('<integer>300</integer>');
    expect(a).toContain('<true/>');
    expect(a).toContain('<string>Background</string>');
    expect(a).toContain('<string>/h/.dreamcontext/logs/automations.log</string>');
  });

  it('XML-escapes special characters in embedded paths', () => {
    const plist = renderDispatcherPlist('/h/a&b/wrapper.sh', '/h/logs/a&b.log');
    expect(plist).toContain('/h/a&amp;b/wrapper.sh');
    expect(plist).not.toContain('a&b/wrapper');
  });
});

// ─── paths ────────────────────────────────────────────────────────────────────

describe('path helpers', () => {
  it('are injectable by home', () => {
    expect(dispatcherWrapperPath('/h')).toBe('/h/.dreamcontext/bin/automations-dispatch.sh');
    expect(dispatcherPlistPath('/h')).toBe('/h/Library/LaunchAgents/com.dreamcontext.automations.plist');
    expect(automationsLogPath('/h')).toBe('/h/.dreamcontext/logs/automations.log');
  });
});

// ─── defaultExecRunner ────────────────────────────────────────────────────────

describe('defaultExecRunner', () => {
  // Generic exec plumbing, exercised against harmless real commands — never
  // `launchctl` (that stays behind the fake ExecRunner everywhere else).
  it('captures stdout and reports ok on a zero exit', async () => {
    const res = await defaultExecRunner('/bin/echo', ['hello']);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
  });

  it('reports ok: false and the exit code on a non-zero exit', async () => {
    const res = await defaultExecRunner('/usr/bin/false', []);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
  });

  it('times out and reports ok: false without hanging the test', async () => {
    const res = await defaultExecRunner('/bin/sleep', ['5'], { timeoutMs: 100 });
    expect(res.ok).toBe(false);
    expect(res.code).toBeNull();
  });
});

// ─── resolveDispatcherTarget ─────────────────────────────────────────────────

describe('resolveDispatcherTarget', () => {
  it('parses a resolved bin + PATH from the runner output', async () => {
    const fakeRunner: ExecRunner = async () => ({
      ok: true,
      stdout: '/usr/local/bin/dreamcontext\n/usr/local/bin:/usr/bin:/bin',
      stderr: '',
      code: 0,
    });
    const target = await resolveDispatcherTarget({ runner: fakeRunner });
    expect(target.bin).toBe('/usr/local/bin/dreamcontext');
    expect(target.path).toBe('/usr/local/bin:/usr/bin:/bin');
  });

  it('reports bin: null when command -v finds nothing', async () => {
    const fakeRunner: ExecRunner = async () => ({
      ok: true,
      stdout: '/usr/local/bin:/usr/bin:/bin',
      stderr: '',
      code: 0,
    });
    const target = await resolveDispatcherTarget({ runner: fakeRunner });
    expect(target.bin).toBeNull();
  });
});

describe('runningCliBin', () => {
  it('resolves process.argv[1] and is testable via stubbing', () => {
    withArgv1('/tmp/definitely-not-real/dreamcontext', () => {
      // realpathSync fails on a non-existent path -> falls back to the raw arg.
      expect(runningCliBin()).toBe('/tmp/definitely-not-real/dreamcontext');
    });
  });

  it('returns null when argv[1] is empty', () => {
    withArgv1('', () => {
      expect(runningCliBin()).toBeNull();
    });
  });
});

// ─── inspectDispatcher / installDispatcher / uninstallDispatcher ────────────

function fakeRunnerFor(opts: {
  bin?: string | null;
  path?: string;
  shell?: string;
  bootoutOk?: boolean;
  bootstrapOk?: boolean;
  loadOk?: boolean;
  printOk?: boolean;
}): { runner: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  // Default the fake resolution to whatever `runningCliBin()` ACTUALLY reports
  // for this test process, so a test that doesn't care about the mismatch
  // guard doesn't accidentally trip it. Tests exercising the mismatch path
  // explicitly override `bin` (and stub `process.argv[1]`) themselves.
  const bin = opts.bin === undefined ? runningCliBin() ?? '/usr/local/bin/dreamcontext' : opts.bin;
  const path = opts.path ?? '/usr/local/bin:/usr/bin:/bin';
  const runner: ExecRunner = async (file, args) => {
    calls.push([file, ...args]);
    if (file !== 'launchctl') {
      // shell resolution probe
      const stdout = bin ? `${bin}\n${path}` : path;
      return { ok: true, stdout, stderr: '', code: 0 };
    }
    const verb = args[0];
    if (verb === 'bootout') {
      const ok = opts.bootoutOk ?? true;
      return { ok, stdout: '', stderr: ok ? '' : 'no such thing', code: ok ? 0 : 1 };
    }
    if (verb === 'bootstrap') {
      const ok = opts.bootstrapOk ?? true;
      return { ok, stdout: '', stderr: ok ? '' : 'bootstrap failed', code: ok ? 0 : 1 };
    }
    if (verb === 'load') {
      const ok = opts.loadOk ?? true;
      return { ok, stdout: '', stderr: ok ? '' : 'load failed', code: ok ? 0 : 1 };
    }
    if (verb === 'print') {
      const ok = opts.printOk ?? true;
      return { ok, stdout: '', stderr: ok ? '' : 'not found', code: ok ? 0 : 1 };
    }
    return { ok: false, stdout: '', stderr: `unexpected verb ${verb}`, code: 1 };
  };
  return { runner, calls };
}

describe('inspectDispatcher', () => {
  it('reports missing plist/wrapper on a fresh home, and never calls real launchctl', async () => {
    const home = tmpHome();
    const { runner, calls } = fakeRunnerFor({});
    const check = await inspectDispatcher({ home, runner, uid: 501 });
    expect(check.wrapperPresent).toBe(false);
    expect(check.plistPresent).toBe(false);
    expect(check.bootstrapped).toBe(true); // fake print() reports ok
    expect(calls.some((c) => c[0] === 'launchctl')).toBe(true);
    // every launchctl-labelled call went through the FAKE runner, never spawn().
  });

  it('flags a mismatch when the resolved bin differs from the running CLI', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({ bin: '/opt/homebrew/bin/dreamcontext' });
    await withArgv1('/Users/x/.nvm/versions/node/v20.19.0/bin/dreamcontext', async () => {
      const check = await inspectDispatcher({ home, runner, uid: 501 });
      expect(check.mismatch).toBe(true);
    });
  });

  it('reports no mismatch when resolution agrees with the running CLI', async () => {
    const home = tmpHome();
    const samePath = join(home, 'bin', 'dreamcontext');
    const { runner } = fakeRunnerFor({ bin: samePath });
    const origArgv1 = process.argv[1];
    process.argv[1] = samePath;
    try {
      const check = await inspectDispatcher({ home, runner, uid: 501 });
      expect(check.mismatch).toBe(false);
    } finally {
      process.argv[1] = origArgv1;
    }
  });
});

describe('installDispatcher', () => {
  it('refuses (throws) when nothing resolves on PATH', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({ bin: null });
    await expect(installDispatcher({ home, runner, uid: 501 })).rejects.toThrow(AutomationError);
  });

  it('refuses without writing when the resolved bin mismatches the running CLI, unless --force', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({ bin: '/opt/homebrew/bin/dreamcontext' });
    const runningPath = '/Users/x/.nvm/versions/node/v20.19.0/bin/dreamcontext';
    const origArgv1 = process.argv[1];
    process.argv[1] = runningPath;
    try {
      const refused = await installDispatcher({ home, runner, uid: 501 });
      expect(refused.wroteWrapper).toBe(false);
      expect(refused.wrotePlist).toBe(false);
      expect(refused.warnings.some((w) => w.includes('mismatch'))).toBe(true);

      const forced = await installDispatcher({ home, runner, uid: 501, force: true });
      expect(forced.wroteWrapper).toBe(true);
      expect(forced.wrotePlist).toBe(true);
    } finally {
      process.argv[1] = origArgv1;
    }
  });

  it('writes the wrapper (mode 0700) and plist, and bootstraps via `bootstrap`', async () => {
    const home = tmpHome();
    const { runner, calls } = fakeRunnerFor({});
    const result = await installDispatcher({ home, runner, uid: 501 });
    expect(result.wroteWrapper).toBe(true);
    expect(result.wrotePlist).toBe(true);
    expect(result.bootstrapped).toBe(true);
    expect(result.method).toBe('bootstrap');
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout')).toBe(true);
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true);

    const wrapperPath = dispatcherWrapperPath(home);
    const plistPath = dispatcherPlistPath(home);
    expect(statSync(wrapperPath).mode & 0o777).toBe(0o700);
    expect(statSync(plistPath).isFile()).toBe(true);
  });

  it('falls back to legacy `load -w` when bootstrap fails', async () => {
    const home = tmpHome();
    const { runner, calls } = fakeRunnerFor({ bootstrapOk: false, loadOk: true });
    const result = await installDispatcher({ home, runner, uid: 501 });
    expect(result.method).toBe('load');
    expect(result.bootstrapped).toBe(true);
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'load' && c[2] === '-w')).toBe(true);
  });

  it('warns (does not throw) when both bootstrap and load fail', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({ bootstrapOk: false, loadOk: false });
    const result = await installDispatcher({ home, runner, uid: 501 });
    expect(result.bootstrapped).toBe(false);
    expect(result.method).toBe('none');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('is idempotent — a re-install with unchanged content writes nothing and re-touches nothing', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({});
    const first = await installDispatcher({ home, runner, uid: 501 });
    expect(first.wroteWrapper).toBe(true);

    const wrapperPath = dispatcherWrapperPath(home);
    const plistPath = dispatcherPlistPath(home);
    const wrapperMtime1 = statSync(wrapperPath).mtimeMs;
    const plistMtime1 = statSync(plistPath).mtimeMs;

    const second = await installDispatcher({ home, runner, uid: 501 });
    expect(second.wroteWrapper).toBe(false);
    expect(second.wrotePlist).toBe(false);
    expect(second.method).toBe('none');

    expect(statSync(wrapperPath).mtimeMs).toBe(wrapperMtime1);
    expect(statSync(plistPath).mtimeMs).toBe(plistMtime1);
  });

  it('re-installs when forced even if already current', async () => {
    const home = tmpHome();
    const { runner, calls } = fakeRunnerFor({});
    await installDispatcher({ home, runner, uid: 501 });
    calls.length = 0;
    const forced = await installDispatcher({ home, runner, uid: 501, force: true });
    expect(forced.wroteWrapper).toBe(true);
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true);
  });

  it('throws on a non-darwin platform', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({});
    await withPlatform('linux', async () => {
      await expect(installDispatcher({ home, runner, uid: 501 })).rejects.toThrow(AutomationError);
    });
  });
});

describe('uninstallDispatcher', () => {
  it('boots out and removes the plist + wrapper', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({});
    await installDispatcher({ home, runner, uid: 501 });
    const result = await uninstallDispatcher({ home, runner, uid: 501 });
    expect(result.bootedOut).toBe(true);
    expect(result.removedPlist).toBe(true);
    expect(result.removedWrapper).toBe(true);
    expect(existsSyncSafe(dispatcherPlistPath(home))).toBe(false);
    expect(existsSyncSafe(dispatcherWrapperPath(home))).toBe(false);
  });

  it('is safe to call when nothing was installed', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({ bootoutOk: false });
    const result = await uninstallDispatcher({ home, runner, uid: 501 });
    expect(result.bootedOut).toBe(false);
    expect(result.removedPlist).toBe(false);
    expect(result.removedWrapper).toBe(false);
  });

  it('throws on a non-darwin platform', async () => {
    const home = tmpHome();
    const { runner } = fakeRunnerFor({});
    await withPlatform('linux', async () => {
      await expect(uninstallDispatcher({ home, runner, uid: 501 })).rejects.toThrow(AutomationError);
    });
  });
});

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// ─── rotateLogIfLarge ─────────────────────────────────────────────────────────

describe('rotateLogIfLarge', () => {
  it('returns false when the log does not exist', () => {
    const home = tmpHome();
    expect(rotateLogIfLarge(home, 1024)).toBe(false);
  });

  it('returns false and does not rotate when under the cap', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.dreamcontext', 'logs'), { recursive: true });
    const logPath = automationsLogPath(home);
    writeFileSync(logPath, 'x'.repeat(10));
    expect(rotateLogIfLarge(home, 1024)).toBe(false);
  });

  it('rotates to .log.1 once past the cap', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.dreamcontext', 'logs'), { recursive: true });
    const logPath = automationsLogPath(home);
    writeFileSync(logPath, 'x'.repeat(2000));
    expect(rotateLogIfLarge(home, 1024)).toBe(true);
    expect(existsSyncSafe(logPath)).toBe(false);
    expect(existsSyncSafe(`${logPath}.1`)).toBe(true);
  });
});
