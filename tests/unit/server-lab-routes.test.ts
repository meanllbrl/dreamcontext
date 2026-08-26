import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleLabList,
  handleLabShow,
  handleLabSync,
  handleLabSyncJobStart,
  handleLabSyncJobCurrent,
  handleLabTweaks,
  handleLabBinding,
  handleLabCredentialsGet,
  handleLabCredentialsSet,
} from '../../src/server/routes/lab.js';
import { _resetLabSyncJobs, currentLabSyncJob } from '../../src/server/lab-sync-job.js';
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

  /**
   * The funnel snapshot trail is the INPUT to `computeFunnelPrev`, which this
   * route already ran. No client reads it, and left in it DOMINATED the
   * response: measured on a live 6-funnel insight, 191,234 of 226,232 bytes
   * (84.5%) were 40 snapshots nobody opened — re-shipped on every window change
   * and every board invalidation.
   */
  it('omits funnelHistory but still serves the deltas derived from it', async () => {
    createInsight(root, { slug: 'funnels', title: 'Funnels' });
    const funnelSet = {
      kind: 'funnel-set/v1' as const,
      primary: 'users',
      funnels: [{
        id: 'f1',
        name: 'One',
        metrics: { users: { v: 120, format: 'count' } },
        steps: [{ key: 'a', label: 'A', users: 120 }],
      }],
    };
    writeCache(root, 'funnels', {
      slug: 'funnels', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: 120, error: null, errorAt: null, scriptHash: null,
      funnel: { set: funnelSet as any, notices: [], range: { fromISO: '2026-02-08', toISO: '2026-02-15' } },
      funnelHistory: [{
        at: '2026-02-08T00:00:00.000Z',
        range: { fromISO: '2026-02-01', toISO: '2026-02-08' },
        funnels: [{ id: 'f1', metrics: { users: 100 }, steps: [{ key: 'a', users: 100 }] }],
      }],
    });

    const { res, status, body } = makeRes();
    await handleLabShow(makeReq('GET'), res, { slug: 'funnels' }, root);

    expect(status()).toBe(200);
    expect(body().cache.funnelHistory).toBeUndefined();
    expect(JSON.stringify(body())).not.toContain('funnelHistory');
    // The trail is dropped, not its VALUE: the previous period still resolves.
    expect(body().funnelPrev.metrics.f1.users).toBe(100);
    expect(body().funnelPrev.source.range).toEqual({ fromISO: '2026-02-01', toISO: '2026-02-08' });
    // Everything the dashboard actually reads survives.
    expect(body().cache.funnel.set.funnels[0].metrics.users.v).toBe(120);
  });

  it('leaves a cache with no funnel trail untouched', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeCache(root, 'wau', {
      slug: 'wau', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: 1, error: null, errorAt: null, scriptHash: null,
    });
    const { res, body } = makeRes();
    await handleLabShow(makeReq('GET'), res, { slug: 'wau' }, root);
    expect(body().cache.slug).toBe('wau');
    expect(body().funnelPrev).toBeNull();
  });

  // Same cost profile as funnelHistory (T7): datasetHistory is an app insight's
  // dated trail — bounded, but nobody past this route reads it (the bridge
  // reads `cache.datasets` for the CURRENT bundle; Reports reads history
  // straight off disk via `readCache`, never through this route).
  it('omits datasetHistory but still serves the current dataset bundle', async () => {
    createInsight(root, { slug: 'breakdown-app', title: 'Breakdown app', render: 'app' });
    const bundle = {
      kind: 'dataset/v1' as const,
      primary: 'usage',
      datasets: [{ key: 'usage', dims: [{ key: 'plan' }], rows: [{ d: { plan: 'pro' }, v: 42 }] }],
    };
    writeCache(root, 'breakdown-app', {
      slug: 'breakdown-app', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: 42, error: null, errorAt: null, scriptHash: null,
      datasets: { bundle, notices: [], range: { fromISO: '2026-02-08', toISO: '2026-02-15' } },
      datasetHistory: [{
        at: '2026-02-08T00:00:00.000Z',
        range: { fromISO: '2026-02-01', toISO: '2026-02-08' },
        bundle,
      }],
    });

    const { res, status, body } = makeRes();
    await handleLabShow(makeReq('GET'), res, { slug: 'breakdown-app' }, root);

    expect(status()).toBe(200);
    expect(body().cache.datasetHistory).toBeUndefined();
    expect(JSON.stringify(body())).not.toContain('datasetHistory');
    // The trail is dropped, not the CURRENT bundle.
    expect(body().cache.datasets.bundle.datasets[0].rows[0].v).toBe(42);
  });

  it('strips BOTH funnelHistory and datasetHistory off the same cache in one pass', async () => {
    createInsight(root, { slug: 'both', title: 'Both trails', render: 'app' });
    const funnelSet = {
      kind: 'funnel-set/v1' as const,
      funnels: [{ id: 'f1', name: 'One', metrics: {}, steps: [{ key: 'a', label: 'A', users: 1 }] }],
    };
    const bundle = { kind: 'dataset/v1' as const, datasets: [{ key: 'usage', dims: [], rows: [] }] };
    writeCache(root, 'both', {
      slug: 'both', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      funnel: { set: funnelSet as any, notices: [], range: { fromISO: '2026-02-08', toISO: '2026-02-15' } },
      funnelHistory: [{ at: '2026-02-08T00:00:00.000Z', range: { fromISO: '2026-02-01', toISO: '2026-02-08' }, funnels: [] }],
      datasets: { bundle, notices: [], range: { fromISO: '2026-02-08', toISO: '2026-02-15' } },
      datasetHistory: [{ at: '2026-02-08T00:00:00.000Z', range: { fromISO: '2026-02-01', toISO: '2026-02-08' }, bundle }],
    });

    const { res, body } = makeRes();
    await handleLabShow(makeReq('GET'), res, { slug: 'both' }, root);

    const json = JSON.stringify(body());
    expect(json).not.toContain('funnelHistory');
    expect(json).not.toContain('datasetHistory');
    expect(body().cache.funnel).toBeDefined();
    expect(body().cache.datasets).toBeDefined();
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

describe('POST /api/lab/sync-jobs — bulk sync outlives the request', () => {
  beforeEach(() => { _resetLabSyncJobs(); });

  /** Poll the job registry until the run settles. */
  async function settle(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = currentLabSyncJob(root);
      if (job && job.status !== 'running') return job;
      if (Date.now() > deadline) throw new Error('job never settled');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('answers IMMEDIATELY with a running job instead of holding the socket for the run', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    // 400ms of work: the response must land well before the run does.
    writeFileSync(
      join(root, 'lab', 'scripts', 'wau.mjs'),
      'export default async () => { await new Promise((r) => setTimeout(r, 400)); return [{ name: "d", points: [{ t: "2026-01-01", v: 3 }] }]; };\n',
      'utf-8',
    );

    const { res, status, body } = makeRes();
    const started = Date.now();
    await handleLabSyncJobStart(makeReq('POST', { force: true }), res, {}, root);
    const elapsed = Date.now() - started;

    expect(status()).toBe(200);
    expect(body().started).toBe(true);
    expect(body().job.status).toBe('running');
    expect(elapsed).toBeLessThan(300);

    const settled = await settle();
    expect(settled.status).toBe('success');
    expect(settled.results[0].latest).toBe(3);
  }, 25_000);

  it('a second press ADOPTS the running job (started:false), never a second engine', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'scripts', 'wau.mjs'),
      'export default async () => { await new Promise((r) => setTimeout(r, 300)); return [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }]; };\n',
      'utf-8',
    );

    const first = makeRes();
    await handleLabSyncJobStart(makeReq('POST', {}), first.res, {}, root);
    const second = makeRes();
    await handleLabSyncJobStart(makeReq('POST', {}), second.res, {}, root);

    expect(first.body().started).toBe(true);
    expect(second.body().started).toBe(false);
    expect(second.body().job.id).toBe(first.body().job.id);
    await settle();
  }, 25_000);

  it('GET /api/lab/sync-jobs/current returns null when nothing has run', async () => {
    const { res, status, body } = makeRes();
    await handleLabSyncJobCurrent(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body().job).toBeNull();
  });

  it('GET /api/lab/sync-jobs/current re-adopts the settled outcome for a returning page', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'scripts', 'wau.mjs'),
      'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 9 }] }];\n',
      'utf-8',
    );

    const start = makeRes();
    await handleLabSyncJobStart(makeReq('POST', {}), start.res, {}, root);
    await settle();

    const { res, status, body } = makeRes();
    await handleLabSyncJobCurrent(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body().job.id).toBe(start.body().job.id);
    expect(body().job.status).toBe('success');
    expect(body().job.done).toBe(1);
    expect(body().job.total).toBe(1);
  }, 25_000);

  it('400s on a non-JSON body', async () => {
    const bad = Object.assign(Readable.from([Buffer.from('not json')]), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    const { res, status } = makeRes();
    await handleLabSyncJobStart(bad, res, {}, root);
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

describe('GET/POST /api/lab/credentials — key status only, never a value', () => {
  // Nested context root: the POST handler derives the project root as
  // dirname(contextRoot), so gitignore writes must land inside the temp dir.
  let ctx: string;

  beforeEach(() => {
    ctx = join(root, '_dream_context');
    mkdirSync(ctx, { recursive: true });
  });

  function writeManifest(slug: string, frontmatterYaml: string): void {
    mkdirSync(join(ctx, 'lab', 'insights'), { recursive: true });
    writeFileSync(join(ctx, 'lab', 'insights', `${slug}.md`), `---\n${frontmatterYaml}\n---\n## Meaning\n`, 'utf-8');
  }

  it('GET reports present/missing per required key with usedBy slugs — and never a value', async () => {
    writeManifest('declared', 'title: Declared\ncredentials_used: [sharedKey, emptyKey]');
    writeManifest('placeholder', [
      'title: Placeholder',
      'source:',
      '  adapter: http',
      '  http:',
      '    endpoint: "https://api.example.com?key={{cred:sharedKey}}"',
      '    method: GET',
      '    headers:',
      '      Authorization: "Bearer {{cred:missingKey}}"',
    ].join('\n'));
    mkdirSync(join(ctx, 'lab'), { recursive: true });
    writeFileSync(join(ctx, 'lab', 'credentials.json'), JSON.stringify({ sharedKey: 'sk-secret-value', emptyKey: '' }), 'utf-8');

    const { res, status, body } = makeRes();
    await handleLabCredentialsGet(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().keys).toEqual([
      { key: 'emptyKey', present: false, usedBy: ['declared'] },
      { key: 'missingKey', present: false, usedBy: ['placeholder'] },
      { key: 'sharedKey', present: true, usedBy: ['declared', 'placeholder'] },
    ]);
    expect(JSON.stringify(body())).not.toContain('sk-secret-value');
  });

  it('GET returns keys: [] with no insights', async () => {
    const { res, status, body } = makeRes();
    await handleLabCredentialsGet(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().keys).toEqual([]);
  });

  it('POST stores the credential, refreshes the tracked example, and never echoes the value', async () => {
    writeManifest('wau', 'title: WAU\ncredentials_used: [apiKey]');

    const { res, status, body } = makeRes();
    await handleLabCredentialsSet(makeReq('POST', { key: 'apiKey', value: 'sk-live-999' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().keys).toEqual([{ key: 'apiKey', present: true, usedBy: ['wau'] }]);
    expect(JSON.stringify(body())).not.toContain('sk-live-999');

    // The tracked example carries the key with an EMPTY value.
    const example = readFileSync(join(ctx, 'lab', 'credentials.example.json'), 'utf-8');
    expect(JSON.parse(example)).toEqual({ apiKey: '' });
    // Gitignore-first writeCredential ran: negation entries keep the example tracked.
    expect(readFileSync(join(ctx, '.gitignore'), 'utf-8')).toContain('!lab/credentials.example.json');
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain('!_dream_context/lab/credentials.example.json');
  });

  it('400s on a missing/empty key or value (and writes nothing)', async () => {
    for (const bad of [{}, { key: 'apiKey' }, { key: 'apiKey', value: '' }, { key: '', value: 'v' }, { key: 'apiKey', value: 42 }]) {
      const { res, status } = makeRes();
      await handleLabCredentialsSet(makeReq('POST', bad), res, {}, ctx);
      expect(status()).toBe(400);
    }
    expect(existsSync(join(ctx, 'lab', 'credentials.json'))).toBe(false);
  });
});
