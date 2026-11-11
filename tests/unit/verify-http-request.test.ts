/**
 * scripts/verify/lib/http.mjs: a verify script's call after a `spawnSync` CLI step must never go
 * out on a pooled keep-alive socket.
 *
 * The 0.41.15 cut saw `POST /api/apps/:slug/data-share` "reset" in app-data-notice.mjs and
 * verify-app-data-share.mjs. The route answered 403 fine; the script's `fetch` sent the POST on a
 * socket the dashboard's Vite dev server had closed while spawnSync blocked the loop (reproduced
 * 5/5 in the real run, 4/4 against a bare Vite). A POST is not retried, so the script read
 * ECONNRESET. The guard is that each call opens its own connection and asks it closed (a pooled
 * `fetch` reuses one): the server here counts connections and reads the header.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http, { type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
// @ts-expect-error a plain .mjs verify helper, no types
import { request } from '../../scripts/verify/lib/http.mjs';

let server: Server;
let base: string;
let connections = 0;
const connectionHeaders: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    connectionHeaders.push(String(req.headers.connection ?? ''));
    req.resume();
    req.on('end', () => {
      const post = req.method === 'POST';
      res.writeHead(post ? 403 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(post ? { error: 'owner_page_only' } : { ok: true }));
    });
  });
  server.on('connection', () => { connections++; });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

describe('verify lib request(): its own connection per call', () => {
  it('request(): every call a new connection that closes, the refusal read with its reason', async () => {
    connections = 0;
    connectionHeaders.length = 0;
    expect((await request(`${base}/api/health`)).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const r = await request(`${base}/api/apps/rakip/data-share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { approve: ['cache/'] } });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'owner_page_only' });
      expect(r.text).toBe('{"error":"owner_page_only"}');
    }
    expect(connections).toBe(4);
    expect(connectionHeaders).toEqual(['close', 'close', 'close', 'close']);
  });

  it('a transport failure rejects with its code', async () => {
    const closed = createNetServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as { port: number }).port;
    await new Promise((r) => closed.close(r));
    await expect(request(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
