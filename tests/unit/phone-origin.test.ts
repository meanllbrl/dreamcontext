// Mac mode (AC7): per-request origin. A phone socket is NEVER loopback although cloudflared
// dials it from 127.0.0.1; a desktop socket in the same process is, exactly as before.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { carriesCloudflareHeaders, isPhoneSocket, markPhoneSocket, requestSurface, isMacOriginAllowed, setMacPublicOrigin } from '../../src/server/phone-origin.js';
import { isLoopback } from '../../src/server/routes/agent-spawn-shared.js';
import { isLoopbackPeer, checkNetworkAuth } from '../../src/server/network-auth.js';
import { isAgentRequest } from '../../src/server/desktop.js';
import { DEVICE_COOKIE, HandsfreeAuth, authFor, hashPassphrase, macHandsfreeAuth, setMacHandsfreeAuthForTests } from '../../src/server/handsfree-auth.js';

function req(socket: object, headers: Record<string, string> = {}): IncomingMessage {
  return { socket, headers, method: 'GET', url: '/' } as unknown as IncomingMessage;
}

const saved: Record<string, string | undefined> = {};
let dir: string;
let mac: HandsfreeAuth;

beforeEach(async () => {
  for (const k of ['DREAMCONTEXT_DESKTOP']) saved[k] = process.env[k];
  process.env.DREAMCONTEXT_DESKTOP = '1';
  dir = mkdtempSync(join(tmpdir(), 'phone-origin-'));
  mac = new HandsfreeAuth({ dir });
  mac.store.setPassphrase(await hashPassphrase('a b c d e f'));
  setMacHandsfreeAuthForTests(mac);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  setMacHandsfreeAuthForTests(null);
  setMacPublicOrigin(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('per-request origin', () => {
  it('isLoopback is false for a phone socket and true for a desktop socket in the same process', () => {
    const desk = { remoteAddress: '127.0.0.1' };
    const phone = { remoteAddress: '127.0.0.1' };
    markPhoneSocket(phone);
    expect(isLoopback(req(desk))).toBe(true);
    expect(isLoopback(req(phone))).toBe(false);
    expect(isLoopbackPeer(req(desk))).toBe(true);
    expect(isLoopbackPeer(req(phone))).toBe(false);
    expect(isPhoneSocket(req(phone))).toBe(true);
    expect(isPhoneSocket(req(desk))).toBe(false);
    expect(requestSurface(req(phone))).toBe('mac-phone');
    expect(requestSurface(req(desk))).toBe('desktop');
  });

  it('the network token gate never waves a phone socket through for being loopback', () => {
    const phone = { remoteAddress: '127.0.0.1' };
    markPhoneSocket(phone);
    let status = 0;
    const res = { setHeader() {}, writeHead(c: number) { status = c; }, end() {} } as never;
    expect(checkNetworkAuth(req(phone), res, 'tok')).toBe(false);
    expect(status).toBe(401);
  });

  it('isAgentRequest: desktop by loopback; a phone socket only with a MAC device session', () => {
    const desk = { remoteAddress: '127.0.0.1' };
    const phone = { remoteAddress: '127.0.0.1' };
    markPhoneSocket(phone);
    expect(isAgentRequest(req(desk))).toBe(true);
    expect(isAgentRequest(req(phone))).toBe(false);
    const id = mac.store.createDevice();
    expect(isAgentRequest(req(phone, { cookie: `${DEVICE_COOKIE}=${id}` }))).toBe(true);
    // A desktop socket never authenticates by cookie.
    expect(isAgentRequest(req({ remoteAddress: '10.0.0.5' }, { cookie: `${DEVICE_COOKIE}=${id}` }))).toBe(false);
  });

  it('authFor: phone → Mac store, desktop → none', () => {
    const phone = {};
    markPhoneSocket(phone);
    expect(authFor(req(phone))).toBe(macHandsfreeAuth());
    expect(authFor(req({}))).toBeNull();
  });

  it('the Origin must be exactly the tunnel origin, and none is allowed before it is known', () => {
    expect(isMacOriginAllowed(req({}, { origin: 'https://a.trycloudflare.com' }))).toBe(false);
    setMacPublicOrigin('https://a.trycloudflare.com/');
    expect(isMacOriginAllowed(req({}, { origin: 'https://a.trycloudflare.com' }))).toBe(true);
    expect(isMacOriginAllowed(req({}, { origin: 'https://b.trycloudflare.com' }))).toBe(false);
    expect(isMacOriginAllowed(req({}, {}))).toBe(false);
  });

  it('recognises every Cloudflare edge header', () => {
    expect(carriesCloudflareHeaders(req({}, {}))).toBe(false);
    for (const h of ['cf-ray', 'cf-connecting-ip', 'cf-warp-tag-id']) expect(carriesCloudflareHeaders(req({}, { [h]: '1' }))).toBe(true);
  });
});
