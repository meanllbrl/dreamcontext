/**
 * The "My Reports" layer — the reports store (B1: lenient read / strict write,
 * a report OWNS NO DATA), the API (B2), the as-of date resolution (B4: latest
 * snapshot at/before the end of the chosen date, honest empty otherwise, no
 * interpolation), missing-insight leniency (B6), and the sync-job `slugs[]`
 * subset with live per-insight results (B8's backend).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createInsight, readCache, cachePath } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import {
  createReport,
  getReport,
  listReports,
  readReportFile,
  reportInsightSlugs,
  reportPath,
  resolveReport,
  resolveReportItem,
} from '../../src/lib/lab/reports-store.js';
import { handleLabReportsList, handleLabReportShow } from '../../src/server/routes/lab.js';
import { _resetLabSyncJobs, currentLabSyncJob, startLabSyncJob } from '../../src/server/lab-sync-job.js';
import { LabError } from '../../src/lib/lab/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-reports-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  _resetLabSyncJobs();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeScript(slug: string, body: string): void {
  mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'lab', 'scripts', `${slug}.mjs`), body, 'utf-8');
}

const MATRIX_SCRIPT = `export default async () => ({
  kind: 'matrix/v1',
  dims: [{ key: 'funnel' }, { key: 'language' }],
  rows: [{ d: { funnel: 'F3000', language: 'TR' }, v: 100 }],
  total: { v: 100 },
});`;

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

function makeReq(url = '/api/lab/reports'): IncomingMessage {
  const readable = Readable.from([]);
  return Object.assign(readable, { method: 'GET', headers: {}, url }) as unknown as IncomingMessage;
}

/** Rewrite a synced matrix cache's history to hand-picked dated snapshots. */
function setMatrixHistory(slug: string, ats: { at: string; v: number }[]): void {
  const path = cachePath(root, slug);
  const cache = JSON.parse(readFileSync(path, 'utf-8'));
  cache.matrixHistory = ats.map(({ at, v }) => ({
    at,
    range: { fromISO: '2026-08-01', toISO: '2026-08-25' },
    rows: [{ d: { funnel: 'F3000', language: 'TR' }, v }],
    total: { v },
  }));
  writeFileSync(path, JSON.stringify(cache), 'utf-8');
}

describe('reports store (B1)', () => {
  it('creates a report and round-trips it through the lenient read', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const r = createReport(root, {
      slug: 'daily', title: 'Daily Product Report', description: 'The day at a glance',
      date_nav: 'daily', insights: ['wau'],
    });
    expect(r.slug).toBe('daily');
    expect(r.date_nav).toBe('daily');
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].items).toEqual([{ insight: 'wau' }]);
    expect(r.notes).toContain('## Notes');
    expect(listReports(root).map((x) => x.slug)).toEqual(['daily']);
  });

  it('write path is STRICT: bad slug, empty title, bad date_nav, unknown insight', () => {
    expect(() => createReport(root, { slug: 'Bad Slug', title: 'T' })).toThrow(LabError);
    expect(() => createReport(root, { slug: 'ok', title: '  ' })).toThrow(LabError);
    expect(() => createReport(root, { slug: 'ok', title: 'T', date_nav: 'hourly' as never })).toThrow(LabError);
    expect(() => createReport(root, { slug: 'ok', title: 'T', insights: ['ghost'] }))
      .toThrow(/composes EXISTING insights/);
  });

  it('read path is LENIENT: malformed sections/items degrade, never throw', () => {
    mkdirSync(join(root, 'lab', 'reports'), { recursive: true });
    writeFileSync(reportPath(root, 'messy'), [
      '---',
      'title: Messy',
      'date_nav: fortnightly', // unknown → none
      'sections:',
      '  - title: Good',
      '    items:',
      '      - insight: wau',
      '      - {}', // no insight → skipped
      '  - "garbage"', // not a record → skipped
      '  - items:', // no title → default
      '      - insight: mrr',
      '        breakdown: { rows: funnel, cols: language, filter: { plan: pro } }',
      '---',
      'Prose body.',
    ].join('\n'), 'utf-8');
    const r = readReportFile(reportPath(root, 'messy'));
    expect(r.date_nav).toBe('none');
    expect(r.sections).toHaveLength(2);
    expect(r.sections[0].items).toEqual([{ insight: 'wau' }]);
    expect(r.sections[1].title).toBe('Section 2');
    expect(r.sections[1].items[0].breakdown).toEqual({ rows: 'funnel', cols: 'language', filter: { plan: 'pro' } });
    expect(reportInsightSlugs(r).sort()).toEqual(['mrr', 'wau']);
  });

  it('a report owns NO data: creating one writes nothing under lab/cache', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    createReport(root, { slug: 'daily', title: 'Daily', insights: ['wau'] });
    expect(readCache(root, 'wau')).toBeNull();
  });
});

describe('as-of date resolution (B4)', () => {
  it('a dated matrix item resolves to the LATEST snapshot at/before end of that date', async () => {
    createInsight(root, { slug: 'bd', title: 'BD', render: 'breakdown', adapter: 'script' });
    writeScript('bd', MATRIX_SCRIPT);
    await syncInsight(root, 'bd', { force: true });
    setMatrixHistory('bd', [
      { at: '2026-08-20T09:00:00Z', v: 80 },
      { at: '2026-08-22T09:00:00Z', v: 90 },
      { at: '2026-08-24T09:00:00Z', v: 100 },
    ]);

    const resolved = resolveReportItem(root, { insight: 'bd' }, '2026-08-23');
    expect(resolved.missing).toBe(false);
    expect(resolved.asOf).toBe('2026-08-22T09:00:00Z'); // as-of stamp is visible
    expect(resolved.matrixSnapshot?.total?.v).toBe(90);
    expect(resolved.latest).toBe(90);
  });

  it('no snapshot at/before the date → honest empty (asOf null), NO interpolation', async () => {
    createInsight(root, { slug: 'bd', title: 'BD', render: 'breakdown', adapter: 'script' });
    writeScript('bd', MATRIX_SCRIPT);
    await syncInsight(root, 'bd', { force: true });
    setMatrixHistory('bd', [{ at: '2026-08-20T09:00:00Z', v: 80 }]);

    const resolved = resolveReportItem(root, { insight: 'bd' }, '2026-08-19');
    expect(resolved.asOf).toBeNull();
    expect(resolved.matrixSnapshot).toBeNull();
    expect(resolved.latest).toBeNull();
  });

  it('a plain series item resolves through its ok sync events', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU', adapter: 'script' });
    writeScript('wau', `export default async () => ([{ name: 'wau', points: [{ t: '2026-08-25', v: 7 }] }]);`);
    await syncInsight(root, 'wau', { force: true });
    // Rewrite history to known dates.
    const path = cachePath(root, 'wau');
    const cache = JSON.parse(readFileSync(path, 'utf-8'));
    cache.history = [
      { at: '2026-08-20T09:00:00Z', status: 'ok', latest: 5, granularity: 'daily', error: null },
      { at: '2026-08-21T09:00:00Z', status: 'failed', latest: null, granularity: null, error: 'x' },
      { at: '2026-08-24T09:00:00Z', status: 'ok', latest: 7, granularity: 'daily', error: null },
    ];
    writeFileSync(path, JSON.stringify(cache), 'utf-8');

    const resolved = resolveReportItem(root, { insight: 'wau' }, '2026-08-22');
    expect(resolved.asOf).toBe('2026-08-20T09:00:00Z'); // failed events never count
    expect(resolved.latest).toBe(5);
  });

  it('live resolution (no date) hands back the current cache stamped with fetchedAt', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU', adapter: 'script' });
    writeScript('wau', `export default async () => ([{ name: 'wau', points: [{ t: '2026-08-25', v: 7 }] }]);`);
    await syncInsight(root, 'wau', { force: true });
    const resolved = resolveReportItem(root, { insight: 'wau' }, null);
    expect(resolved.cache).not.toBeNull();
    expect(resolved.asOf).toBe(resolved.cache!.fetchedAt);
    expect(resolved.latest).toBe(7);
  });
});

describe('missing-insight leniency (B6)', () => {
  it('a deleted insight resolves to missing:true — nothing throws', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const report = createReport(root, { slug: 'daily', title: 'Daily', insights: ['wau'] });
    rmSync(join(root, 'lab', 'insights', 'wau.md'));
    const sections = resolveReport(root, report, null);
    expect(sections[0].items[0].missing).toBe(true);
    expect(sections[0].items[0].asOf).toBeNull();
  });
});

describe('reports API (B2)', () => {
  it('GET /api/lab/reports lists reports with counts', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    createReport(root, { slug: 'daily', title: 'Daily', insights: ['wau'] });
    const { res, status, body } = makeRes();
    await handleLabReportsList(makeReq(), res, {}, root);
    expect(status()).toBe(200);
    expect(body().reports).toEqual([
      { slug: 'daily', title: 'Daily', description: null, date_nav: 'daily', sections: 1, items: 1 },
    ]);
  });

  it('GET /api/lab/reports/:slug?date= resolves items as of the date', async () => {
    createInsight(root, { slug: 'bd', title: 'BD', render: 'breakdown', adapter: 'script' });
    writeScript('bd', MATRIX_SCRIPT);
    await syncInsight(root, 'bd', { force: true });
    setMatrixHistory('bd', [{ at: '2026-08-20T09:00:00Z', v: 80 }, { at: '2026-08-24T09:00:00Z', v: 100 }]);
    createReport(root, { slug: 'daily', title: 'Daily', insights: ['bd'] });

    const { res, status, body } = makeRes();
    await handleLabReportShow(makeReq('/api/lab/reports/daily?date=2026-08-21'), res, { slug: 'daily' }, root);
    expect(status()).toBe(200);
    expect(body().date).toBe('2026-08-21');
    const item = body().sections[0].items[0];
    expect(item.asOf).toBe('2026-08-20T09:00:00Z');
    expect(item.matrixSnapshot.total.v).toBe(80);
  });

  it('rejects a malformed date with 400 and an unknown report with 404', async () => {
    createReport(root, { slug: 'daily', title: 'Daily' });
    const bad = makeRes();
    await handleLabReportShow(makeReq('/api/lab/reports/daily?date=yesterday'), bad.res, { slug: 'daily' }, root);
    expect(bad.status()).toBe(400);

    const missing = makeRes();
    await handleLabReportShow(makeReq('/api/lab/reports/nope'), missing.res, { slug: 'nope' }, root);
    expect(missing.status()).toBe(404);
  });

  it('the reports routes are registered BEFORE /api/lab/:slug (first match wins)', () => {
    const source = readFileSync(join(import.meta.dirname, '../../src/server/index.ts'), 'utf-8');
    const reportsAt = source.indexOf("router.get('/api/lab/reports'");
    const slugAt = source.indexOf("router.get('/api/lab/:slug'");
    expect(reportsAt).toBeGreaterThan(-1);
    expect(reportsAt).toBeLessThan(slugAt);
  });
});

describe('sync-job slugs[] subset (B8 backend)', () => {
  function scriptInsight(slug: string): void {
    createInsight(root, { slug, title: slug, adapter: 'script' });
    writeScript(slug, `export default async () => ([{ name: '${slug}', points: [{ t: '2026-08-25', v: 1 }] }]);`);
  }

  async function settled(): Promise<NonNullable<ReturnType<typeof currentLabSyncJob>>> {
    for (let i = 0; i < 200; i++) {
      const job = currentLabSyncJob(root);
      if (job && job.status !== 'running') return job;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job never settled');
  }

  it('a scoped job syncs ONLY the requested slugs', async () => {
    scriptInsight('a'); scriptInsight('b'); scriptInsight('c');
    const { started, job } = startLabSyncJob(root, { slugs: ['a', 'c'] });
    expect(started).toBe(true);
    expect(job.slugs).toEqual(['a', 'c']);

    const done = await settled();
    expect(done.status).toBe('success');
    expect(done.results.map((r) => r.slug).sort()).toEqual(['a', 'c']);
    expect(readCache(root, 'a')).not.toBeNull();
    expect(readCache(root, 'b')).toBeNull(); // untouched
  });

  it('results fill LIVE as insights settle (the progressive section fill feed)', async () => {
    scriptInsight('a'); scriptInsight('b');
    startLabSyncJob(root, { slugs: ['a', 'b'] });
    // Poll mid-run and after: every observed results array is append-only and
    // carries per-slug outcomes the report page can flip sections on.
    const done = await settled();
    expect(done.results.every((r) => r.slug === 'a' || r.slug === 'b')).toBe(true);
    expect(done.results).toHaveLength(2);
    expect(done.current).toBeNull(); // cleared on settle
  });

  it('a running job is ADOPTED — a scoped request never spawns a second engine', async () => {
    scriptInsight('a');
    const first = startLabSyncJob(root, {});
    const second = startLabSyncJob(root, { slugs: ['a'] });
    expect(second.started).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    await settled();
  });
});
