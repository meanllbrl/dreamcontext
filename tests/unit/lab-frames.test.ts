import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { saveLibraryBlock } from '../../src/lib/lab/block-library.js';
import { parseDataRef, resolveBoardFrames, resolveFrame, type TableFrame } from '../../src/lib/lab/frames.js';
import { applyFrameOps, frameOpsFromOptions } from '../../src/lib/lab/frameOps.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-lab-frames-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const base = (slug: string, extra: Partial<InsightCache> = {}): InsightCache => ({
  slug, fetchedAt: '2026-09-01T00:00:00Z', tweaks: {}, granularity: 'daily', unit: 'users',
  series: [], latest: null, error: null, errorAt: null, scriptHash: null, ...extra,
});

function seed(): void {
  createInsight(root, { slug: 'signups', title: 'Signups' });
  writeCache(root, 'signups', base('signups', {
    series: [{ name: 'signups', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 12 }, { t: '2026-09-03', v: 15 }] }],
    latest: 15,
  }));
  createInsight(root, { slug: 'revenue', title: 'Revenue', render: 'app', adapter: 'script' });
  writeCache(root, 'revenue', base('revenue', {
    datasets: {
      notices: [],
      range: { fromISO: '2026-09-01', toISO: '2026-09-30' },
      bundle: {
        kind: 'dataset/v1',
        primary: 'by-country',
        datasets: [
          { key: 'by-country', dims: [{ key: 'country', label: 'Country' }], rows: [{ d: { country: 'TR' }, v: 7 }, { d: { country: 'DE' }, v: 3 }], total: { v: 10, prev: 8 } },
          { key: 'by-plan', dims: [{ key: 'plan' }], rows: [{ d: { plan: 'pro' }, v: 4 }] },
        ],
      },
    },
  }));
  createInsight(root, { slug: 'onboarding', title: 'Onboarding', render: 'funnel', adapter: 'script' });
  writeCache(root, 'onboarding', base('onboarding', {
    funnel: {
      notices: [],
      range: { fromISO: '2026-09-01', toISO: '2026-09-30' },
      set: {
        kind: 'funnel-set/v1', dimensions: [],
        funnels: [{ id: 'f1', name: 'Main', meta: {}, metrics: {}, steps: [{ key: 's1', label: 'Start', users: 100 }, { key: 's2', label: 'Done', users: 40 }] }],
      },
    },
  }));
  createInsight(root, { slug: 'never-synced', title: 'Never' });
}

describe('parseDataRef', () => {
  it('accepts <insight> and <insight>/<dataset>, refuses traversal and encoded slashes', () => {
    expect(parseDataRef('signups')).toEqual({ insight: 'signups', dataset: null });
    expect(parseDataRef('revenue/by-country')).toEqual({ insight: 'revenue', dataset: 'by-country' });
    for (const bad of ['../signups', 'a%2Fb', '%2e%2e', 'Signups', '', 'a/', '/x', 'a--b', 42, null]) {
      expect(parseDataRef(bad)).toBeNull();
    }
  });
});

describe('resolveFrame', () => {
  beforeEach(seed);

  it('series, value (latest + prev + spark), table (primary dataset or named), funnel', () => {
    expect(resolveFrame(root, 'signups', ['series'])).toMatchObject({ kind: 'series', insight: 'signups', unit: 'users' });
    expect(resolveFrame(root, 'signups', ['value'])).toEqual({ kind: 'value', insight: 'signups', value: 15, prev: 12, spark: [10, 12, 15], unit: 'users' });
    const t = resolveFrame(root, 'revenue', ['table']) as TableFrame;
    expect(t).toMatchObject({ kind: 'table', dataset: 'by-country', total: { count: 2, v: 10 } });
    expect(t.dims).toEqual([{ key: 'country', label: 'Country' }]);
    expect(resolveFrame(root, 'revenue/by-plan', ['table'])).toMatchObject({ dataset: 'by-plan', dims: [{ key: 'plan', label: 'plan' }] });
    expect(resolveFrame(root, 'revenue/by-country', ['value'])).toMatchObject({ kind: 'value', value: 10, prev: 8 });
    expect(resolveFrame(root, 'onboarding', ['funnel'])).toEqual({
      kind: 'funnel', insight: 'onboarding',
      funnels: [{ id: 'f1', name: 'Main', steps: [{ key: 's1', label: 'Start', users: 100 }, { key: 's2', label: 'Done', users: 40 }] }],
    });
  });

  it('takes the first accepted kind the cache can build', () => {
    expect(resolveFrame(root, 'signups', ['table', 'series']).kind).toBe('series');
    expect(resolveFrame(root, 'revenue', ['table', 'series']).kind).toBe('table');
  });

  it('empty reasons: unsafe-ref, missing-insight, no-cache, missing-dataset, kind-mismatch', () => {
    expect(resolveFrame(root, '../signups', ['series'])).toEqual({ kind: 'empty', reason: 'unsafe-ref', ref: '../signups' });
    expect(resolveFrame(root, 'ghost', ['series'])).toMatchObject({ reason: 'missing-insight' });
    expect(resolveFrame(root, 'never-synced', ['series'])).toMatchObject({ reason: 'no-cache' });
    expect(resolveFrame(root, 'revenue/nope', ['table'])).toMatchObject({ reason: 'missing-dataset' });
    expect(resolveFrame(root, 'signups', ['funnel'])).toMatchObject({ reason: 'kind-mismatch' });
  });

  it('frames are un-limited; frameOps shapes them (the same code the dashboard runs)', () => {
    const t = resolveFrame(root, 'revenue', ['table']);
    const shaped = applyFrameOps(t, frameOpsFromOptions({ sort: '-v', limit: 1 })) as TableFrame;
    expect(shaped.rows).toEqual([{ d: { country: 'TR' }, v: 7 }]);
    expect(shaped.total).toMatchObject({ count: 2, v: 10 });
  });
});

describe('resolveBoardFrames', () => {
  beforeEach(seed);

  it('keys frames by card:path, walks tabs one level, resolves html inputs by DECLARED name only', () => {
    saveLibraryBlock(root, 'kpi-grid', { title: 'KPI grid', html: '<div class="dc-card"></div>', inputs: [{ name: 'money', kind: 'table' }] });
    const frames = resolveBoardFrames(root, {
      cards: [
        { id: 'c-legacy', at: { x: 0, y: 0, w: 4, h: 3 }, insight: 'signups' },
        {
          id: 'c-mix', at: { x: 4, y: 0, w: 8, h: 6 },
          blocks: [
            { type: 'stat', data: 'signups', options: {} },
            { type: 'text', options: { markdown: 'hi' } },
            { type: 'tabs', options: {}, tabs: [{ label: 'A', blocks: [{ type: 'line', data: 'signups', options: {} }] }, { label: 'B', blocks: [{ type: 'table', data: 'revenue', options: {} }] }] },
            { type: 'html', options: { html: '<p></p>', inputs: { s: 'signups', bad: '../x' } } },
            { type: 'html', options: { ref: 'kpi-grid', inputs: { money: 'revenue', sneaky: 'signups' } } },
          ],
        },
      ],
    });
    expect(Object.keys(frames).sort()).toEqual(['c-mix:0', 'c-mix:2.0.0', 'c-mix:2.1.0', 'c-mix:3#bad', 'c-mix:3#s', 'c-mix:4#money']);
    expect(frames['c-mix:0'].kind).toBe('value');
    expect(frames['c-mix:2.0.0'].kind).toBe('series');
    expect(frames['c-mix:2.1.0'].kind).toBe('table');
    expect(frames['c-mix:3#bad']).toMatchObject({ kind: 'empty', reason: 'unsafe-ref' });
    expect(frames['c-mix:4#money'].kind).toBe('table');
    expect(frames['c-mix:4#sneaky']).toBeUndefined();
  });
});
