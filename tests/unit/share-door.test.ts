// Live links, the door (plan C2, C3; criterion K5): the link is the credential, the password an
// optional second factor; an unknown token, a wrong token, no session and a closed share look the
// same; a wrong password costs a step of a per-IP limiter keyed on Cloudflare's own header.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeAllShares, openShare, type Share } from '../../src/server/shares/registry.js';
import { DOOR_CSP, LoginLimiter, SESSION_CAP, SHARE_LOGIN_PER_MINUTE, limiterKey } from '../../src/server/shares/door.js';
import { fakeKind, fakeWorld, openAndWait, sessionCookie, viaTunnel, type FakeWorld, type KindSpy } from './share-fixture.js';

let world: FakeWorld;
let kind: KindSpy;
const HTML = { accept: 'text/html,application/xhtml+xml' };

beforeEach(() => {
  world = fakeWorld();
  kind = fakeKind('board');
});
afterEach(async () => { await closeAllShares('shutdown'); });

const open = (password?: string): Promise<Share> => openAndWait(() => openShare({ kind: 'board', vault: 'demo', slug: `b${Math.random().toString(36).slice(2, 8)}`, password }).share);

describe('the link without a password', () => {
  it('mints a Strict __Host- session on a same-origin bounce page and lets the guest in', async () => {
    const s = await open();
    const r = await viaTunnel(s, 'GET', `/k/${s.token}`, HTML);
    expect(r.status).toBe(200);
    const line = (r.headers['set-cookie'] ?? []).find((l) => l.startsWith('__Host-dcs='))!;
    expect(line).toMatch(/; Secure; HttpOnly; SameSite=Strict; Path=\//);
    expect(line).not.toMatch(/domain=/i);
    expect(r.body).toContain('http-equiv="refresh" content="0;url=/"');
    expect(r.body).not.toContain(s.token);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toBe(DOOR_CSP);
    const g = await viaTunnel(s, 'GET', '/', { cookie: sessionCookie(r) });
    expect(g.status).toBe(200);
    expect(g.body).toBe('guest ok');
    expect(kind.served).toEqual(['GET /']);
  });

  it('answers an unknown token, a wrong token, no session and the closed path with the same page', async () => {
    const s = await open();
    const wrong = await viaTunnel(s, 'GET', `/k/${'A'.repeat(43)}`, HTML);
    const garbage = await viaTunnel(s, 'GET', '/k/x', HTML);
    const none = await viaTunnel(s, 'GET', '/', HTML);
    const closed = await viaTunnel(s, 'GET', '/__share/closed', HTML);
    for (const r of [wrong, garbage, none, closed]) {
      expect(r.status).toBe(401);
      expect(r.body).toBe(wrong.body);
      expect(r.body).toContain('Bu paylaşım kapandı');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect(kind.served).toEqual([]);
    // Data callers get JSON, the same for every case too.
    const j1 = await viaTunnel(s, 'GET', '/api/board');
    const j2 = await viaTunnel(s, 'POST', `/k/${s.token}`);
    expect(j1.status).toBe(401);
    expect(JSON.parse(j1.body)).toEqual({ error: 'share_unavailable' });
    expect(j2.status).toBe(401);
  });

  it('refuses a request that did not come through the tunnel or names another host', async () => {
    const s = await open();
    expect((await viaTunnel(s, 'GET', `/k/${s.token}`, { 'cf-connecting-ip': undefined })).status).toBe(400);
    expect((await viaTunnel(s, 'GET', `/k/${s.token}`, { host: 'evil.example' })).status).toBe(421);
    expect((await viaTunnel(s, 'GET', `/k/${s.token}`, { host: `127.0.0.1:${s.port}` })).status).toBe(421);
  });

  it('a session of one share opens nothing on another', async () => {
    const a = await open();
    const b = await open();
    const ra = await viaTunnel(a, 'GET', `/k/${a.token}`, HTML);
    const onB = await viaTunnel(b, 'GET', '/', { cookie: sessionCookie(ra) });
    expect(onB.status).toBe(401);
    const tokenOfA = await viaTunnel(b, 'GET', `/k/${a.token}`, HTML);
    expect(tokenOfA.status).toBe(401);
  });

  it('caps the sessions of a share, dropping the least recently used first', async () => {
    const s = await open();
    const first = sessionCookie(await viaTunnel(s, 'GET', `/k/${s.token}`, HTML));
    const second = sessionCookie(await viaTunnel(s, 'GET', `/k/${s.token}`, HTML));
    // `first` is used again: it is now the most recent.
    expect((await viaTunnel(s, 'GET', '/', { cookie: first })).status).toBe(200);
    for (let i = 0; i < SESSION_CAP - 1; i++) await viaTunnel(s, 'GET', `/k/${s.token}`, HTML);
    expect(s.sessions.size).toBe(SESSION_CAP);
    expect((await viaTunnel(s, 'GET', '/', { cookie: second })).status).toBe(401);
    expect((await viaTunnel(s, 'GET', '/', { cookie: first })).status).toBe(200);
  }, 20_000);
});

describe('the link with a password (K5)', () => {
  const PW = 'kuzey-limon-pencere';

  async function ticketOf(s: Share): Promise<string> {
    const r = await viaTunnel(s, 'GET', `/k/${s.token}`, HTML);
    expect(r.status).toBe(200);
    expect(r.body).toContain('type="password"');
    expect(r.body).toContain('Lansman');
    expect((r.headers['set-cookie'] ?? []).some((l) => l.startsWith('__Host-dcs='))).toBe(false);
    const line = (r.headers['set-cookie'] ?? []).find((l) => l.startsWith('__Host-dct='))!;
    expect(line).toMatch(/; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=300/);
    return line.split(';')[0];
  }

  const login = (s: Share, ticket: string, pw: string, ip = '203.0.113.7', extra: Record<string, string | undefined> = {}) => viaTunnel(s, 'POST', '/__share/login', {
    cookie: ticket, origin: s.origin ?? '', 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip, ...extra,
  }, `p=${encodeURIComponent(pw)}`);

  it('shows only the password page, then lets the right password in', async () => {
    const s = await open(PW);
    const ticket = await ticketOf(s);
    expect((await viaTunnel(s, 'GET', '/', { cookie: ticket })).status).toBe(401);
    const ok = await login(s, ticket, PW);
    expect(ok.status).toBe(200);
    const cookie = sessionCookie(ok);
    expect((await viaTunnel(s, 'GET', '/', { cookie })).body).toBe('guest ok');
    // The ticket is single-use: consumed by the right password.
    expect((await login(s, ticket, PW)).status).toBe(401);
  });

  it('refuses the 6th wrong try from one IP within a minute, even with the right password', async () => {
    const s = await open(PW);
    const ticket = await ticketOf(s);
    for (let i = 0; i < 5; i++) {
      const r = await login(s, ticket, 'yanlis-sifre-123');
      expect(r.status).toBe(401);
      expect(r.body).toContain('Şifre yanlış');
      expect(r.body).not.toContain('yanlis-sifre-123');
    }
    expect((await login(s, ticket, PW)).status).toBe(429);
    // Another IP (Cloudflare's own header) still may: the limiter is keyed on cf-connecting-ip.
    const other = await login(s, ticket, PW, '198.51.100.9');
    expect(other.status).toBe(200);
    // A minute later the first IP may again.
    world.now += 61_000;
    const t2 = await ticketOf(s);
    expect((await login(s, t2, PW)).status).toBe(200);
  });

  it('never keys the limiter on x-forwarded-for and refuses a login without Cloudflare\'s header', async () => {
    const s = await open(PW);
    const ticket = await ticketOf(s);
    for (let i = 0; i < 5; i++) await login(s, ticket, 'yanlis-sifre-123', '203.0.113.7', { 'x-forwarded-for': `10.0.0.${i}` });
    expect((await login(s, ticket, PW, '203.0.113.7', { 'x-forwarded-for': '10.9.9.9' })).status).toBe(429);
    expect((await login(s, ticket, PW, '', { 'cf-connecting-ip': undefined })).status).toBe(400);
  });

  it('needs the share\'s own Origin and a live ticket', async () => {
    const s = await open(PW);
    const ticket = await ticketOf(s);
    expect((await login(s, ticket, PW, '203.0.113.7', { origin: 'https://evil.example' })).status).toBe(401);
    expect((await login(s, ticket, PW, '203.0.113.7', { origin: undefined })).status).toBe(401);
    expect((await login(s, '__Host-dct=' + 'B'.repeat(43), PW)).status).toBe(401);
    // An expired ticket (5 minutes) is dead.
    world.now += 5 * 60_000 + 1;
    expect((await login(s, ticket, PW)).status).toBe(401);
  });

  it('refuses a password shorter than 10 characters', () => {
    expect(() => openShare({ kind: 'board', vault: 'demo', slug: 'short', password: 'kisa' })).toThrow(/at least 10/);
  });
});

describe('the password door under parallel and spread-out guessing (K5)', () => {
  const PW = 'kuzey-limon-pencere';
  const ticketOf = async (s: Share): Promise<string> => {
    const r = await viaTunnel(s, 'GET', `/k/${s.token}`, HTML);
    return (r.headers['set-cookie'] ?? []).find((l) => l.startsWith('__Host-dct='))!.split(';')[0];
  };
  const login = (s: Share, ticket: string, pw: string, ip: string) => viaTunnel(s, 'POST', '/__share/login', {
    cookie: ticket, origin: s.origin ?? '', 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip,
  }, `p=${encodeURIComponent(pw)}`);

  it('serves the password page same-origin so a real browser keeps its Origin on the POST', async () => {
    const s = await open(PW);
    const r = await viaTunnel(s, 'GET', `/k/${s.token}`, HTML);
    expect(r.headers['referrer-policy']).toBe('same-origin');
    expect(r.body).toContain('<meta name="referrer" content="same-origin">');
    // Every other door page stays no-referrer.
    expect((await viaTunnel(s, 'GET', '/__share/closed', HTML)).headers['referrer-policy']).toBe('no-referrer');
    // A browser never sends Origin: null from that page, and the door still refuses one.
    const ticket = await ticketOf(s);
    expect((await viaTunnel(s, 'POST', '/__share/login', { cookie: ticket, origin: 'null', 'cf-connecting-ip': '203.0.113.7' }, `p=${PW}`)).status).toBe(401);
  });

  it('checks at most 5 of 20 parallel wrong posts from one IP against the password', async () => {
    const s = await open(PW);
    const ticket = await ticketOf(s);
    const replies = await Promise.all(Array.from({ length: 20 }, () => login(s, ticket, 'yanlis-sifre-123', '203.0.113.7')));
    expect(replies.filter((r) => r.status === 401).length).toBe(5);
    expect(replies.filter((r) => r.status === 429).length).toBe(15);
  });

  it('counts a whole IPv6 /64 as one address', async () => {
    const s = await open(PW);
    const ticket = await ticketOf(s);
    for (let i = 1; i <= 5; i++) expect((await login(s, ticket, 'yanlis-sifre-123', `2001:db8:1:2::${i.toString(16)}`)).status).toBe(401);
    expect((await login(s, ticket, PW, '2001:0db8:0001:0002:ffff:0:0:9')).status).toBe(429);
    expect((await login(s, ticket, PW, '2001:db8:1:3::1')).status).toBe(200);
  });

  it('caps wrong tries per share per minute whatever the addresses', async () => {
    const s = await open(PW);
    const ticket = await ticketOf(s);
    let ip = 0;
    for (let i = 0; i < SHARE_LOGIN_PER_MINUTE; i++) expect((await login(s, ticket, 'yanlis-sifre-123', `198.51.100.${(ip++ % 200) + 1}`)).status).toBe(401);
    expect((await login(s, ticket, PW, '192.0.2.1')).status).toBe(429);
    world.now += 61_000;
    expect((await login(s, ticket, PW, '192.0.2.1')).status).toBe(200);
  });
});

describe('LoginLimiter', () => {
  it('takes a slot at admission, per key, within the last minute; a refund gives it back', () => {
    const l = new LoginLimiter(5);
    const stamps: number[] = [];
    for (let i = 0; i < 5; i++) stamps.push(l.admit('a', 1000)!);
    expect(stamps.every((t) => t === 1000)).toBe(true);
    expect(l.admit('a', 1000)).toBeNull();
    expect(l.admit('b', 1000)).toBe(1000);
    l.refund('a', stamps[0]);
    expect(l.admit('a', 1000)).toBe(1000);
    expect(l.admit('a', 1000)).toBeNull();
    expect(l.admit('a', 61_001)).toBe(61_001);
  });

  it('keys IPv4 as is, IPv6 by its /64, IPv4-mapped IPv6 as IPv4', () => {
    expect(limiterKey('203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKey('2001:db8:1:2::5')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('::1')).toBe('0:0:0:0::/64');
    expect(limiterKey('::ffff:198.51.100.4')).toBe('198.51.100.4');
  });
});
