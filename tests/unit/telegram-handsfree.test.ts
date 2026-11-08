/**
 * Hands-free from Telegram (W2 lane B; plan B5, C3, D2, E3, E4, F1, F3, F4):
 *  - power-only start writes state (channel telegram + startedVia) BEFORE arming power and starts
 *    no listener or tunnel; a Mac/HTTP start never carries startedVia;
 *  - every end emits `ended` with why and whether it was keyed; streaming stops with it;
 *  - boot recovery announces once, and not at all when the tick's marker names this run;
 *  - `/handsfree`: two buttons; Mac-started → the explanatory line; losing the binding ends
 *    Telegram-only hands-free.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { MacSession, readMacState, statePathOf, telegramEndedPathOf, type MacSessionDeps } from '../../src/lib/handsfree/mac/session.js';
import { HandsfreeAuth, ensureMacHandsfreeDir, generatePassphrase, hashPassphrase } from '../../src/server/handsfree-auth.js';
import type { PowerRunner } from '../../src/lib/handsfree/mac/power.js';
import { World } from '../helpers/thermal-world.js';
import type { HandsfreeEvent } from '../../src/lib/telegram/contract.js';
import { handsfreeAdapter, HF_LINES } from '../../src/server/telegram/handsfree.js';

let home: string; let auth: HandsfreeAuth; let events: string[]; let world: World;
const VIA = { scope: 'ba9e7119eaab8c22', target: 'super' };

function powerRun(): PowerRunner {
  return async (file, args) => {
    const line = [file, ...args].join(' ');
    // State must already be on disk when power is first touched.
    if (line.includes('disablesleep 1')) events.push(`power:arm state=${existsSync(statePathOf(home)) ? JSON.parse(readFileSync(statePathOf(home), 'utf8')).channel : 'none'}`);
    else events.push(line);
    if (line === '/usr/bin/pmset -g custom') return { code: 0, stdout: 'Battery Power:\n lowpowermode 0\nAC Power:\n lowpowermode 0\n', stderr: '' };
    if (line === '/usr/bin/pmset -g batt') return { code: 0, stdout: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging;", stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}
function deps(over: Partial<MacSessionDeps> = {}): MacSessionDeps {
  return {
    home, serverPid: 777, platform: 'darwin', auth: () => auth as never,
    hashPassphrase: (p) => hashPassphrase(p), generatePassphrase: () => generatePassphrase(),
    startListener: async () => { events.push('listener:start'); return { port: 41234 }; },
    stopListener: async () => { events.push('listener:stop'); },
    setPublicOrigin: () => {}, setProbeNonce: () => {}, setPhoneSource: () => {},
    releasePhoneSessions: () => 0, notify: () => {}, powerRun: powerRun(),
    ensureBinary: async () => '/x/cloudflared',
    makeSupervisor: (_o, e) => ({ pid: 4242, url: 'https://quiet-lake-1234.trycloudflare.com', start: vi.fn(async () => { events.push('tunnel:start'); e.onUrl('https://quiet-lake-1234.trycloudflare.com', false); return { child: new EventEmitter() as never, url: 'https://quiet-lake-1234.trycloudflare.com', mode: 'quick' as const }; }), stop: vi.fn(async () => {}) }),
    probe: async () => true, sudoersInstalled: () => true, installSudoers: async () => 'ok',
    isAlive: () => false, commandOf: () => '', kill: vi.fn(),
    thermalRun: world.run, readThermal: world.readThermal, thermalPollMs: 60_000,
    ...over,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-hf-'));
  auth = new HandsfreeAuth({ dir: ensureMacHandsfreeDir(home) });
  events = []; world = new World();
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('the session (lane B)', () => {
  it('power-only: state before power, no listener or tunnel; startedVia only while on', async () => {
    const s = new MacSession(deps());
    await s.startPowerOnly(VIA);
    expect(events).toContain('power:arm state=telegram');
    expect(events).not.toContain('listener:start');
    expect(events).not.toContain('tunnel:start');
    expect(s.isOn()).toBe(true);
    expect(s.startedVia).toEqual(VIA);
    expect(readMacState(home)).toMatchObject({ channel: 'telegram', startedVia: VIA, exposedVaults: [] });
    const got: HandsfreeEvent[] = [];
    s.onEvent((e) => got.push(e));
    await s.stop({ reason: 'http', keyed: false });
    expect(s.startedVia).toBeNull();
    expect(got).toEqual([{ type: 'ended', channel: 'telegram', reason: 'http', keyed: false, startedVia: VIA }]);
  });

  it('a Mac start never carries startedVia (never streams); its end is still emitted', async () => {
    await auth.store.setPassphrase(await hashPassphrase('x y z') as never);
    const s = new MacSession(deps());
    const got: HandsfreeEvent[] = [];
    s.onEvent((e) => got.push(e));
    await s.start({ vaults: ['acme'] });
    expect(s.startedVia).toBeNull();
    await s.stop({ reason: 'mac' });
    expect(got).toEqual([{ type: 'ended', channel: 'full', reason: 'mac', keyed: true }]);
  });

  it('boot recovery announces a Telegram-started run once, and not when the tick already did', async () => {
    const state = { on: true, serverPid: 1, tunnelPid: null, tunnelBin: null, startedAt: '2026-11-08T10:00:00.000Z', priorLpm: null, sleepDisabledByUs: true, url: null, mode: 'quick', channel: 'telegram', startedVia: VIA };
    writeFileSync(statePathOf(home), JSON.stringify(state));
    const a = new MacSession(deps());
    const got: HandsfreeEvent[] = [];
    await a.recoverOnBoot();
    a.onEvent((e) => got.push(e)); // held until the hub subscribes
    expect(got).toEqual([{ type: 'ended', channel: 'telegram', reason: 'crash', keyed: true, startedVia: VIA }]);
    writeFileSync(statePathOf(home), JSON.stringify(state));
    writeFileSync(telegramEndedPathOf(home), JSON.stringify({ startedAt: state.startedAt }));
    const b = new MacSession(deps());
    const got2: HandsfreeEvent[] = [];
    b.onEvent((e) => got2.push(e));
    expect(await b.recoverOnBoot()).toBe(true);
    expect(got2).toEqual([]);
    expect(existsSync(telegramEndedPathOf(home))).toBe(false);
    expect(readMacState(home)).toBeNull();
  });
});

describe('the hub adapter', () => {
  function fakeHub() {
    const replies: string[] = [];
    const buttons: string[][][] = [];
    const ab = { key: `${VIA.scope}/super`, scope: VIA.scope, target: 'super', projectName: 'acme' };
    return { replies, buttons, hub: { active: new Map([[ab.key, ab]]), reply: async (_a: unknown, l: string) => { replies.push(l); }, sendButtons: async (_a: unknown, _h: string, l: string[][]) => { buttons.push(l); return 'id'; } } as never };
  }
  function fakeSession(over: Partial<Record<string, unknown>> = {}) {
    let on = false; let via: typeof VIA | null = null; let channel: 'telegram' | 'full' | null = null;
    const listeners: Array<(e: HandsfreeEvent) => void> = [];
    const s = {
      isOn: () => on, get startedVia() { return via; }, get channel() { return channel; },
      startPowerOnly: vi.fn(async (v: typeof VIA) => { on = true; via = v; channel = 'telegram'; return {} as never; }),
      start: vi.fn(async () => { on = true; channel = 'full'; return { url: 'https://a.trycloudflare.com/x' } as never; }),
      stop: vi.fn(async (o?: { reason?: string; keyed?: boolean }) => { const v = via; const c = channel; on = false; via = null; channel = null; for (const l of listeners) l({ type: 'ended', channel: c ?? 'full', reason: o?.reason ?? 'mac', keyed: o?.keyed ?? true, ...(v ? { startedVia: v } : {}) }); }),
      onEvent: (fn: (e: HandsfreeEvent) => void) => { listeners.push(fn); return () => {}; },
      status: () => ({ url: null }),
      macStart: () => { on = true; channel = 'full'; },
      ...over,
    };
    return s;
  }
  const cmd = (text: string) => ({ message: { text } });

  it('two buttons; Yalnız Telegram starts power-only for THIS binding and streams until any end', async () => {
    const { hub, buttons, replies } = fakeHub();
    const s = fakeSession();
    const a = handsfreeAdapter(() => s as never);
    a.wire(hub);
    expect(await a.onCommand!(hub, `${VIA.scope}/super`, cmd('/handsfree'))).toBe(true);
    expect(buttons[0]).toEqual([['Yalnız Telegram'], ['Telegram + telefon linki']]);
    await a.onCallback!(hub, `${VIA.scope}/super`, {} as never, 0);
    expect(s.startPowerOnly).toHaveBeenCalledWith(VIA);
    expect(a.streamsTo(VIA.scope, 'super')).toBe(true);
    expect(a.streamsTo(VIA.scope, 'ua-manager')).toBe(false);
    await s.stop({ reason: 'http', keyed: false });
    expect(a.streamsTo(VIA.scope, 'super')).toBe(false);
    expect(replies.at(-1)).toBe(HF_LINES.ended('istekle kapatıldı', false));
  });

  it('Mac-started hands-free: the explanatory line, and it never streams', async () => {
    const { hub, replies } = fakeHub();
    const s = fakeSession();
    s.macStart();
    const a = handsfreeAdapter(() => s as never);
    await a.onCommand!(hub, `${VIA.scope}/super`, cmd('/handsfree'));
    expect(replies).toEqual([HF_LINES.macOn]);
    expect(a.streamsTo(VIA.scope, 'super')).toBe(false);
  });

  it('losing the binding ends Telegram-only hands-free; a Mac panel end reads "Mac\'ten kapatıldı" with no key note', async () => {
    const { hub, replies } = fakeHub();
    const s = fakeSession();
    const a = handsfreeAdapter(() => s as never);
    a.wire(hub);
    await a.onCallback!(hub, `${VIA.scope}/super`, {} as never, 0);
    a.onBindingLost!(VIA.scope, 'super');
    expect(s.stop).toHaveBeenCalledWith({ reason: 'binding_lost', keyed: true });
    await a.onCallback!(hub, `${VIA.scope}/super`, {} as never, 0);
    await s.stop({ reason: 'mac', keyed: true });
    expect(replies.at(-1)).toBe(HF_LINES.ended("Mac'ten kapatıldı", true));
  });

  describe('on Telegram, by itself (owner 2026-11-09)', () => {
    const KEY = `${VIA.scope}/super`;
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it('a Telegram message arms power-only once, marked auto; a second message is a no-op', async () => {
      const { hub } = fakeHub();
      const s = fakeSession();
      const a = handsfreeAdapter(() => s as never, { readHidIdleMs: async () => null, hidPollMs: 60_000 });
      a.onPresence!(hub, KEY, 'telegram');
      a.onPresence!(hub, KEY, 'telegram');
      await settle();
      a.onPresence!(hub, KEY, 'telegram');
      await settle();
      expect(s.startPowerOnly).toHaveBeenCalledTimes(1);
      expect(s.startPowerOnly).toHaveBeenCalledWith({ ...VIA, auto: true });
      expect(a.streamsTo(VIA.scope, 'super')).toBe(true);
      await s.stop({ reason: 'mac' });
    });

    it('a message typed on the Mac disarms it and tells him once', async () => {
      const { hub, replies } = fakeHub();
      const s = fakeSession();
      const a = handsfreeAdapter(() => s as never, { readHidIdleMs: async () => null, hidPollMs: 60_000 });
      a.wire(hub);
      a.onPresence!(hub, KEY, 'telegram');
      await settle();
      a.onPresence!(hub, KEY, 'mac');
      await settle();
      expect(s.stop).toHaveBeenCalledWith({ reason: 'back', keyed: true });
      expect(s.isOn()).toBe(false);
      expect(replies).toEqual([HF_LINES.back]);
    });

    it('real input on the Mac after the start (HIDIdleTime drops) disarms it', async () => {
      const { hub, replies } = fakeHub();
      const s = fakeSession();
      let t = 1_000_000;
      let idle = 600_000; // untouched for 10 minutes when it starts
      const a = handsfreeAdapter(() => s as never, { readHidIdleMs: async () => idle, hidPollMs: 5, now: () => t });
      a.wire(hub);
      a.onPresence!(hub, KEY, 'telegram');
      await settle();
      t += 60_000; idle += 60_000; // a minute later, still untouched
      await settle();
      expect(s.isOn()).toBe(true);
      idle = 1_000; // he touched the keyboard
      await vi.waitFor(() => expect(s.isOn()).toBe(false));
      expect(s.stop).toHaveBeenCalledWith({ reason: 'back', keyed: true });
      expect(replies).toEqual([HF_LINES.back]);
    });

    it('a run he started by the button is never disarmed by a Mac message or input', async () => {
      const { hub } = fakeHub();
      const s = fakeSession();
      const a = handsfreeAdapter(() => s as never, { readHidIdleMs: async () => 0, hidPollMs: 5 });
      await a.onCallback!(hub, KEY, {} as never, 0);
      a.onPresence!(hub, KEY, 'telegram');
      a.onPresence!(hub, KEY, 'mac');
      await settle();
      expect(s.isOn()).toBe(true);
      expect(s.startPowerOnly).toHaveBeenCalledTimes(1);
      expect(s.stop).not.toHaveBeenCalled();
    });

    it('no sleep permission: one line to Telegram, no crash, no second line', async () => {
      const { hub, replies } = fakeHub();
      const s = fakeSession({ startPowerOnly: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'mac_sudo_missing' }); }) });
      const a = handsfreeAdapter(() => s as never, { readHidIdleMs: async () => null });
      a.onPresence!(hub, KEY, 'telegram');
      await settle();
      a.onPresence!(hub, KEY, 'telegram');
      await settle();
      expect(replies).toEqual([HF_LINES.noGrant]);
      expect(s.isOn()).toBe(false);
    });

    it('the session keeps the auto mark in its state file', async () => {
      const ms = new MacSession(deps());
      await ms.startPowerOnly({ ...VIA, auto: true } as never);
      expect(readMacState(home)).toMatchObject({ channel: 'telegram', startedVia: { ...VIA, auto: true } });
      expect(ms.startedVia).toEqual({ ...VIA, auto: true });
      await ms.stop({ reason: 'back' });
    });
  });

  it('Telegram + link sends the bare origin, never a login token', async () => {
    const { hub, replies } = fakeHub();
    const s = fakeSession();
    const a = handsfreeAdapter(() => s as never);
    await a.onCallback!(hub, `${VIA.scope}/super`, {} as never, 1);
    expect(replies.at(-1)).toBe(HF_LINES.linkOn('https://a.trycloudflare.com'));
    expect(replies.join('')).not.toMatch(/login\?/);
  });
});
