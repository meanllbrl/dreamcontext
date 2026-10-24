/**
 * Task attachments over a real socket (AC12, AC13), against a scratch vault:
 * the REAL `buildRouter()` (registration + order) behind the REAL global `isCrossSiteWrite`.
 *
 *   POST /api/tasks/:slug/assets?name=   → 201, streamed; 413 at the cap with no file left
 *   GET  /api/tasks/:slug/assets          → the listing
 *   GET  /api/tasks/:slug/assets/raw      → Range 206
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter } from '../../src/server/index.js';
import { handleCors, isCrossSiteWrite, sendError } from '../../src/server/middleware.js';
import { TASK_ASSET_LIMITS } from '../../src/lib/task-assets.js';

let tmp: string;
let root: string;
let server: Server;
let port: number;

interface Reply { status: number; body: any; raw: Buffer; headers: Record<string, string | string[] | undefined> }

/** `chunks` streams the body chunked (no Content-Length), so the server's streaming cap is what stops it. */
function call(
  method: string,
  path: string,
  opts: { raw?: Buffer; chunks?: Buffer[]; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(opts.raw ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(opts.raw.length) } : {}),
        ...(opts.chunks ? { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } : {}),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body: unknown = raw.toString('utf-8');
        try { body = JSON.parse(raw.toString('utf-8')); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers });
      });
    });
    // The server may drop the socket after answering a refused upload mid-stream.
    req.on('error', (err) => { if (!(err as NodeJS.ErrnoException).code?.startsWith('EPIPE') && (err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err); });
    if (opts.raw) req.write(opts.raw);
    if (opts.chunks) for (const c of opts.chunks) req.write(c);
    req.end();
  });
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dc-task-assets-api-')));
  root = join(tmp, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'demo.md'), '---\nname: Demo\nstatus: todo\n---\n## Why\nx\n', 'utf-8');

  const router = buildRouter();
  server = createServer(async (req, res) => {
    try {
      if (handleCors(req, res)) return;
      if (isCrossSiteWrite(req)) { sendError(res, 403, 'forbidden', 'Cross-site request blocked.'); return; }
      const url = new URL(req.url || '/', 'http://localhost');
      const match = router.match(req.method || 'GET', url.pathname);
      if (!match) { sendError(res, 404, 'not_found', `No route: ${req.method} ${url.pathname}`); return; }
      await match.handler(req, res, match.params, root);
    } catch (err) {
      sendError(res, 500, 'internal_error', String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  TASK_ASSET_LIMITS.capBytes = 100 * 1024 * 1024;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

const dir = () => join(root, 'state', 'assets', 'demo');

describe('task assets API', () => {
  it('uploads, lists, and serves with Range', async () => {
    const bytes = Buffer.alloc(4096, 3);
    const up = await call('POST', '/api/tasks/demo/assets?name=clip.mp4', { raw: bytes });
    expect(up.status).toBe(201);
    expect(up.body).toEqual({ name: 'clip.mp4', size: 4096 });
    expect(readFileSync(join(dir(), 'clip.mp4')).equals(bytes)).toBe(true);

    const list = await call('GET', '/api/tasks/demo/assets');
    expect(list.status).toBe(200);
    expect(list.body.entries).toEqual([{ name: 'clip.mp4', path: 'clip.mp4', kind: 'video', size: 4096 }]);

    const ranged = await call('GET', '/api/tasks/demo/assets/raw?path=clip.mp4', { headers: { Range: 'bytes=100-199' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe('bytes 100-199/4096');
    expect(ranged.headers['x-content-type-options']).toBe('nosniff');
    expect(ranged.raw.length).toBe(100);

    const tasks = await call('GET', '/api/tasks');
    expect(tasks.body.tasks[0].attachments).toEqual({ count: 1, cover: null });
  });

  it('413 at the streaming cap, with no file left behind', async () => {
    TASK_ASSET_LIMITS.capBytes = 64 * 1024;
    const r = await call('POST', '/api/tasks/demo/assets?name=big.bin', { chunks: Array.from({ length: 8 }, () => Buffer.alloc(16 * 1024, 1)) });
    TASK_ASSET_LIMITS.capBytes = 100 * 1024 * 1024;
    expect(r.status).toBe(413);
    await new Promise((res) => setTimeout(res, 50));
    expect(existsSync(join(dir(), 'big.bin'))).toBe(false);
    expect(readdirSync(dir()).filter((n) => n.startsWith('.upload-'))).toEqual([]);
  });

  it('413 from Content-Length before reading', async () => {
    TASK_ASSET_LIMITS.capBytes = 1024;
    const r = await call('POST', '/api/tasks/demo/assets?name=big2.bin', { raw: Buffer.alloc(2048) });
    TASK_ASSET_LIMITS.capBytes = 100 * 1024 * 1024;
    expect(r.status).toBe(413);
    expect(existsSync(join(dir(), 'big2.bin'))).toBe(false);
  });

  it('refuses a cross-site Origin', async () => {
    const r = await call('POST', '/api/tasks/demo/assets?name=evil.png', {
      raw: Buffer.from('x'),
      headers: { Origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
    expect(existsSync(join(dir(), 'evil.png'))).toBe(false);
  });
});
