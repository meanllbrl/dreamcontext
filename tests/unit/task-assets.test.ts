import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  TASK_ASSET_LIMITS, assetsDirFor, capAssetName, claimName, kindOf, listAssets, pruneStaleUploads, summarizeAssets,
  writeUploadStream,
} from '../../src/lib/task-assets.js';
import {
  activeTaskAssetUploads, handleTaskAssetRaw, handleTaskAssetsList, handleTaskAssetUpload,
} from '../../src/server/routes/task-assets.js';

/**
 * Task attachments (AC12, AC13): the listing, the top-level-only summary, the raw route's fixed
 * type table + every refusal (traversal, symlinks at each level, bad slug, missing task), its
 * headers (nosniff on every exit, sandbox CSP on images only and never on a PDF), and the
 * upload stream (cap, abort, the atomic name claim, the 200-byte name cap, stale tmp prune).
 */

function makeRes() {
  let statusCode = 0;
  let headers: Record<string, string | number> = {};
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); });
  const finished = new Promise<void>((resolve) => { sink.on('finish', () => resolve()); sink.on('close', () => resolve()); });
  const res = Object.assign(sink, {
    headersSent: false,
    setHeader(name: string, value: string) { headers[name] = value; },
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      statusCode = code; headers = { ...headers, ...(hdrs ?? {}) }; (res as any).headersSent = true; return res;
    },
  }) as unknown as ServerResponse;
  const raw = () => (chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
  return {
    res,
    status: () => statusCode,
    header: (n: string) => headers[n],
    raw,
    body: () => { try { return JSON.parse(raw().toString('utf-8')); } catch { return raw(); } },
    done: () => finished,
  };
}

function getReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, method: 'GET', headers } as unknown as IncomingMessage;
}

/** A streaming request body the test feeds chunk by chunk. */
function uploadReq(url: string, headers: Record<string, string> = {}): IncomingMessage & PassThrough {
  const s = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(s, { url, method: 'POST', headers });
  return s;
}

let projectRoot: string;
let contextRoot: string;
let assets: string;

function writeTask(slug: string): void {
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), `---\nname: ${slug}\nstatus: todo\n---\n## Why\nx\n`, 'utf-8');
}

beforeEach(() => {
  const raw = join(tmpdir(), `task-assets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeTask('demo');
  writeTask('empty');
  assets = join(contextRoot, 'state', 'assets', 'demo');
  mkdirSync(join(assets, 'clips', 'deep'), { recursive: true });
  writeFileSync(join(assets, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  writeFileSync(join(assets, 'demo.mp4'), Buffer.alloc(1000, 7));
  writeFileSync(join(assets, 'spec.pdf'), '%PDF-1.4 fake');
  writeFileSync(join(assets, 'notes.txt'), 'hello');
  writeFileSync(join(assets, 'icon.svg'), '<svg><script>alert(1)</script></svg>');
  writeFileSync(join(assets, 'page.html'), '<script>alert(1)</script>');
  writeFileSync(join(assets, '.hidden.png'), 'x');
  writeFileSync(join(assets, 'clips', 'a.png'), 'x');
  writeFileSync(join(assets, 'clips', 'deep', 'b.png'), 'x');
  TASK_ASSET_LIMITS.capBytes = 100 * 1024 * 1024;
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  TASK_ASSET_LIMITS.capBytes = 100 * 1024 * 1024;
});

describe('lib', () => {
  it('kindOf: svg is a plain file', () => {
    expect(kindOf('.PNG')).toBe('image');
    expect(kindOf('.mov')).toBe('video');
    expect(kindOf('.m4a')).toBe('audio');
    expect(kindOf('.pdf')).toBe('pdf');
    expect(kindOf('.svg')).toBe('file');
    expect(kindOf('.html')).toBe('file');
  });

  it('listAssets: kinds, sizes, folder recursive counts, dotfiles and symlinks skipped', () => {
    symlinkSync(join(assets, 'shot.png'), join(assets, 'link.png'));
    const l = listAssets(assets);
    const names = l.entries.map((e) => e.name);
    expect(names).toEqual(['demo.mp4', 'icon.svg', 'notes.txt', 'page.html', 'shot.png', 'spec.pdf', 'clips']);
    expect(l.entries.find((e) => e.name === 'demo.mp4')).toMatchObject({ kind: 'video', size: 1000 });
    expect(l.entries.find((e) => e.name === 'clips')).toMatchObject({ kind: 'folder', count: 2 });
    expect(l.total).toBe(8);
    expect(l.truncated).toBe(false);
  });

  it('listAssets: truncated past the walk bound', () => {
    const big = join(contextRoot, 'state', 'assets', 'empty');
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 2010; i++) writeFileSync(join(big, `f${i}.txt`), '');
    const l = listAssets(big);
    expect(l.truncated).toBe(true);
    expect(l.total).toBeLessThanOrEqual(2000);
  });

  it('summarizeAssets reads the top level only (count = top-level entries, first image by name)', () => {
    expect(summarizeAssets(contextRoot, 'demo')).toEqual({ count: 7, cover: 'shot.png' });
    expect(summarizeAssets(contextRoot, 'empty')).toEqual({ count: 0, cover: null });
    expect(summarizeAssets(contextRoot, 'Bad Slug')).toEqual({ count: 0, cover: null });
  });

  it('assetsDirFor refuses a bad slug, a symlinked assets/<slug>, a symlinked state/assets', () => {
    expect(() => assetsDirFor(contextRoot, '../x')).toThrow(/Invalid task slug/);
    const elsewhere = join(projectRoot, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(contextRoot, 'state', 'assets', 'empty'));
    expect(() => assetsDirFor(contextRoot, 'empty')).toThrow(/symlink/);
    expect(summarizeAssets(contextRoot, 'empty')).toEqual({ count: 0, cover: null });
  });

  it('assetsDirFor refuses a symlinked state/assets', () => {
    rmSync(join(contextRoot, 'state', 'assets'), { recursive: true });
    const outside = join(projectRoot, 'outside-assets');
    mkdirSync(join(outside, 'demo'), { recursive: true });
    symlinkSync(outside, join(contextRoot, 'state', 'assets'));
    expect(() => assetsDirFor(contextRoot, 'demo')).toThrow(/symlink/);
    expect(() => assetsDirFor(contextRoot, 'empty', { create: true })).toThrow(/symlink/);
  });

  it('capAssetName keeps the extension within 200 bytes', () => {
    const long = `${'a'.repeat(400)}.png`;
    const capped = capAssetName(long);
    expect(Buffer.byteLength(capped)).toBe(200);
    expect(capped.endsWith('.png')).toBe(true);
    expect(capAssetName('short.png')).toBe('short.png');
  });

  it('claimName never overwrites: name, name-1, name-2', () => {
    const dir = join(contextRoot, 'state', 'assets', 'empty');
    mkdirSync(dir, { recursive: true });
    for (const expected of ['p.png', 'p-1.png', 'p-2.png']) {
      const tmp = join(dir, '.upload-t');
      writeFileSync(tmp, expected);
      expect(claimName(tmp, dir, 'p.png')).toBe(expected);
      rmSync(tmp);
    }
    expect(readFileSync(join(dir, 'p.png'), 'utf-8')).toBe('p.png');
    expect(readFileSync(join(dir, 'p-2.png'), 'utf-8')).toBe('p-2.png');
  });

  it('pruneStaleUploads deletes .upload-* older than an hour, keeps fresh ones', () => {
    const dir = join(contextRoot, 'state', 'assets', 'empty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.upload-old'), 'x');
    writeFileSync(join(dir, '.upload-new'), 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(dir, '.upload-old'), old, old);
    pruneStaleUploads(dir);
    expect(readdirSync(dir).sort()).toEqual(['.upload-new']);
  });

  it('writeUploadStream: past the cap the partial file is removed and the result is 413', async () => {
    const dir = join(contextRoot, 'state', 'assets', 'empty');
    mkdirSync(dir, { recursive: true });
    const req = uploadReq('/');
    const p = writeUploadStream(req, dir, 'big.bin', 10);
    req.write(Buffer.alloc(6));
    req.write(Buffer.alloc(6));
    const r = await p;
    expect(r).toMatchObject({ ok: false, status: 413 });
    await new Promise((res) => setTimeout(res, 20));
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('GET /api/tasks/:slug/assets', () => {
  it('lists the folder; an absent folder is empty; a missing task is 404', async () => {
    let r = makeRes();
    await handleTaskAssetsList(getReq('/'), r.res, { slug: 'demo' }, contextRoot);
    await r.done();
    expect(r.status()).toBe(200);
    expect(r.body().total).toBe(8);
    r = makeRes();
    await handleTaskAssetsList(getReq('/'), r.res, { slug: 'empty' }, contextRoot);
    await r.done();
    expect(r.body()).toEqual({ entries: [], total: 0, truncated: false });
    r = makeRes();
    await handleTaskAssetsList(getReq('/'), r.res, { slug: 'ghost' }, contextRoot);
    await r.done();
    expect(r.status()).toBe(404);
  });
});

describe('GET /api/tasks/:slug/assets/raw', () => {
  async function raw(path: string, slug = 'demo', headers: Record<string, string> = {}) {
    const r = makeRes();
    await handleTaskAssetRaw(getReq(`/api/tasks/${slug}/assets/raw?path=${encodeURIComponent(path)}`, headers), r.res, { slug }, contextRoot);
    await r.done();
    return r;
  }

  it('serves an image inline with nosniff and the sandbox CSP', async () => {
    const r = await raw('shot.png');
    expect(r.status()).toBe(200);
    expect(r.header('Content-Type')).toBe('image/png');
    expect(r.header('X-Content-Type-Options')).toBe('nosniff');
    expect(r.header('Content-Disposition')).toBe('inline');
    expect(r.header('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(r.raw().length).toBe(8);
  });

  it('serves a pdf WITHOUT the sandbox CSP (PdfViewer frames it)', async () => {
    const r = await raw('spec.pdf');
    expect(r.status()).toBe(200);
    expect(r.header('Content-Type')).toBe('application/pdf');
    expect(r.header('Content-Security-Policy')).toBeUndefined();
    expect(r.header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('answers a Range with 206 and nosniff', async () => {
    const r = await raw('demo.mp4', 'demo', { range: 'bytes=0-99' });
    expect(r.status()).toBe(206);
    expect(r.raw().length).toBe(100);
    expect(r.header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('serves a file inside a subfolder', async () => {
    const r = await raw('clips/deep/b.png');
    expect(r.status()).toBe(200);
  });

  it.each(['icon.svg', 'page.html', 'notes.txt'])('%s → 415 with nosniff', async (p) => {
    const r = await raw(p);
    expect(r.status()).toBe(415);
    expect(r.header('X-Content-Type-Options')).toBe('nosniff');
  });

  it.each([
    '../demo.md',
    '/etc/passwd.png',
    'clips/../../demo.png',
    '%2e%2e/x.png',
    '..%2fx.png',
    '.hidden.png',
  ])('refuses traversal %s with 400 and nosniff', async (p) => {
    const r = await raw(p);
    expect(r.status()).toBe(400);
    expect(r.header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('refuses a symlinked file (and the list skips it)', async () => {
    const secret = join(projectRoot, 'secret.png');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(assets, 'link.png'));
    const r = await raw('link.png');
    expect(r.status()).toBe(400);
    expect(listAssets(assets).entries.some((e) => e.name === 'link.png')).toBe(false);
  });

  it('refuses a symlinked subfolder', async () => {
    const outside = join(projectRoot, 'outdir');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.png'), 'x');
    symlinkSync(outside, join(assets, 'linked'));
    const r = await raw('linked/x.png');
    expect(r.status()).toBe(400);
  });

  it('refuses a symlinked assets/<slug>', async () => {
    const outside = join(projectRoot, 'outslug');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.png'), 'x');
    symlinkSync(outside, join(contextRoot, 'state', 'assets', 'empty'));
    const r = await raw('x.png', 'empty');
    expect(r.status()).toBe(400);
  });

  it('refuses a bad slug and a missing task', async () => {
    let r = await raw('shot.png', '..');
    expect(r.status()).toBe(400);
    expect(r.header('X-Content-Type-Options')).toBe('nosniff');
    r = await raw('shot.png', 'ghost');
    expect(r.status()).toBe(404);
    expect(r.header('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('POST /api/tasks/:slug/assets', () => {
  it('streams the body to disk and claims a free name', async () => {
    writeFileSync(join(contextRoot, 'state', 'assets', 'demo', 'up.png'), 'old');
    const req = uploadReq('/api/tasks/demo/assets?name=up.png');
    const r = makeRes();
    const p = handleTaskAssetUpload(req, r.res, { slug: 'demo' }, contextRoot);
    req.end(Buffer.from('new-bytes'));
    await p;
    await r.done();
    expect(r.status()).toBe(201);
    expect(r.body()).toEqual({ name: 'up-1.png', size: 9 });
    expect(readFileSync(join(assets, 'up.png'), 'utf-8')).toBe('old');
    expect(readFileSync(join(assets, 'up-1.png'), 'utf-8')).toBe('new-bytes');
    expect(readdirSync(assets).some((n) => n.startsWith('.upload-'))).toBe(false);
  });

  it('sanitizes the name (no traversal) and caps it at 200 bytes', async () => {
    const req = uploadReq(`/api/tasks/empty/assets?name=${encodeURIComponent(`../../${'x'.repeat(300)}.png`)}`);
    const r = makeRes();
    const p = handleTaskAssetUpload(req, r.res, { slug: 'empty' }, contextRoot);
    req.end(Buffer.from('x'));
    await p;
    await r.done();
    expect(r.status()).toBe(201);
    const name = r.body().name as string;
    expect(Buffer.byteLength(name)).toBe(200);
    expect(name.endsWith('.png')).toBe(true);
    expect(existsSync(join(contextRoot, 'state', 'assets', 'empty', name))).toBe(true);
  });

  it('413 from Content-Length before reading', async () => {
    TASK_ASSET_LIMITS.capBytes = 10;
    const req = uploadReq('/api/tasks/empty/assets?name=a.bin', { 'content-length': '11' });
    const r = makeRes();
    await handleTaskAssetUpload(req, r.res, { slug: 'empty' }, contextRoot);
    await r.done();
    expect(r.status()).toBe(413);
    expect(existsSync(join(contextRoot, 'state', 'assets', 'empty'))).toBe(false);
  });

  it('413 at the streaming cap leaves no partial file and frees the slot', async () => {
    TASK_ASSET_LIMITS.capBytes = 10;
    const req = uploadReq('/api/tasks/empty/assets?name=a.bin');
    const r = makeRes();
    const p = handleTaskAssetUpload(req, r.res, { slug: 'empty' }, contextRoot);
    await new Promise((res) => setTimeout(res, 10));
    req.write(Buffer.alloc(8));
    req.write(Buffer.alloc(8));
    await p;
    await r.done();
    expect(r.status()).toBe(413);
    await new Promise((res) => setTimeout(res, 20));
    expect(readdirSync(join(contextRoot, 'state', 'assets', 'empty'))).toEqual([]);
    expect(activeTaskAssetUploads()).toBe(0);
  });

  it('an aborted upload frees its concurrency slot and leaves no partial file', async () => {
    const req = uploadReq('/api/tasks/empty/assets?name=a.bin');
    const r = makeRes();
    const p = handleTaskAssetUpload(req, r.res, { slug: 'empty' }, contextRoot);
    await new Promise((res) => setTimeout(res, 10));
    req.write(Buffer.alloc(4));
    expect(activeTaskAssetUploads()).toBe(1);
    req.destroy();
    await p;
    expect(activeTaskAssetUploads()).toBe(0);
    await new Promise((res) => setTimeout(res, 20));
    expect(readdirSync(join(contextRoot, 'state', 'assets', 'empty'))).toEqual([]);
  });

  it('429 above four concurrent uploads', async () => {
    const reqs = [0, 1, 2, 3].map(() => uploadReq('/api/tasks/empty/assets?name=a.bin'));
    const pending = reqs.map((req) => handleTaskAssetUpload(req, makeRes().res, { slug: 'empty' }, contextRoot));
    await new Promise((res) => setTimeout(res, 20));
    expect(activeTaskAssetUploads()).toBe(4);
    const fifth = makeRes();
    await handleTaskAssetUpload(uploadReq('/api/tasks/empty/assets?name=b.bin'), fifth.res, { slug: 'empty' }, contextRoot);
    await fifth.done();
    expect(fifth.status()).toBe(429);
    reqs.forEach((req) => req.end(Buffer.from('x')));
    await Promise.all(pending);
    expect(activeTaskAssetUploads()).toBe(0);
  });

  it('a missing task is 404 and creates nothing', async () => {
    const r = makeRes();
    await handleTaskAssetUpload(uploadReq('/api/tasks/ghost/assets?name=a.png'), r.res, { slug: 'ghost' }, contextRoot);
    await r.done();
    expect(r.status()).toBe(404);
    expect(existsSync(join(contextRoot, 'state', 'assets', 'ghost'))).toBe(false);
  });
});

describe('the walk bound never hides a top-level file', () => {
  it('a huge subfolder sorted first still leaves every top-level file listed', () => {
    const dir = join(contextRoot, 'state', 'assets', 'empty');
    mkdirSync(join(dir, 'aaa-frames'), { recursive: true });
    for (let i = 0; i < 2100; i++) writeFileSync(join(dir, 'aaa-frames', `f${i}.png`), '');
    writeFileSync(join(dir, 'zz-screenshot.png'), 'x');
    const l = listAssets(dir);
    expect(l.entries.map((e) => e.name)).toEqual(['zz-screenshot.png', 'aaa-frames']);
    expect(l.truncated).toBe(true);
  });
});

describe('an upload aborted before the stream is read', () => {
  it('releases its slot even when the request died during the task lookup', async () => {
    const req = uploadReq('/api/tasks/empty/assets?name=a.bin');
    req.destroy();
    const r = makeRes();
    await handleTaskAssetUpload(req, r.res, { slug: 'empty' }, contextRoot);
    expect(activeTaskAssetUploads()).toBe(0);
  });
});
