import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  isSameOriginAsHost, isTailnetAddress, isTrustedRemotePeer, remoteAccessEnabled,
} from '../../src/server/remote-access.js';
import { AUTH_COOKIE } from '../../src/server/network-auth.js';
import { isCrossSiteWrite } from '../../src/server/middleware.js';

const TOKEN = 'a'.repeat(64);
const HOST = '100.101.102.103:4173';

function mockReq(opts: {
  remote?: string; cookie?: string; url?: string; origin?: string; method?: string; host?: string;
}): IncomingMessage {
  return {
    url: opts.url ?? '/',
    method: opts.method ?? 'GET',
    headers: {
      host: opts.host ?? HOST,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    socket: { remoteAddress: opts.remote ?? '100.64.1.2' },
  } as unknown as IncomingMessage;
}

/** Turn remote access on for one assertion; `afterEach` always puts it back. */
function withRemote<T>(fn: () => T): T {
  process.env.DREAMCONTEXT_REMOTE = '1';
  return fn();
}

afterEach(() => { delete process.env.DREAMCONTEXT_REMOTE; });

describe('remoteAccessEnabled', () => {
  it('is off unless the env var is exactly "1"', () => {
    expect(remoteAccessEnabled()).toBe(false);
    process.env.DREAMCONTEXT_REMOTE = 'true';
    expect(remoteAccessEnabled()).toBe(false);
    process.env.DREAMCONTEXT_REMOTE = '1';
    expect(remoteAccessEnabled()).toBe(true);
  });
});

describe('isTailnetAddress', () => {
  it('accepts the CGNAT range, at both edges', () => {
    expect(isTailnetAddress('100.64.0.0')).toBe(true);
    expect(isTailnetAddress('100.101.102.103')).toBe(true);
    expect(isTailnetAddress('100.127.255.255')).toBe(true);
  });

  it('accepts a v4-mapped-v6 peer — the shape Node reports on a dual-stack listener', () => {
    expect(isTailnetAddress('::ffff:100.100.1.1')).toBe(true);
  });

  it('accepts the Tailscale IPv6 ULA prefix', () => {
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailnetAddress('FD7A:115C:A1E0:ab12::9')).toBe(true);
  });

  it('rejects everything just outside the range', () => {
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('101.64.0.1')).toBe(false);
  });

  it('rejects LAN, loopback, public and malformed addresses', () => {
    expect(isTailnetAddress('192.168.1.5')).toBe(false);
    expect(isTailnetAddress('127.0.0.1')).toBe(false);
    expect(isTailnetAddress('8.8.8.8')).toBe(false);
    expect(isTailnetAddress('100.999.0.1')).toBe(false);
    expect(isTailnetAddress('fd00::1')).toBe(false);
    expect(isTailnetAddress(undefined)).toBe(false);
    expect(isTailnetAddress(null)).toBe(false);
  });
});

describe('isSameOriginAsHost', () => {
  it('is true when the origin is the host that was dialed', () => {
    expect(isSameOriginAsHost(mockReq({ origin: `http://${HOST}` }))).toBe(true);
  });

  it('is false for a third-party origin, a port mismatch, or a missing header', () => {
    expect(isSameOriginAsHost(mockReq({ origin: 'https://evil.com' }))).toBe(false);
    expect(isSameOriginAsHost(mockReq({ origin: 'http://100.101.102.103:9999' }))).toBe(false);
    expect(isSameOriginAsHost(mockReq({}))).toBe(false);
    expect(isSameOriginAsHost(mockReq({ origin: 'not a url' }))).toBe(false);
  });
});

describe('isTrustedRemotePeer — all three facts, or nothing', () => {
  const cookie = `${AUTH_COOKIE}=${TOKEN}`;

  it('trusts an opted-in, tailnet, token-bearing peer', () => {
    expect(withRemote(() => isTrustedRemotePeer(mockReq({ cookie }), TOKEN))).toBe(true);
  });

  it('accepts the token on the URL too — the first visit, before any cookie exists', () => {
    const req = mockReq({ url: `/api/agent/chat?vault=x&token=${TOKEN}` });
    expect(withRemote(() => isTrustedRemotePeer(req, TOKEN))).toBe(true);
  });

  it('refuses when the operator never opted in', () => {
    expect(isTrustedRemotePeer(mockReq({ cookie }), TOKEN)).toBe(false);
  });

  it('refuses a token-bearing peer that is not on the tailnet', () => {
    const req = mockReq({ cookie, remote: '192.168.1.44' });
    expect(withRemote(() => isTrustedRemotePeer(req, TOKEN))).toBe(false);
  });

  it('refuses a tailnet peer with no token, a wrong token, or a token of another length', () => {
    expect(withRemote(() => isTrustedRemotePeer(mockReq({}), TOKEN))).toBe(false);
    const wrong = mockReq({ cookie: `${AUTH_COOKIE}=${'b'.repeat(64)}` });
    expect(withRemote(() => isTrustedRemotePeer(wrong, TOKEN))).toBe(false);
    const short = mockReq({ cookie: `${AUTH_COOKIE}=aaa` });
    expect(withRemote(() => isTrustedRemotePeer(short, TOKEN))).toBe(false);
  });

  it('refuses when the server minted no token at all (loopback bind)', () => {
    expect(withRemote(() => isTrustedRemotePeer(mockReq({ cookie }), null))).toBe(false);
  });
});

describe('isCrossSiteWrite under remote access', () => {
  it('blocks a phone-origin write while remote access is off', () => {
    const req = mockReq({ method: 'PUT', origin: `http://${HOST}` });
    expect(isCrossSiteWrite(req)).toBe(true);
  });

  it('allows that same write once remote access is on — it is same-origin', () => {
    const req = mockReq({ method: 'PUT', origin: `http://${HOST}` });
    expect(withRemote(() => isCrossSiteWrite(req))).toBe(false);
  });

  it('still blocks a drive-by write from a third-party page', () => {
    const req = mockReq({ method: 'POST', origin: 'https://evil.com' });
    expect(withRemote(() => isCrossSiteWrite(req))).toBe(true);
  });

  it('leaves loopback and header-less clients exactly as they were', () => {
    expect(isCrossSiteWrite(mockReq({ method: 'POST', origin: 'http://localhost:4173' }))).toBe(false);
    expect(isCrossSiteWrite(mockReq({ method: 'POST' }))).toBe(false);
    expect(isCrossSiteWrite(mockReq({ method: 'GET', origin: 'https://evil.com' }))).toBe(false);
  });
});
