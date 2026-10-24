import { describe, it, expect, vi, afterEach } from 'vitest';
import { promisify } from 'node:util';
import {
  withHiddenWindow, installHiddenWindowDefaults, killPortable, killChildTree,
  resolveBareWin32, withResolvedFile, recordedChildIsOurs, win32AbsolutePathDirs,
} from '../../src/lib/proc.js';

const H = { windowsHide: true };

afterEach(() => vi.restoreAllMocks());

describe('withHiddenWindow', () => {
  it('adds the options argument to a bare call', () => {
    expect(withHiddenWindow(['git'])).toEqual(['git', H]);
  });

  it('puts options after an args array', () => {
    expect(withHiddenWindow(['git', ['status']])).toEqual(['git', ['status'], H]);
  });

  it('merges into an options object', () => {
    expect(withHiddenWindow(['git', { cwd: '/x' }])).toEqual(['git', { cwd: '/x', windowsHide: true }]);
    expect(withHiddenWindow(['git', ['a'], { cwd: '/x' }])).toEqual(['git', ['a'], { cwd: '/x', windowsHide: true }]);
  });

  it('keeps an explicit windowsHide, true or false', () => {
    expect(withHiddenWindow(['explorer', { windowsHide: false }])).toEqual(['explorer', { windowsHide: false }]);
    expect(withHiddenWindow(['x', [], { windowsHide: true, cwd: 'c' }])).toEqual(['x', [], { windowsHide: true, cwd: 'c' }]);
  });

  it('splices options in before a callback', () => {
    const cb = () => {};
    expect(withHiddenWindow(['dir', cb])).toEqual(['dir', H, cb]);
    expect(withHiddenWindow(['dir', { cwd: 'c' }, cb])).toEqual(['dir', { cwd: 'c', windowsHide: true }, cb]);
    expect(withHiddenWindow(['f', ['a'], cb])).toEqual(['f', ['a'], H, cb]);
  });

  it('fills a null options slot (execFile(f, args, null, cb))', () => {
    const cb = () => {};
    expect(withHiddenWindow(['f', ['a'], null, cb])).toEqual(['f', ['a'], H, cb]);
  });

  it('finds options behind an undefined args slot', () => {
    expect(withHiddenWindow(['f', undefined, { cwd: 'c' }])).toEqual(['f', undefined, { cwd: 'c', windowsHide: true }]);
  });

  it('never mutates its input', () => {
    const opts = { cwd: 'c' };
    const args = ['f', ['a'], opts];
    withHiddenWindow(args);
    expect(opts).toEqual({ cwd: 'c' });
    expect(args).toHaveLength(3);
  });
});

/** A stand-in for child_process whose launchers record what they were called with. */
function fakeCp() {
  const calls: Record<string, unknown[][]> = {};
  const cp: Record<string, unknown> = {};
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    calls[name] = [];
    cp[name] = (...a: unknown[]) => { calls[name].push(a); return name; };
  }
  (cp.execFile as Record<symbol, unknown>)[promisify.custom] = (...a: unknown[]) => { calls.execFilePromisified = [a]; return Promise.resolve({}); };
  return { cp: cp as never, raw: cp, calls };
}

describe('installHiddenWindowDefaults', () => {
  it('does nothing off Windows', () => {
    const { cp, raw } = fakeCp();
    const before = { ...raw };
    expect(installHiddenWindowDefaults(cp, 'darwin')).toBe(false);
    expect(raw.spawn).toBe(before.spawn);
  });

  it('wraps every launcher on win32 and defaults windowsHide', () => {
    const { cp, raw, calls } = fakeCp();
    expect(installHiddenWindowDefaults(cp, 'win32', (f) => f)).toBe(true);
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      expect((raw[name] as (...a: unknown[]) => unknown)('cmd')).toBe(name);
      expect(calls[name][0]).toEqual(['cmd', H]);
    }
  });

  it('is idempotent', () => {
    const { cp, raw, calls } = fakeCp();
    installHiddenWindowDefaults(cp, 'win32');
    const wrapped = raw.spawn;
    expect(installHiddenWindowDefaults(cp, 'win32')).toBe(true);
    expect(raw.spawn).toBe(wrapped);
    (raw.spawn as (...a: unknown[]) => unknown)('cmd');
    expect(calls.spawn).toHaveLength(1);
  });

  it('routes promisify(execFile) through the custom symbol with windowsHide', async () => {
    const { cp, raw, calls } = fakeCp();
    installHiddenWindowDefaults(cp, 'win32', (f) => f);
    await promisify(raw.execFile as never)('git', ['--version']);
    expect(calls.execFilePromisified[0]).toEqual(['git', ['--version'], H]);
  });

  it('runs a bare name through the resolver on the four FILE launchers only', async () => {
    const { cp, raw, calls } = fakeCp();
    installHiddenWindowDefaults(cp, 'win32', (f) => `C:\\abs\\${f}.exe`);
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
      (raw[name] as (...a: unknown[]) => unknown)('git', ['status']);
      expect(calls[name][0][0], name).toBe('C:\\abs\\git.exe');
    }
    for (const name of ['exec', 'execSync', 'fork']) {
      (raw[name] as (...a: unknown[]) => unknown)('git status');
      expect(calls[name][0][0], name).toBe('git status');
    }
    await promisify(raw.execFile as never)('git', ['--version']);
    expect(calls.execFilePromisified[0][0]).toBe('C:\\abs\\git.exe');
  });
});

describe('resolveBareWin32 — a bare name never runs from the working folder', () => {
  const env = { Path: 'C:\\Program Files\\Git\\cmd;.;bin;"C:\\Tools"', SystemRoot: 'C:\\Windows' };
  const onDisk = (...files: string[]) => (p: string) => files.includes(p);

  it('takes the first absolute PATH hit, .com before .exe, any key case', () => {
    expect(resolveBareWin32('git', env, onDisk('C:\\Program Files\\Git\\cmd\\git.exe'))).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(resolveBareWin32('x', env, onDisk('C:\\Tools\\x.com', 'C:\\Tools\\x.exe'))).toBe('C:\\Tools\\x.com');
    expect(resolveBareWin32('claude.exe', env, onDisk('C:\\Tools\\claude.exe'))).toBe('C:\\Tools\\claude.exe');
  });

  it('ignores relative PATH entries (., bin): they are the working folder again', () => {
    expect(win32AbsolutePathDirs(env)).toEqual(['C:\\Program Files\\Git\\cmd', 'C:\\Tools']);
    const probed: string[] = [];
    resolveBareWin32('git', env, (p) => { probed.push(p); return false; });
    expect(probed.every((p) => /^C:\\/.test(p))).toBe(true);
  });

  it('falls back to System32 (ENOENT there), never the bare name', () => {
    expect(resolveBareWin32('claude', env, () => false)).toBe('C:\\Windows\\System32\\claude');
    expect(resolveBareWin32('claude', {}, () => false)).toBe('C:\\Windows\\System32\\claude');
  });

  it('leaves a path with a separator or a drive alone', () => {
    for (const f of ['C:\\x\\git.exe', '.\\git', 'tools/git', 'D:git']) {
      expect(resolveBareWin32(f, env, () => true)).toBe(f);
    }
  });

  it('withResolvedFile skips a shell call and reads PATH from the call\'s own env', () => {
    const seen: Array<string | undefined> = [];
    const r = (f: string, e: NodeJS.ProcessEnv) => { seen.push(e.PATH); return `R:${f}`; };
    expect(withResolvedFile(['npm install', { shell: true }], r)).toEqual(['npm install', { shell: true }]);
    expect(withResolvedFile(['git', ['a'], { env: { PATH: 'C:\\only' } }], r)[0]).toBe('R:git');
    expect(seen).toEqual(['C:\\only']);
  });
});

describe('recordedChildIsOurs — Windows reuses pids, and the kill is a tree kill', () => {
  it('is always true off win32 (a recycled pid there fails ESRCH harmlessly)', () => {
    expect(recordedChildIsOurs(123, 0, 'darwin', () => { throw new Error('never asked'); })).toBe(true);
  });

  it('on win32: only while the recorded runner is still the parent', () => {
    expect(recordedChildIsOurs(500, 42, 'win32', () => 42)).toBe(true);
    expect(recordedChildIsOurs(500, 42, 'win32', () => 9001)).toBe(false); // reused by someone else
    expect(recordedChildIsOurs(500, 42, 'win32', () => null)).toBe(false); // gone / unreadable
    expect(recordedChildIsOurs(500, 0, 'win32', () => 0)).toBe(false); // no runner on record
  });
});

describe('killPortable', () => {
  it('is process.kill off win32', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killPortable(-123, 'SIGTERM', { platform: 'darwin' });
    expect(spy).toHaveBeenCalledWith(-123, 'SIGTERM');
  });

  it('probes liveness with the absolute pid on win32 for signal 0', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killPortable(-123, 0, { platform: 'win32' });
    expect(spy).toHaveBeenCalledWith(123, 0);
  });

  it('SIGKILL makes one forced taskkill with the absolute pid', () => {
    const taskkill = vi.fn(() => true);
    killPortable(-77, 'SIGKILL', { platform: 'win32', taskkill });
    expect(taskkill.mock.calls).toEqual([[77, true]]);
  });

  it('SIGTERM stops after one graceful call when the pid is really gone', () => {
    const taskkill = vi.fn(() => true);
    killPortable(-77, 'SIGTERM', { platform: 'win32', taskkill, isAlive: () => false });
    expect(taskkill.mock.calls).toEqual([[77, false]]);
  });

  it('escalates to /F when the graceful call exits 0 but the pid is still alive', () => {
    const taskkill = vi.fn(() => true);
    killPortable(-77, 'SIGTERM', { platform: 'win32', taskkill, isAlive: () => true });
    expect(taskkill.mock.calls).toEqual([[77, false], [77, true]]);
  });

  it('escalates to /F when the graceful call fails', () => {
    const taskkill = vi.fn((_pid: number, force: boolean) => force);
    killPortable(-77, 'SIGTERM', { platform: 'win32', taskkill, isAlive: () => true });
    expect(taskkill.mock.calls).toEqual([[77, false], [77, true]]);
  });

  it('throws ESRCH when taskkill fails and the pid is gone', () => {
    expect(() => killPortable(-77, 'SIGKILL', { platform: 'win32', taskkill: () => false, isAlive: () => false }))
      .toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('throws EPERM when taskkill fails and the pid lives on', () => {
    expect(() => killPortable(-77, 'SIGKILL', { platform: 'win32', taskkill: () => false, isAlive: () => true }))
      .toThrow(expect.objectContaining({ code: 'EPERM' }));
  });
});

describe('killChildTree', () => {
  it('is child.kill(signal) off win32', () => {
    const child = { pid: 5, kill: vi.fn(() => true) };
    killChildTree(child, 'SIGTERM', 'darwin');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills the tree through taskkill on win32', () => {
    const child = { pid: 5, kill: vi.fn(() => true) };
    const taskkill = vi.fn(() => true);
    killChildTree(child, 'SIGKILL', 'win32', { taskkill });
    expect(taskkill.mock.calls).toEqual([[5, true]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to child.kill() when taskkill cannot', () => {
    const child = { pid: 5, kill: vi.fn(() => true) };
    killChildTree(child, 'SIGTERM', 'win32', { taskkill: () => false, isAlive: () => true });
    expect(child.kill).toHaveBeenCalledWith();
  });

  it('uses child.kill when there is no pid', () => {
    const child = { kill: vi.fn(() => true) };
    killChildTree(child, 'SIGTERM', 'win32');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('treeKillRealChild', () => {
  it('never taskkills a plain fake, even on win32 with a pid', async () => {
    const { treeKillRealChild } = await import('../../src/lib/proc.js');
    const tree = vi.fn();
    expect(treeKillRealChild({ pid: 4242 }, 'SIGKILL', 'win32', tree)).toBe(false);
    expect(tree).not.toHaveBeenCalled();
  });

  it('tree-kills a real ChildProcess on win32 only', async () => {
    const { treeKillRealChild } = await import('../../src/lib/proc.js');
    const { ChildProcess } = await import('node:child_process');
    const real = Object.assign(new ChildProcess(), { pid: 777 });
    const tree = vi.fn();
    expect(treeKillRealChild(real, 'SIGKILL', 'darwin', tree)).toBe(false);
    expect(tree).not.toHaveBeenCalled();
    expect(treeKillRealChild(real, 'SIGKILL', 'win32', tree)).toBe(true);
    expect(tree).toHaveBeenCalledWith(-777, 'SIGKILL');
  });

  it('reports false when the tree kill throws, so the caller falls back', async () => {
    const { treeKillRealChild } = await import('../../src/lib/proc.js');
    const { ChildProcess } = await import('node:child_process');
    const real = Object.assign(new ChildProcess(), { pid: 777 });
    expect(treeKillRealChild(real, 'SIGKILL', 'win32', () => { throw new Error('x'); })).toBe(false);
  });
});
