/**
 * app/v1 + dataset/v1 (T1 — parser half). Covers `parseAppSpec` (app.ts),
 * `parseDatasetBundle` + its lookup/synthesis helpers (dataset.ts), and the
 * envelope-detection fix that makes an `{ app }`-only return recognisable at
 * all (types.ts `isRawPayloadEnvelope`).
 *
 * T2 appends the sync-engine half (custom-script.ts gatekeeping, syncInsight
 * writing cache.app/cache.datasets/cache.datasetHistory) below the last
 * describe block in this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isRawAppSpec,
  isRawDatasetBundle,
  isRawPayloadEnvelope,
  LabError,
} from '../../src/lib/lab/types.js';
import {
  APP_PAGE_ID_RE,
  MAX_APP_BYTES,
  MAX_APP_PAGES,
  appPageIds,
  findAppPage,
  parseAppSpec,
} from '../../src/lib/lab/app.js';
import {
  DATASET_BUNDLE_KIND,
  MAX_DATASETS,
  appendDatasetHistory,
  datasetLatest,
  datasetToSeries,
  findDataset,
  makeDatasetSnapshot,
  parseDatasetBundle,
  seriesToDatasetBundle,
  type ParsedDatasetBundle,
} from '../../src/lib/lab/dataset.js';
import { MAX_MATRIX_BYTES } from '../../src/lib/lab/matrix.js';
import { createInsight, readCache } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

function fixtureAppSpec(): Record<string, unknown> {
  return {
    kind: 'app/v1',
    entry: 'overview',
    pages: [
      { id: 'overview', title: 'Overview', html: '<div class="lk-value">42</div>' },
      { id: 'steps', title: 'Steps', html: '<div class="lk-table">…</div>', dataset: 'funnel' },
    ],
  };
}

function fixtureDatasetBundle(): Record<string, unknown> {
  return {
    kind: 'dataset/v1',
    primary: 'funnel',
    datasets: [
      {
        key: 'funnel',
        label: 'Funnel',
        dims: [{ key: 'funnel', label: 'Funnel' }, { key: 'language' }],
        rows: [
          { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 },
          { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100 },
        ],
        total: { v: 203000, n: 7300 },
      },
      {
        key: 'countries',
        dims: [{ key: 'country' }],
        rows: [{ d: { country: 'TR' }, v: 50 }],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe('parseAppSpec', () => {
  it('accepts the fixture and preserves shape, with no notices', () => {
    const { spec, notices } = parseAppSpec(fixtureAppSpec());
    expect(notices).toEqual([]);
    expect(spec.kind).toBe('app/v1');
    expect(spec.entry).toBe('overview');
    expect(spec.pages).toHaveLength(2);
    expect(spec.pages[0]).toEqual({ id: 'overview', title: 'Overview', html: '<div class="lk-value">42</div>' });
    expect(spec.pages[1].dataset).toBe('funnel');
    expect(spec.card).toBeUndefined();
    expect(spec.shell).toBeUndefined();
  });

  it('defaults a missing title to the page id, with a notice', () => {
    const { spec, notices } = parseAppSpec({
      kind: 'app/v1',
      entry: 'a',
      pages: [{ id: 'a', html: '<p>x</p>' }],
    });
    expect(spec.pages[0].title).toBe('a');
    expect(notices).toEqual(['pages[0] ("a") has no `title` — used the id.']);
  });

  it('captures an optional card override and shell', () => {
    const { spec } = parseAppSpec({
      kind: 'app/v1',
      entry: 'overview',
      card: 'steps',
      shell: { style: '.x{color:red}', script: 'console.log(1)' },
      pages: [
        { id: 'overview', title: 'Overview', html: '<p>a</p>' },
        { id: 'steps', title: 'Steps', html: '<p>b</p>' },
      ],
    });
    expect(spec.card).toBe('steps');
    expect(spec.shell).toEqual({ style: '.x{color:red}', script: 'console.log(1)' });
  });

  it('rejects a payload without the app kind', () => {
    expect(() => parseAppSpec({ pages: [] })).toThrow(LabError);
    expect(() => parseAppSpec({ kind: 'matrix/v1', pages: [] })).toThrow(LabError);
    expect(() => parseAppSpec([{ id: 'a' }])).toThrow(LabError);
  });

  it('rejects a payload with no pages', () => {
    expect(() => parseAppSpec({ kind: 'app/v1', entry: 'a', pages: [] })).toThrow(/non-empty `pages`/);
    expect(() => parseAppSpec({ kind: 'app/v1', entry: 'a', pages: 'nope' })).toThrow(/non-empty `pages`/);
  });

  it('rejects over the MAX_APP_PAGES cap (structural — no truncation)', () => {
    const pages = Array.from({ length: MAX_APP_PAGES + 1 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, html: '<p>x</p>' }));
    expect(() => parseAppSpec({ kind: 'app/v1', entry: 'p0', pages })).toThrow(new RegExp(`cap is ${MAX_APP_PAGES}`));
  });

  it('the page-id charset accepts lowercase/digits/hyphens only', () => {
    expect(APP_PAGE_ID_RE.test('overview')).toBe(true);
    expect(APP_PAGE_ID_RE.test('step-2')).toBe(true);
    expect(APP_PAGE_ID_RE.test('Bad Id!')).toBe(false);
    expect(APP_PAGE_ID_RE.test('')).toBe(false);
  });

  it('rejects an invalid page id', () => {
    expect(() => parseAppSpec({
      kind: 'app/v1', entry: 'Bad', pages: [{ id: 'Bad Id!', title: 'x', html: '<p>x</p>' }],
    })).toThrow(/pages\[0\]\.id/);
    expect(() => parseAppSpec({
      kind: 'app/v1', entry: 'a', pages: [{ id: '', title: 'x', html: '<p>x</p>' }],
    })).toThrow(/pages\[0\]\.id/);
  });

  it('rejects a page with no html', () => {
    expect(() => parseAppSpec({
      kind: 'app/v1', entry: 'a', pages: [{ id: 'a', title: 'x', html: '   ' }],
    })).toThrow(/has no `html`/);
  });

  it('rejects duplicate page ids', () => {
    expect(() => parseAppSpec({
      kind: 'app/v1',
      entry: 'a',
      pages: [{ id: 'a', title: '1', html: '<p>1</p>' }, { id: 'a', title: '2', html: '<p>2</p>' }],
    })).toThrow(/two pages with id "a"/);
  });

  it('rejects a missing or unresolvable entry', () => {
    expect(() => parseAppSpec({ kind: 'app/v1', pages: [{ id: 'a', title: 'x', html: '<p>x</p>' }] }))
      .toThrow(/must declare `entry`/);
    expect(() => parseAppSpec({ kind: 'app/v1', entry: 'missing', pages: [{ id: 'a', title: 'x', html: '<p>x</p>' }] }))
      .toThrow(/`entry` \("missing"\) is not one of/);
  });

  it('rejects a card that does not name a declared page', () => {
    expect(() => parseAppSpec({
      kind: 'app/v1', entry: 'a', card: 'nope', pages: [{ id: 'a', title: 'x', html: '<p>x</p>' }],
    })).toThrow(/`card` \("nope"\) is not one of/);
  });

  it('rejects a spec over the MAX_APP_BYTES cap', () => {
    const bigHtml = '<p>' + 'a'.repeat(MAX_APP_BYTES) + '</p>';
    expect(() => parseAppSpec({
      kind: 'app/v1', entry: 'a', pages: [{ id: 'a', title: 'x', html: bigHtml }],
    })).toThrow(new RegExp(`${MAX_APP_BYTES}-byte cap`));
  });
});

describe('findAppPage / appPageIds', () => {
  it('resolves a matching id', () => {
    const { spec } = parseAppSpec(fixtureAppSpec());
    expect(findAppPage(spec, 'steps')?.id).toBe('steps');
  });

  it('falls back to entry for an unknown, null, or undefined id', () => {
    const { spec } = parseAppSpec(fixtureAppSpec());
    expect(findAppPage(spec, 'nonexistent')?.id).toBe('overview');
    expect(findAppPage(spec, null)?.id).toBe('overview');
    expect(findAppPage(spec, undefined)?.id).toBe('overview');
  });

  it('lists page ids in spec order', () => {
    const { spec } = parseAppSpec(fixtureAppSpec());
    expect(appPageIds(spec)).toEqual(['overview', 'steps']);
  });
});

describe('parseDatasetBundle', () => {
  it('accepts the fixture and preserves shape, delegating each dataset to parseMatrixSet', () => {
    const { bundle, notices } = parseDatasetBundle(fixtureDatasetBundle());
    expect(notices).toEqual([]);
    expect(bundle.kind).toBe(DATASET_BUNDLE_KIND);
    expect(bundle.primary).toBe('funnel');
    expect(bundle.datasets).toHaveLength(2);
    const funnel = bundle.datasets[0];
    expect(funnel.key).toBe('funnel');
    expect(funnel.label).toBe('Funnel');
    expect(funnel.dims.map((d) => d.key)).toEqual(['funnel', 'language']);
    expect(funnel.rows).toHaveLength(2);
    expect(funnel.total).toEqual({ v: 203000, n: 7300 });
    expect(bundle.datasets[1].key).toBe('countries');
  });

  it('propagates parseMatrixSet caps as dataset-prefixed notices', () => {
    const { notices } = parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [{
        key: 'wide',
        dims: [{ key: 'x' }],
        rows: [
          { d: { x: 'a' }, v: 9 }, { d: { x: 'b' }, v: 8 }, { d: { x: 'c' }, v: 7 },
          { d: { x: 'd' }, v: 6 }, { d: { x: 'e' }, v: 5 }, { d: { x: 'f' }, v: 4 },
          { d: { x: 'g' }, v: 3 }, { d: { x: 'h' }, v: 2 }, { d: { x: 'i' }, v: 1 },
        ],
      }],
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^dataset "wide": dimension "x" had 9 values/);
  });

  it('propagates a parseMatrixSet rejection with dataset index+key context', () => {
    expect(() => parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [{ key: 'bad', dims: [], rows: [] }],
    })).toThrow(/datasets\[0\] \("bad"\): .*1-3/);
  });

  it('rejects a payload without the dataset kind', () => {
    expect(() => parseDatasetBundle({ datasets: [] })).toThrow(LabError);
    expect(() => parseDatasetBundle({ kind: 'matrix/v1', datasets: [] })).toThrow(LabError);
    expect(() => parseDatasetBundle([{ key: 'a' }])).toThrow(LabError);
  });

  it('rejects a payload with no datasets', () => {
    expect(() => parseDatasetBundle({ kind: 'dataset/v1', datasets: [] })).toThrow(/non-empty `datasets`/);
    expect(() => parseDatasetBundle({ kind: 'dataset/v1', datasets: 'nope' })).toThrow(/non-empty `datasets`/);
  });

  it('rejects over the MAX_DATASETS cap (structural — no truncation)', () => {
    const datasets = Array.from({ length: MAX_DATASETS + 1 }, (_, i) => ({
      key: `d${i}`, dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }],
    }));
    expect(() => parseDatasetBundle({ kind: 'dataset/v1', datasets })).toThrow(new RegExp(`cap is ${MAX_DATASETS}`));
  });

  it('rejects a dataset with no key', () => {
    expect(() => parseDatasetBundle({
      kind: 'dataset/v1', datasets: [{ dims: [{ key: 'x' }], rows: [] }],
    })).toThrow(/datasets\[0\] has no `key`/);
  });

  it('rejects duplicate dataset keys', () => {
    expect(() => parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [
        { key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] },
        { key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '2' }, v: 2 }] },
      ],
    })).toThrow(/two datasets with key "a"/);
  });

  it('rejects a `primary` that does not name a declared dataset', () => {
    expect(() => parseDatasetBundle({
      kind: 'dataset/v1',
      primary: 'nope',
      datasets: [{ key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] }],
    })).toThrow(/`primary` \("nope"\) is not one of/);
  });

  it('rejects a bundle over MAX_MATRIX_BYTES even when every individual dataset is under its own cap', () => {
    // Each dataset alone: 8 distinct rows of one ~19,000-char dim value each
    // (~152KB) — comfortably under the per-dataset MAX_MATRIX_BYTES (200,000,
    // enforced inside parseMatrixSet). Two of them together exceed the SAME
    // figure reused as the whole-bundle cap.
    const bigDataset = (key: string) => ({
      key,
      dims: [{ key: 'x' }],
      rows: Array.from({ length: 8 }, (_, i) => ({ d: { x: `${key}-${i}-${'a'.repeat(19000)}` }, v: i })),
    });
    expect(() => parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [bigDataset('a'), bigDataset('b')],
    })).toThrow(new RegExp(`exceeds the ${MAX_MATRIX_BYTES}-byte cap`));
  });
});

describe('findDataset / datasetToSeries / datasetLatest', () => {
  let parsed: ParsedDatasetBundle;
  beforeEach(() => {
    parsed = parseDatasetBundle(fixtureDatasetBundle());
  });

  it('resolves the named key', () => {
    expect(findDataset(parsed.bundle, 'countries')?.key).toBe('countries');
  });

  it('resolves `primary` when no key is given', () => {
    expect(findDataset(parsed.bundle)?.key).toBe('funnel');
    expect(findDataset(parsed.bundle, null)?.key).toBe('funnel');
  });

  it('resolves the first dataset when there is no `primary` and no key', () => {
    const noPrimary = parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [
        { key: 'first', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] },
        { key: 'second', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 2 }] },
      ],
    }).bundle;
    expect(findDataset(noPrimary)?.key).toBe('first');
  });

  it('returns null for a named key that does not exist — never a silent fallback', () => {
    expect(findDataset(parsed.bundle, 'nonexistent')).toBeNull();
  });

  it('synthesizes Series[] from the primary dataset (2-dim: series named by dim1 VALUE, matrixToSeries\' contract)', () => {
    const series = datasetToSeries(parsed.bundle);
    expect(series).toHaveLength(1);
    expect(series[0].name).toBe('F3000');
    expect(series[0].points).toEqual([{ t: 'TR', v: 119000 }, { t: 'EN', v: 84000 }]);
  });

  it('returns the primary dataset total as latest, finite-or-null', () => {
    expect(datasetLatest(parsed.bundle)).toBe(203000);
    const noTotal = parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [{ key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] }],
    }).bundle;
    expect(datasetLatest(noTotal)).toBeNull();
  });
});

describe('seriesToDatasetBundle (PINNED shape — legacy-cache read path)', () => {
  it('synthesizes the exact pinned bundle shape from Series[]', () => {
    const bundle = seriesToDatasetBundle([
      { name: 'signups', points: [{ t: '2026-08-24', v: 10 }, { t: '2026-08-25', v: 12 }] },
    ]);
    expect(bundle).toEqual({
      kind: 'dataset/v1',
      primary: 'series',
      datasets: [{
        key: 'series',
        label: 'Series',
        dims: [{ key: 'series' }, { key: 'date' }],
        rows: [
          { d: { series: 'signups', date: '2026-08-24' }, v: 10 },
          { d: { series: 'signups', date: '2026-08-25' }, v: 12 },
        ],
      }],
    });
  });

  it('resolves to the pinned "series" key with no key given', () => {
    const bundle = seriesToDatasetBundle([{ name: 'x', points: [{ t: '2026-08-25', v: 1 }] }]);
    expect(findDataset(bundle)?.key).toBe('series');
  });

  it('produces an empty datasets-row list for empty series, never throwing', () => {
    const bundle = seriesToDatasetBundle([]);
    expect(bundle.datasets[0].rows).toEqual([]);
  });
});

describe('makeDatasetSnapshot / appendDatasetHistory', () => {
  const range = { fromISO: '2026-08-01', toISO: '2026-08-25' };

  it('compacts a snapshot: drops `prev`, keeps `n`', () => {
    const { bundle } = parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [{
        key: 'a',
        dims: [{ key: 'x' }],
        rows: [{ d: { x: '1' }, v: 10, n: 5, prev: 8 }],
      }],
    });
    const snap = makeDatasetSnapshot(bundle, range, '2026-08-25T00:00:00.000Z');
    expect(snap.at).toBe('2026-08-25T00:00:00.000Z');
    expect(snap.range).toEqual(range);
    expect(snap.bundle.datasets[0].rows[0]).toEqual({ d: { x: '1' }, v: 10, n: 5 });
    expect((snap.bundle.datasets[0].rows[0] as { prev?: number }).prev).toBeUndefined();
  });

  it('appends, enforcing the count cap and the byte cap together, newest always surviving', () => {
    const { bundle } = parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [{ key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] }],
    });
    const snap1 = makeDatasetSnapshot(bundle, range, '2026-08-24T00:00:00.000Z');
    const snap2 = makeDatasetSnapshot(bundle, range, '2026-08-25T00:00:00.000Z');
    const trail = appendDatasetHistory([snap1], snap2);
    expect(trail).toHaveLength(2);
    expect(trail[trail.length - 1]).toBe(snap2);
  });

  it('tolerates a malformed prior trail (non-array)', () => {
    const { bundle } = parseDatasetBundle({
      kind: 'dataset/v1',
      datasets: [{ key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] }],
    });
    const snap = makeDatasetSnapshot(bundle, range, '2026-08-25T00:00:00.000Z');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trail = appendDatasetHistory(undefined as any, snap);
    expect(trail).toEqual([snap]);
  });
});

describe('envelope detection (types.ts)', () => {
  it('recognises { data } and { data, html? } as before', () => {
    expect(isRawPayloadEnvelope({ data: [] })).toBe(true);
    expect(isRawPayloadEnvelope({ data: [], html: '<b>x</b>' })).toBe(true);
  });

  it('recognises { app } alone as an envelope — the fix that makes the data-mandatory reject reachable', () => {
    expect(isRawPayloadEnvelope({ app: { kind: 'app/v1', entry: 'a', pages: [] } })).toBe(true);
    expect(isRawPayloadEnvelope({ data: [], app: { kind: 'app/v1', entry: 'a', pages: [] } })).toBe(true);
  });

  it('does not steal a bare typed payload or a legacy array', () => {
    expect(isRawPayloadEnvelope([{ name: 'a', points: [] }])).toBe(false);
    expect(isRawPayloadEnvelope({ kind: 'matrix/v1', dims: [], rows: [] })).toBe(false);
    expect(isRawPayloadEnvelope({ kind: 'funnel-set/v1', funnels: [] })).toBe(false);
    expect(isRawPayloadEnvelope({ kind: 'app/v1', entry: 'a', pages: [] })).toBe(false);
    expect(isRawPayloadEnvelope({ kind: 'dataset/v1', datasets: [] })).toBe(false);
  });

  it('isRawAppSpec recognises a bare app/v1 payload only', () => {
    expect(isRawAppSpec({ kind: 'app/v1' })).toBe(true);
    expect(isRawAppSpec({ kind: 'matrix/v1' })).toBe(false);
    expect(isRawAppSpec([])).toBe(false);
    expect(isRawAppSpec(null)).toBe(false);
  });

  it('isRawDatasetBundle recognises a bare dataset/v1 payload only', () => {
    expect(isRawDatasetBundle({ kind: 'dataset/v1' })).toBe(true);
    expect(isRawDatasetBundle({ kind: 'matrix/v1' })).toBe(false);
    expect(isRawDatasetBundle([])).toBe(false);
    expect(isRawDatasetBundle(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T2 appends the sync-engine half (custom-script.ts gatekeeping, syncInsight
// cache.app/cache.datasets/cache.datasetHistory) below this line.
// ─────────────────────────────────────────────────────────────────────────

describe('the { data, app? } envelope (engine — T2)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-app-'));
    mkdirSync(join(root, 'core'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeScript(slug: string, body: string): void {
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', `${slug}.mjs`), body, 'utf-8');
  }

  it('caches app ALONGSIDE the data — latest/series semantics unchanged', async () => {
    createInsight(root, { slug: 'app-hybrid', title: 'App Hybrid', render: 'app', adapter: 'script' });
    writeScript('app-hybrid', `export default async () => ({
      data: [{ name: 'metric', points: [{ t: '2026-08-24', v: 10 }, { t: '2026-08-25', v: 42 }] }],
      app: {
        kind: 'app/v1',
        entry: 'overview',
        pages: [{ id: 'overview', title: 'Overview', html: '<div class="lk-value">42</div>' }],
      },
    });`);

    const result = await syncInsight(root, 'app-hybrid', { force: true });
    expect(result.status).toBe('ok');
    expect(result.latest).toBe(42); // from data, exactly as a bare return

    const cache = readCache(root, 'app-hybrid')!;
    expect(cache.app?.spec.entry).toBe('overview');
    expect(cache.app?.spec.pages).toHaveLength(1);
    expect(cache.series).toHaveLength(1);
    expect(cache.latest).toBe(42);
    expect(cache.html).toBeUndefined();
  });

  it('wraps a dataset bundle too — cache.datasets AND cache.app, latest from the primary total', async () => {
    createInsight(root, { slug: 'app-ds', title: 'App DS', render: 'app', adapter: 'script' });
    writeScript('app-ds', `export default async () => ({
      data: {
        kind: 'dataset/v1',
        primary: 'breakdown',
        datasets: [{ key: 'breakdown', dims: [{ key: 'x' }], rows: [{ d: { x: 'a' }, v: 5 }], total: { v: 5 } }],
      },
      app: {
        kind: 'app/v1',
        entry: 'overview',
        pages: [{ id: 'overview', title: 'Overview', html: '<div class="lk-stat">5</div>', dataset: 'breakdown' }],
      },
    });`);

    const result = await syncInsight(root, 'app-ds', { force: true });
    expect(result.status).toBe('ok');
    const cache = readCache(root, 'app-ds')!;
    expect(cache.datasets?.bundle.datasets[0].key).toBe('breakdown');
    expect(cache.app?.spec.pages[0].dataset).toBe('breakdown');
    expect(cache.latest).toBe(5);
    expect(cache.datasetHistory).toHaveLength(1);
  });

  it('a bare dataset/v1 payload is render-agnostic — cache.datasets even under render: number', async () => {
    createInsight(root, { slug: 'ds-bare', title: 'DS Bare', render: 'number', adapter: 'script' });
    writeScript('ds-bare', `export default async () => ({
      kind: 'dataset/v1',
      datasets: [{ key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: 'a' }, v: 7 }], total: { v: 7 } }],
    });`);

    const result = await syncInsight(root, 'ds-bare', { force: true });
    expect(result.status).toBe('ok');
    const cache = readCache(root, 'ds-bare')!;
    expect(cache.datasets?.bundle.datasets[0].key).toBe('a');
    expect(cache.latest).toBe(7);
    expect(cache.app).toBeUndefined();
  });

  it('REJECTS a bare { kind: "app/v1" } return — data is mandatory', async () => {
    createInsight(root, { slug: 'app-bare', title: 'App Bare', render: 'app', adapter: 'script' });
    writeScript('app-bare', `export default async () => ({
      kind: 'app/v1',
      entry: 'overview',
      pages: [{ id: 'overview', title: 'Overview', html: '<div>x</div>' }],
    });`);
    const result = await syncInsight(root, 'app-bare', { force: true });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/data is mandatory/);
  });

  it('REJECTS { app } alongside { html } — one body contract per insight', async () => {
    createInsight(root, { slug: 'both-bodies', title: 'Both', render: 'app', adapter: 'script' });
    writeScript('both-bodies', `export default async () => ({
      data: [{ name: 'm', points: [{ t: '2026-08-25', v: 1 }] }],
      html: '<div>html</div>',
      app: {
        kind: 'app/v1',
        entry: 'overview',
        pages: [{ id: 'overview', title: 'Overview', html: '<div>app</div>' }],
      },
    });`);
    const result = await syncInsight(root, 'both-bodies', { force: true });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/ONE body contract/);
    expect(readCache(root, 'both-bodies')!.app).toBeUndefined();
    expect(readCache(root, 'both-bodies')!.html).toBeUndefined();
  });

  it('rejects an over-cap app spec LOUDLY (no truncation)', async () => {
    createInsight(root, { slug: 'app-fat', title: 'App Fat', render: 'app', adapter: 'script' });
    const tooManyPages = Array.from({ length: MAX_APP_PAGES + 1 }, (_, i) => `{ id: 'p${i}', title: 'P${i}', html: '<div>${i}</div>' }`).join(',');
    writeScript('app-fat', `export default async () => ({
      data: [{ name: 'm', points: [{ t: '2026-08-25', v: 1 }] }],
      app: { kind: 'app/v1', entry: 'p0', pages: [${tooManyPages}] },
    });`);
    const result = await syncInsight(root, 'app-fat', { force: true });
    expect(result.status).toBe('failed');
    expect(result.error).toContain(`the cap is ${MAX_APP_PAGES}`);
    expect(readCache(root, 'app-fat')!.app).toBeUndefined();
  });

  it('a failed sync preserves the prior app; a clean run without app clears it', async () => {
    createInsight(root, { slug: 'app-cycle', title: 'App Cycle', render: 'app', adapter: 'script' });
    writeScript('app-cycle', `export default async () => ({
      data: [{ name: 'm', points: [{ t: '2026-08-25', v: 1 }] }],
      app: { kind: 'app/v1', entry: 'overview', pages: [{ id: 'overview', title: 'Overview', html: '<div>v1</div>' }] },
    });`);
    await syncInsight(root, 'app-cycle', { force: true });
    expect(readCache(root, 'app-cycle')!.app?.spec.pages[0].html).toBe('<div>v1</div>');

    writeScript('app-cycle', `export default async () => { throw new Error('boom'); };`);
    await syncInsight(root, 'app-cycle', { force: true });
    expect(readCache(root, 'app-cycle')!.app?.spec.pages[0].html).toBe('<div>v1</div>'); // keep-prior

    writeScript('app-cycle', `export default async () => ([{ name: 'm', points: [{ t: '2026-08-25', v: 2 }] }]);`);
    const result = await syncInsight(root, 'app-cycle', { force: true });
    expect(result.status).toBe('ok');
    expect(readCache(root, 'app-cycle')!.app).toBeUndefined(); // stale presentation is worse than none
  });
});

describe('appScriptTemplate (T2 scaffold)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-app-scaffold-'));
    mkdirSync(join(root, 'core'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scaffolds a script for render: app + adapter: script, never for breakdown', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    createInsight(root, { slug: 'app-scaffold', title: 'App Scaffold', render: 'app', adapter: 'script' });
    const scriptPath = join(root, 'lab', 'scripts', 'app-scaffold.mjs');
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf-8');
    expect(script).toContain("kind: 'app/v1'");
    expect(script).toContain("kind: 'dataset/v1'");
    expect(script).toContain('lab.navigate');
    expect(script).toContain('lab.data()');
    expect(script).toContain('lk-stat');

    createInsight(root, { slug: 'bd-scaffold', title: 'BD Scaffold', render: 'breakdown', adapter: 'script' });
    expect(existsSync(join(root, 'lab', 'scripts', 'bd-scaffold.mjs'))).toBe(false);
  });

  it('gives render: app the range tweak, same as funnel/breakdown', () => {
    const manifest = createInsight(root, { slug: 'app-range', title: 'App Range', render: 'app', adapter: 'script' });
    expect(manifest.tweaks.some((t) => t.key === 'range')).toBe(true);
  });
});
