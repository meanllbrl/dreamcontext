/**
 * The whiteboard HTTP routes (Lane C) over a real socket, against a scratch vault.
 *
 *   GET    /api/whiteboards              → { whiteboards[] }
 *   POST   /api/whiteboards              → 201 { slug, name, description, rev }
 *   GET    /api/whiteboards/:slug        → { slug, name, description, elements, rev } | 422
 *   GET    /api/whiteboards/:slug/rev    → { rev }
 *   PUT    /api/whiteboards/:slug        → { rev, elements? }   (D11)
 *   DELETE /api/whiteboards/:slug        → board folder moved to whiteboards/.trash/
 *
 * The server here is the production pipeline minus the dashboard shell: the REAL
 * `buildRouter()` (so the registration and its order are what is tested) behind the REAL
 * global `isCrossSiteWrite`. Requests go through `node:http` so `Host` and `Origin` can be
 * set exactly as a browser would send them. "The CLI" writing concurrently is the lib's own
 * `mutateWhiteboard` — the one write path the CLI goes through.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter } from '../../src/server/index.js';
import { handleCors, isCrossSiteWrite, sendError } from '../../src/server/middleware.js';
import { createWhiteboard, mutateWhiteboard, nextIndices, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { makeWidgetElement, type WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';
import { WHITEBOARD_MAX_BODY_BYTES } from '../../src/lib/whiteboards/validate.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

let tmp: string;
let root: string;
let server: Server;
let port: number;

interface Reply { status: number; body: any; raw: Buffer; headers: Record<string, string | string[] | undefined> }

function call(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf-8');
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const boardFile = (slug: string) => join(root, 'whiteboards', slug, `${slug}.excalidraw.md`);

function snap(slug: string): { bytes: string; mtimeMs: number } {
  const f = boardFile(slug);
  return { bytes: readFileSync(f, 'utf-8'), mtimeMs: statSync(f).mtimeMs };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rect(id: string, index: string, version = 1, versionNonce = 1000): WhiteboardElement {
  return {
    id, type: 'rectangle', x: 0, y: 0, width: 100, height: 60, angle: 0,
    version, versionNonce, index, isDeleted: false, groupIds: [], boundElements: null,
  };
}

function webWidget(url: string): WhiteboardElement {
  return makeWidgetElement('web', { url, title: 'Site' }, { x: 0, y: 0 }, 'a5');
}

/** A CLI-side write: exactly what `dreamcontext whiteboard add … note` does through the store. */
async function cliAddNote(slug: string, markdown: string): Promise<WhiteboardElement> {
  let added!: WhiteboardElement;
  await mutateWhiteboard(root, slug, (board) => {
    const [index] = nextIndices(board.elements, 1);
    added = makeWidgetElement('note', { markdown }, { x: 400, y: 0 }, index);
    board.elements.push(added);
  });
  return added;
}

let n = 0;
/** A fresh board per test, so one test's state never leaks into another. */
function freshBoard(): string {
  return createWhiteboard(root, `Board ${++n}`).slug;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-api-')));
  root = join(tmp, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });

  const router = buildRouter();
  server = createServer(async (req, res) => {
    try {
      if (handleCors(req, res)) return;
      if (isCrossSiteWrite(req)) {
        sendError(res, 403, 'forbidden', 'Cross-site request blocked.');
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const match = router.match(req.method || 'GET', url.pathname);
      if (!match) {
        sendError(res, 404, 'not_found', `No route: ${req.method} ${url.pathname}`);
        return;
      }
      await match.handler(req, res, match.params, root);
    } catch (err) {
      sendError(res, 500, 'internal_error', String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

// ─── CRUD + rev ──────────────────────────────────────────────────────────────

describe('whiteboards API: CRUD', () => {
  it('create → list → get → rev → put → delete (moved to .trash, git-ignored)', async () => {
    const created = await call('POST', '/api/whiteboards', { body: { name: 'Günlük', description: 'her gün' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: 'gunluk', name: 'Günlük', description: 'her gün' });
    expect(typeof created.body.rev).toBe('string');
    expect(readFileSync(join(root, 'whiteboards', '.gitattributes'), 'utf-8')).toBe('* merge=binary\n');

    const list = await call('GET', '/api/whiteboards');
    expect(list.status).toBe(200);
    expect(list.body.whiteboards).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: 'gunluk', name: 'Günlük', elements: 0 })]),
    );

    const got = await call('GET', '/api/whiteboards/gunluk');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ slug: 'gunluk', name: 'Günlük', description: 'her gün', elements: [], rev: created.body.rev });

    const rev0 = (await call('GET', '/api/whiteboards/gunluk/rev')).body.rev;
    expect(rev0).toBe(created.body.rev);

    const put = await call('PUT', '/api/whiteboards/gunluk', { body: { elements: [rect('r1', 'a0')] } });
    expect(put.status).toBe(200);
    expect(put.body.rev).not.toBe(rev0);
    expect(put.body.elements).toBeUndefined(); // nothing on disk the browser lacked
    const rev1 = (await call('GET', '/api/whiteboards/gunluk/rev')).body.rev;
    expect(rev1).toBe(put.body.rev);
    expect(readWhiteboard(root, 'gunluk').board.elements.map((e) => e.id)).toEqual(['r1']);

    const del = await call('DELETE', '/api/whiteboards/gunluk');
    expect(del.status).toBe(200);
    expect(existsSync(join(root, 'whiteboards', 'gunluk'))).toBe(false);
    const trash = join(root, 'whiteboards', '.trash');
    expect(readFileSync(join(trash, '.gitignore'), 'utf-8')).toBe('*\n');
    const trashed = readdirSync(trash).filter((d) => d.startsWith('gunluk-'));
    expect(trashed).toHaveLength(1);
    expect(del.body.trashed).toBe(`.trash/${trashed[0]}`);
    expect(existsSync(join(trash, trashed[0], 'gunluk.excalidraw.md'))).toBe(true);

    expect((await call('GET', '/api/whiteboards/gunluk')).status).toBe(404);
    expect((await call('GET', '/api/whiteboards')).body.whiteboards.map((b: any) => b.slug)).not.toContain('gunluk');
  });

  it('POST without a name is a 400 and creates nothing', async () => {
    const before = readdirSync(join(root, 'whiteboards')).sort();
    expect((await call('POST', '/api/whiteboards', { body: { name: '   ' } })).status).toBe(400);
    expect((await call('POST', '/api/whiteboards', { body: { name: 'x', description: 42 } })).status).toBe(400);
    expect(readdirSync(join(root, 'whiteboards')).sort()).toEqual(before);
  });

  it('a PUT to a deleted board is a 404 and never re-creates it', async () => {
    const slug = freshBoard();
    expect((await call('DELETE', `/api/whiteboards/${slug}`)).status).toBe(200);
    const put = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0')] } });
    expect(put.status).toBe(404);
    expect(existsSync(join(root, 'whiteboards', slug))).toBe(false);
    // …and a PUT to a slug that never existed is the same.
    expect((await call('PUT', '/api/whiteboards/never-was', { body: { elements: [] } })).status).toBe(404);
    expect(existsSync(join(root, 'whiteboards', 'never-was'))).toBe(false);
  });
});

// ─── D11: merge, interleave, no-op ───────────────────────────────────────────

describe('whiteboards API: PUT merge contract (D4, D11)', () => {
  it('a CLI write between the browser\'s GET and its PUT survives, and the PUT returns the merged elements', async () => {
    const slug = freshBoard();
    // The browser loaded the board and holds a scene with one rectangle.
    await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0')] } });
    const loaded = await call('GET', `/api/whiteboards/${slug}`);
    const browserScene: WhiteboardElement[] = loaded.body.elements;

    // The CLI adds a note meanwhile.
    const note = await cliAddNote(slug, 'from the CLI');
    const revAfterCli = (await call('GET', `/api/whiteboards/${slug}/rev`)).body.rev;
    expect(revAfterCli).not.toBe(loaded.body.rev);

    // The browser saves its stale scene plus a new rectangle.
    const put = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [...browserScene, rect('r2', 'a9')] } });
    expect(put.status).toBe(200);
    expect(put.body.rev).not.toBe(revAfterCli);
    // D11: disk contributed the note, so the merged scene comes back.
    const ids = (put.body.elements as WhiteboardElement[]).map((e) => e.id).sort();
    expect(ids).toEqual([note.id, 'r1', 'r2'].sort());
    expect(readWhiteboard(root, slug).board.elements.map((e) => e.id).sort()).toEqual(ids);
    expect(put.body.rev).toBe((await call('GET', `/api/whiteboards/${slug}/rev`)).body.rev);

    // A follow-up PUT that already carries everything on disk gets no `elements`.
    const again = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: put.body.elements } });
    expect(again.status).toBe(200);
    expect(again.body.elements).toBeUndefined();
  });

  it('a stale browser copy loses to a newer CLI version; the newer browser edit wins over an older disk copy', async () => {
    const slug = freshBoard();
    await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0', 1), rect('r2', 'a1', 1)] } });
    // CLI bumps r1 to v3 (moved); the browser concurrently bumps r2 to v2 but still holds r1@v1.
    await mutateWhiteboard(root, slug, (b) => {
      b.elements = b.elements.map((e) => (e.id === 'r1' ? { ...e, x: 999, version: 3, versionNonce: 7 } : e));
    });
    const put = await call('PUT', `/api/whiteboards/${slug}`, {
      body: { elements: [rect('r1', 'a0', 1), { ...rect('r2', 'a1', 2, 5), x: 50 }] },
    });
    expect(put.status).toBe(200);
    const byId = new Map(readWhiteboard(root, slug).board.elements.map((e) => [e.id, e]));
    expect(byId.get('r1')).toMatchObject({ version: 3, x: 999 });
    expect(byId.get('r2')).toMatchObject({ version: 2, x: 50 });
    expect((put.body.elements as WhiteboardElement[]).find((e) => e.id === 'r1')).toMatchObject({ version: 3 });
  });

  it('a PUT of the scene already on disk leaves the file\'s bytes AND mtime unchanged', async () => {
    const slug = freshBoard();
    await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0'), rect('r2', 'a1')] } });
    await cliAddNote(slug, 'note');
    const scene = (await call('GET', `/api/whiteboards/${slug}`)).body;
    const before = snap(slug);
    await pause(30); // a rewrite now would carry a visibly later mtime

    const put = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: scene.elements } });
    expect(put.status).toBe(200);
    expect(put.body.rev).toBe(scene.rev);
    expect(put.body.elements).toBeUndefined();
    const after = snap(slug);
    expect(after.bytes).toBe(before.bytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

// ─── D12: corrupt boards ─────────────────────────────────────────────────────

describe('whiteboards API: a corrupt board is never written over (D12)', () => {
  it('GET is a 422 with the reason; PUT is refused and the file is untouched; the list flags it', async () => {
    const slug = freshBoard();
    const corrupt = '---\ndreamcontext-whiteboard: 1\nname: "Broken"\n---\n\n# Drawing\n```json\n{ "elements": [ this is not json\n```\n';
    writeFileSync(boardFile(slug), corrupt);
    const before = snap(slug);
    await pause(30);

    const got = await call('GET', `/api/whiteboards/${slug}`);
    expect(got.status).toBe(422);
    expect(got.body.error).toBe('corrupt');
    expect(typeof got.body.message).toBe('string');
    expect(got.body.message.length).toBeGreaterThan(0);

    const put = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0')] } });
    expect(put.status).toBe(422);
    const after = snap(slug);
    expect(after.bytes).toBe(corrupt);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    const listed = (await call('GET', '/api/whiteboards')).body.whiteboards.find((b: any) => b.slug === slug);
    expect(listed?.corrupt).toBeTruthy();
  });
});

// ─── Security invariants ─────────────────────────────────────────────────────

describe('whiteboards API: paths (A10)', () => {
  it('a symlinked board directory is refused on every route and skipped by the listing', async () => {
    const outside = join(tmp, 'outside-dir');
    mkdirSync(join(outside), { recursive: true });
    const victim = join(outside, 'evil.excalidraw.md');
    const victimMd = '---\ndreamcontext-whiteboard: 1\nname: "Evil"\n---\n\n# Drawing\n```json\n{"type":"excalidraw","version":2,"elements":[]}\n```\n';
    writeFileSync(victim, victimMd);
    symlinkSync(outside, join(root, 'whiteboards', 'evil'));

    expect((await call('GET', '/api/whiteboards/evil')).status).toBe(404);
    expect((await call('GET', '/api/whiteboards/evil/rev')).status).toBe(404);
    expect((await call('PUT', '/api/whiteboards/evil', { body: { elements: [rect('r1', 'a0')] } })).status).toBe(404);
    expect((await call('DELETE', '/api/whiteboards/evil')).status).toBe(404);
    expect((await call('GET', '/api/whiteboards')).body.whiteboards.map((b: any) => b.slug)).not.toContain('evil');
    expect(readFileSync(victim, 'utf-8')).toBe(victimMd);
    expect(existsSync(join(root, 'whiteboards', 'evil'))).toBe(true); // the link itself was not moved
  });

  it('a symlinked board FILE inside a real board folder is refused', async () => {
    const slug = freshBoard();
    const outsideFile = join(tmp, 'outside-file.excalidraw.md');
    writeFileSync(outsideFile, readFileSync(boardFile(slug), 'utf-8'));
    const original = readFileSync(outsideFile, 'utf-8');
    rmSync(boardFile(slug));
    symlinkSync(outsideFile, boardFile(slug));

    expect((await call('GET', `/api/whiteboards/${slug}`)).status).toBe(404);
    expect((await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0')] } })).status).toBe(404);
    expect(readFileSync(outsideFile, 'utf-8')).toBe(original);
    expect((await call('GET', '/api/whiteboards')).body.whiteboards.map((b: any) => b.slug)).not.toContain(slug);
  });

  it('a bad slug is a 404 before any filesystem access', async () => {
    const sentinel = join(tmp, 'sentinel.excalidraw.md');
    writeFileSync(sentinel, 'untouched');
    for (const bad of ['Bad_Slug', '-lead', '..%2f..%2fsentinel', '%2e%2e', 'a'.repeat(65)]) {
      expect((await call('GET', `/api/whiteboards/${bad}`)).status, bad).toBe(404);
      expect((await call('PUT', `/api/whiteboards/${bad}`, { body: { elements: [] } })).status, bad).toBe(404);
      expect((await call('DELETE', `/api/whiteboards/${bad}`)).status, bad).toBe(404);
    }
    expect(readFileSync(sentinel, 'utf-8')).toBe('untouched');
  });
});

describe('whiteboards API: PUT body (A10, A12)', () => {
  let slug: string;
  let before: { bytes: string; mtimeMs: number };
  beforeEach(async () => {
    slug = freshBoard();
    await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0')] } });
    before = snap(slug);
    await pause(20);
  });
  const untouched = () => {
    const after = snap(slug);
    expect(after.bytes).toBe(before.bytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  };

  it('a body over 5MB is a 413', async () => {
    const big = JSON.stringify({ elements: [{ ...rect('r9', 'a1'), pad: 'x'.repeat(WHITEBOARD_MAX_BODY_BYTES) }] });
    const r = await call('PUT', `/api/whiteboards/${slug}`, { raw: big });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('too_large');
    untouched();
  });

  it('a body over 5MB without a Content-Length (chunked) is a 413 too', async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/whiteboards/${slug}`, headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', (err) => reject(err));
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      req.write('{"elements":[{"pad":"');
      for (let i = 0; i < 6; i++) req.write(chunk);
      req.end('"}]}');
    });
    expect(r).toBe(413);
    untouched();
  });

  it('a `files` key is a 400: a picture goes up on its own route', async () => {
    const r = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0', 2)], files: {} } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/never carries files/);
    untouched();
  });

  it('an image element without a valid file id is a 400', async () => {
    const img = { ...rect('img1', 'a1'), type: 'image', fileId: 'abc', status: 'saved' };
    const r = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0'), img] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/image/i);
    untouched();
  });

  it('any other body key, a non-array elements, or a malformed element is a 400', async () => {
    const bodies: unknown[] = [
      { elements: [], appState: {} },
      { elements: 'nope' },
      { elements: [{ id: 'x', type: 'rectangle' }] }, // no numeric version
      [rect('r1', 'a0')],
    ];
    for (const body of bodies) {
      expect((await call('PUT', `/api/whiteboards/${slug}`, { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('PUT', `/api/whiteboards/${slug}`, { raw: '{not json' })).status).toBe(400);
    untouched();
  });

  it('widget payloads are validated server-side: kind, ref, url', async () => {
    const note = makeWidgetElement('note', { markdown: 'hi' }, { x: 0, y: 0 }, 'a3');
    const bad: WhiteboardElement[] = [
      { ...note, customData: { dc: { v: 1, kind: 'iframe' } } },
      makeWidgetElement('knowledge', { ref: '../../etc/passwd' }, { x: 0, y: 0 }, 'a3'),
      makeWidgetElement('task', { ref: 'Has Spaces' }, { x: 0, y: 0 }, 'a3'),
      webWidget('http://example.com/'),
      webWidget('javascript:alert(1)'),
      webWidget('https://user:pw@example.com/'),
    ];
    for (const el of bad) {
      const r = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0'), el] } });
      expect(r.status, JSON.stringify(el.customData)).toBe(400);
    }
    untouched();
    // A valid widget goes through.
    const ok = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0'), webWidget('https://example.com/')] } });
    expect(ok.status).toBe(200);
  });
});

describe('whiteboards API: own-origin web widget (D7, selfOrigin)', () => {
  it('a web widget pointing at the dashboard\'s own https origin is a 400', async () => {
    const slug = freshBoard();
    const host = `localhost:${port}`;
    // A same-origin browser write: the page's own origin, as the browser names it.
    const r = await call('PUT', `/api/whiteboards/${slug}`, {
      body: { elements: [webWidget(`https://${host}/whiteboards`)] },
      headers: { Host: host, Origin: `https://${host}` },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/this dashboard/);
    // The same request with a foreign https target is fine.
    const ok = await call('PUT', `/api/whiteboards/${slug}`, {
      body: { elements: [webWidget('https://example.com/')] },
      headers: { Host: host, Origin: `https://${host}` },
    });
    expect(ok.status).toBe(200);
  });

  it('behind a TLS proxy on the tailnet (remote access on), the dashboard\'s https name is refused', async () => {
    const prev = process.env.DREAMCONTEXT_REMOTE;
    process.env.DREAMCONTEXT_REMOTE = '1';
    try {
      const slug = freshBoard();
      const host = 'studio.tail1234.ts.net';
      const r = await call('PUT', `/api/whiteboards/${slug}`, {
        body: { elements: [webWidget(`https://${host}/`)] },
        headers: { Host: host, Origin: `https://${host}` },
      });
      expect(r.status).toBe(400);
      expect(readWhiteboard(root, slug).board.elements).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_REMOTE;
      else process.env.DREAMCONTEXT_REMOTE = prev;
    }
  });
});

describe('whiteboards API: CSRF', () => {
  it('a cross-site PUT, POST or DELETE is a 403 and changes nothing', async () => {
    const slug = freshBoard();
    const before = snap(slug);
    const evil = { Origin: 'https://evil.example' };
    expect((await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [rect('r1', 'a0')] }, headers: evil })).status).toBe(403);
    expect((await call('DELETE', `/api/whiteboards/${slug}`, { headers: evil })).status).toBe(403);
    const boards = readdirSync(join(root, 'whiteboards')).sort();
    expect((await call('POST', '/api/whiteboards', { body: { name: 'Drive-by' }, headers: evil })).status).toBe(403);
    expect(readdirSync(join(root, 'whiteboards')).sort()).toEqual(boards);
    expect(snap(slug)).toEqual(before);
  });
});

// ─── Round 2: the default board and widget sizes (A15, A17) ─────────────────

describe('whiteboards API: the default "Control Panel" board (A15)', () => {
  it('GET /api/whiteboards/default creates control-panel once and returns {slug}; it is not shadowed by :slug', async () => {
    const file = boardFile('control-panel');
    expect(existsSync(file)).toBe(false);
    const [a, b] = await Promise.all([call('GET', '/api/whiteboards/default'), call('GET', '/api/whiteboards/default')]);
    expect({ status: a.status, body: a.body }).toEqual({ status: 200, body: { slug: 'control-panel' } });
    expect({ status: b.status, body: b.body }).toEqual({ status: 200, body: { slug: 'control-panel' } });
    const got = await call('GET', '/api/whiteboards/control-panel');
    expect(got.body).toMatchObject({ slug: 'control-panel', name: 'Control Panel', elements: [] });

    // Once it exists, asking again rewrites nothing.
    const put = await call('PUT', '/api/whiteboards/control-panel', { body: { elements: [rect('cp1', 'a0')] } });
    expect(put.status).toBe(200);
    const before = snap('control-panel');
    await pause(20);
    expect((await call('GET', '/api/whiteboards/default')).body).toEqual({ slug: 'control-panel' });
    expect(snap('control-panel')).toEqual(before);

    const list = await call('GET', '/api/whiteboards');
    const entries = list.body.whiteboards.filter((w: any) => w.slug === 'control-panel');
    expect(entries).toEqual([expect.objectContaining({ isDefault: true, name: 'Control Panel' })]);
  });

  it('DELETE of the default board is a 409 with a message, and the board stays', async () => {
    await call('GET', '/api/whiteboards/default');
    const del = await call('DELETE', '/api/whiteboards/control-panel');
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: 'conflict', message: expect.stringMatching(/default board/) });
    expect(existsSync(boardFile('control-panel'))).toBe(true);
  });

  it('POST of a board named "Default" never takes the slug the default route owns', async () => {
    const created = await call('POST', '/api/whiteboards', { body: { name: 'Default' } });
    expect(created.status).toBe(201);
    expect(created.body.slug).toBe('default-2');
  });
});

describe('whiteboards API: widget sizes (A17)', () => {
  it('a PUT carrying a widget with a size outside s|m|l|xl is a 400; a valid size is stored', async () => {
    const slug = freshBoard();
    const before = snap(slug);
    const note = makeWidgetElement('note', { markdown: 'hi' }, { x: 0, y: 0 }, 'a0');
    const bad = { ...note, customData: { dc: { ...(note.customData as any).dc, size: 'xxl' } } };
    const r = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [bad] } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/invalid widget size/);
    expect(snap(slug)).toEqual(before);

    const ok = { ...note, customData: { dc: { ...(note.customData as any).dc, size: 'xl' } } };
    expect((await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [ok] } })).status).toBe(200);
    expect((readWhiteboard(root, slug).board.elements[0].customData as any).dc.size).toBe('xl');
  });
});

describe('whiteboards API: pictures (W7)', () => {
  /** A PNG header naming a 3x2 picture: the server reads the type from the bytes alone. */
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  const id = 'pic'.padEnd(40, '0');
  const upload = (slug: string, fileId: string, bytes: Buffer, type = 'image/png') =>
    call('POST', `/api/whiteboards/${slug}/files/${fileId}`, { raw: bytes, headers: { 'Content-Type': type, 'Content-Length': String(bytes.length) } });

  it('POST stores the bytes beside the board; GET reads them back, typed, nosniff, no script', async () => {
    const slug = freshBoard();
    const up = await upload(slug, id, png);
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ id, mimeType: 'image/png' });
    expect(readFileSync(join(root, 'whiteboards', slug, 'files', `${id}.png`)).equals(png)).toBe(true);
    const r = await call('GET', `/api/whiteboards/${slug}/files/${id}`);
    expect(r.status).toBe(200);
    expect(r.raw.equals(png)).toBe(true);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toMatch(/default-src 'none'; sandbox/);
    // The same id again is a no-op, and the element naming it saves.
    expect((await upload(slug, id, png)).status).toBe(200);
    const img = { id: 'img1', type: 'image', version: 1, versionNonce: 1, index: 'a0', x: 0, y: 0, width: 3, height: 2, fileId: id, status: 'saved' };
    expect((await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [img] } })).status).toBe(200);
    expect(readWhiteboard(root, slug).board.elements.map((e) => e.fileId)).toEqual([id]);
  });

  it('refuses what is not a raster picture, whatever it says it is; a bad id; a missing board', async () => {
    const slug = freshBoard();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r1 = await upload(slug, id, svg, 'image/png');
    expect(r1.status).toBe(400);
    expect(r1.body.message).toMatch(/PNG, JPEG, GIF or WebP/);
    expect((await upload(slug, 'short', png)).status).toBe(400);
    expect((await upload(slug, `${id}.png`, png)).status).toBe(400);
    expect((await upload('no-such-board', id, png)).status).toBe(404);
    expect(existsSync(join(root, 'whiteboards', slug, 'files'))).toBe(false);
    expect((await call('GET', `/api/whiteboards/${slug}/files/${id}`)).status).toBe(404);
    expect((await call('GET', `/api/whiteboards/${slug}/files/..%2F..%2Fx`)).status).toBe(404);
  });

  it('a PUT naming a picture never uploaded is a 400 and the board is untouched', async () => {
    const slug = freshBoard();
    const before = readWhiteboard(root, slug).rev;
    const img = { id: 'img1', type: 'image', version: 1, versionNonce: 1, index: 'a0', x: 0, y: 0, width: 3, height: 2, fileId: id, status: 'saved' };
    const r = await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [img] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/does not hold/);
    expect(readWhiteboard(root, slug).rev).toBe(before);
    // Uploaded first, the same save goes through.
    expect((await upload(slug, id, png)).status).toBe(200);
    expect((await call('PUT', `/api/whiteboards/${slug}`, { body: { elements: [img] } })).status).toBe(200);
  });

  it('a picture over 10MB is a 413 and nothing is stored', async () => {
    const slug = freshBoard();
    const big = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
    const r = await upload(slug, id, big);
    expect(r.status).toBe(413);
    expect(existsSync(join(root, 'whiteboards', slug, 'files'))).toBe(false);
  });

  it('a cross-site POST is refused like any other write', async () => {
    const slug = freshBoard();
    const r = await call('POST', `/api/whiteboards/${slug}/files/${id}`, {
      raw: png, headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length), Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(r.status).toBe(403);
    expect(existsSync(join(root, 'whiteboards', slug, 'files'))).toBe(false);
  });
});
