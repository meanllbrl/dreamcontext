import { describe, it, expect } from 'vitest';
import { htmlToText } from '../../src/lib/lab/htmlText.js';
import { queryDataset, resolveDatasetAsOf } from '../../src/lib/lab/datasetQuery.js';
import type { DatasetBundle, DatasetSnapshot, InsightCache } from '../../src/lib/lab/types.js';

/**
 * T3 unit coverage: `htmlToText` (html/v1 + app/v1 page extraction),
 * `queryDataset` (the `lab query` slice/aggregate engine) and
 * `resolveDatasetAsOf` (the reports as-of rule over dataset bundles).
 * Pure-function tests only — no CLI subprocess, no sync engine — so this
 * file has zero coupling to T2's in-flight sync/adapter work.
 */

describe('htmlToText', () => {
  it('extracts plain text, turning block tags into line breaks', () => {
    const html = '<div><p>Hello</p><p>World</p></div>';
    expect(htmlToText(html)).toBe('Hello\n\nWorld');
  });

  it('drops script and style CONTENTS entirely, in both formats', () => {
    const html = '<style>.x{color:red}</style><p>Visible</p><script>evil();</script>';
    expect(htmlToText(html)).toBe('Visible');
    expect(htmlToText(html, { format: 'md' })).toBe('Visible');
  });

  it('decodes named entities', () => {
    expect(htmlToText('<p>A &amp; B &mdash; C</p>')).toBe('A & B — C');
  });

  it('decodes numeric entities (decimal and hex)', () => {
    expect(htmlToText('<p>&#8212;&#x2014;</p>')).toBe('——');
  });

  it('renders headings with a # prefix in md, plain in text', () => {
    const html = '<h1>Title</h1><h3>Sub</h3>';
    expect(htmlToText(html, { format: 'md' })).toBe('# Title\n\n### Sub');
    expect(htmlToText(html, { format: 'text' })).toBe('Title\n\nSub');
  });

  it('renders list items with a "- " prefix in md, plain in text', () => {
    const html = '<ul><li>Alpha</li><li>Beta</li></ul>';
    expect(htmlToText(html, { format: 'md' })).toBe('- Alpha\n\n- Beta');
    expect(htmlToText(html, { format: 'text' })).toBe('Alpha\n\nBeta');
  });

  it('renders a table as a GFM pipe table in md, a plain listing in text', () => {
    const html = '<table><tr><th>Funnel</th><th>Users</th></tr><tr><td>F3000</td><td>119000</td></tr></table>';
    expect(htmlToText(html, { format: 'md' })).toBe(
      '| Funnel | Users |\n| --- | --- |\n| F3000 | 119000 |',
    );
    expect(htmlToText(html, { format: 'text' })).toBe('Funnel  Users\nF3000  119000');
  });

  it('collapses runs of blank lines to at most one', () => {
    const html = '<p>A</p><div></div><div></div><div></div><p>B</p>';
    const out = htmlToText(html);
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toBe('A\n\nB');
  });

  it('text format never emits markdown syntax characters', () => {
    const html = '<h2>Head</h2><ul><li>Item</li></ul><table><tr><th>A</th></tr><tr><td>1</td></tr></table>';
    const out = htmlToText(html, { format: 'text' });
    expect(out).not.toContain('#');
    expect(out).not.toContain('- Item');
    expect(out).not.toContain('|');
  });

  it('truncates to maxChars and marks the cut with an ellipsis', () => {
    const html = '<p>' + 'x'.repeat(50) + '</p>';
    const out = htmlToText(html, { maxChars: 10 });
    expect(out.length).toBe(11); // 10 chars + the ellipsis mark
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate when under maxChars', () => {
    expect(htmlToText('<p>short</p>', { maxChars: 100 })).toBe('short');
  });

  it('a plain number in the body text is never eaten by table-restore tokens', () => {
    // Regression guard: the table placeholder must not collide with digits
    // that appear naturally in the body (e.g. a value right after a table).
    const html = '<table><tr><td>A</td></tr></table><p>42</p>';
    const out = htmlToText(html, { format: 'text' });
    expect(out).toBe('A\n\n42');
  });
});

// ─── queryDataset ────────────────────────────────────────────────────────────

function fixtureBundle(): DatasetBundle {
  return {
    kind: 'dataset/v1',
    primary: 'breakdown',
    datasets: [
      {
        key: 'breakdown',
        label: 'Funnel × Language',
        dims: [{ key: 'funnel', label: 'Funnel' }, { key: 'language', label: 'Language' }],
        rows: [
          { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200, prev: 101000 },
          { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100, prev: 80000 },
          { d: { funnel: 'F4000', language: 'TR' }, v: 52000, n: 1800 },
          { d: { funnel: 'F4000', language: 'EN' }, v: 31000, n: 25 },
        ],
        total: { v: 286000, n: 9125 },
      },
      {
        key: 'steps',
        dims: [{ key: 'step' }],
        rows: [{ d: { step: 'start' }, v: 100 }, { d: { step: 'finish' }, v: 40 }],
      },
    ],
  };
}

describe('queryDataset', () => {
  it('resolves the bundle primary when no dataset key is given', () => {
    const result = queryDataset(fixtureBundle(), {});
    expect(result.dataset).toBe('breakdown');
    expect(result.rows).toHaveLength(4);
  });

  it('resolves a named dataset', () => {
    const result = queryDataset(fixtureBundle(), { dataset: 'steps' });
    expect(result.dataset).toBe('steps');
    expect(result.rows).toHaveLength(2);
  });

  it('an unknown dataset key is an honest miss with a notice, never a fallback', () => {
    const result = queryDataset(fixtureBundle(), { dataset: 'nope' });
    expect(result.dataset).toBe('nope');
    expect(result.rows).toEqual([]);
    expect(result.notices.some((n) => n.includes('"nope"') && n.includes('not found'))).toBe(true);
  });

  it('applies a where filter as an exact match', () => {
    const result = queryDataset(fixtureBundle(), { where: { language: 'TR' } });
    expect(result.rows.map((r) => r.d.funnel).sort()).toEqual(['F3000', 'F4000']);
    expect(result.rows.every((r) => r.d.language === 'TR')).toBe(true);
  });

  it('an unknown dim in --where is noticed and ignored, not silently dropped', () => {
    const result = queryDataset(fixtureBundle(), { where: { plan: 'pro' } });
    expect(result.rows).toHaveLength(4); // filter had no effect
    expect(result.notices.some((n) => n.includes('unknown dim "plan"'))).toBe(true);
  });

  it('group-by collapses to one row per value, summing v and n', () => {
    const result = queryDataset(fixtureBundle(), { groupBy: 'funnel' });
    expect(result.dims).toEqual(['funnel']);
    const f3000 = result.rows.find((r) => r.d.funnel === 'F3000')!;
    expect(f3000.v).toBe(119000 + 84000);
    expect(f3000.n).toBe(4200 + 3100);
  });

  it('group-by sums prev only when every collapsed row carries one', () => {
    const result = queryDataset(fixtureBundle(), { groupBy: 'funnel' });
    const f3000 = result.rows.find((r) => r.d.funnel === 'F3000')!;
    const f4000 = result.rows.find((r) => r.d.funnel === 'F4000')!;
    expect(f3000.prev).toBe(101000 + 80000); // both rows had prev
    expect(f4000.prev).toBeNull(); // neither F4000 row has prev
  });

  it('an unknown dim in --group-by is noticed and ignored (ungrouped result)', () => {
    const result = queryDataset(fixtureBundle(), { groupBy: 'country' });
    expect(result.rows).toHaveLength(4);
    expect(result.dims).toEqual(['funnel', 'language']);
    expect(result.notices.some((n) => n.includes('unknown dim "country"'))).toBe(true);
  });

  it('top keeps the highest-value N rows', () => {
    const result = queryDataset(fixtureBundle(), { top: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.v)).toEqual([119000, 84000]);
  });

  it('an invalid top is noticed and ignored, not silently swallowed', () => {
    const result = queryDataset(fixtureBundle(), { top: -3 });
    expect(result.rows).toHaveLength(4);
    expect(result.notices.some((n) => n.includes('--top must be a positive number'))).toBe(true);
  });

  it('total passes through the declared grand total, unaffected by where/top', () => {
    const result = queryDataset(fixtureBundle(), { where: { language: 'TR' }, top: 1 });
    expect(result.total).toEqual({ v: 286000, n: 9125 });
  });

  it('a bundle with no datasets yields an empty, noticed result', () => {
    const empty: DatasetBundle = { kind: 'dataset/v1', datasets: [] };
    const result = queryDataset(empty, {});
    expect(result.dataset).toBe('');
    expect(result.rows).toEqual([]);
    expect(result.notices.some((n) => n.includes('no datasets'))).toBe(true);
  });
});

// ─── resolveDatasetAsOf ──────────────────────────────────────────────────────

function baseCache(overrides: Partial<InsightCache> = {}): InsightCache {
  return {
    slug: 'x',
    fetchedAt: '2026-08-25T12:00:00.000Z',
    tweaks: {},
    granularity: 'daily',
    unit: null,
    series: [],
    latest: null,
    error: null,
    errorAt: null,
    scriptHash: null,
    ...overrides,
  };
}

describe('resolveDatasetAsOf', () => {
  it('live: prefers cache.datasets when present', () => {
    const bundle = fixtureBundle();
    const cache = baseCache({ datasets: { bundle, notices: [], range: { fromISO: '2026-08-01', toISO: '2026-08-25' } } });
    const resolved = resolveDatasetAsOf(cache, null);
    expect(resolved).not.toBeNull();
    expect(resolved!.bundle).toBe(bundle);
    expect(resolved!.at).toBe('2026-08-25T12:00:00.000Z');
  });

  it('live: falls back to a bundle synthesized from series when no datasets payload exists', () => {
    const cache = baseCache({ series: [{ name: 'signups', points: [{ t: '2026-08-24', v: 10 }, { t: '2026-08-25', v: 12 }] }] });
    const resolved = resolveDatasetAsOf(cache, null);
    expect(resolved).not.toBeNull();
    expect(resolved!.bundle.primary).toBe('series');
    expect(resolved!.bundle.datasets[0].key).toBe('series');
    expect(resolved!.bundle.datasets[0].dims.map((d) => d.key)).toEqual(['series', 'date']);
  });

  it('live: null when there is neither a datasets payload nor any series', () => {
    expect(resolveDatasetAsOf(baseCache(), null)).toBeNull();
  });

  it('dated: returns the newest snapshot at or before the end of the date', () => {
    const older: DatasetSnapshot = { at: '2026-08-20T08:00:00.000Z', range: { fromISO: '2026-08-01', toISO: '2026-08-20' }, bundle: fixtureBundle() };
    const newer: DatasetSnapshot = { at: '2026-08-24T08:00:00.000Z', range: { fromISO: '2026-08-01', toISO: '2026-08-24' }, bundle: fixtureBundle() };
    const future: DatasetSnapshot = { at: '2026-08-26T08:00:00.000Z', range: { fromISO: '2026-08-01', toISO: '2026-08-26' }, bundle: fixtureBundle() };
    const cache = baseCache({ datasetHistory: [older, newer, future] });
    const resolved = resolveDatasetAsOf(cache, '2026-08-25');
    expect(resolved!.at).toBe('2026-08-24T08:00:00.000Z');
  });

  it('dated: honest null when no snapshot qualifies — never interpolates, never reaches forward', () => {
    const future: DatasetSnapshot = { at: '2026-09-01T00:00:00.000Z', range: { fromISO: '2026-08-01', toISO: '2026-09-01' }, bundle: fixtureBundle() };
    const cache = baseCache({ datasetHistory: [future] });
    expect(resolveDatasetAsOf(cache, '2026-08-25')).toBeNull();
  });

  it('dated: never falls back to the live bundle, even when history is entirely absent', () => {
    const cache = baseCache({
      datasets: { bundle: fixtureBundle(), notices: [], range: { fromISO: '2026-08-01', toISO: '2026-08-25' } },
      series: [{ name: 's', points: [{ t: '2026-08-25', v: 1 }] }],
    });
    expect(resolveDatasetAsOf(cache, '2026-08-25')).toBeNull();
  });
});
