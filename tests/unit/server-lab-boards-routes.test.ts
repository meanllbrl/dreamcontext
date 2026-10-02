import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildRouter } from '../../src/server/index.js';
import { isCrossSiteWrite } from '../../src/server/middleware.js';
import { MAX_CACHE_SLUGS } from '../../src/server/routes/lab-boards.js';
import { _resetLabSyncJobs, _setLabSyncAllImpl } from '../../src/server/lab-sync-job.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { boardsDir, boardsLockPath } from '../../src/lib/lab/boards.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

/**
 * The board + block-library routes (Insights v2, D5), dispatched through the
 * REAL router the way `startDashboardServer` does it, so route order and the
 * router's own URL decoding are part of what is tested.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, url: string, bodyObj?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
  }) as unknown as IncomingMessage;
}

/** The server's dispatch: pathname -> router (which URL-decodes params), query kept on req.url. */
async function call(method: string, url: string, bodyObj?: unknown) {
  const out = makeRes();
  const pathname = url.split('?')[0];
  const match = buildRouter().match(method, pathname);
  if (!match) {
    out.res.writeHead(404);
    out.res.end(JSON.stringify({ error: 'not_found' }));
    return out;
  }
  await match.handler(makeReq(method, url, bodyObj), out.res, match.params, root);
  return out;
}

const cacheFor = (slug: string, v: number, extra: Partial<InsightCache> = {}): InsightCache => ({
  slug, fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily', unit: null,
  series: [{ name: 'default', points: [{ t: '2026-09-01', v: v - 1 }, { t: '2026-09-02', v }] }],
  latest: v, error: null, errorAt: null, scriptHash: null,
  history: [{ at: '2026-09-02T00:00:00Z', status: 'ok', latest: v, granularity: 'daily', error: null }],
  ...extra,
});

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-boards-routes-'));
  outside = mkdtempSync(join(tmpdir(), 'dc-lab-boards-outside-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  createInsight(root, { slug: 'signups', title: 'Signups', category: 'Growth' });
  createInsight(root, { slug: 'visits', title: 'Visits', category: 'Growth' });
  createInsight(root, { slug: 'mrr', title: 'MRR', category: 'Revenue' });
  writeCache(root, 'signups', cacheFor('signups', 10));
  writeCache(root, 'mrr', cacheFor('mrr', 500));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('derived boards (legacy vault, nothing materialized)', () => {
  it('GET /api/lab/boards lists one derived board per category and writes nothing', async () => {
    const { status, body } = await call('GET', '/api/lab/boards');
    expect(status()).toBe(200);
    expect(body().derived).toBe(true);
    expect(body().boards.map((b: any) => b.slug)).toEqual(['growth', 'revenue']);
    expect(body().unplaced).toEqual([]);
    expect(existsSync(boardsDir(root))).toBe(false);
  });

  it('GET /api/lab/boards/:slug returns the BoardResponse shape', async () => {
    const { status, body } = await call('GET', '/api/lab/boards/growth');
    expect(status()).toBe(200);
    expect(Object.keys(body()).sort()).toEqual(['board', 'frames', 'summaries', 'unplaced']);
    expect(body().board.derived).toBe(true);
    expect(body().board.cards.map((c: any) => c.id)).toEqual(['c-signups', 'c-visits']);
    expect(Object.keys(body().summaries).sort()).toEqual(['signups', 'visits']);
    expect(body().summaries.signups.latest).toBe(10);
    expect(existsSync(boardsDir(root))).toBe(false);
  });

  it('the first PUT materializes EVERY board, with the edit applied', async () => {
    const shown = (await call('GET', '/api/lab/boards/growth')).body();
    const spec = { ...shown.board, cards: [...shown.board.cards, {
      id: 'c-stat', at: { x: 0, y: 10, w: 3, h: 3 }, blocks: [{ type: 'stat', data: 'signups', options: { delta: 'prev' } }],
    }] };
    const { status, body } = await call('PUT', '/api/lab/boards/growth', { rev: shown.board.rev, spec });
    expect(status()).toBe(200);
    expect(body().board.derived).toBe(false);
    expect(body().frames['c-stat:0']).toMatchObject({ kind: 'value', value: 10, prev: 9 });
    expect(readdirSync(boardsDir(root)).sort()).toEqual(['growth.md', 'revenue.md']);
    expect(readFileSync(join(boardsDir(root), 'growth.md'), 'utf-8')).toContain('c-stat');
    expect(readdirSync(join(root, 'lab')).filter((n) => n.startsWith('.boards-staging-'))).toEqual([]);
  });
});

describe('PUT /api/lab/boards/:slug', () => {
  async function materialized() {
    const shown = (await call('GET', '/api/lab/boards/growth')).body();
    return (await call('PUT', '/api/lab/boards/growth', { rev: shown.board.rev, spec: shown.board })).body().board;
  }

  it('409 on a stale rev, and the file is left alone', async () => {
    const board = await materialized();
    const before = readFileSync(join(boardsDir(root), 'growth.md'), 'utf-8');
    const { status, body } = await call('PUT', '/api/lab/boards/growth', { rev: 'deadbeefdeadbeef', spec: { ...board, title: 'Hijack' } });
    expect(status()).toBe(409);
    expect(body().error).toBe('rev-conflict');
    expect(readFileSync(join(boardsDir(root), 'growth.md'), 'utf-8')).toBe(before);
  });

  it('a save with the returned rev succeeds (no self-409 on a burst)', async () => {
    let board = await materialized();
    for (let i = 0; i < 3; i++) {
      const moved = { ...board, cards: board.cards.map((c: any, j: number) => (j === 0 ? { ...c, at: { ...c.at, y: c.at.y + 10 + i } } : c)) };
      const res = await call('PUT', '/api/lab/boards/growth', { rev: board.rev, spec: moved });
      expect(res.status()).toBe(200);
      board = res.body().board;
    }
  });

  it('400 without a rev (never a silent overwrite)', async () => {
    const { status, body } = await call('PUT', '/api/lab/boards/growth', { spec: { title: 'x', cards: [] } });
    expect(status()).toBe(400);
    expect(body().error).toBe('missing_rev');
  });

  it('400 with diagnostics naming the card id, the block path and the fix', async () => {
    const board = await materialized();
    const bad = { ...board, cards: [{ id: 'c-x', at: { x: 0, y: 0, w: 4, h: 3 }, blocks: [{ line: { data: 'signups', color: 99 } }] }] };
    const { status, body } = await call('PUT', '/api/lab/boards/growth', { rev: board.rev, spec: bad });
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid');
    const d = body().diagnostics[0];
    expect(d.cardId).toBe('c-x');
    expect(d.path).toBe('cards[0].blocks[0].line.color');
    expect(d.fix).toMatch(/color/);
  });

  it('423 on an error board (conflict markers): GET shows it, PUT refuses it', async () => {
    await materialized();
    writeFileSync(join(boardsDir(root), 'broken.md'), '---\ntitle: Broken\n<<<<<<< ours\ncards: []\n=======\ncards: [x]\n>>>>>>> theirs\n---\n');
    const shown = await call('GET', '/api/lab/boards/broken');
    expect(shown.status()).toBe(200);
    expect(shown.body().board.error.kind).toBe('conflict');
    expect((await call('GET', '/api/lab/boards')).body().boards.map((b: any) => b.slug)).toContain('broken');
    const put = await call('PUT', '/api/lab/boards/broken', { rev: shown.body().board.rev, spec: { title: 'Fixed', cards: [] } });
    expect(put.status()).toBe(423);
    expect(put.body().error).toBe('error-board');
  });

  it('503 when the board lock stays busy (the client retries)', async () => {
    const board = await materialized();
    mkdirSync(join(root, 'state', '.locks'), { recursive: true });
    // Held by a live pid (this process), so it is never reclaimed as stale.
    expect(acquireFileLock(boardsLockPath(root), Date.now(), 30_000, { verifyPidLiveness: true })).toBe(true);
    try {
      const { status, body } = await call('PUT', '/api/lab/boards/growth', { rev: board.rev, spec: board });
      expect(status()).toBe(503);
      expect(body().error).toBe('busy');
    } finally {
      releaseFileLock(boardsLockPath(root));
    }
  }, 10_000);
});

describe('POST / DELETE boards', () => {
  it('POST creates a slugged board (materializing the derived ones), DELETE removes it', async () => {
    const created = await call('POST', '/api/lab/boards', { title: 'Büyüme Özeti' });
    expect(created.status()).toBe(201);
    expect(created.body().board.slug).toBe('buyume-ozeti');
    expect(readdirSync(boardsDir(root)).sort()).toEqual(['buyume-ozeti.md', 'growth.md', 'revenue.md']);
    const again = await call('POST', '/api/lab/boards', { title: 'Büyüme Özeti' });
    expect(again.body().board.slug).toBe('buyume-ozeti-2');

    const del = await call('DELETE', '/api/lab/boards/buyume-ozeti');
    expect(del.status()).toBe(200);
    expect(existsSync(join(boardsDir(root), 'buyume-ozeti.md'))).toBe(false);
    expect((await call('DELETE', '/api/lab/boards/nope')).status()).toBe(404);
  });

  it('DELETE with a stale ?rev= is a 409', async () => {
    await call('POST', '/api/lab/boards', { title: 'Temp' });
    expect((await call('DELETE', '/api/lab/boards/temp?rev=0000000000000000')).status()).toBe(409);
    expect(existsSync(join(boardsDir(root), 'temp.md'))).toBe(true);
  });

  it('unplaced lists insights on no board once boards are materialized', async () => {
    await call('POST', '/api/lab/boards', { title: 'Temp' });
    await call('DELETE', '/api/lab/boards/revenue');
    const list = (await call('GET', '/api/lab/boards')).body();
    expect(list.derived).toBe(false);
    expect(list.unplaced).toEqual(['mrr']);
  });
});

describe('containment: nothing outside lab/ reaches a response', () => {
  it('a symlinked cache yields an empty no-cache frame and no data at board GET', async () => {
    createInsight(root, { slug: 'leak', title: 'Leak', category: 'Growth' });
    writeFileSync(join(outside, 'secret.json'), JSON.stringify(cacheFor('leak', 999_999)));
    symlinkSync(join(outside, 'secret.json'), join(root, 'lab', 'cache', 'leak.json'));
    const shown = (await call('GET', '/api/lab/boards/growth')).body();
    const spec = { ...shown.board, cards: [...shown.board.cards, {
      id: 'c-leak-stat', at: { x: 0, y: 20, w: 3, h: 3 },
      blocks: [{ type: 'stat', data: 'leak', options: {} }, { type: 'html', options: { html: '<p></p>', inputs: { s: 'leak' } } }],
    }] };
    const put = await call('PUT', '/api/lab/boards/growth', { rev: shown.board.rev, spec });
    expect(put.status()).toBe(200);
    const got = await call('GET', '/api/lab/boards/growth');
    expect(got.body().frames['c-leak-stat:0']).toMatchObject({ kind: 'empty', reason: 'no-cache' });
    expect(got.body().frames['c-leak-stat:1#s']).toMatchObject({ kind: 'empty', reason: 'no-cache' });
    expect(JSON.stringify(got.body())).not.toContain('999999');
    const caches = await call('GET', '/api/lab/caches?slugs=leak');
    expect(caches.body().caches.leak).toBeNull();
  });

  it.each([
    ['GET', '/api/lab/boards/..%2Fsecret'],
    ['GET', '/api/lab/boards/a%2Fb'],
    ['PUT', '/api/lab/boards/..%2F..%2Fcore'],
    ['DELETE', '/api/lab/boards/%2E%2E'],
    ['GET', '/api/lab/blocks/..%2Fx'],
    ['PUT', '/api/lab/blocks/a%2Fb'],
  ])('%s %s -> 400 after decoding, before any path is built', async (method, url) => {
    const { status, body } = await call(method, url, method === 'PUT' ? { rev: null, spec: { title: 'x', cards: [] } } : undefined);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_slug');
  });

  it('a ../ or %2F binding is refused on write and resolves to unsafe-ref on read', async () => {
    const shown = (await call('GET', '/api/lab/boards/growth')).body();
    for (const data of ['../signups', 'a%2Fb']) {
      const spec = { ...shown.board, cards: [{ id: 'c-x', at: { x: 0, y: 0, w: 3, h: 3 }, blocks: [{ type: 'stat', data, options: {} }] }] };
      const put = await call('PUT', '/api/lab/boards/growth', { rev: shown.board.rev, spec });
      expect(put.status()).toBe(400);
      expect(put.body().diagnostics[0].path).toBe('cards[0].blocks[0].stat.data');
    }
    // A hand-written file carrying one reads leniently to an empty unsafe-ref frame.
    mkdirSync(boardsDir(root), { recursive: true });
    writeFileSync(join(boardsDir(root), 'hand.md'), '---\ntitle: Hand\ncards:\n  - id: c-x\n    at: {x: 0, y: 0, w: 3, h: 3}\n    blocks:\n      - stat: {data: ../signups}\n---\n');
    const got = await call('GET', '/api/lab/boards/hand');
    expect(got.body().frames['c-x:0']).toMatchObject({ kind: 'empty', reason: 'unsafe-ref' });
  });
});

describe('origin guard', () => {
  it('a cross-site PUT / POST / DELETE on a board route is refused by the global guard (403 in the server loop)', () => {
    for (const [method, url] of [['PUT', '/api/lab/boards/growth'], ['DELETE', '/api/lab/boards/growth'], ['POST', '/api/lab/boards'], ['PUT', '/api/lab/blocks/x']]) {
      expect(buildRouter().match(method, url)).not.toBeNull();
      expect(isCrossSiteWrite(makeReq(method, url, undefined, { origin: 'https://evil.example' }))).toBe(true);
      expect(isCrossSiteWrite(makeReq(method, url, undefined, { origin: 'http://localhost:4173' }))).toBe(false);
    }
    expect(isCrossSiteWrite(makeReq('GET', '/api/lab/boards/growth', undefined, { origin: 'https://evil.example' }))).toBe(false);
  });
});

describe('GET /api/lab/caches', () => {
  it('returns summaries + caches without any history trail', async () => {
    writeCache(root, 'visits', cacheFor('visits', 7, { funnelHistory: [] as any, datasetHistory: [] as any }));
    const { status, body } = await call('GET', '/api/lab/caches?slugs=signups,visits,ghost');
    expect(status()).toBe(200);
    expect(Object.keys(body().summaries).sort()).toEqual(['signups', 'visits']);
    expect(body().caches.signups.latest).toBe(10);
    for (const c of [body().caches.signups, body().caches.visits]) {
      expect(c).not.toHaveProperty('history');
      expect(c).not.toHaveProperty('funnelHistory');
      expect(c).not.toHaveProperty('datasetHistory');
    }
    expect(body().caches).not.toHaveProperty('ghost');
  });

  it(`refuses more than ${MAX_CACHE_SLUGS} slugs, and any unsafe one`, async () => {
    const many = Array.from({ length: MAX_CACHE_SLUGS + 1 }, (_, i) => `s-${i}`).join(',');
    expect((await call('GET', `/api/lab/caches?slugs=${many}`)).status()).toBe(400);
    const exactly = Array.from({ length: MAX_CACHE_SLUGS }, (_, i) => `s-${i}`).join(',');
    expect((await call('GET', `/api/lab/caches?slugs=${exactly}`)).status()).toBe(200);
    expect((await call('GET', '/api/lab/caches?slugs=signups,..%2Fx')).status()).toBe(400);
    expect((await call('GET', '/api/lab/caches')).status()).toBe(400);
  });
});

describe('block library routes', () => {
  it('PUT saves, GET reads back, a stale rev is a 409', async () => {
    const put = await call('PUT', '/api/lab/blocks/cohort-grid', {
      title: 'Cohort grid', inputs: [{ name: 'cohorts', kind: 'table' }], html: '<div class="dc-card"></div>', rev: null,
    });
    expect(put.status()).toBe(200);
    const rev = put.body().block.rev;
    expect((await call('GET', '/api/lab/blocks')).body().blocks.map((b: any) => b.slug)).toEqual(['cohort-grid']);
    expect((await call('GET', '/api/lab/blocks/cohort-grid')).body().block.inputs).toEqual([{ name: 'cohorts', kind: 'table' }]);
    expect((await call('PUT', '/api/lab/blocks/cohort-grid', { title: 'x', html: '<p></p>', rev: 'stale' })).status()).toBe(409);
    expect((await call('PUT', '/api/lab/blocks/cohort-grid', { title: 'x', html: '<p></p>', rev })).status()).toBe(200);
    expect((await call('PUT', '/api/lab/blocks/empty', { title: 'x', html: '' })).status()).toBe(400);
    expect((await call('GET', '/api/lab/blocks/nope')).status()).toBe(404);
  });
});

describe('sync-jobs responses carry both slots and job ids', () => {
  beforeEach(() => { _resetLabSyncJobs(); });
  afterEach(() => { _setLabSyncAllImpl(null); _resetLabSyncJobs(); });

  it('start returns job/started/queued/running/pending; a follow-up is queued: true; current mirrors it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    _setLabSyncAllImpl(async () => { await gate; return { results: [], failed: [] }; });

    const first = await call('POST', '/api/lab/sync-jobs', { slugs: ['signups'] });
    expect(first.body()).toMatchObject({ started: true, queued: false, pending: null });
    expect(first.body().running.id).toBe(first.body().job.id);
    const second = await call('POST', '/api/lab/sync-jobs', { slugs: ['mrr'], force: 'user' });
    expect(second.body().queued).toBe(true);
    expect(second.body().job.status).toBe('queued');
    expect(second.body().running.id).toBe(first.body().job.id);
    expect(second.body().pending.id).toBe(second.body().job.id);

    const current = (await call('GET', '/api/lab/sync-jobs/current')).body();
    expect(current.job.id).toBe(first.body().job.id);
    expect(current.running.id).toBe(first.body().job.id);
    expect(current.pending.id).toBe(second.body().job.id);
    expect(current.queued).toBe(true);
    release();
  });
});
