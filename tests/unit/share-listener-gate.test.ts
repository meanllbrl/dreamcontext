// Live links, the share surface (plan C1): no request or upgrade on a share socket reaches a
// dashboard handler, whatever its path, with or without a guest session, for both kinds; and a
// share socket is never loopback to any trust check, although cloudflared dials it from 127.0.0.1.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { buildRouter } from '../../src/server/index.js';
import { Router } from '../../src/server/router.js';
import { closeAllShares, openShare, type Share } from '../../src/server/shares/registry.js';
import { isLoopback } from '../../src/server/routes/agent-spawn-shared.js';
import { isLoopbackPeer } from '../../src/server/network-auth.js';
import { isAgentRequest } from '../../src/server/desktop.js';
import { isShareSocket, isPhoneSocket, isTunnelSocket, markShareSocket } from '../../src/server/phone-origin.js';
import { fakeKind, fakeWorld, openAndWait, sessionCookie, upgradeViaTunnel, viaTunnel } from './share-fixture.js';

const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;
let routes: Array<{ method: string; path: string }>;
const shares: Record<'app' | 'board', Share | null> = { app: null, board: null };
const cookies: Record<'app' | 'board', string> = { app: '', board: '' };

beforeAll(async () => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  routes = buildRouter().list();
  fakeWorld();
  fakeKind('app');
  fakeKind('board');
  for (const k of ['app', 'board'] as const) {
    shares[k] = await openAndWait(() => openShare({ kind: k, vault: 'demo', slug: `gate-${k}` }).share);
    cookies[k] = sessionCookie(await viaTunnel(shares[k]!, 'GET', `/k/${shares[k]!.token}`, { accept: 'text/html' }));
  }
});
afterAll(async () => {
  await closeAllShares('shutdown');
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
});

const concrete = (p: string): string => p.replace(/:[A-Za-z_]+/g, 'x').replace(/\*[A-Za-z_]*/g, 'x');

describe('C1: the share listener never dispatches to the dashboard', () => {
  it('walks every registered dashboard route, both kinds, with and without a session: the router is never asked', async () => {
    const match = vi.spyOn(Router.prototype, 'match');
    try {
      expect(routes.length).toBeGreaterThan(300);
      for (const k of ['app', 'board'] as const) {
        const s = shares[k]!;
        for (const r of routes) {
          const path = concrete(r.path);
          for (const cookie of [undefined, cookies[k]]) {
            const body = r.method === 'GET' || r.method === 'HEAD' ? undefined : '{}';
            const reply = await viaTunnel(s, r.method, path, { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', origin: s.origin ?? '' }, body);
            // With a session the kind handler answers (an app's own `/api/*` is ITS backend);
            // without one the door's page. Never the dashboard.
            if (cookie) expect(reply.body).toBe('guest ok'); else expect(reply.status).toBe(401);
            expect(reply.body).not.toMatch(/"version"\s*:/);
          }
        }
      }
      expect(match).not.toHaveBeenCalled();
    } finally {
      match.mockRestore();
    }
  }, 120_000);

  it('every upgrade path the dashboard accepts is the kind\'s or refused, never the dashboard\'s', async () => {
    const match = vi.spyOn(Router.prototype, 'match');
    try {
      for (const k of ['app', 'board'] as const) {
        const s = shares[k]!;
        for (const path of ['/api/agent/chat', '/api/agent/terminal', '/api/agent/run-terminal', '/api/assistant/ws', '/api/browser-mirror', '/ws']) {
          const noSession = await upgradeViaTunnel(s, path, {});
          expect(noSession.status).toBe(401);
          noSession.sock.destroy();
          const foreign = await upgradeViaTunnel(s, path, { cookie: cookies[k], origin: 'https://evil.example' });
          expect(foreign.status).toBe(403);
          foreign.sock.destroy();
          const ok = await upgradeViaTunnel(s, path, { cookie: cookies[k] });
          expect(ok.status).toBe(101); // the fake kind's own upgrade (an app's backend WS)
          ok.sock.destroy();
        }
      }
      expect(match).not.toHaveBeenCalled();
    } finally {
      match.mockRestore();
    }
  });

  it('the listener module imports nothing of the dashboard dispatch', () => {
    const src = readFileSync(join(__dirname, '../../src/server/shares/listener.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n');
    expect(imports).not.toMatch(/'\.\.\/index\.js'|'\.\.\/router\.js'|'\.\.\/routes\//);
    expect(src).not.toMatch(/makeRequestHandler\(|buildRouter\(|\.match\(/);
  });
});

describe('C1: a share socket is never loopback', () => {
  const sock = { remoteAddress: '127.0.0.1' };
  const req = { socket: sock, headers: { host: '127.0.0.1:4173', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4173' } } as unknown as IncomingMessage;

  it('isLoopback, isLoopbackPeer and isAgentRequest refuse it; it is not a phone socket', () => {
    expect(isLoopback(req)).toBe(true);
    markShareSocket(sock);
    expect(isShareSocket(req)).toBe(true);
    expect(isTunnelSocket(req)).toBe(true);
    expect(isPhoneSocket(req)).toBe(false);
    expect(isLoopback(req)).toBe(false);
    expect(isLoopbackPeer(req)).toBe(false);
    expect(isAgentRequest(req)).toBe(false);
  });
});
