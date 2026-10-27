import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLatestVersion,
  readSelfUpdateRecord,
  runSelfUpdateCheck,
  selfUpdateDisabledBy,
  selfUpdateLogPath,
  setSelfUpdateEnabled,
  SELF_UPDATE_INTERVAL_MS,
  SELF_UPDATE_RETRY_MS,
  type SelfUpdateDeps,
} from '../../src/lib/self-update.js';
import { cliAutoUpdateOffPath, selfUpdateLockPath } from '../../src/lib/version-check.js';

let home: string;
let clock: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-self-update-'));
  clock = 1_800_000_000_000;
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const log = () => (existsSync(selfUpdateLogPath(home)) ? readFileSync(selfUpdateLogPath(home), 'utf-8') : '');

/** A machine on `installed` with `latest` published; the upgrade moves it to `lands` (or not). */
function machine(opts: { installed?: string; latest?: string | null; lands?: string | null; ok?: boolean; output?: string; busy?: () => boolean } = {}) {
  let installed = opts.installed ?? '0.35.0';
  const runUpgrade = vi.fn(async () => {
    if (opts.lands) installed = opts.lands;
    return { ok: opts.ok ?? true, output: opts.output ?? 'CLI upgraded.\n✓ Refreshed 2/2 project(s).' };
  });
  const deps: SelfUpdateDeps = {
    home,
    env: {},
    now: () => clock,
    busy: opts.busy ?? (() => false),
    installedVersion: () => installed,
    latestVersion: async () => (opts.latest === undefined ? '0.36.0' : opts.latest),
    runUpgrade,
  };
  return { deps, runUpgrade };
}

describe('runSelfUpdateCheck', () => {
  it('upgrades a CLI that is behind through the injected upgrade job, records it and logs it', async () => {
    const { deps, runUpgrade } = machine({ lands: '0.36.0' });
    const r = await runSelfUpdateCheck({}, deps);
    expect(runUpgrade).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ ran: true, state: 'updated' });
    expect(readSelfUpdateRecord(home)).toMatchObject({ state: 'updated', from: '0.35.0', to: '0.36.0', attemptedFor: '0.36.0', checkedAt: clock });
    expect(log()).toContain('updating: 0.35.0 → 0.36.0');
    expect(log()).toContain('updated: 0.35.0 → 0.36.0');
    // The lock is released once the run ends.
    expect(existsSync(selfUpdateLockPath(home))).toBe(false);
  });

  it('a current CLI runs nothing', async () => {
    const { deps, runUpgrade } = machine({ installed: '0.36.0' });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ ran: true, state: 'current' });
    expect(runUpgrade).not.toHaveBeenCalled();
  });

  it('npm out of reach records unknown and runs nothing', async () => {
    const { deps, runUpgrade } = machine({ latest: null });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'unknown' });
    expect(runUpgrade).not.toHaveBeenCalled();
  });

  it('is throttled for 6 h after a check; force skips the throttle', async () => {
    const { deps, runUpgrade } = machine({ installed: '0.36.0' });
    await runSelfUpdateCheck({}, deps);
    clock += SELF_UPDATE_INTERVAL_MS - 1;
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ ran: false, state: 'skipped' });
    expect((await runSelfUpdateCheck({ force: true }, deps)).ran).toBe(true);
    clock += SELF_UPDATE_INTERVAL_MS;
    expect((await runSelfUpdateCheck({}, deps)).ran).toBe(true);
    expect(runUpgrade).not.toHaveBeenCalled();
  });

  it('a busy chat defers the run without spending the throttle, and the deferral is logged once', async () => {
    let busy = true;
    const { deps, runUpgrade } = machine({ lands: '0.36.0', busy: () => busy });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ ran: false, state: 'deferred' });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ ran: false, state: 'deferred' });
    expect(runUpgrade).not.toHaveBeenCalled();
    expect(log().match(/deferred/g)).toHaveLength(1);
    busy = false;
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ ran: true, state: 'updated' });
  });

  it('a chat that starts while the version is looked up still defers the upgrade', async () => {
    let calls = 0;
    const { deps, runUpgrade } = machine({ lands: '0.36.0', busy: () => ++calls > 1 });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'deferred' });
    expect(runUpgrade).not.toHaveBeenCalled();
    expect(existsSync(selfUpdateLockPath(home))).toBe(false);
  });

  it('a failed upgrade is recorded with its output and retried only a day later (never a loop)', async () => {
    const { deps, runUpgrade } = machine({ lands: null, ok: false, output: 'npm ERR! code EACCES\nnpm ERR! permission denied' });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'failed' });
    expect(readSelfUpdateRecord(home)?.error).toContain('EACCES');
    expect(log()).toContain('failed: 0.35.0 → 0.36.0');
    clock += SELF_UPDATE_INTERVAL_MS;
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'failed' });
    expect(runUpgrade).toHaveBeenCalledOnce();
    expect(readSelfUpdateRecord(home)?.error).toContain('EACCES');
    clock += SELF_UPDATE_RETRY_MS;
    await runSelfUpdateCheck({}, deps);
    expect(runUpgrade).toHaveBeenCalledTimes(2);
  });

  it('a deferral, an offline check or an opt-out between attempts does not reset the daily retry limit', async () => {
    let busy = false;
    const latest = { v: '0.36.0' as string | null };
    const { deps, runUpgrade } = machine({ lands: null, ok: false, output: 'npm ERR! EACCES', busy: () => busy });
    deps.latestVersion = async () => latest.v;
    await runSelfUpdateCheck({}, deps);
    expect(runUpgrade).toHaveBeenCalledOnce();
    clock += SELF_UPDATE_INTERVAL_MS;
    busy = true;
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'deferred' });
    busy = false;
    latest.v = null;
    expect(await runSelfUpdateCheck({ force: true }, deps)).toMatchObject({ state: 'unknown' });
    latest.v = '0.36.0';
    setSelfUpdateEnabled(false, home);
    await runSelfUpdateCheck({ force: true }, deps);
    setSelfUpdateEnabled(true, home);
    expect(await runSelfUpdateCheck({ force: true }, deps)).toMatchObject({ state: 'failed' });
    expect(runUpgrade).toHaveBeenCalledOnce();
    expect(readSelfUpdateRecord(home)?.error).toContain('EACCES');
  });

  it('a success clears the failure it carried', async () => {
    let lands: string | null = null;
    const { deps } = machine({ ok: true });
    let installed = '0.35.0';
    deps.installedVersion = () => installed;
    deps.runUpgrade = async () => { if (lands) installed = lands; return { ok: !!lands, output: lands ? 'ok' : 'npm ERR! boom' }; };
    await runSelfUpdateCheck({}, deps);
    expect(readSelfUpdateRecord(home)).toMatchObject({ state: 'failed', failedFor: '0.36.0' });
    clock += SELF_UPDATE_RETRY_MS;
    lands = '0.36.0';
    await runSelfUpdateCheck({}, deps);
    const rec = readSelfUpdateRecord(home);
    expect(rec).toMatchObject({ state: 'updated' });
    expect(rec?.failedFor).toBeUndefined();
    expect(rec?.error).toBeUndefined();
  });

  it('an upgrade that exits 0 but leaves the install behind is a failure', async () => {
    const { deps } = machine({ lands: null, ok: true });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'failed' });
  });

  it('a newer target than the one that failed is tried at once', async () => {
    const latest = { v: '0.36.0' };
    const { deps, runUpgrade } = machine({ lands: null, ok: false });
    deps.latestVersion = async () => latest.v;
    await runSelfUpdateCheck({}, deps);
    clock += SELF_UPDATE_INTERVAL_MS;
    latest.v = '0.36.1';
    await runSelfUpdateCheck({}, deps);
    expect(runUpgrade).toHaveBeenCalledTimes(2);
  });

  it('stands back while another live process holds the lock', async () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(selfUpdateLockPath(home), JSON.stringify({ pid: process.pid, at: clock }));
    const { deps, runUpgrade } = machine({ lands: '0.36.0' });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ ran: false, state: 'skipped' });
    expect(runUpgrade).not.toHaveBeenCalled();
    expect(existsSync(selfUpdateLockPath(home))).toBe(true);
  });

  it('a second call while one runs joins it instead of starting another', async () => {
    let release: () => void = () => {};
    const { deps, runUpgrade } = machine({ lands: '0.36.0' });
    deps.runUpgrade = vi.fn(() => new Promise<{ ok: boolean; output: string }>((r) => { release = () => r({ ok: true, output: '' }); }));
    const a = runSelfUpdateCheck({}, deps);
    const b = runSelfUpdateCheck({}, deps);
    expect(b).toBe(a);
    await vi.waitFor(() => expect(deps.runUpgrade).toHaveBeenCalledOnce());
    release();
    await a;
    expect(runUpgrade).not.toHaveBeenCalled();
  });

  it('respects the opt-out: the Settings marker and both variables, logged once', async () => {
    const { deps, runUpgrade } = machine({ lands: '0.36.0' });
    setSelfUpdateEnabled(false, home);
    expect(existsSync(cliAutoUpdateOffPath(home))).toBe(true);
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'disabled' });
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'disabled' });
    expect(log().match(/off: turned off in Settings/g)).toHaveLength(1);
    setSelfUpdateEnabled(true, home);
    expect(await runSelfUpdateCheck({}, { ...deps, env: { DREAMCONTEXT_AUTO_UPGRADE: '0' } })).toMatchObject({ state: 'disabled' });
    expect(await runSelfUpdateCheck({}, { ...deps, env: { DREAMCONTEXT_VERSION_CHECK: '0' } })).toMatchObject({ state: 'disabled' });
    expect(runUpgrade).not.toHaveBeenCalled();
    expect(await runSelfUpdateCheck({}, deps)).toMatchObject({ state: 'updated' });
  });
});

describe('helpers', () => {
  it('names what turned updates off', () => {
    expect(selfUpdateDisabledBy({}, home)).toBeNull();
    expect(selfUpdateDisabledBy({ DREAMCONTEXT_VERSION_CHECK: '0' }, home)).toBe('DREAMCONTEXT_VERSION_CHECK=0');
    setSelfUpdateEnabled(false, home);
    expect(selfUpdateDisabledBy({}, home)).toBe('turned off in Settings');
  });

  it('reads the version off npm view output, ignoring a noisy login shell', () => {
    expect(parseLatestVersion('Now using node v22.11.0 (npm v10.9.0)\n0.36.0\n')).toBe('0.36.0');
    expect(parseLatestVersion('npm ERR! 404')).toBeNull();
  });

  it('an unreadable record reads as none', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'self-update.json'), '{nope');
    expect(readSelfUpdateRecord(home)).toBeNull();
  });
});
