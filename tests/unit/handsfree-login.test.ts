// The phone's server-rendered pages on Mac mode's phone listener: the service worker and its
// offline page, /login's routing, and GET /api/handsfree/phone. The Mac login page itself is
// covered through the real listener in phone-listener-gate.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import {
  handleHandsfreePhone,
  handlePhonePages,
  pickLang,
  renderOfflinePage,
  resetPhonePagesForTests,
  setMacPhoneSource,
} from '../../src/server/handsfree-login.js';

beforeEach(() => { resetPhonePagesForTests(); });
afterEach(() => { resetPhonePagesForTests(); setMacPhoneSource(null); });

interface Res { res: ServerResponse; status: () => number | null; headers: Record<string, string>; body: () => string }
function mockRes(): Res {
  let status: number | null = null;
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    setHeader(n: string, v: string) { headers[n.toLowerCase()] = String(v); },
    writeHead(code: number, h?: Record<string, string | number>) {
      status = code;
      for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v);
      return res;
    },
    end(b?: string) { body = b ?? ''; },
  } as unknown as ServerResponse;
  return { res, status: () => status, headers, body: () => body };
}
function phoneSocket(): object {
  const s = { remoteAddress: '127.0.0.1' };
  markPhoneSocket(s);
  return s;
}
function req(method: string, url: string, socket: object, h: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers: { host: 'localhost:4173', ...h }, socket } as unknown as IncomingMessage;
}
function page(url: string, socket: object = phoneSocket(), method = 'GET'): Res & { handled: boolean } {
  const m = mockRes();
  const handled = handlePhonePages(req(method, url, socket), m.res, new URL(url, 'http://localhost'));
  return { ...m, handled };
}

/** Every inline executable script and style is allowed by the CSP hash, and nothing else. */
function expectCspMatches(html: string, csp: string) {
  const b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  for (const s of scripts) expect(csp).toContain(`'sha256-${b64(s)}'`);
  for (const s of styles) expect(csp).toContain(`'sha256-${b64(s)}'`);
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
}

describe('pickLang', () => {
  it('picks the preferred of en/tr by q, default en', () => {
    expect(pickLang('tr-TR,tr;q=0.9,en;q=0.8')).toBe('tr');
    expect(pickLang('en-US,en;q=0.9,tr;q=0.8')).toBe('en');
    expect(pickLang('de-DE,tr;q=0.7,en;q=0.5')).toBe('tr');
    expect(pickLang('en;q=0.3,tr;q=0.9')).toBe('tr');
    expect(pickLang(undefined)).toBe('en');
    expect(pickLang('fr')).toBe('en');
  });
});

describe('service worker and offline page on the phone listener', () => {
  it('serves the SW as no-cache JavaScript for the whole origin, and the offline page fully inline', () => {
    const sw = page('/handsfree-sw.js');
    expect(sw.status()).toBe(200);
    expect(sw.headers['content-type']).toMatch(/^application\/javascript/);
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.headers['service-worker-allowed']).toBe('/');
    expect(sw.body()).toContain("addEventListener('fetch'");
    expect(sw.body()).toMatch(/const CACHE = "dc-hf-offline-[0-9a-f]{12}"/);

    const off = page('/handsfree-offline.html');
    expect(off.status()).toBe(200);
    const html = off.body();
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|<a /);
    expect(html).toContain("fetch('/api/health'");
    expect(html).toContain("cache:'no-store'");
    expect(html).toContain('Reaching your Mac…');
    expect(html).toContain('Your Mac is not reachable');
    expect(html).toContain('Mac\'ine ulaşılamıyor');
    expect(html).toContain('X-Dreamcontext-Surface');
    expectCspMatches(html, off.headers['content-security-policy']);
  });

  it('the SW cache version follows the offline page', () => {
    const v = (body: string) => /dc-hf-offline-([0-9a-f]{12})/.exec(body)?.[1];
    const a = renderOfflinePage('en');
    const sw = page('/handsfree-sw.js').body();
    expect(v(sw)).toBe(createHash('sha256').update(a.html).update('\0').update(a.csp).update('\0').digest('hex').slice(0, 12));
  });

  it('only GET/HEAD', () => {
    expect(page('/handsfree-sw.js', phoneSocket(), 'POST').status()).toBe(405);
  });

  it('are 404 off the phone listener, where /login is left to the SPA', () => {
    for (const p of ['/handsfree-sw.js', '/handsfree-offline.html']) {
      const r = page(p, {});
      expect(r.handled).toBe(true);
      expect(r.status()).toBe(404);
    }
    expect(page('/login', {}).handled).toBe(false);
  });

  it('leave every other path alone', () => {
    expect(page('/').handled).toBe(false);
    expect(page('/assets/x.js').handled).toBe(false);
  });
});

describe('GET /api/handsfree/phone', () => {
  async function phone(socket: object): Promise<Res> {
    const m = mockRes();
    await handleHandsfreePhone(req('GET', '/api/handsfree/phone', socket), m.res);
    return m;
  }

  it('is 404 off the phone listener', async () => {
    expect((await phone({})).status()).toBe(404);
  });

  it('answers the Mac chip (battery, sleep allowed) on a phone socket', async () => {
    setMacPhoneSource(() => ({ mode: 'mac', battery: { percent: 42, charging: false }, sleepAllowed: false }));
    const r = await phone(phoneSocket());
    expect(r.status()).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body())).toEqual({ mode: 'mac', battery: { percent: 42, charging: false }, sleepAllowed: false });
  });
});
