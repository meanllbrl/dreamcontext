import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveStatic, cacheControlFor } from '../../src/server/static.js';

let staticDir: string;

beforeAll(() => {
  staticDir = mkdtempSync(join(tmpdir(), 'dc-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'index-CURRENT.js'), 'export const x = 1;');
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
// the manifest and its boards change bytes while keeping the same URL. Serving
// them `immutable` pinned the pre-authoring copy in the browser for a year — a
// new announcement stayed invisible until the next version bump, even across a
// hard reload (an immutable response is never revalidated).
describe('serveStatic — cache-control for authored content vs hashed assets', () => {
  it('keeps immutable caching for content-hashed build assets', () => {
    expect(cacheControlFor('/assets/index-CURRENT.js', '.js')).toMatch(/immutable/);
    const r = run('/assets/index-CURRENT.js');
    expect(String(r.headers?.['Cache-Control'])).toMatch(/immutable/);
  });

  it('never caches the announcements manifest as immutable', () => {
    expect(cacheControlFor('/announcements.json', '.json')).toBe('no-cache');
  });

  it('never caches an announcement board as immutable', () => {
    expect(cacheControlFor('/announcements/native-agent-chat.excalidraw.md', '.md')).toBe('no-cache');
  });

  it('still serves index.html with no-cache', () => {
    expect(cacheControlFor('/index.html', '.html')).toBe('no-cache');
  });

  it('does not treat a lookalike path outside the announcements root as authored content', () => {
    expect(cacheControlFor('/assets/announcements-CURRENT.js', '.js')).toMatch(/immutable/);
  });
});
