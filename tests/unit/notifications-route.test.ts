/**
 * `GET /api/notifications` + `POST /api/notify` (src/server/routes/notifications.ts): the app's
 * own routable banner and the history its Notifications window lists. Driven through the real
 * handlers with an injected home and an injected poster, so no case posts a real banner or
 * reads the developer's real history.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotificationRoutes } from '../../src/server/routes/notifications.js';
import { recordNotification, notificationsLogPath } from '../../src/lib/notification-log.js';

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  return Object.assign(stream, { method, url, headers: {} }) as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; captured: { status: number; body: any } } {
  const captured = { status: 0, body: null as any };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    setHeader() { return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  return { res, captured };
}

let home: string;
let post: ReturnType<typeof vi.fn>;
let routes: ReturnType<typeof createNotificationRoutes>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-notify-route-'));
  post = vi.fn(() => true);
  routes = createNotificationRoutes({ home, post });
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
afterAll(() => { delete process.env.DREAMCONTEXT_DESKTOP; });

describe('desktop gate (the same as POST /api/agent/drop)', () => {
  it('refuses both routes outside the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const a = fakeRes();
    await routes.handleNotificationsGet(fakeReq('GET', '/api/notifications'), a.res);
    expect(a.captured.status).toBe(403);
    expect(a.captured.body.error).toBe('desktop_only');
    const b = fakeRes();
    await routes.handleNotifyPost(fakeReq('POST', '/api/notify', { title: 't', body: 'b' }), b.res);
    expect(b.captured.status).toBe(403);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('GET /api/notifications', () => {
  it('lists the history newest first, honouring ?limit', async () => {
    for (let i = 0; i < 4; i += 1) recordNotification({ title: `t${i}`, body: '', link: 'dreamcontext://inbox' }, home);
    const { res, captured } = fakeRes();
    await routes.handleNotificationsGet(fakeReq('GET', '/api/notifications?limit=2'), res);
    expect(captured.status).toBe(200);
    expect(captured.body.notifications.map((n: { title: string }) => n.title)).toEqual(['t3', 't2']);
    expect(captured.body.notifications[0]).toMatchObject({ link: 'dreamcontext://inbox', file: null });
  });

  it('defaults to 50 and ignores a nonsense limit', async () => {
    for (let i = 0; i < 60; i += 1) recordNotification({ title: `t${i}`, body: '' }, home);
    const a = fakeRes();
    await routes.handleNotificationsGet(fakeReq('GET', '/api/notifications'), a.res);
    expect(a.captured.body.notifications).toHaveLength(50);
    const b = fakeRes();
    await routes.handleNotificationsGet(fakeReq('GET', '/api/notifications?limit=-3'), b.res);
    expect(b.captured.body.notifications).toHaveLength(50);
  });

  it('is an empty list, not an error, before any banner was posted', async () => {
    const { res, captured } = fakeRes();
    await routes.handleNotificationsGet(fakeReq('GET', '/api/notifications'), res);
    expect(captured.body).toEqual({ notifications: [] });
  });
});

describe('POST /api/notify', () => {
  const SESSION_LINK = 'dreamcontext://project/Kitap%20A%C4%9Fac%C4%B1/session/0b1d3c97-6daf-4943-96d5-8614e7d0960e';

  it('posts a routable banner and answers {posted:true}', async () => {
    const { res, captured } = fakeRes();
    await routes.handleNotifyPost(fakeReq('POST', '/api/notify', { title: 'Claude is asking', body: 'Allow Bash?', link: SESSION_LINK, sound: 'Glass' }), res);
    expect(captured).toEqual({ status: 200, body: { posted: true } });
    expect(post).toHaveBeenCalledWith('Claude is asking', 'Allow Bash?', home, { sound: 'Glass', link: SESSION_LINK });
  });

  it('answers {posted:false} when no banner could be posted, the cue to use the Tauri plugin', async () => {
    post.mockReturnValue(false);
    const { res, captured } = fakeRes();
    await routes.handleNotifyPost(fakeReq('POST', '/api/notify', { title: 't', body: 'b' }), res);
    expect(captured).toEqual({ status: 200, body: { posted: false } });
  });

  it('defaults a missing link to the Notifications window', async () => {
    const { res } = fakeRes();
    await routes.handleNotifyPost(fakeReq('POST', '/api/notify', { title: 't', body: 'b' }), res);
    expect(post.mock.calls[0][3]).toEqual({ sound: undefined, link: 'dreamcontext://inbox' });
  });

  it('caps the banner body the way the runner does', async () => {
    const { res } = fakeRes();
    await routes.handleNotifyPost(fakeReq('POST', '/api/notify', { title: 't', body: 'x'.repeat(500) }), res);
    const body = post.mock.calls[0][1] as string;
    expect(body.length).toBeLessThanOrEqual(240);
    expect(body.endsWith('…')).toBe(true);
  });

  const refusals: Array<[string, unknown]> = [
    ['no body at all', undefined],
    ['non-JSON', 'not json'],
    ['a missing title', { body: 'b' }],
    ['a blank title', { title: '   ', body: 'b' }],
    ['a non-string body', { title: 't', body: 3 }],
    ['an invalid link', { title: 't', body: 'b', link: 'dreamcontext://project/../session/x' }],
    ['a foreign scheme', { title: 't', body: 'b', link: 'https://example.com' }],
    ['a sound that is not a sound name', { title: 't', body: 'b', sound: '../../x; rm' }],
  ];
  for (const [name, payload] of refusals) {
    it(`400s on ${name} and posts nothing`, async () => {
      const { res, captured } = fakeRes();
      await routes.handleNotifyPost(fakeReq('POST', '/api/notify', payload), res);
      expect(captured.status).toBe(400);
      expect(captured.body.error).toBe('invalid_notification');
      expect(post).not.toHaveBeenCalled();
    });
  }

  it('never builds the applet: the default poster refuses when it is absent', async () => {
    const real = createNotificationRoutes({ home });
    const { res, captured } = fakeRes();
    await real.handleNotifyPost(fakeReq('POST', '/api/notify', { title: 't', body: 'b' }), res);
    expect(captured.body).toEqual({ posted: false });
    expect(() => readFileSync(notificationsLogPath(home))).toThrow();
  });
});

describe('router registration', () => {
  it('registers both routes as vault-agnostic', () => {
    const index = readFileSync(join(__dirname, '../../src/server/index.ts'), 'utf-8');
    expect(index).toContain("router.get('/api/notifications', handleNotificationsGet)");
    expect(index).toContain("router.post('/api/notify', handleNotifyPost)");
    const list = index.match(/const VAULT_AGNOSTIC_PREFIXES = \[[^\]]*\]/)![0];
    expect(list).toContain("'/api/notifications'");
    expect(list).toContain("'/api/notify'");
  });
});
