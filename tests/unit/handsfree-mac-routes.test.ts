// Mac mode's panel routes (AC14 sign-in notification + devices, AC15 mutual exclusion, AC16 no
// credential ever returned, AC2 passphrase shown once) behind the laptop gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const posted: Array<[string, string]> = [];
vi.mock('../../src/lib/automations/notifier.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/automations/notifier.js')>()),
  notifyViaBundle: (title: string, body: string) => { posted.push([title, body]); return true; },
}));

const { handsfreeMacRoutes, setMacSessionForTests, macSession } = await import('../../src/server/routes/handsfree-mac.js');
const { MacSession } = await import('../../src/lib/handsfree/mac/session.js');
const { HandsfreeAuth, ensureMacHandsfreeDir, generatePassphrase, hashPassphrase, notifyMacSignIn, setMacHandsfreeAuthForTests } = await import('../../src/server/handsfree-auth.js');
const { markPhoneSocket } = await import('../../src/server/phone-origin.js');
const { addVault } = await import('../../src/lib/vaults.js');

let home: string;
let auth: InstanceType<typeof HandsfreeAuth>;
const saved: Record<string, string | undefined> = {};

function req(method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; socket?: object } = {}): IncomingMessage {
  const r = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(r, { method, url: path, headers: { host: '127.0.0.1:41000', ...(o.headers ?? {}) }, socket: o.socket ?? { remoteAddress: '127.0.0.1' } });
  setImmediate(() => { if (o.body !== undefined) r.emit('data', Buffer.from(JSON.stringify(o.body))); r.emit('end'); });
  return r;
}

function res(): { r: ServerResponse; done: Promise<{ status: number; body: Record<string, unknown>; raw: string }> } {
  let resolve!: (v: { status: number; body: Record<string, unknown>; raw: string }) => void;
  const done = new Promise<{ status: number; body: Record<string, unknown>; raw: string }>((r) => { resolve = r; });
  let status = 200;
  const r = {
    setHeader() {},
    writeHead(code: number) { status = code; return r; },
    end(b?: string) { resolve({ status, body: b ? JSON.parse(b) : {}, raw: b ?? '' }); },
  } as unknown as ServerResponse;
  return { r, done };
}

async function call(h: (q: IncomingMessage, s: ServerResponse) => Promise<void>, q: IncomingMessage) {
  const { r, done } = res();
  await h(q, r);
  return done;
}

function fakeSession() {
  return new MacSession({
    home, serverPid: process.pid, platform: 'darwin',
    auth: () => auth as never,
    hashPassphrase: (p) => hashPassphrase(p), generatePassphrase: () => generatePassphrase(),
    startListener: async () => ({ port: 40001 }), stopListener: async () => {},
    setPublicOrigin: () => {}, setProbeNonce: () => {}, setPhoneSource: () => {}, releasePhoneSessions: () => 0,
    notify: () => {},
    powerRun: async (file, args) => ({ code: 0, stdout: args.join(' ') === '-g custom' ? 'Battery Power:\n lowpowermode 0\nAC Power:\n lowpowermode 0\n' : '', stderr: '' }),
    ensureBinary: async () => '/x/cloudflared-1',
    makeSupervisor: (_o, e) => ({ pid: 1, url: 'https://a-b.trycloudflare.com', start: async () => { e.onUrl('https://a-b.trycloudflare.com', false); return { child: new EventEmitter() as never, url: 'https://a-b.trycloudflare.com', mode: 'quick' as const }; }, stop: async () => {} }),
    probe: async () => true,
    sudoersInstalled: () => true, installSudoers: async () => 'ok',
    readThermal: async () => 'nominal',   // never slow the machine's real processes
  });
}

beforeEach(() => {
  for (const k of ['DREAMCONTEXT_DESKTOP', 'HOME']) saved[k] = process.env[k];
  process.env.DREAMCONTEXT_DESKTOP = '1';
  home = mkdtempSync(join(tmpdir(), 'mac-routes-'));
  process.env.HOME = home;
  auth = new HandsfreeAuth({ dir: ensureMacHandsfreeDir(home) });
  setMacHandsfreeAuthForTests(auth);
  mkdirSync(join(home, 'proj', '_dream_context'), { recursive: true });
  addVault('proj', join(home, 'proj'));
  setMacSessionForTests(fakeSession());
  posted.length = 0;
});
afterEach(async () => {
  await macSession().stop();
  setMacSessionForTests(null);
  setMacHandsfreeAuthForTests(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

describe('the laptop gate', () => {
  it('a phone socket, a forwarded request, a foreign Origin and a non-loopback Host are refused', async () => {
    const phone = { remoteAddress: '127.0.0.1' };
    markPhoneSocket(phone);
    expect((await call(handsfreeMacRoutes.status, req('GET', '/api/handsfree/mac/status', { socket: phone }))).status).toBe(403);
    expect((await call(handsfreeMacRoutes.status, req('GET', '/api/handsfree/mac/status', { headers: { 'x-forwarded-for': '1.2.3.4' } }))).status).toBe(403);
    expect((await call(handsfreeMacRoutes.start, req('POST', '/api/handsfree/mac/start', { headers: { origin: 'https://evil.example' } }))).status).toBe(403);
    expect((await call(handsfreeMacRoutes.status, req('GET', '/api/handsfree/mac/status', { headers: { host: 'evil.example' } }))).status).toBe(403);
    expect((await call(handsfreeMacRoutes.status, req('GET', '/api/handsfree/mac/status'))).status).toBe(200);
  });
});

describe('setup, start and secrets', () => {
  it('setup shows the passphrase once; a second setup does not', async () => {
    const first = await call(handsfreeMacRoutes.setup, req('POST', '/api/handsfree/mac/setup', { body: {} }));
    expect(first.status).toBe(200);
    expect(String(first.body.passphrase)).toMatch(/^\S+( \S+){5}$/);
    const again = await call(handsfreeMacRoutes.setup, req('POST', '/api/handsfree/mac/setup', { body: {} }));
    expect(again.body.passphrase).toBeNull();
  });

  it('AC16: no route ever returns the tunnel credentials (the fixed address set up, Mac mode on)', async () => {
    const macDir = join(home, '.dreamcontext', 'handsfree-mac');
    writeFileSync(join(macDir, 'tunnel.json'), JSON.stringify({ AccountTag: 'acc', TunnelSecret: 'SUPER-SECRET-TUNNEL', TunnelID: '6f1c2e9a-a001-4a5b-8c9d-0123456789ab' }), { mode: 0o600 });
    writeFileSync(join(macDir, 'fixed.json'), JSON.stringify({ hostname: 'phone.example.com', tunnelId: '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', name: 'dreamcontext-hf' }), { mode: 0o600 });
    await call(handsfreeMacRoutes.setup, req('POST', '/api/handsfree/mac/setup', { body: {} }));
    const raws: string[] = [];
    raws.push((await call(handsfreeMacRoutes.status, req('GET', '/x'))).raw);
    raws.push((await call(handsfreeMacRoutes.start, req('POST', '/x', { body: { vaults: ['proj'] } }))).raw);
    raws.push((await call(handsfreeMacRoutes.devices, req('GET', '/x'))).raw);
    raws.push((await call(handsfreeMacRoutes.qr, req('POST', '/x'))).raw);
    for (const r of raws) {
      expect(r).not.toContain('SUPER-SECRET-TUNNEL');
      expect(r).not.toContain('TunnelSecret');
    }
    const status = JSON.parse(raws[0]);
    expect(status.fixedHostname).toBe('phone.example.com');
  });

  it('AC16: start needs { vaults } of registered projects: none = mac_no_project, unknown = mac_unknown_project (both 400)', async () => {
    await call(handsfreeMacRoutes.setup, req('POST', '/x', { body: {} }));
    const none = await call(handsfreeMacRoutes.start, req('POST', '/x', { body: { vaults: [] } }));
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('mac_no_project');
    expect((await call(handsfreeMacRoutes.start, req('POST', '/x', { body: { vault: 'proj' } }))).body.error).toBe('mac_no_project');
    const unknown = await call(handsfreeMacRoutes.start, req('POST', '/x', { body: { vaults: ['proj', 'nope'] } }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('mac_unknown_project');
    expect(macSession().isOn()).toBe(false);
    const ok = await call(handsfreeMacRoutes.start, req('POST', '/x', { body: { vaults: ['proj'] } }));
    expect(ok.body.exposedVaults).toEqual(['proj']);
  });

  it('start → on with the URL; the QR route mints a one-time link', async () => {
    await call(handsfreeMacRoutes.setup, req('POST', '/x', { body: {} }));
    const s = await call(handsfreeMacRoutes.start, req('POST', '/x', { body: { vaults: ['proj'] } }));
    expect(s.body).toMatchObject({ phase: 'on', url: 'https://a-b.trycloudflare.com' });
    expect(String((await call(handsfreeMacRoutes.qr, req('POST', '/x'))).body.url)).toMatch(/^https:\/\/a-b\.trycloudflare\.com\/login\?t=/);
  });
});

describe('AC14: sign-in notification and the device list', () => {
  it('every new phone sign-in posts a macOS notification; the devices route lists them; revoke-all clears', async () => {
    setMacSessionForTests(null);
    macSession(); // the real session registers the sign-in listener
    notifyMacSignIn('iPhone · Safari');
    expect(posted.some(([t, b]) => /phone signed in/.test(t) && b.includes('iPhone · Safari'))).toBe(true);
    auth.store.setPassphrase(await hashPassphrase('a b c d e f'));
    auth.store.createDevice('iPhone · Safari');
    const list = await call(handsfreeMacRoutes.devices, req('GET', '/x'));
    expect((list.body.devices as Array<{ label: string }>).map((d) => d.label)).toEqual(['iPhone · Safari']);
    const rv = await call(handsfreeMacRoutes.revokeAll, req('POST', '/x'));
    expect(rv.body.revoked).toBe(1);
    expect(((await call(handsfreeMacRoutes.devices, req('GET', '/x'))).body.devices as unknown[]).length).toBe(0);
  });
});
