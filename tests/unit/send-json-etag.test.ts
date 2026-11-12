import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../src/server/middleware.js';

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string | number>, body: '' as string | undefined };
  const res = {
    writeHead(s: number, h: Record<string, string | number>) { out.status = s; out.headers = h; },
    end(b?: string) { out.body = b; },
  } as unknown as ServerResponse;
  return { res, out };
}
const req = (method: string, inm?: string) => ({ method, headers: inm ? { 'if-none-match': inm } : {} }) as unknown as IncomingMessage;

describe('sendJson weak ETag', () => {
  it('adds a weak ETag to a GET 200 and answers 304 with no body on a match', () => {
    const a = fakeRes();
    sendJson(a.res, 200, { x: 1 }, req('GET'));
    const etag = String(a.out.headers.ETag);
    expect(etag).toMatch(/^W\/".+"$/);
    expect(a.out.status).toBe(200);
    expect(a.out.body).toBe('{"x":1}');

    const b = fakeRes();
    sendJson(b.res, 200, { x: 1 }, req('GET', etag));
    expect(b.out.status).toBe(304);
    expect(b.out.body).toBeUndefined();
  });

  it('re-sends the body when the data changed, and ignores non-GET and errors', () => {
    const a = fakeRes();
    sendJson(a.res, 200, { x: 1 }, req('GET'));
    const etag = String(a.out.headers.ETag);
    const b = fakeRes();
    sendJson(b.res, 200, { x: 2 }, req('GET', etag));
    expect(b.out.status).toBe(200);
    const c = fakeRes();
    sendJson(c.res, 200, { x: 1 }, req('POST', etag));
    expect(c.out.status).toBe(200);
    expect(c.out.headers.ETag).toBeUndefined();
    const d = fakeRes();
    sendJson(d.res, 404, { x: 1 }, req('GET', etag));
    expect(d.out.status).toBe(404);
  });

  it('plain call without req keeps the old response', () => {
    const a = fakeRes();
    sendJson(a.res, 200, { x: 1 });
    expect(a.out.headers.ETag).toBeUndefined();
  });
});
