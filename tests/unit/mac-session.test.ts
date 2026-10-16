// Mac mode's orchestrator (AC2 setup, AC3 start, AC10 Return, AC12 crash recovery, AC13, AC15).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacSession, MacModeError, readMacState, statePathOf, type MacSessionDeps } from '../../src/lib/handsfree/mac/session.js';
import { HandsfreeAuth, ensureMacHandsfreeDir, generatePassphrase, hashPassphrase, sha256Hex } from '../../src/server/handsfree-auth.js';
import type { PowerRunner } from '../../src/lib/handsfree/mac/power.js';

const CUSTOM = 'Battery Power:\n lowpowermode         0\nAC Power:\n lowpowermode         1\n';

let home: string;
let auth: HandsfreeAuth;
let events: string[];
let battText: string;
let origin: string | null;
let notes: Array<[string, string]>;

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
    cloudTripActive: () => false,
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
    ...over,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'mac-session-'));
  const dir = ensureMacHandsfreeDir(home);
  auth = new HandsfreeAuth({ dir });
  events = [];
  notes = [];
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
    const st = await s.start();
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

  it('Return: phone sessions let go BEFORE devices are revoked, tunnel + listener stop, sleep and LPM restored per source, state cleared', async () => {
    const s = new MacSession(deps());
    await s.start();
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
    await expect(s.start()).rejects.toMatchObject({ code: 'mac_probe_failed' });
    expect(events.some((e) => e.includes('disablesleep 1') && !e.includes(' -l '))).toBe(false);
    expect(events).toEqual(expect.arrayContaining(['tunnel:stop', 'listener:stop']));
    expect(existsSync(statePathOf(home))).toBe(false);
    expect(s.status()).toMatchObject({ phase: 'off', lastError: 'mac_probe_failed' });
  });

  it('preflight: not set up / sudo missing are refused before anything starts', async () => {
    const fresh = new HandsfreeAuth({ dir: mkdtempSync(join(tmpdir(), 'mac-fresh-')) });
    await expect(new MacSession(deps({ auth: () => fresh as never })).start()).rejects.toMatchObject({ code: 'mac_not_setup' });
    const noSudo: PowerRunner = async (file) => ({ code: file === '/usr/bin/sudo' ? 1 : 0, stdout: '', stderr: '' });
    await expect(new MacSession(deps({ powerRun: noSudo })).start()).rejects.toMatchObject({ code: 'mac_sudo_missing' });
    expect(events).not.toContain('listener:start');
  });

  it('AC15: a cloud trip that is not home refuses Mac start with a reason code', async () => {
    const s = new MacSession(deps({ cloudTripActive: () => true }));
    const err = await s.start().catch((e) => e);
    expect(err).toBeInstanceOf(MacModeError);
    expect(err.code).toBe('mac_cloud_trip_active');
    expect(events).not.toContain('listener:start');
  });

  it('AC13: discharging at <=15% → sleep allowed again, the phone chip says so, a notification; no re-arm', async () => {
    battText = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t12%; discharging;";
    const s = new MacSession(deps());
    await s.start();
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
    await s.start();
    ev!.onUrl('https://new-name-9.trycloudflare.com', true);
    expect(origin).toBe('https://new-name-9.trycloudflare.com');
    expect(s.status().url).toBe('https://new-name-9.trycloudflare.com');
    expect(notes.some(([t]) => /new address/.test(t))).toBe(true);
    await s.stop();
  });
});

describe('crash recovery (AC12)', () => {
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
