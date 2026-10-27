import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const runSelfUpdateCheck = vi.fn();
vi.mock('../../src/lib/self-update.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/self-update.js')>()),
  runSelfUpdateCheck: (...args: unknown[]) => runSelfUpdateCheck(...args),
}));

const { readyVersionOnDisk, selfUpdateJobDisabledReason, startSelfUpdateJob } = await import('../../src/server/self-update-job.js');
const { selfUpdateView } = await import('../../src/server/routes/launcher.js');
const { setSelfUpdateEnabled } = await import('../../src/lib/self-update.js');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startUpgradeRun, getUpgradeRun, __resetUpgradeRun } = await import('../../src/server/upgrade-job.js');
const { relaunchableUpgrade } = await import('../../src/server/routes/health.js');

/** The app-owned desktop server: the Tauri shell's pid is this process's ppid. */
const APP_ENV = { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: '4242' };

beforeEach(() => {
  runSelfUpdateCheck.mockReset();
  runSelfUpdateCheck.mockResolvedValue({ ran: true, state: 'current', message: 'current: 0.36.0 is the latest' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  __resetUpgradeRun();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('selfUpdateJobDisabledReason', () => {
  it('runs only in the app-owned desktop server, off Windows, outside tests', () => {
    expect(selfUpdateJobDisabledReason(APP_ENV, 4242, 'darwin')).toBeNull();
    expect(selfUpdateJobDisabledReason({}, 4242, 'darwin')).toBe('not the desktop app');
    expect(selfUpdateJobDisabledReason({ ...APP_ENV, VITEST: 'true' }, 4242, 'darwin')).toBe('test run');
    expect(selfUpdateJobDisabledReason(APP_ENV, 1, 'darwin')).toMatch(/not the app-owned server/);
    expect(selfUpdateJobDisabledReason(APP_ENV, 4242, 'win32')).toMatch(/Windows/);
  });
});

describe('startSelfUpdateJob', () => {
  it('asks once after the first delay, then on every tick, with the busy test and the upgrade job wired in', async () => {
    vi.useFakeTimers();
    const stop = startSelfUpdateJob({ env: APP_ENV, ppid: 4242, platform: 'darwin', firstTickMs: 1000, tickMs: 5000 });
    expect(stop).toBeTypeOf('function');
    expect(runSelfUpdateCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runSelfUpdateCheck).toHaveBeenCalledOnce();
    const deps = runSelfUpdateCheck.mock.calls[0][1] as { busy: () => boolean; runUpgrade: unknown };
    expect(deps.busy()).toBe(false);
    expect(deps.runUpgrade).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runSelfUpdateCheck).toHaveBeenCalledTimes(3);
    stop!();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runSelfUpdateCheck).toHaveBeenCalledTimes(3);
  });

  it('starts nothing when gated off', () => {
    expect(startSelfUpdateJob({ env: {}, ppid: 4242, platform: 'darwin' })).toBeUndefined();
  });

  it('the timer knobs come from the environment (the scratch end-to-end uses them)', async () => {
    vi.useFakeTimers();
    const stop = startSelfUpdateJob({ env: { ...APP_ENV, DREAMCONTEXT_SELF_UPDATE_FIRST_TICK_MS: '50' }, ppid: 4242, platform: 'darwin' });
    await vi.advanceTimersByTimeAsync(50);
    expect(runSelfUpdateCheck).toHaveBeenCalledOnce();
    stop!();
  });
});

/** A child process stand-in the test drives. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  return child;
}

describe('startUpgradeRun (the one upgrade path the badge and the self-update share)', () => {
  it('runs `<node> <cli> upgrade --yes` in a login shell and reports done with the output tail', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child);
    const started = startUpgradeRun({ trigger: 'auto', env: { SHELL: '/bin/zsh' }, cliEntry: '/p/bin/dreamcontext', execPath: '/n/node', spawnImpl: spawnImpl as never });
    expect('error' in started).toBe(false);
    if ('error' in started) return;
    expect(spawnImpl).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'exec "$0" "$1" upgrade --yes', '/n/node', '/p/bin/dreamcontext'], expect.anything());
    // A second start while it runs joins it.
    const again = startUpgradeRun({ trigger: 'manual', spawnImpl: spawnImpl as never, cliEntry: '/x' });
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect('error' in again ? null : again.run).toBe(started.run);
    child.stdout.write('CLI upgraded.\n');
    child.emit('close', 0);
    const run = await started.done;
    expect(run).toMatchObject({ state: 'done', trigger: 'auto' });
    expect(run.output).toContain('CLI upgraded.');
    expect(getUpgradeRun()).toBe(run);
  });

  it('a non-zero exit, a spawn error and the timeout all end as error', async () => {
    const a = fakeChild();
    const r1 = startUpgradeRun({ trigger: 'auto', env: {}, cliEntry: '/c', spawnImpl: (() => a) as never });
    a.emit('close', 1);
    expect(('error' in r1 ? null : await r1.done)?.state).toBe('error');

    const b = fakeChild();
    const r2 = startUpgradeRun({ trigger: 'auto', env: {}, cliEntry: '/c', spawnImpl: (() => b) as never });
    b.emit('error', new Error('ENOENT'));
    expect(('error' in r2 ? null : await r2.done)?.output).toContain('ENOENT');

    vi.useFakeTimers();
    const c = fakeChild();
    const r3 = startUpgradeRun({ trigger: 'auto', env: {}, cliEntry: '/c', spawnImpl: (() => c) as never, maxMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(('error' in r3 ? null : await r3.done)?.output).toContain('timed out');
    expect(c.kill).toHaveBeenCalled();
  });

  it('no CLI entry is reported, not spawned', () => {
    const spawnImpl = vi.fn();
    expect(startUpgradeRun({ trigger: 'auto', env: {}, cliEntry: '', spawnImpl: spawnImpl as never })).toEqual({ error: 'no_cli' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('relaunchableUpgrade', () => {
  it('holds the relaunch back while a chat is mid-turn', () => {
    expect(relaunchableUpgrade('0.36.0', () => false, () => false)).toBe('0.36.0');
    expect(relaunchableUpgrade('0.36.0', () => true, () => false)).toBeNull();
    expect(relaunchableUpgrade(null, () => false, () => false)).toBeNull();
  });

  it('holds it back while an upgrade run is still refreshing projects (the relaunch would reap it)', () => {
    expect(relaunchableUpgrade('0.36.0', () => false, () => true)).toBeNull();
  });

  it('by default reads the shared upgrade run: a running one holds the relaunch, a finished one releases it', async () => {
    const child = fakeChild();
    const started = startUpgradeRun({ trigger: 'auto', env: {}, cliEntry: '/c', spawnImpl: (() => child) as never });
    expect(relaunchableUpgrade('0.36.0', () => false)).toBeNull();
    child.emit('close', 0);
    if (!('error' in started)) await started.done;
    expect(relaunchableUpgrade('0.36.0', () => false)).toBe('0.36.0');
  });
});

describe('readyVersionOnDisk', () => {
  const own = () => '0.36.0';
  it('is the running package\'s own version when the global CLI is what runs, or there is none', () => {
    expect(readyVersionOnDisk({}, '/p/bin/dreamcontext', own, () => '9.9.9')).toBe('0.36.0');
    expect(readyVersionOnDisk({ DREAMCONTEXT_GLOBAL_CLI: '/p/bin/dreamcontext' }, '/p/bin/dreamcontext', own, () => '9.9.9')).toBe('0.36.0');
  });

  it('while the bundled copy runs, a strictly newer global install is the upgrade to relaunch onto', () => {
    const env = { DREAMCONTEXT_GLOBAL_CLI: '/p/bin/dreamcontext' };
    const bundle = '/Applications/dreamcontext-beta.app/Contents/Resources/dist/index.js';
    expect(readyVersionOnDisk(env, bundle, own, () => '0.37.0')).toBe('0.37.0');
    expect(readyVersionOnDisk(env, bundle, own, () => '0.36.0')).toBe('0.36.0');
    expect(readyVersionOnDisk(env, bundle, own, () => '0.35.0')).toBe('0.36.0');
    expect(readyVersionOnDisk(env, bundle, own, () => null)).toBe('0.36.0');
  });
});

describe('selfUpdateView (what Settings shows)', () => {
  it('the switch is its marker, also while a variable turns updates off', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-self-update-view-'));
    try {
      const env = { DREAMCONTEXT_AUTO_UPGRADE: '0' };
      expect(selfUpdateView(home, env)).toMatchObject({ enabled: true, disabledBy: 'DREAMCONTEXT_AUTO_UPGRADE=0' });
      setSelfUpdateEnabled(false, home);
      expect(selfUpdateView(home, env)).toMatchObject({ enabled: false, disabledBy: 'DREAMCONTEXT_AUTO_UPGRADE=0' });
      expect(selfUpdateView(home, {})).toMatchObject({ enabled: false, disabledBy: 'turned off in Settings' });
      setSelfUpdateEnabled(true, home);
      expect(selfUpdateView(home, {})).toMatchObject({ enabled: true, disabledBy: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
