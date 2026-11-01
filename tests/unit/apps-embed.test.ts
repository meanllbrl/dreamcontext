import { describe, it, expect, afterEach, vi } from 'vitest';
import { dropEmbedToken, embedFrameGrant, mintEmbedToken, resolveEmbedToken } from '../../src/server/apps/embed-token.js';
import { refuseForeignFrame } from '../../src/server/middleware.js';
import { checkEmbedFrame, embedGrant, embedSocketAllowed, embedWriteAllowed, lockEmbedWrites } from '../../dashboard/src/lib/frameGuard';
import { PAGE_ROUTES, deniedForEveryone } from '../../src/lib/apps/page-routes.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';

/**
 * Embedding a dreamcontext screen in an app's window (dreamcontext-apps plan r19, W4): the token,
 * the one exception to the frame gate, and the page's own check before it draws.
 */

const grant = { slug: 'meta-ads', vault: 'acme', projectRoot: '/p/acme', gwPort: 5100 };
afterEach(() => { dropEmbedToken(5100); dropEmbedToken(5200); });

const frameReq = (tk: string, over: Record<string, unknown> = {}) => ({
  method: 'GET',
  url: `/?embed=tasks&vault=acme&tk=${tk}`,
  headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' },
  ...over,
});
function res() {
  const headers: Record<string, string> = {};
  let status = 0;
  return {
    headers, status: () => status,
    setHeader(k: string, v: string) { headers[k] = v; },
    writeHead(c: number) { status = c; },
    end() {},
    writableEnded: false,
  };
}

describe('the token', () => {
  it('is one per gateway port and dies with it', () => {
    const tk = mintEmbedToken(grant);
    expect(mintEmbedToken(grant)).toBe(tk);
    expect(mintEmbedToken({ ...grant, gwPort: 5200 })).not.toBe(tk);
    expect(resolveEmbedToken(tk)).toMatchObject({ slug: 'meta-ads', gwPort: 5100 });
    dropEmbedToken(5100);
    expect(resolveEmbedToken(tk)).toBeNull();
    expect(resolveEmbedToken(undefined)).toBeNull();
    expect(resolveEmbedToken('x'.repeat(43))).toBeNull();
  });
});

describe('the frame gate', () => {
  it('lets the app window in, and names that window as the only parent', () => {
    const tk = mintEmbedToken(grant);
    const r = res();
    expect(refuseForeignFrame(frameReq(tk) as never, r as never)).toBe(false);
    expect(r.headers['Content-Security-Policy']).toBe('frame-ancestors http://127.0.0.1:5100');
  });

  // Each of these holds a valid token and still gets 403.
  it.each([
    ['a cross-site parent', { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' } }],
    ['no site header', { headers: { 'sec-fetch-dest': 'iframe' } }],
    ['an object tag', { headers: { 'sec-fetch-dest': 'object', 'sec-fetch-site': 'same-site' } }],
    ['a POST', { method: 'POST' }],
  ])('refuses %s', (_name, over) => {
    const r = res();
    expect(refuseForeignFrame(frameReq(mintEmbedToken(grant), over) as never, r as never)).toBe(true);
    expect(r.status()).toBe(403);
  });

  it('refuses another vault, another path, no token, a dead token', () => {
    const tk = mintEmbedToken(grant);
    expect(embedFrameGrant(frameReq(tk, { url: `/?embed=tasks&vault=other&tk=${tk}` }) as never)).toBeNull();
    expect(embedFrameGrant(frameReq(tk, { url: `/assets/x.js?embed=tasks&vault=acme&tk=${tk}` }) as never)).toBeNull();
    expect(embedFrameGrant(frameReq(tk, { url: '/?embed=tasks&vault=acme' }) as never)).toBeNull();
    dropEmbedToken(5100);
    expect(embedFrameGrant(frameReq(tk) as never)).toBeNull();
  });

  it('a frame with no token is refused as before (mutation: the exception must key on the grant)', () => {
    const r = res();
    expect(refuseForeignFrame({ method: 'GET', url: '/', headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' } } as never, r as never)).toBe(true);
    expect(r.headers['Content-Security-Policy']).toBeUndefined();
  });
});

describe('the page check', () => {
  function win(search: string) {
    const replaced: string[] = [];
    return {
      replaced,
      w: {
        location: { search, href: `http://127.0.0.1:4173/${search}` },
        localStorage: { setItem: vi.fn() },
        fetch: vi.fn(async () => new Response('{}')),
        history: { state: null, replaceState: (_s: unknown, _t: string, u: string) => { replaced.push(u); } },
      } as unknown as Window,
    };
  }

  it('asks the server first, then takes the token off the URL', async () => {
    const { w, replaced } = win('?embed=chat&vault=acme&tk=abc&member=ua');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ slug: 'meta-ads', vault: 'acme' }))) as never;
    expect(await checkEmbedFrame(w, fetchImpl)).toBe(true);
    expect(embedGrant()).toMatchObject({ view: 'chat', slug: 'meta-ads', member: 'ua' });
    expect(replaced[0]).not.toContain('tk=');
  });

  it('a refusal, a wrong vault or a network error draws nothing', async () => {
    const { w } = win('?embed=chat&vault=acme&tk=abc');
    expect(await checkEmbedFrame(w, (async () => new Response('', { status: 403 })) as never)).toBe(false);
    expect(await checkEmbedFrame(w, (async () => new Response(JSON.stringify({ slug: 'x', vault: 'other' }))) as never)).toBe(false);
    expect(await checkEmbedFrame(w, (async () => { throw new Error('down'); }) as never)).toBe(false);
    expect(await checkEmbedFrame(win('?embed=chat').w, vi.fn() as never)).toBe(false);
  });

  it('in the frame every write is refused before it leaves, but the chat send and every read go out', async () => {
    const base = 'http://127.0.0.1:4173/?embed=tasks';
    expect(embedWriteAllowed('GET', '/api/tasks', base, 'meta-ads')).toBe(true);
    expect(embedWriteAllowed('POST', '/api/apps/meta-ads/say', base, 'meta-ads')).toBe(true);
    for (const [m, u] of [['POST', '/api/apps/other/say'], ['PATCH', '/api/tasks/x'], ['DELETE', '/api/tasks/x'], ['POST', '/api/agents/sync/confirm'], ['PUT', '/api/objectives/o'], ['POST', 'http://127.0.0.1:4173/api/apps/meta-ads/say/../../tasks']]) {
      expect(embedWriteAllowed(m, u, base, 'meta-ads'), `${m} ${u}`).toBe(false);
    }
    const real = vi.fn(async () => new Response('{}'));
    class FakeXhr { method = ''; open(m: string) { this.method = m; } send() { return 'sent'; } }
    const w = { location: { href: base }, fetch: real, XMLHttpRequest: FakeXhr } as unknown as Window;
    lockEmbedWrites(w, 'meta-ads');
    await expect(w.fetch('/api/tasks/x', { method: 'PATCH', body: '{}' })).rejects.toThrow(/main app/);
    await w.fetch('/api/tasks');
    await w.fetch('/api/apps/meta-ads/say', { method: 'POST', body: '{}' });
    expect(real).toHaveBeenCalledTimes(2);
    const x = new (w as unknown as { XMLHttpRequest: new () => XMLHttpRequest }).XMLHttpRequest();
    x.open('POST', '/api/tasks/x/assets');
    expect(() => x.send(null)).toThrow(/main app/);
  });
});

describe('what a page can reach', () => {
  it('neither embed route is open to a page or a phone', () => {
    expect(PAGE_ROUTES.some((r) => r.includes('/api/apps/'))).toBe(false);
    expect(deniedForEveryone('/api/apps/meta/say')).toBe(true);
    expect(ROUTE_POLICY['POST /api/apps/embed-check'].allow).toBe(false);
    expect(ROUTE_POLICY['POST /api/apps/:slug/say'].allow).toBe(false);
  });
});

describe('the frame locks what leaves it (plan r9, D12)', () => {
  const base = 'http://127.0.0.1:9/';
  it('allows its list and nothing else', () => {
    for (const p of ['/api/apps/yuk/say', '/api/apps/yuk/chats/close', '/api/apps/yuk/chats/title', '/api/apps/embed-check', '/api/agent/drop']) {
      expect(embedWriteAllowed('POST', p, base, 'yuk'), p).toBe(true);
    }
    for (const p of ['/api/apps/other/chats/close', '/api/agent/grant', '/api/tasks', '/api/agent/accounts/relogin', '/api/agent/secret']) {
      expect(embedWriteAllowed('POST', p, base, 'yuk'), p).toBe(false);
    }
    expect(embedWriteAllowed('DELETE', '/api/apps/yuk/chats/close', base, 'yuk')).toBe(false);
  });
  it('a socket only through its own app gate', () => {
    expect(embedSocketAllowed('ws://127.0.0.1:9/api/agent/chat?app=yuk&tk=T&vault=v', base, 'yuk', 'T')).toBe(true);
    expect(embedSocketAllowed('ws://127.0.0.1:9/api/agent/chat?vault=v', base, 'yuk', 'T')).toBe(false);
    expect(embedSocketAllowed('ws://127.0.0.1:9/api/agent/chat?app=other&tk=T', base, 'yuk', 'T')).toBe(false);
    expect(embedSocketAllowed('ws://127.0.0.1:9/api/agent/terminal?app=yuk&tk=T', base, 'yuk', 'T')).toBe(false);
  });
  it('a non-app WebSocket throws', () => {
    class FakeWS { constructor(public url: string) {} }
    const win = { location: { href: base }, fetch: async () => new Response(''), WebSocket: FakeWS } as unknown as Window;
    lockEmbedWrites(win, 'yuk', 'T');
    const W = (win as unknown as { WebSocket: new (u: string) => unknown }).WebSocket;
    expect(() => new W('ws://127.0.0.1:9/api/agent/terminal')).toThrow();
    expect(() => new W('ws://127.0.0.1:9/api/agent/chat?app=yuk&tk=T')).not.toThrow();
  });
});
