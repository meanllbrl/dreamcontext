// The phone's server-rendered pages in cloud mode: /login, the sealed page, the offline Wake
// page, the service worker route, and GET /api/handsfree/phone (lane H, wave 3).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setCloudPhaseSource, type CloudPhase } from '../../src/server/cloud-mode.js';
import { DEVICE_COOKIE, HandsfreeAuth, handleHandsfreeLogin, hashPassphrase, setHandsfreeAuthForTests, sha256Hex } from '../../src/server/handsfree-auth.js';
import { Readable } from 'node:stream';
import { CloudIdle, IDLE_AFTER_MS, setCloudIdle } from '../../src/server/cloud-idle.js';
import { CloudStateStore } from '../../src/server/cloud-state.js';
import { TransferStore } from '../../src/server/cloud-transfers.js';
import { setCloudServicesForTests } from '../../src/server/routes/handsfree-cloud.js';
import { cloudGate } from '../../src/server/middleware.js';
import { rootIdFor } from '../../src/lib/handsfree/manifest.js';
import {
  handleHandsfreePhone,
  handlePhonePages,
  pickLang,
  renderLoginPage,
  renderOfflinePage,
  renderSealedPage,
  resetPhonePagesForTests,
  tripVaultName,
  wakeUrlFromOrigin,
} from '../../src/server/handsfree-login.js';

const ENV_KEYS = ['DREAMCONTEXT_CLOUD', 'DC_HF_ORIGIN'];
const saved: Record<string, string | undefined> = {};
const PASS = 'correct horse battery staple extra words';
let dir: string;
let auth: HandsfreeAuth;
let deviceId: string;
let phase: CloudPhase;
let state: CloudStateStore;

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DREAMCONTEXT_CLOUD = '1';
  process.env.DC_HF_ORIGIN = 'https://dc-hf-phone-8080.app.github.dev';
  resetPhonePagesForTests();
  dir = mkdtempSync(join(tmpdir(), 'hf-login-'));
  auth = new HandsfreeAuth({ dir });
  auth.store.installVerifiers({ generation: 1, passphrase: await hashPassphrase(PASS), transferSha256: sha256Hex('t') });
  deviceId = auth.store.createDevice();
  setHandsfreeAuthForTests(auth);
  state = new CloudStateStore({ dir });
  setCloudServicesForTests({ state, transfers: new TransferStore({ dir }) });
  phase = 'active';
  setCloudPhaseSource(() => phase);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setHandsfreeAuthForTests(null);
  setCloudServicesForTests(null);
  setCloudIdle(null);
  setCloudPhaseSource(() => 'sealed');
  resetPhonePagesForTests();
  rmSync(dir, { recursive: true, force: true });
});

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
function req(method: string, url: string, h: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers: { host: 'localhost:8080', ...h }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
}
function page(url: string, h: Record<string, string> = {}): Res & { handled: boolean } {
  const m = mockRes();
  const handled = handlePhonePages(req('GET', url, h), m.res, new URL(url, 'http://localhost'));
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

describe('GET /login', () => {
  it('renders a standalone mobile page in EN with one hardened passphrase field', () => {
    const p = page('/login', { accept: 'text/html', 'accept-language': 'en-US' });
    expect(p.handled).toBe(true);
    expect(p.status()).toBe(200);
    expect(p.headers['content-type']).toMatch(/text\/html/);
    expect(p.headers['cache-control']).toBe('no-store');
    const html = p.body();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Sign in to your cloud project');
    expect(html).toContain('viewport-fit=cover');
    expect(html.match(/<input /g)?.length).toBe(1);
    expect(html).toMatch(/<input[^>]*autocomplete="off"[^>]*autocapitalize="off"[^>]*autocorrect="off"[^>]*spellcheck="false"/);
    expect(html).toContain("fetch('/api/handsfree/login'");
    expect(html).toContain("location.replace('/')");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!github\.com\/codespaces)/);
    expectCspMatches(html, p.headers['content-security-policy']);
  });

  it('renders TR for a Turkish phone', () => {
    const html = page('/login', { 'accept-language': 'tr-TR,tr;q=0.9' }).body();
    expect(html).toContain('<html lang="tr">');
    expect(html).toContain('Bulut projene giriş yap');
  });

  it('carries no secret: no verifier, no device id, no passphrase', () => {
    const html = page('/login').body();
    expect(html).not.toContain(deviceId);
    expect(html).not.toContain(PASS);
    expect(html).not.toContain(auth.store.passphraseVerifier!.hash);
    expect(html).not.toContain(auth.store.passphraseVerifier!.salt);
  });

  it('shows the limiter\'s real wait (Retry-After from retryAfterMs) and the other outcomes', () => {
    const html = renderLoginPage('en', { revoked: false }).html;
    expect(html).toContain('o.body.retryAfterMs');
    expect(html).toContain('Too many tries. You can try again in {s} s.');
    expect(html).toContain('That password is not right.');
    expect(html).toContain('dreamcontext handsfree password');
  });

  it('a first visit with no cookie forgets nothing; a stale cookie or ?revoked=1 unregisters the worker', () => {
    const data = (html: string) => JSON.parse(/<script type="application\/json" id="dc-data">([\s\S]*?)<\/script>/.exec(html)![1]);
    const first = page('/login');
    expect(data(first.body()).forget).toBe(false);
    expect(first.headers['set-cookie']).toBeUndefined();

    const flagged = page('/login?revoked=1');
    expect(data(flagged.body()).forget).toBe(true);
    expect(flagged.body()).toContain('This device was signed out.');

    expect(auth.store.revokeAllDevices(2).ok).toBe(true); // revoke-all: the old cookie is now stale
    const stale = page('/login', { cookie: `${DEVICE_COOKIE}=${deviceId}` });
    expect(data(stale.body()).forget).toBe(true);
    expect(stale.headers['set-cookie']).toMatch(/^__Host-dc_hf_session=;.*Max-Age=0/);
    expect(stale.body()).toContain('getRegistrations');
  });

  it('a signed-in device goes straight to the chat', () => {
    const p = page('/login', { cookie: `${DEVICE_COOKIE}=${deviceId}` });
    expect(p.status()).toBe(302);
    expect(p.headers.location).toBe('/');
  });

  it('a sealed cloud serves only the sealed page, even at /login', () => {
    phase = 'sealed';
    const p = page('/login', { 'accept-language': 'en' });
    expect(p.status()).toBe(503);
    expect(p.body()).toContain('This project is back on your laptop.');
  });

  it('off the cloud /login is left to the SPA', () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    expect(page('/login').handled).toBe(false);
  });
});

describe('sealed page', () => {
  it('EN/TR, unregisters the service worker and clears its caches', () => {
    for (const [lang, text] of [['en', 'This project is back on your laptop.'], ['tr', 'Bu proje laptopuna döndü.']] as const) {
      const p = renderSealedPage(lang, false);
      expect(p.html).toContain(text);
      expect(p.html).toContain('dcForgetOffline();');
      expect(p.html).toContain('.unregister()');
      expect(p.html).toContain('caches.delete');
      expectCspMatches(p.html, p.csp);
    }
  });

  it('a trip still going in says so and keeps the worker', () => {
    const p = renderSealedPage('en', true);
    expect(p.html).toContain('Your laptop is still sending this project.');
    expect(p.html).not.toContain('dcForgetOffline');
  });
});

describe('service worker and offline page routes', () => {
  it('serves the SW as no-cache JavaScript and the offline page fully inline', () => {
    const sw = page('/handsfree-sw.js');
    expect(sw.status()).toBe(200);
    expect(sw.headers['content-type']).toMatch(/^application\/javascript/);
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.body()).toContain("addEventListener('fetch'");
    expect(sw.body()).toMatch(/const CACHE = "dc-hf-offline-[0-9a-f]{12}"/);

    const off = page('/handsfree-offline.html', { 'x-tunnel-skip-antiphishing-page': 'true' });
    expect(off.status()).toBe(200);
    const html = off.body();
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(html).toContain('href="https://dc-hf-phone.github.dev" target="_blank"');
    expect(html).toContain("fetch('/api/health'");
    expect(html).toContain("'X-Tunnel-Skip-AntiPhishing-Page':'true'");
    expect(html).toContain("cache:'no-store'");
    expect(html).toContain('Checking the cloud machine…');
    expect(html).toContain('Come back to THIS tab.');
    expect(html).toContain('BU sekmeye geri dön.');
    expectCspMatches(html, off.headers['content-security-policy']);
  });

  it('the SW cache version follows the offline page', () => {
    const a = page('/handsfree-sw.js').body();
    process.env.DC_HF_ORIGIN = 'https://other-cs-8080.app.github.dev';
    resetPhonePagesForTests();
    expect(page('/handsfree-sw.js').body()).not.toBe(a);
  });

  it('derives Wake A from DC_HF_ORIGIN, else falls back to github.com/codespaces', () => {
    expect(wakeUrlFromOrigin('https://fuzzy-space-x9-8080.app.github.dev')).toBe('https://fuzzy-space-x9.github.dev');
    expect(wakeUrlFromOrigin('http://localhost:8080')).toBeNull();
    expect(wakeUrlFromOrigin(undefined)).toBeNull();
    expect(renderOfflinePage('en', null).html).toContain('href="https://github.com/codespaces" target="_blank"');
  });

  it('are 404 off the cloud', () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    for (const p of ['/handsfree-sw.js', '/handsfree-offline.html']) {
      const r = page(p);
      expect(r.handled).toBe(true);
      expect(r.status()).toBe(404);
    }
  });

  it('leave every other path alone', () => {
    expect(page('/').handled).toBe(false);
    expect(page('/assets/x.js').handled).toBe(false);
  });
});

describe('GET /api/handsfree/phone', () => {
  async function phone(): Promise<Res> {
    const m = mockRes();
    await handleHandsfreePhone(req('GET', '/api/handsfree/phone'), m.res);
    return m;
  }

  it('is 404 off the cloud', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    expect((await phone()).status()).toBe(404);
  });

  it('answers the phase and the planned stop time, without touching the idle clock', async () => {
    let now = 1_000_000;
    const idle = new CloudIdle({
      now: () => now,
      liveChats: () => [],
      trip: () => ({ phase: 'active', goingSince: null, quiescingSince: null, servedEpoch: null, epoch: 0, lastLaptopProgressAt: null }),
      onRevert: () => undefined,
      onSeal: () => undefined,
      publicDir: join(dir, 'pub'),
      bootId: 'b',
    });
    setCloudIdle(idle);
    expect(JSON.parse((await phone()).body())).toEqual({ phase: 'sealed', stopAt: null }); // no tick yet, no trip

    const stopAt = idle.tick();
    now += 10 * 60_000;
    for (let i = 0; i < 20; i++) await phone();
    const r = await phone();
    expect(r.status()).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body()).stopAt).toBe(new Date(stopAt).toISOString());
    // Polling is not an owner action: the next tick still plans the same stop.
    expect(idle.inputs().lastActionAt).toBeNull();
    expect(idle.tick()).toBe(stopAt);
  });

  it('reports going for a sealed cloud with a trip on its way in', async () => {
    state.startTrip({ tripId: 't', laptopId: 'l', go: {}, rootIds: [], takeOver: false });
    expect(JSON.parse((await phone()).body()).phase).toBe('going');
    state.activate('t');
    expect(JSON.parse((await phone()).body()).phase).toBe('active');
  });
});

describe('`/` opens the trip\'s project chat (AC3)', () => {
  let savedHome: string | undefined;
  let home: string;
  const nav = (url: string, h: Record<string, string> = {}) => {
    const m = mockRes();
    const passed = cloudGate(req('GET', url, { accept: 'text/html', ...h }), m.res);
    return { ...m, passed };
  };
  const signedIn = () => ({ cookie: `${DEVICE_COOKIE}=${deviceId}` });

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = join(dir, 'home');
    const vault = join(home, 'projects', 'acme-notes');
    const linked = join(home, 'projects', 'acme-api');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [
      { name: 'acme-api', path: linked }, // also registered, but a linked repo of this trip
      { name: 'acme-notes', path: vault },
    ] }));
    process.env.HOME = home;
    // The active vault is first (it is a git repo, so its kind is `repo`), then a linked repo.
    const go = { version: 1, tripId: 't', laptopId: 'l', createdAt: new Date(0).toISOString(), home, roots: [
      { rootId: rootIdFor(vault), kind: 'repo', absPath: vault },
      { rootId: rootIdFor(linked), kind: 'repo', absPath: linked },
    ] };
    state.startTrip({ tripId: 't', laptopId: 'l', go, rootIds: [rootIdFor(vault), rootIdFor(linked)], takeOver: false });
    state.activate('t');
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it('resolves the vault the trip went with from the cloud state, never from the request', () => {
    expect(tripVaultName()).toBe('acme-notes');
  });

  it('a signed-in navigation to exactly / gets 302 to /?vault=<trip vault>', () => {
    const r = nav('/', signedIn());
    expect(r.passed).toBe(false);
    expect(r.status()).toBe(302);
    expect(r.headers.location).toBe('/?vault=acme-notes');
    expect(r.headers['x-dreamcontext-cloud']).toBe('1');
  });

  it('leaves alone a URL that names a vault, any other path, and non-HTML requests', () => {
    expect(nav('/?vault=acme-api', signedIn()).passed).toBe(true);
    expect(nav('/agents', signedIn()).passed).toBe(true);
    const m = mockRes();
    expect(cloudGate(req('GET', '/', { ...signedIn(), accept: '*/*' }), m.res)).toBe(true);
  });

  it('every gate stays in front: signed out -> /login, stale cookie -> revoked, sealed -> sealed page', () => {
    expect(nav('/').headers.location).toBe('/login');
    phase = 'sealed';
    const sealed = nav('/', signedIn());
    expect(sealed.status()).toBe(503);
    expect(sealed.body()).toContain('This project is back on your laptop.');
    phase = 'active';
    auth.store.revokeAllDevices(2);
    expect(nav('/', signedIn()).headers.location).toBe('/login?revoked=1');
  });

  it('no registered vault at the trip path: no redirect (the SPA decides, as before)', () => {
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [] }));
    expect(tripVaultName()).toBeNull();
    expect(nav('/', signedIn()).passed).toBe(true);
  });
});

describe('AC16: a successful phone login is the owner\'s real action (smoke #3)', () => {
  const MIN = 60_000;
  let now: number;
  let idle: CloudIdle;
  beforeEach(() => {
    now = 5_000_000_000;
    idle = new CloudIdle({
      now: () => now,
      liveChats: () => [],
      trip: () => ({ phase: 'active', goingSince: null, quiescingSince: null, servedEpoch: null, epoch: 0, lastLaptopProgressAt: null }),
      onRevert: () => undefined, onSeal: () => undefined, publicDir: join(dir, 'pub'), bootId: 'b',
    });
    setCloudIdle(idle);
  });
  /** POST /api/handsfree/login through the real handler (a real body stream, a real client key). */
  const login = async (passphrase: string) => {
    const r = Object.assign(Readable.from([Buffer.from(JSON.stringify({ passphrase }))]), {
      method: 'POST', url: '/api/handsfree/login',
      headers: { host: 'localhost:8080', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
    const m = mockRes();
    await handleHandsfreeLogin(r, m.res);
    return m;
  };

  it('the owner opens the app 14 min after boot: GET /login and a wrong passphrase move nothing; the right one gives the full 15 min', async () => {
    const boot = idle.bootAt;
    expect(idle.tick()).toBe(boot + IDLE_AFTER_MS);
    now = boot + 14 * MIN;
    expect(page('/login', { accept: 'text/html' }).status()).toBe(200);
    expect((await login('wrong words entirely here now')).status()).toBe(401);
    expect(idle.tick()).toBe(boot + IDLE_AFTER_MS);
    const ok = await login(PASS);
    expect(ok.status()).toBe(200);
    expect(ok.headers['set-cookie']).toContain(DEVICE_COOKIE);
    expect(idle.tick()).toBe(now + IDLE_AFTER_MS);
  });
});

describe('AC16: the login page installs the offline worker itself (smoke #3)', () => {
  it('after a successful login it registers /handsfree-sw.js (scope /) BEFORE entering, and its CSP allows that worker', () => {
    const p = page('/login', { accept: 'text/html' });
    const html = p.body();
    const csp = p.headers['content-security-policy'];
    // Registration is on the success path, then the page enters the app (at most 4 s later).
    expect(html).toMatch(/o\.status===200&&o\.body&&o\.body\.ok\)\{[^}]*dcEnterApp\(\)/);
    expect(html).toContain("navigator.serviceWorker.register('/handsfree-sw.js',{scope:'/'}).then(go,go)");
    expect(html).toContain('setTimeout(go,4000)');
    expect(csp).toContain("worker-src 'self'");
    expectCspMatches(html, csp);
  });

  it('a hung login request is aborted after 30 s and says so (never "checking" forever)', () => {
    const html = page('/login', { accept: 'text/html' }).body();
    expect(html).toContain('setTimeout(function(){ctl.abort();},30000)');
    expect(html).toContain('signal:ctl?ctl.signal:undefined');
    expect(html).toMatch(/\.catch\(function\(\)\{if\(hang\)clearTimeout\(hang\);btn\.disabled=false;say\(s\.network,true\);\}\)/);
  });
});

