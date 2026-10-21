/**
 * The main listener's HTTP gate is port-strict on loopback (jarvis plan r9, T3, AC4): a page on
 * another loopback port (an approved dev server in a web card, any localhost tab) is another
 * origin. Before this, `isCrossSiteWrite` and `handleCors` trusted every loopback spelling on
 * every port, so such a page could create, approve and run a `bypassPermissions` automation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mainLaptopGate } from '../../src/server/index.js';
import { isCrossSiteWrite, handleCors } from '../../src/server/middleware.js';
import { isCrossSiteRequest, isSameOriginStrict, requireLocalRead } from '../../src/server/routes/agent-spawn-shared.js';

const SELF = '127.0.0.1:4173';
const saved = process.env.DREAMCONTEXT_REMOTE;
afterEach(() => { if (saved === undefined) delete process.env.DREAMCONTEXT_REMOTE; else process.env.DREAMCONTEXT_REMOTE = saved; });

function req(o: { method?: string; headers?: Record<string, string>; remote?: string; url?: string } = {}): IncomingMessage {
  return { method: o.method ?? 'POST', url: o.url ?? '/', headers: { host: SELF, ...(o.headers ?? {}) }, socket: { remoteAddress: o.remote ?? '127.0.0.1' } } as unknown as IncomingMessage;
}

function res() {
  const headers: Record<string, string> = {};
  const out = { status: 0, headers, body: '' };
  const r = {
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    writeHead: (s: number, h?: Record<string, string>) => { out.status = s; for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v; },
    end: (b?: string) => { out.body = b ?? ''; },
  } as unknown as ServerResponse;
  return { r, out };
}

const gate = (rq: IncomingMessage) => { const { r, out } = res(); const passed = mainLaptopGate(rq, r, null); return { passed, ...out }; };

describe('a write from another loopback port is refused (the automation path, agent/install, onboarding/fix)', () => {
  for (const path of ['/api/automations', '/api/automations/x/approve', '/api/automations/x/run', '/api/agent/install', '/api/onboarding/fix']) {
    it(`POST ${path} with Origin http://localhost:5173 → 403, no CORS reflection`, () => {
      const g = gate(req({ url: path, headers: { origin: 'http://localhost:5173' } }));
      expect(g.passed).toBe(false);
      expect(g.status).toBe(403);
      expect(g.headers['access-control-allow-origin']).toBeUndefined();
    });
  }

  it('every loopback spelling on another port is another origin; so is another spelling of this port', () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://[::1]:4173', 'http://localhost:4173', 'http://127.0.0.1']) {
      expect(isCrossSiteWrite(req({ headers: { origin } })), origin).toBe(true);
    }
  });

  it('`Origin: null` (a sandboxed frame, a data: page) is refused', () => {
    expect(gate(req({ headers: { origin: 'null' } })).status).toBe(403);
  });

  it('the app itself, a client with no Origin, and GETs pass', () => {
    expect(gate(req({ headers: { origin: `http://${SELF}` } })).passed).toBe(true);
    expect(gate(req()).passed).toBe(true);
    expect(gate(req({ method: 'GET', headers: { origin: 'http://localhost:5173' } })).passed).toBe(true);
  });

  it('CORS reflects only the dialed origin', () => {
    const own = res(); handleCors(req({ method: 'GET', headers: { origin: `http://${SELF}` } }), own.r);
    expect(own.out.headers['access-control-allow-origin']).toBe(`http://${SELF}`);
    const other = res(); handleCors(req({ method: 'GET', headers: { origin: 'http://localhost:5173' } }), other.r);
    expect(other.out.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a DNS-rebinding page (Origin = Host = evil.test:PORT) is refused while remote access is off', () => {
    expect(isCrossSiteWrite(req({ headers: { host: 'evil.test:4173', origin: 'http://evil.test:4173' } }))).toBe(true);
  });

  it('tailnet same-origin still passes with remote access on (unchanged remote branch)', () => {
    process.env.DREAMCONTEXT_REMOTE = '1';
    expect(isCrossSiteWrite(req({ remote: '100.64.1.2', headers: { host: '100.64.1.2:4173', origin: 'http://100.64.1.2:4173' } }))).toBe(false);
  });
});

describe('the readiness read cannot be triggered from another port', () => {
  it('an Origin-less no-cors GET with Sec-Fetch-Site: same-site (an <img src>) → 403', () => {
    const { r, out } = res();
    expect(requireLocalRead(req({ method: 'GET', headers: { 'sec-fetch-site': 'same-site' } }), r)).toBe(false);
    expect(out.status).toBe(403);
  });

  it('port-strict: another loopback port is cross-site, this origin is not', () => {
    expect(isCrossSiteRequest(req({ headers: { origin: 'http://localhost:5173' } }))).toBe(true);
    expect(isCrossSiteRequest(req({ headers: { origin: `http://${SELF}`, 'sec-fetch-site': 'same-origin' } }))).toBe(false);
    expect(isCrossSiteRequest(req())).toBe(false);
  });
});

describe('isSameOriginStrict (the chat, terminal, super and grant doors)', () => {
  it('passes the app, a CLI and a tailnet same-origin; refuses another port, rebinding, a loopback proxy Host', () => {
    expect(isSameOriginStrict(req({ headers: { origin: `http://${SELF}`, 'sec-fetch-site': 'same-origin' } }))).toBe(true);
    expect(isSameOriginStrict(req())).toBe(true);
    expect(isSameOriginStrict(req({ remote: '100.64.1.2', headers: { host: '100.64.1.2:4173', origin: 'http://100.64.1.2:4173' } }))).toBe(true);
    expect(isSameOriginStrict(req({ headers: { origin: 'http://localhost:5173' } }))).toBe(false);
    expect(isSameOriginStrict(req({ headers: { host: 'evil.test:4173', origin: 'http://evil.test:4173' } }))).toBe(false);
    expect(isSameOriginStrict(req({ headers: { host: 'mac.tail1234.ts.net' } }))).toBe(false);
    expect(isSameOriginStrict(req({ headers: { host: 'app.localhost:4173' } }))).toBe(false);
    expect(isSameOriginStrict(req({ headers: { origin: 'null' } }))).toBe(false);
    expect(isSameOriginStrict(req({ headers: { origin: `http://${SELF}`, 'sec-fetch-site': 'same-site' } }))).toBe(false);
  });
});

describe('the window never calls the API across ports (so port-strict breaks nothing of its own)', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) files.push(p);
    }
  };
  walk(new URL('../../dashboard/src', import.meta.url).pathname);

  it('no absolute loopback fetch, WebSocket or EventSource in dashboard/src', () => {
    const bad: string[] = [];
    const re = /(fetch|WebSocket|EventSource)\(\s*[`'"](https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])/;
    for (const f of files) if (re.test(readFileSync(f, 'utf-8'))) bad.push(f);
    expect(bad).toEqual([]);
  });
});

describe('the Vite dev proxy rewrites only its own page\'s Origin (security review, T3 in dev)', async () => {
  const { rewrittenOrigin } = await import('../../dashboard/devProxyOrigin.js');
  const T = 'http://localhost:4173';
  it('the dev page itself → the target origin; anything else passes untouched', () => {
    expect(rewrittenOrigin('http://localhost:5173', 'localhost:5173', T)).toBe(T);
    expect(rewrittenOrigin('http://LOCALHOST:5173', 'localhost:5173', T)).toBe(T);
    for (const o of ['http://localhost:3000', 'https://evil.com', 'null', 'http://127.0.0.1:5173']) {
      expect(rewrittenOrigin(o, 'localhost:5173', T), o).toBeNull();
    }
    expect(rewrittenOrigin(undefined, 'localhost:5173', T)).toBeNull();
  });
  it('vite.config uses the rule, never an unconditional rewrite', () => {
    const cfg = readFileSync(new URL('../../dashboard/vite.config.ts', import.meta.url), 'utf-8');
    expect(cfg).toContain('rewrittenOrigin(req.headers.origin, req.headers.host, API_TARGET)');
    expect(cfg).not.toMatch(/if \(proxyReq\.getHeader\('origin'\)\) proxyReq\.setHeader/);
  });
});
