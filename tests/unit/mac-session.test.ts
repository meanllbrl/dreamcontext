// Mac mode's orchestrator (AC2 setup, AC3 start, AC10 Return, AC12 crash recovery, AC13, AC15).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacSession, MacModeError, readMacState, statePathOf, type MacSessionDeps } from '../../src/lib/handsfree/mac/session.js';
import { HandsfreeAuth, ensureMacHandsfreeDir, generatePassphrase, hashPassphrase, sha256Hex } from '../../src/server/handsfree-auth.js';
import type { PowerRunner } from '../../src/lib/handsfree/mac/power.js';
import { ThermalGovernor, thermalPendingPathOf, type LedgerEntry } from '../../src/lib/handsfree/mac/thermal.js';
import { BG_PRI, NORMAL_PRI, T0, World, lstartOf } from '../helpers/thermal-world.js';
import { macPrefsPathOf, readMacPrefs } from '../../src/lib/handsfree/mac/prefs.js';

const CUSTOM = 'Battery Power:\n lowpowermode         0\nAC Power:\n lowpowermode         1\n';

let home: string;
let auth: HandsfreeAuth;
let events: string[];
let battText: string;
let origin: string | null;
let notes: Array<[string, string]>;
let world: World;

function powerRun(): PowerRunner {
  return async (file, args) => {
    const line = [file, ...args].join(' ');
    events.push(line);
    if (line === '/usr/bin/pmset -g custom') return { code: 0, stdout: CUSTOM, stderr: '' };
    if (line === '/usr/bin/pmset -g batt') return { code: 0, stdout: battText, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

function fakeSupervisor(url = 'https://quiet-lake-1234.trycloudflare.com') {
  return () => ({
    pid: 4242 as number | null,
    url,
    start: vi.fn(async () => { events.push('tunnel:start'); return { child: new EventEmitter() as never, url, mode: 'quick' as const }; }),
    stop: vi.fn(async () => { events.push('tunnel:stop'); }),
  });
}

function deps(over: Partial<MacSessionDeps> = {}): MacSessionDeps {
  return {
    home,
    serverPid: 777,
    platform: 'darwin',
    auth: () => auth as never,
    hashPassphrase: (p) => hashPassphrase(p),
    generatePassphrase: () => generatePassphrase(),
    startListener: async () => { events.push('listener:start'); return { port: 41234 }; },
    stopListener: async () => { events.push('listener:stop'); },
    setPublicOrigin: (o) => { origin = o; events.push(`origin:${o}`); },
    setProbeNonce: () => {},
    setPhoneSource: () => {},
    releasePhoneSessions: () => { events.push('release'); return 1; },
    notify: (t, b) => { notes.push([t, b]); },
    powerRun: powerRun(),
    ensureBinary: async () => join(home, '.dreamcontext', 'bin', 'cloudflared-2026.10.1'),
    makeSupervisor: (_o, e) => { const s = fakeSupervisor()(); const start = s.start; s.start = vi.fn(async () => { const r = await start(); e.onUrl(r.url, false); return r; }); return s; },
    probe: async () => true,
    sudoersInstalled: () => true,
    installSudoers: async () => 'ok',
    isAlive: () => false,
    commandOf: () => '',
    kill: vi.fn(),
    // Never the real osascript/ps/taskpolicy: a fake process table.
    thermalRun: world.run,
    readThermal: world.readThermal,
    thermalPollMs: 60_000,
    ...over,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'mac-session-'));
  const dir = ensureMacHandsfreeDir(home);
  auth = new HandsfreeAuth({ dir });
  events = [];
  notes = [];
  world = new World();
  origin = null;
  battText = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging;";
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('setup (AC2)', () => {
  it('installs the drop-in once and shows the passphrase once; only its verifier is stored, 0700/0600', async () => {
    let installed = false;
    const install = vi.fn(async () => { installed = true; return 'ok' as const; });
    const s = new MacSession(deps({ sudoersInstalled: () => installed, installSudoers: install }));
    const r = await s.setup();
    expect(install).toHaveBeenCalledTimes(1);
    expect(r.passphrase).toMatch(/^[a-z-]+( [a-z-]+){5}$/);
    const dir = join(home, '.dreamcontext', 'handsfree-mac');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, 'auth.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(r.passphrase!);
    // A second setup keeps the passphrase (null = not shown again) and prompts no more.
    expect((await s.setup()).passphrase).toBeNull();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('a dismissed admin prompt is mac_admin_cancelled', async () => {
    const s = new MacSession(deps({ sudoersInstalled: () => false, installSudoers: async () => 'cancelled' }));
    await expect(s.setup()).rejects.toMatchObject({ code: 'mac_admin_cancelled' });
  });
});

describe('start (AC3) and Return (AC10)', () => {
  beforeEach(async () => { auth.store.setPassphrase(await hashPassphrase('a b c d e f')); });

  it('start: listener → tunnel → probe → state → power; URL + QR; prior LPM recorded per source', async () => {
    const s = new MacSession(deps());
    const st = await s.start({ vaults: ['proj'] });
    expect(st.phase).toBe('on');
    expect(st.url).toBe('https://quiet-lake-1234.trycloudflare.com');
    expect(origin).toBe('https://quiet-lake-1234.trycloudflare.com');
    const order = events.filter((e) => /listener:start|tunnel:start|pmset -g custom|disablesleep 1/.test(e) && !e.includes(' -l '));
    expect(order).toEqual(['listener:start', 'tunnel:start', '/usr/bin/pmset -g custom', '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1']);
    expect(events).toContain('/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 1');
    expect(events).toContain('/usr/bin/sudo -n /usr/bin/pmset -c lowpowermode 1');
    const state = readMacState(home)!;
    expect(state).toMatchObject({ on: true, serverPid: 777, tunnelPid: 4242, priorLpm: { battery: 0, ac: 1 }, sleepDisabledByUs: true, mode: 'quick' });
    expect(statSync(statePathOf(home)).mode & 0o777).toBe(0o600);
    expect(s.mintQr()).toMatch(/^https:\/\/quiet-lake-1234\.trycloudflare\.com\/login\?t=[A-Za-z0-9_-]{43}$/);
    await s.stop();
  });

  it('AC16: start exposes the chosen projects (status + state for reporting), stop clears them; none chosen is mac_no_project', async () => {
    let exposed: readonly string[] = [];
    const s = new MacSession(deps({ setExposedVaults: (n) => { exposed = n; } }));
    await expect(s.start({ vaults: [] })).rejects.toMatchObject({ code: 'mac_no_project' });
    expect(s.isOn()).toBe(false);
    const st = await s.start({ vaults: ['proj', 'other', 'proj'] });
    expect(st.exposedVaults).toEqual(['proj', 'other']);
    expect(exposed).toEqual(['proj', 'other']);
    expect(readMacState(home)!.exposedVaults).toEqual(['proj', 'other']);
    await s.stop();
    expect(exposed).toEqual([]);
    expect(s.status().exposedVaults).toEqual([]);
  });

  it('Return: phone sessions let go BEFORE devices are revoked, tunnel + listener stop, sleep and LPM restored per source, state cleared', async () => {
    const s = new MacSession(deps());
    await s.start({ vaults: ['proj'] });
    const id = auth.store.createDevice('iPhone');
    events = [];
    await s.stop();
    expect(events.indexOf('release')).toBe(0);
    expect(auth.store.isValidDevice(id)).toBe(false);
    expect(events).toEqual(expect.arrayContaining(['tunnel:stop', 'listener:stop', 'origin:null',
      '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0',
      '/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 0',
      '/usr/bin/sudo -n /usr/bin/pmset -c lowpowermode 1']));
    expect(events.indexOf('tunnel:stop')).toBeLessThan(events.indexOf('listener:stop'));
    expect(existsSync(statePathOf(home))).toBe(false);
    expect(s.status().phase).toBe('off');
    expect(origin).toBeNull();
  });

  it('a failed probe rolls everything back: no power change, nothing left running, no state', async () => {
    const s = new MacSession(deps({ probe: async () => false }));
    await expect(s.start({ vaults: ['proj'] })).rejects.toMatchObject({ code: 'mac_probe_failed' });
    expect(events.some((e) => e.includes('disablesleep 1') && !e.includes(' -l '))).toBe(false);
    expect(events).toEqual(expect.arrayContaining(['tunnel:stop', 'listener:stop']));
    expect(existsSync(statePathOf(home))).toBe(false);
    expect(s.status()).toMatchObject({ phase: 'off', lastError: 'mac_probe_failed' });
  });

  it('preflight: not set up / sudo missing are refused before anything starts', async () => {
    const fresh = new HandsfreeAuth({ dir: mkdtempSync(join(tmpdir(), 'mac-fresh-')) });
    await expect(new MacSession(deps({ auth: () => fresh as never })).start({ vaults: ['proj'] })).rejects.toMatchObject({ code: 'mac_not_setup' });
    const noSudo: PowerRunner = async (file) => ({ code: file === '/usr/bin/sudo' ? 1 : 0, stdout: '', stderr: '' });
    await expect(new MacSession(deps({ powerRun: noSudo })).start({ vaults: ['proj'] })).rejects.toMatchObject({ code: 'mac_sudo_missing' });
    expect(events).not.toContain('listener:start');
  });

  it('AC13: discharging at <=15% → sleep allowed again, the phone chip says so, a notification; no re-arm', async () => {
    battText = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t12%; discharging;";
    const s = new MacSession(deps());
    await s.start({ vaults: ['proj'] });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.status().sleepAllowed).toBe(true);
    expect(notes.some(([t]) => /battery low/i.test(t))).toBe(true);
    expect(events.filter((e) => e.endsWith('disablesleep 0'))).toHaveLength(1);
    expect(readMacState(home)!.sleepDisabledByUs).toBe(false);
    await s.stop();
  });

  it('a tunnel restart with a new quick URL updates the origin and posts a notification', async () => {
    let ev: Parameters<NonNullable<MacSessionDeps['makeSupervisor']>>[1] | null = null;
    const s = new MacSession(deps({ makeSupervisor: (_o, e) => { ev = e; const f = fakeSupervisor()(); const st = f.start; f.start = vi.fn(async () => { const r = await st(); e.onUrl(r.url, false); return r; }); return f; } }));
    await s.start({ vaults: ['proj'] });
    ev!.onUrl('https://new-name-9.trycloudflare.com', true);
    expect(origin).toBe('https://new-name-9.trycloudflare.com');
    expect(s.status().url).toBe('https://new-name-9.trycloudflare.com');
    expect(notes.some(([t]) => /new address/.test(t))).toBe(true);
    await s.stop();
  });

  it('Return lands the phone\'s tabs of the exposed projects AFTER the devices are signed out, before the tunnel stops', async () => {
    const landed: Array<[readonly string[], number]> = [];
    let validAtLanding: boolean | null = null;
    let id = '';
    const s = new MacSession(deps({
      landPhoneTabs: async (vaults, o) => { validAtLanding = auth.store.isValidDevice(id); landed.push([vaults, o.waitMs]); events.push('land'); return 2; },
    }));
    await s.start({ vaults: ['proj', 'other'] });
    id = auth.store.createDevice('iPhone');
    events = [];
    await s.stop();
    expect(landed).toEqual([[['proj', 'other'], 2_000]]);
    expect(validAtLanding).toBe(false);
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('land'));
    expect(events.indexOf('land')).toBeLessThan(events.indexOf('tunnel:stop'));
  });

  it('quitting the app with Mac mode on lands them on a short lock wait; a landing that throws never blocks the Return', async () => {
    const waits: number[] = [];
    const s = new MacSession(deps({ landPhoneTabs: async (_v, o) => { waits.push(o.waitMs); throw new Error('the desktop roster is locked'); } }));
    await s.start({ vaults: ['proj'] });
    await s.stop({ shutdown: true });
    expect(waits).toEqual([200]);
    expect(s.status().phase).toBe('off');
    expect(existsSync(statePathOf(home))).toBe(false);
  });
});

describe('crash recovery (AC12)', () => {
  it('boot recovery lands a crashed run\'s phone tabs for the projects it had exposed', async () => {
    writeFileSync(statePathOf(home), JSON.stringify({ on: true, serverPid: 99999, tunnelPid: null, tunnelBin: null, startedAt: 'x', priorLpm: null, sleepDisabledByUs: false, url: null, mode: 'quick', exposedVaults: ['proj'] }), { mode: 0o600 });
    const landed: Array<readonly string[]> = [];
    const s = new MacSession(deps({ landPhoneTabs: async (vaults) => { landed.push(vaults); return 1; } }));
    expect(await s.recoverOnBoot()).toBe(true);
    expect(landed).toEqual([['proj']]);
  });

  function plantState(tunnelPid: number) {
    writeFileSync(statePathOf(home), JSON.stringify({ on: true, serverPid: 99999, tunnelPid, tunnelBin: 'x', startedAt: 'x', priorLpm: { battery: 1, ac: 0 }, sleepDisabledByUs: true, url: 'https://a.trycloudflare.com', mode: 'quick' }), { mode: 0o600 });
  }

  it('state.on + dead serverPid: kills a MATCHING orphan cloudflared, revokes every Mac device, restores power, clears state', async () => {
    auth.store.setPassphrase(await hashPassphrase('a b c d e f'));
    const id = auth.store.createDevice();
    plantState(5150);
    const kill = vi.fn();
    const s = new MacSession(deps({ isAlive: (pid) => pid === 5150, commandOf: () => `${join(home, '.dreamcontext', 'bin', 'cloudflared-2026.10.1')} tunnel --no-autoupdate`, kill }));
    expect(await s.recoverOnBoot()).toBe(true);
    expect(kill).toHaveBeenCalledWith(5150, 'SIGTERM');
    expect(auth.store.isValidDevice(id)).toBe(false);
    expect(events).toEqual(expect.arrayContaining(['/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0', '/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 1', '/usr/bin/sudo -n /usr/bin/pmset -c lowpowermode 0']));
    expect(existsSync(statePathOf(home))).toBe(false);
    expect(notes).toHaveLength(1);
  });

  it('never kills a pid that is not our cloudflared', async () => {
    plantState(5151);
    const kill = vi.fn();
    const s = new MacSession(deps({ isAlive: (pid) => pid === 5151, commandOf: () => '/usr/bin/vim notes.txt', kill }));
    expect(await s.recoverOnBoot()).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it('leaves a state alone while its server still lives (another app instance)', async () => {
    plantState(5152);
    const s = new MacSession(deps({ isAlive: (pid) => pid === 99999 }));
    expect(await s.recoverOnBoot()).toBe(false);
    expect(existsSync(statePathOf(home))).toBe(true);
  });

  it('nothing to recover without a state file', async () => {
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    expect(await new MacSession(deps()).recoverOnBoot()).toBe(false);
    void sha256Hex;
  });
});

describe('the thermal governor in the session (AC6, AC7)', () => {
  beforeEach(async () => { auth.store.setPassphrase(await hashPassphrase('a b c d e f')); });
  const pendingPath = () => thermalPendingPathOf(home);
  const entry = (pid: number): LedgerEntry => ({ pid, lstart: lstartOf(T0), clampedAt: T0 + 1000, kind: 'root', state: 'clamped' });

  async function hotSession(over: Partial<MacSessionDeps> = {}, burners = [10]) {
    for (const pid of burners) world.add({ pid });
    world.steady = 'serious';
    let phone: (() => { thermal: { state: string | null; slowed: number } }) | null = null;
    const s = new MacSession(deps({ thermalPollMs: 5, setPhoneSource: (src) => { phone = src as typeof phone; }, ...over }));
    await s.start({ vaults: ['proj'] });
    await vi.waitFor(() => expect(s.status().thermal.slowed).toBe(burners.length), { timeout: 2000 });
    return { s, phone: () => phone };
  }

  it('the ledger is written to state.json; status and the phone payload carry thermal', async () => {
    const { s, phone } = await hotSession();
    expect(readMacState(home)!.clamped).toEqual([expect.objectContaining({ pid: 10, kind: 'root', state: 'clamped' })]);
    expect(s.status().thermal).toEqual({ state: 'serious', slowed: 1 });
    expect(s.status().bagMode).toBe(true);   // no choice made: Bag mode (the default) clamps
    expect(phone()!().thermal).toEqual({ state: 'serious', slowed: 1 });
    await s.stop();
  });

  it('Return releases every slowed process; no pending file, state cleared', async () => {
    const { s } = await hotSession();
    expect(world.procs.get(10)!.pri).toBe(BG_PRI);
    await s.stop();
    expect(world.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(existsSync(pendingPath())).toBe(false);
    expect(existsSync(statePathOf(home))).toBe(false);
    expect(s.status().thermal).toEqual({ state: null, slowed: 0 });
  });

  it('sleep and Low Power Mode are restored BEFORE the release starts (a slow release never delays power)', async () => {
    const { s } = await hotSession();
    const spy = vi.spyOn(ThermalGovernor.prototype, 'releaseAll').mockImplementation(async () => {
      events.push('releaseAll:start');
      await new Promise((r) => setTimeout(r, 50));
      return [];
    });
    try {
      events = [];
      await s.stop();
      const power = events.indexOf('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0');
      expect(power).toBeGreaterThanOrEqual(0);
      expect(power).toBeLessThan(events.indexOf('releaseAll:start'));
    } finally { spy.mockRestore(); }
  });

  it('stop({shutdown:true}) returns within the 800 ms deadline + slack; what it could not release waits in the pending file', async () => {
    const burners = Array.from({ length: 10 }, (_, i) => 10 + i);
    const { s } = await hotSession({}, burners);
    world.onTaskpolicy = async (flag) => { if (flag === '-B') await new Promise((r) => setTimeout(r, 150)); };
    const t = Date.now();
    await s.stop({ shutdown: true });
    const took = Date.now() - t;
    expect(took).toBeLessThan(800 + 400);
    const pending = JSON.parse(readFileSync(pendingPath(), 'utf8')) as LedgerEntry[];
    const stillSlow = burners.filter((p) => world.procs.get(p)!.pri === BG_PRI);
    expect(stillSlow.length).toBeGreaterThan(0);
    expect(pending.map((e) => e.pid).sort()).toEqual(stillSlow.sort());
    expect(statSync(pendingPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(statePathOf(home))).toBe(false);
  });

  it('Return then quitting the app (a second, overlapping stop) waits for the first release: nothing is left slowed unrecorded', async () => {
    const burners = [10, 11, 12];
    const { s } = await hotSession({}, burners);
    world.onTaskpolicy = async (flag) => { if (flag === '-B') await new Promise((r) => setTimeout(r, 150)); };
    const first = s.stop();
    await new Promise((r) => setTimeout(r, 20));
    // The server exits as soon as the SIGTERM path's stop resolves: judge the world at THAT moment.
    await s.stop({ shutdown: true });
    const pending = existsSync(pendingPath()) ? (JSON.parse(readFileSync(pendingPath(), 'utf8')) as LedgerEntry[]).map((e) => e.pid) : [];
    const recorded = new Set([...pending, ...(readMacState(home)?.clamped ?? []).map((e) => e.pid)]);
    const stillSlow = burners.filter((p) => world.procs.get(p)!.pri === BG_PRI);
    expect(stillSlow.filter((p) => !recorded.has(p))).toEqual([]);   // nothing slowed without a record
    expect(stillSlow).toEqual([]);   // the second stop waited for the first, unbounded release
    expect(s.status().phase).toBe('off');
    await first;
  });

  it('the shutdown deadline counts from stop(), not from the release: a slow tunnel stop leaves less time', async () => {
    const burners = [10, 11, 12, 13, 14];
    const slowTunnel: MacSessionDeps['makeSupervisor'] = (_o, e) => {
      const f = fakeSupervisor()(); const st = f.start;
      f.start = vi.fn(async () => { const r = await st(); e.onUrl(r.url, false); return r; });
      f.stop = vi.fn(async () => { await new Promise((r) => setTimeout(r, 600)); });
      return f;
    };
    const { s } = await hotSession({ makeSupervisor: slowTunnel }, burners);
    world.onTaskpolicy = async (flag) => { if (flag === '-B') await new Promise((r) => setTimeout(r, 150)); };
    const t = Date.now();
    await s.stop({ shutdown: true });
    expect(Date.now() - t).toBeLessThan(800 + 300);
    const pending = (JSON.parse(readFileSync(pendingPath(), 'utf8')) as LedgerEntry[]).map((e) => e.pid).sort();
    const stillSlow = burners.filter((p) => world.procs.get(p)!.pri === BG_PRI).sort();
    expect(stillSlow.length).toBeGreaterThan(0);
    expect(pending).toEqual(stillSlow);
  });

  it('a ps failure at Return leaves the entry in the pending file; the next start releases it and deletes the file', async () => {
    const { s } = await hotSession();
    world.psFails = true;
    await s.stop();
    expect(JSON.parse(readFileSync(pendingPath(), 'utf8')).map((e: LedgerEntry) => e.pid)).toEqual([10]);
    expect(world.procs.get(10)!.pri).toBe(BG_PRI);
    world.psFails = false;
    world.steady = 'nominal';
    await s.start({ vaults: ['proj'] });
    expect(world.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(existsSync(pendingPath())).toBe(false);
    await s.stop();
  });

  it('the SIGTERM path passes shutdown: true', () => {
    const src = readFileSync(join(__dirname, '../../src/server/index.ts'), 'utf8');
    expect(src).toContain('macSession().stop({ shutdown: true })');
  });

  it('boot recovery releases a crashed run\'s state.clamped and the pending file', async () => {
    world.add({ pid: 30, pri: BG_PRI });
    world.add({ pid: 31, pri: BG_PRI });
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(statePathOf(home), JSON.stringify({ on: true, serverPid: 99999, tunnelPid: null, tunnelBin: null, startedAt: 'x', priorLpm: null, sleepDisabledByUs: true, url: null, mode: 'quick', clamped: [entry(30)] }));
    writeFileSync(pendingPath(), JSON.stringify([entry(31)]));
    expect(await new MacSession(deps()).recoverOnBoot()).toBe(true);
    expect(world.procs.get(30)!.pri).toBe(NORMAL_PRI);
    expect(world.procs.get(31)!.pri).toBe(NORMAL_PRI);
    expect(existsSync(pendingPath())).toBe(false);
    expect(existsSync(statePathOf(home))).toBe(false);
  });

  it('the pending file is released at the top of boot recovery, even with no state to recover', async () => {
    world.add({ pid: 32, pri: BG_PRI });
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(pendingPath(), JSON.stringify([entry(32)]));
    expect(await new MacSession(deps()).recoverOnBoot()).toBe(false);
    expect(world.procs.get(32)!.pri).toBe(NORMAL_PRI);
    expect(existsSync(pendingPath())).toBe(false);
  });

  it('uninstall releases the pending file before it deletes the Mac folder', async () => {
    world.add({ pid: 33, pri: BG_PRI });
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(pendingPath(), JSON.stringify([entry(33)]));
    await new MacSession(deps({ removeSudoers: async () => 'ok' })).uninstall();
    expect(world.procs.get(33)!.pri).toBe(NORMAL_PRI);
    expect(existsSync(join(home, '.dreamcontext', 'handsfree-mac'))).toBe(false);
  });
});

describe('bag mode', () => {
  beforeEach(async () => { auth.store.setPassphrase(await hashPassphrase('a b c d e f')); });
  const taskpolicyCalls = () => world.calls.filter((c) => c.includes('taskpolicy'));

  it('normal mode never slows: hot readings, no ps, no taskpolicy, no ledger; keep-awake and LPM still armed', async () => {
    world.add({ pid: 10 });
    world.steady = 'serious';
    // The real reader through the fake runner, so every reading is an osascript call we can count.
    const s = new MacSession(deps({ thermalPollMs: 5, readThermal: undefined }));
    await s.start({ vaults: ['proj'], bagMode: false });
    await vi.waitFor(() => expect(s.status().thermal.state).toBe('serious'), { timeout: 2000 });
    await vi.waitFor(() => expect(world.count('/usr/bin/osascript')).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(world.count('/bin/ps')).toBe(0);
    expect(taskpolicyCalls()).toEqual([]);
    expect(world.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(readMacState(home)!.clamped).toBeUndefined();
    expect(readMacState(home)!.bagMode).toBe(false);
    expect(s.status()).toMatchObject({ bagMode: false, thermal: { state: 'serious', slowed: 0 } });
    expect(events).toEqual(expect.arrayContaining([
      '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1',
      '/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 1',
      '/usr/bin/sudo -n /usr/bin/pmset -c lowpowermode 1',
    ]));
    await s.stop();
    expect(world.count('/bin/ps')).toBe(0);
    expect(taskpolicyCalls()).toEqual([]);
    expect(existsSync(thermalPendingPathOf(home))).toBe(false);
    expect(world.procs.get(10)!.pri).toBe(NORMAL_PRI);
  });

  it('never chosen: Bag mode on (today\'s behaviour), and it clamps', async () => {
    world.add({ pid: 10 });
    world.steady = 'serious';
    const s = new MacSession(deps({ thermalPollMs: 5 }));
    expect(s.status().bagMode).toBe(true);
    await s.start({ vaults: ['proj'] });
    expect(s.status().bagMode).toBe(true);
    await vi.waitFor(() => expect(s.status().thermal.slowed).toBe(1), { timeout: 2000 });
    expect(world.procs.get(10)!.pri).toBe(BG_PRI);
    await s.stop();
    expect(world.procs.get(10)!.pri).toBe(NORMAL_PRI);
  });

  it('the choice is remembered across Return and a restart; a start without it uses the last one', async () => {
    const s = new MacSession(deps());
    await s.start({ vaults: ['proj'], bagMode: false });
    await s.stop();
    expect(readMacPrefs(home).bagMode).toBe(false);
    expect(statSync(macPrefsPathOf(home)).mode & 0o777).toBe(0o600);
    expect(existsSync(statePathOf(home))).toBe(false);
    expect(s.status()).toMatchObject({ phase: 'off', bagMode: false });

    // A new process (the app restarted): the choice is still there, and a start without it uses it.
    world.add({ pid: 10 });
    world.steady = 'serious';
    const again = new MacSession(deps({ thermalPollMs: 5 }));
    expect(again.status().bagMode).toBe(false);
    await again.start({ vaults: ['proj'] });
    expect(again.status().bagMode).toBe(false);
    await vi.waitFor(() => expect(again.status().thermal.state).toBe('serious'), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(taskpolicyCalls()).toEqual([]);
    await again.stop();

    // And back: an explicit true is remembered too.
    await again.start({ vaults: ['proj'], bagMode: true });
    expect(again.status().bagMode).toBe(true);
    await again.stop();
    expect(readMacPrefs(home).bagMode).toBe(true);
  });

  it('the choice is remembered even when the tunnel then fails', async () => {
    const s = new MacSession(deps({ probe: async () => false }));
    await expect(s.start({ vaults: ['proj'], bagMode: false })).rejects.toMatchObject({ code: 'mac_probe_failed' });
    expect(readMacPrefs(home).bagMode).toBe(false);
    expect(s.status()).toMatchObject({ phase: 'off', bagMode: false });
  });

  it('a start refused before the preflight passes remembers nothing', async () => {
    const s = new MacSession(deps());
    await expect(s.start({ vaults: [], bagMode: false })).rejects.toMatchObject({ code: 'mac_no_project' });
    const noSudo: PowerRunner = async (file) => ({ code: file === '/usr/bin/sudo' ? 1 : 0, stdout: '', stderr: '' });
    await expect(new MacSession(deps({ powerRun: noSudo })).start({ vaults: ['proj'], bagMode: false })).rejects.toMatchObject({ code: 'mac_sudo_missing' });
    expect(existsSync(macPrefsPathOf(home))).toBe(false);
  });

  it('boot recovery releases a crashed run\'s clamps whatever its bag mode says', async () => {
    world.add({ pid: 30, pri: BG_PRI });
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    const entry: LedgerEntry = { pid: 30, lstart: lstartOf(T0), clampedAt: T0 + 1000, kind: 'root', state: 'clamped' };
    writeFileSync(statePathOf(home), JSON.stringify({ on: true, serverPid: 99999, tunnelPid: null, tunnelBin: null, startedAt: 'x', priorLpm: null, sleepDisabledByUs: true, url: null, mode: 'quick', bagMode: false, clamped: [entry] }));
    expect(await new MacSession(deps()).recoverOnBoot()).toBe(true);
    expect(world.procs.get(30)!.pri).toBe(NORMAL_PRI);
    expect(existsSync(statePathOf(home))).toBe(false);
  });
});

describe('fixed address: an existing DNS record is never replaced unasked', () => {
  it('a hostname in use is mac_hostname_in_use; the confirmed retry passes overwriteDns through', async () => {
    const { HostnameInUseError } = await import('../../src/lib/handsfree/mac/tunnel.js');
    const seen: Array<boolean | undefined> = [];
    const s = new MacSession(deps({
      setupFixedTunnel: async (o) => {
        seen.push(o.overwriteDns);
        if (!o.overwriteDns) throw new HostnameInUseError(o.hostname);
        return { hostname: o.hostname, tunnelId: 'x', name: 'dreamcontext-hf' };
      },
    }));
    const err = await s.setupFixed('www.example.com').catch((e) => e);
    expect(err).toBeInstanceOf(MacModeError);
    expect(err.code).toBe('mac_hostname_in_use');
    expect((await s.setupFixed('www.example.com', undefined, { overwriteDns: true })).hostname).toBe('www.example.com');
    expect(seen).toEqual([false, true]);
  });
});
