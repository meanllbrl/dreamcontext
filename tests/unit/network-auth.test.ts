import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkNetworkAuth, generateNetworkToken, isLoopbackAddress, AUTH_COOKIE } from '../../src/server/network-auth.js';

const TOKEN = 'a'.repeat(64);

interface MockRes {
  res: ServerResponse;
  statusCode: () => number | null;
  headers: Record<string, string>;
  ended: () => boolean;
}

function mockRes(): MockRes {
  let status: number | null = null;
  let ended = false;
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) { headers[name] = value; },
    writeHead(code: number) { status = code; return res; },
    end() { ended = true; },
  } as unknown as ServerResponse;
  return { res, statusCode: () => status, headers, ended: () => ended };
}

function mockReq(opts: { remote?: string; cookie?: string; url?: string }): IncomingMessage {
  return {
    url: opts.url ?? '/',
    headers: { host: '192.168.1.10:3333', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    socket: { remoteAddress: opts.remote ?? '192.168.1.99' },
  } as unknown as IncomingMessage;
}

describe('isLoopbackAddress', () => {
  it('accepts all loopback representations', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects LAN and absent addresses', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('10.0.0.7')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe('checkNetworkAuth (network-exposure token gate)', () => {
  it('always allows loopback peers (CLI, hooks, local browser)', () => {
    const { res, statusCode } = mockRes();
    expect(checkNetworkAuth(mockReq({ remote: '127.0.0.1' }), res, TOKEN)).toBe(true);
    expect(statusCode()).toBeNull();
  });

  it('rejects a bare LAN request with 401', () => {
    const m = mockRes();
    expect(checkNetworkAuth(mockReq({}), m.res, TOKEN)).toBe(false);
    expect(m.statusCode()).toBe(401);
    expect(m.ended()).toBe(true);
  });

  it('accepts a valid ?token= and sets the auth cookie', () => {
    const m = mockRes();
    expect(checkNetworkAuth(mockReq({ url: `/?token=${TOKEN}` }), m.res, TOKEN)).toBe(true);
    expect(m.headers['Set-Cookie']).toContain(`${AUTH_COOKIE}=${TOKEN}`);
    expect(m.headers['Set-Cookie']).toContain('HttpOnly');
    expect(m.headers['Set-Cookie']).toContain('SameSite=Strict');
  });

  it('rejects a wrong ?token=', () => {
    const m = mockRes();
    expect(checkNetworkAuth(mockReq({ url: `/?token=${'b'.repeat(64)}` }), m.res, TOKEN)).toBe(false);
    expect(m.statusCode()).toBe(401);
  });

  it('rejects a token of a different length (timing-safe compare guard)', () => {
    const m = mockRes();
    expect(checkNetworkAuth(mockReq({ url: '/?token=short' }), m.res, TOKEN)).toBe(false);
    expect(m.statusCode()).toBe(401);
  });

  it('accepts the auth cookie on subsequent requests', () => {
    const m = mockRes();
    const req = mockReq({ cookie: `${AUTH_COOKIE}=${TOKEN}`, url: '/api/tasks' });
    expect(checkNetworkAuth(req, m.res, TOKEN)).toBe(true);
    expect(m.statusCode()).toBeNull();
  });

  it('accepts the auth cookie among other cookies', () => {
    const m = mockRes();
    const req = mockReq({ cookie: `other=1; ${AUTH_COOKIE}=${TOKEN}; theme=dark` });
    expect(checkNetworkAuth(req, m.res, TOKEN)).toBe(true);
  });

  it('rejects a wrong cookie value', () => {
    const m = mockRes();
    const req = mockReq({ cookie: `${AUTH_COOKIE}=${'c'.repeat(64)}` });
    expect(checkNetworkAuth(req, m.res, TOKEN)).toBe(false);
    expect(m.statusCode()).toBe(401);
  });
});

describe('generateNetworkToken', () => {
  it('produces 64 hex chars, unique per call', () => {
    const a = generateNetworkToken();
    const b = generateNetworkToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
