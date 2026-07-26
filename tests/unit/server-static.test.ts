import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveStatic, cacheControlFor } from '../../src/server/static.js';

let staticDir: string;

/** 16 bytes standing in for a clip — the server streams bytes, it never decodes them. */
const CLIP_BYTES = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

beforeAll(() => {
  staticDir = mkdtempSync(join(tmpdir(), 'dc-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'index-CURRENT.js'), 'export const x = 1;');
  mkdirSync(join(staticDir, 'announcements', 'clips', 'v0-22-0'), { recursive: true });
  writeFileSync(join(staticDir, 'announcements', 'clips', 'v0-22-0', 'demo.mp4'), CLIP_BYTES);
});

afterAll(() => {
  rmSync(staticDir, { recursive: true, force: true });
});

/** Minimal req/res doubles that capture what serveStatic writes. */
function run(url: string, accept = '*/*') {
  const req = {
    url,
    method: 'GET',
    headers: { host: 'localhost:4173', accept },
  } as unknown as IncomingMessage;

  const captured: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body?: Buffer | string) {
      captured.body = body == null ? '' : body.toString();
    },
  } as unknown as ServerResponse;

  serveStatic(req, res, staticDir);
  return captured;
}

/**
 * Media takes the STREAMING path, so the doubles above (which only capture a
 * single `end()`) can't observe it — a real writable is needed for `pipe`.
 */
async function runMedia(url: string, range?: string) {
  const req = {
    url,
    method: 'GET',
    headers: { host: 'localhost:4173', accept: '*/*', ...(range ? { range } : {}) },
  } as unknown as IncomingMessage;

  const captured: { status?: number; headers?: Record<string, unknown> } = {};
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const finished = new Promise<void>((resolve) => sink.once('finish', () => resolve()));

  const res = Object.assign(sink, {
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
  }) as unknown as ServerResponse;

  serveStatic(req, res, staticDir);
  await finished;
  return { ...captured, body: Buffer.concat(chunks), header: (k: string) => captured.headers?.[k] };
}

describe('serveStatic — SPA fallback vs missing-asset MIME bug', () => {
  it('serves an existing hashed JS chunk with a JS MIME type', () => {
    const r = run('/assets/index-CURRENT.js');
    expect(r.status).toBe(200);
    expect(String(r.headers?.['Content-Type'])).toMatch(/javascript/);
  });

  it('serves index.html (text/html) for a navigation request to an SPA route', () => {
    const r = run('/knowledge/some-slug', 'text/html,application/xhtml+xml');
    expect(r.status).toBe(200);
    expect(String(r.headers?.['Content-Type'])).toMatch(/text\/html/);
    expect(r.body).toContain('<title>app</title>');
  });

  // Root cause regression: a stale document / lazy import() requests a hashed
  // chunk from a previous build that no longer exists. This MUST 404 — never
  // fall back to index.html, which would return HTML under a module <script>
  // request and trip "'text/html' is not a valid JavaScript MIME type".
  it('404s a missing JS chunk instead of returning HTML (the reported bug)', () => {
    const r = run('/assets/index-STALEHASH.js', '*/*');
    expect(r.status).toBe(404);
    expect(String(r.headers?.['Content-Type'])).not.toMatch(/text\/html/);
  });

  it('404s a missing CSS asset instead of returning HTML', () => {
    const r = run('/assets/index-STALEHASH.css', '*/*');
    expect(r.status).toBe(404);
    expect(String(r.headers?.['Content-Type'])).not.toMatch(/text\/html/);
  });

  it('serves index.html for an extensionless deep link even without an Accept header', () => {
    const r = run('/tasks', '');
    expect(r.status).toBe(200);
    expect(String(r.headers?.['Content-Type'])).toMatch(/text\/html/);
  });
});

// Root cause regression: announcements are HAND-AUTHORED between releases, so
// the manifest, its stories and their screenshots change bytes while keeping the
// same URL. Serving them `immutable` pinned the pre-authoring copy in the browser
// for a year — a new announcement stayed invisible until the next version bump,
// even across a hard reload (an immutable response is never revalidated).
describe('serveStatic — cache-control for authored content vs hashed assets', () => {
  it('keeps immutable caching for content-hashed build assets', () => {
    expect(cacheControlFor('/assets/index-CURRENT.js', '.js')).toMatch(/immutable/);
    const r = run('/assets/index-CURRENT.js');
    expect(String(r.headers?.['Cache-Control'])).toMatch(/immutable/);
  });

  it('never caches the announcements manifest as immutable', () => {
    expect(cacheControlFor('/announcements.json', '.json')).toBe('no-cache');
  });

  it('never caches an announcement story as immutable', () => {
    expect(cacheControlFor('/announcements/v0-22-0.json', '.json')).toBe('no-cache');
  });

  // Re-shooting a screenshot keeps its filename — the shot is not content-hashed,
  // so pinning it immutable would show the old picture next to the new copy.
  it('never caches an announcement screenshot as immutable', () => {
    expect(cacheControlFor('/announcements/shots/v0-22-0/chat.png', '.png')).toBe('no-cache');
  });

  it('still serves index.html with no-cache', () => {
    expect(cacheControlFor('/index.html', '.html')).toBe('no-cache');
  });

  it('does not treat a lookalike path outside the announcements root as authored content', () => {
    expect(cacheControlFor('/assets/announcements-CURRENT.js', '.js')).toMatch(/immutable/);
  });
});

/**
 * Announcement clips are `<video>` sources. A video element seeks by issuing
 * Range requests, and a server that answers 200-with-everything leaves the clip
 * unseekable — WKWebView, which is what the desktop app renders in, refuses to
 * play it at all. Served as `application/octet-stream` it doesn't play either.
 * Both failures are silent in the UI (a dead player, no console error, no
 * network error), so these lock the contract the clip renderer depends on.
 */
describe('serveStatic — video is streamed with byte ranges', () => {
  const url = '/announcements/clips/v0-22-0/demo.mp4';

  it('serves a clip as video/mp4 and advertises range support', async () => {
    const r = await runMedia(url);
    expect(r.status).toBe(200);
    expect(r.header('Content-Type')).toBe('video/mp4');
    expect(r.header('Accept-Ranges')).toBe('bytes');
    expect(r.header('Content-Length')).toBe(CLIP_BYTES.length);
    expect(r.body).toEqual(CLIP_BYTES);
  });

  it('answers a range with 206 + Content-Range, and only those bytes', async () => {
    const r = await runMedia(url, 'bytes=4-7');
    expect(r.status).toBe(206);
    expect(r.header('Content-Range')).toBe('bytes 4-7/16');
    expect(r.header('Content-Length')).toBe(4);
    expect([...r.body]).toEqual([4, 5, 6, 7]);
  });

  it('416s a range that starts past the end, reporting the real size', async () => {
    const r = await runMedia(url, 'bytes=99-200');
    expect(r.status).toBe(416);
    expect(r.header('Content-Range')).toBe('bytes */16');
  });

  it('keeps a re-recorded clip revalidating rather than pinned for a year', async () => {
    const r = await runMedia(url);
    expect(r.header('Cache-Control')).toBe('no-cache');
  });
});
