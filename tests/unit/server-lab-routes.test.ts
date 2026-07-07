import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleLabList,
  handleLabShow,
  handleLabSync,
  handleLabTweaks,
  handleLabBinding,
} from '../../src/server/routes/lab.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { createObjective, getObjective } from '../../src/lib/objectives-store.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';

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

function makeReq(method: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, { method, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
}

let root: string;

function useScriptSource(slug: string, file: string): void {
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter(path);
  writeFrontmatter(path, { ...data, source: { adapter: 'script', script: { file } } }, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-routes-'));
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/lab — list', () => {
  it('lists insight summaries', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU', unit: 'users' });
    const { res, status, body } = makeRes();
    await handleLabList(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body().insights).toHaveLength(1);
    expect(body().insights[0].slug).toBe('wau');
  });

  it('never returns a credential value', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const { res, body } = makeRes();
    await handleLabList(makeReq('GET'), res, {}, root);
    expect(JSON.stringify(body())).not.toContain('credentials.json');
  });
});

describe('GET /api/lab/:slug — show', () => {
  it('returns the full manifest + cached series', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeCache(root, 'wau', {
      slug: 'wau', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [{ name: 'default', points: [{ t: '2026-01-01', v: 1 }] }],
      latest: 1, error: null, errorAt: null, scriptHash: null,
    });
    const { res, status, body } = makeRes();
    await handleLabShow(makeReq('GET'), res, { slug: 'wau' }, root);
    expect(status()).toBe(200);
    expect(body().insight.slug).toBe('wau');
    expect(body().cache.series).toHaveLength(1);
  });

  it('404s for an unknown slug', async () => {
    const { res, status } = makeRes();
    await handleLabShow(makeReq('GET'), res, { slug: 'nope' }, root);
    expect(status()).toBe(404);
  });
});

describe('POST /api/lab/sync — runs the same engine as the CLI', () => {
  it('syncs one insight by slug', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', 'wau.mjs'), 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 5 }] }];\n', 'utf-8');

    const { res, status, body } = makeRes();
    await handleLabSync(makeReq('POST', { slug: 'wau', force: true }), res, {}, root);
    expect(status()).toBe(200);
    expect(body().results[0].status).toBe('ok');
    expect(body().failed).toEqual([]);
  });

  it('runs {all:true} and returns a non-empty failed[] when one insight errors', async () => {
    createInsight(root, { slug: 'good', title: 'Good' });
    useScriptSource('good', 'scripts/good.mjs');
    createInsight(root, { slug: 'bad', title: 'Bad' });
    useScriptSource('bad', 'scripts/bad.mjs');
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', 'good.mjs'), 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];\n', 'utf-8');
    writeFileSync(join(root, 'lab', 'scripts', 'bad.mjs'), 'export default async () => { throw new Error("nope"); };\n', 'utf-8');

    const { res, status, body } = makeRes();
    await handleLabSync(makeReq('POST', { all: true, force: true }), res, {}, root);
    expect(status()).toBe(200);
    expect(body().failed.length).toBeGreaterThan(0);
  });

  it('400s on a missing slug/all', async () => {
    const { res, status } = makeRes();
    await handleLabSync(makeReq('POST', {}), res, {}, root);
    expect(status()).toBe(400);
  });
});

describe('PATCH /api/lab/:slug/tweaks — persists', () => {
  it('persists a tweak value', async () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'insights', 'wau.md'),
      '---\ntitle: WAU\nrender: number\ntweaks:\n  - key: range\n    type: enum\n    options: ["last_30_days", "last_1_year"]\n---\n## Meaning\n',
      'utf-8',
    );
    const { res, status, body } = makeRes();
    await handleLabTweaks(makeReq('PATCH', { tweaks: { range: 'last_1_year' } }), res, { slug: 'wau' }, root);
    expect(status()).toBe(200);
    expect(body().insight.tweaks[0].value).toBe('last_1_year');
  });

  it('404s for an unknown slug', async () => {
    const { res, status } = makeRes();
    await handleLabTweaks(makeReq('PATCH', { tweaks: { x: 'y' } }), res, { slug: 'nope' }, root);
    expect(status()).toBe(404);
  });

  it('400s on an invalid body', async () => {
    const { res, status } = makeRes();
    await handleLabTweaks(makeReq('PATCH', {}), res, { slug: 'wau' }, root);
    expect(status()).toBe(400);
  });
});

describe('PATCH /api/lab/:slug/binding — connect/disconnect an objective Key Result', () => {
  it('connects an insight, seeds metric.current from the cache, and unbinds the previous feeder', async () => {
    createObjective(root, { slug: 'mrr-goal', title: 'MRR', metric: { label: 'MRR', unit: 'USD', baseline: 0, target: 2000, current: 0 } });
    createInsight(root, { slug: 'mrr', title: 'MRR insight', unit: 'USD' });
    createInsight(root, { slug: 'old-feeder', title: 'Old feeder' });
    // old-feeder currently feeds the objective — connecting mrr must move it.
    {
      const { res, status } = makeRes();
      await handleLabBinding(makeReq('PATCH', { binding: { objective: 'mrr-goal' } }), res, { slug: 'old-feeder' }, root);
      expect(status()).toBe(200);
    }
    writeCache(root, 'mrr', {
      slug: 'mrr', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: 'USD', series: [{ name: 'default', points: [{ t: '2026-07-01', v: 850 }] }],
      latest: 850, error: null, errorAt: null, scriptHash: null,
    });
    const { res, status, body } = makeRes();
    await handleLabBinding(makeReq('PATCH', { binding: { objective: 'mrr-goal' } }), res, { slug: 'mrr' }, root);
    expect(status()).toBe(200);
    expect(body().insight.binding).toEqual({ objective: 'mrr-goal', value: 'latest' });
    expect(body().unbound).toEqual(['old-feeder']);
    expect(body().seededCurrent).toBe(850);
    expect(getObjective(root, 'mrr-goal')?.metric?.current).toBe(850);
  });

  it('disconnects with binding: null', async () => {
    createObjective(root, { slug: 'goal', title: 'Goal', metric: { label: 'X', unit: null, baseline: 0, target: 10, current: 0 } });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    {
      const { res } = makeRes();
      await handleLabBinding(makeReq('PATCH', { binding: { objective: 'goal' } }), res, { slug: 'wau' }, root);
    }
    const { res, status, body } = makeRes();
    await handleLabBinding(makeReq('PATCH', { binding: null }), res, { slug: 'wau' }, root);
    expect(status()).toBe(200);
    expect(body().insight.binding).toBeNull();
  });

  it('404s when the objective does not exist (nothing written)', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const { res, status } = makeRes();
    await handleLabBinding(makeReq('PATCH', { binding: { objective: 'no-such-objective' } }), res, { slug: 'wau' }, root);
    expect(status()).toBe(404);
    const { res: res2, body: body2 } = makeRes();
    await handleLabShow(makeReq('GET'), res2, { slug: 'wau' }, root);
    expect(body2().insight.binding).toBeNull();
  });

  it('404s for an unknown insight and 400s on a malformed body / bad value', async () => {
    createObjective(root, { slug: 'goal', title: 'Goal' });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    {
      const { res, status } = makeRes();
      await handleLabBinding(makeReq('PATCH', { binding: { objective: 'goal' } }), res, { slug: 'nope' }, root);
      expect(status()).toBe(404);
    }
    {
      const { res, status } = makeRes();
      await handleLabBinding(makeReq('PATCH', {}), res, { slug: 'wau' }, root);
      expect(status()).toBe(400);
    }
    {
      const { res, status } = makeRes();
      await handleLabBinding(makeReq('PATCH', { binding: { objective: 'goal', value: 'series:' } }), res, { slug: 'wau' }, root);
      expect(status()).toBe(400);
    }
  });

  it('connects without seeding when the objective has no metric or the cache is empty', async () => {
    createObjective(root, { slug: 'no-metric', title: 'No metric' });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const { res, status, body } = makeRes();
    await handleLabBinding(makeReq('PATCH', { binding: { objective: 'no-metric' } }), res, { slug: 'wau' }, root);
    expect(status()).toBe(200);
    expect(body().insight.binding).toEqual({ objective: 'no-metric', value: 'latest' });
    expect(body().seededCurrent).toBeNull();
  });
});
