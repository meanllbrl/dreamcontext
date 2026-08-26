import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkLab } from '../../src/cli/commands/doctor.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { writeCredential } from '../../src/lib/lab/credentials.js';
import type { AppSpec, DatasetBundle, DatasetSnapshot } from '../../src/lib/lab/types.js';

let projectRoot: string;
let root: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-lab-doctor-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('checkLab — silent when empty', () => {
  it('returns [] when lab/insights/ is empty and no credentials.json exists', () => {
    expect(checkLab(root)).toEqual([]);
  });
});

describe('checkLab — credentials coverage FAIL (self-heal net)', () => {
  it('FAILS when lab/credentials.json exists but is not covered by the mode-appropriate .gitignore', () => {
    // Simulate a pre-Lab brain repo: hand-place credentials.json with no gitignore
    // coverage at all (bypassing writeCredential's own ordering).
    mkdirSync(join(root, 'lab'), { recursive: true });
    writeFileSync(join(root, 'lab', 'credentials.json'), '{"key":"secret"}', 'utf-8');
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'error')).toBe(true);
  });

  it('does NOT fail when credentials.json was written via writeCredential (properly covered)', () => {
    writeCredential(projectRoot, root, 'apiKey', 'sk-test');
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'error')).toBe(false);
  });
});

describe('checkLab — WARN branches', () => {
  it('WARNS when a manifest credentials_used key is absent from credentials.json', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const path = join(root, 'lab', 'insights', 'wau.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('credentials_used: []', 'credentials_used:\n  - apiKey'), 'utf-8');

    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('apiKey'))).toBe(true);
  });

  it('WARNS when binding.objective does not resolve', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const path = join(root, 'lab', 'insights', 'wau.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('binding: null', 'binding:\n  objective: does-not-exist\n  value: latest'), 'utf-8');

    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('does-not-exist'))).toBe(true);
  });

  it('does not warn about binding when the objective resolves', () => {
    createObjective(root, { slug: 'mrr', title: 'MRR' });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const path = join(root, 'lab', 'insights', 'wau.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('binding: null', 'binding:\n  objective: mrr\n  value: latest'), 'utf-8');

    const results = checkLab(root);
    expect(results.some((r) => r.message.includes('does not resolve'))).toBe(false);
  });

  it('WARNS on an insight slug that is not kebab-case', () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'insights', 'Bad_Slug.md'),
      '---\ntitle: Bad\nrender: number\nsource:\n  adapter: http\n  http:\n    endpoint: https://x\n    method: GET\n    headers: {}\n    body: null\n    extract:\n      seriesPath: data\n      seriesKey: null\n      x: t\n      y: v\n      agg: last\ntweaks: []\nbinding: null\ncredentials_used: []\n---\n## Meaning\n',
      'utf-8',
    );
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('kebab-case'))).toBe(true);
  });
});

describe('checkLab — ok summary', () => {
  it('reports ok with the insight count when nothing is wrong', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const results = checkLab(root);
    expect(results).toEqual([{ name: 'Lab', status: 'ok', message: expect.stringContaining('1 insight') }]);
  });
});

// ─── T7: app/v1 + dataset/v1 cache-shape checks (mirrors the funnel/matrix
// blocks — a stored cache must re-validate cleanly through the SAME parsers
// the sync engine uses; cap violations mean a hand-edited or older-build
// cache, and the warn always points at `lab sync --force`). ──────────────────

const VALID_SPEC: AppSpec = {
  kind: 'app/v1',
  entry: 'overview',
  pages: [{ id: 'overview', title: 'Overview', html: '<div class="lk-value">42</div>' }],
};

const VALID_BUNDLE: DatasetBundle = {
  kind: 'dataset/v1',
  datasets: [{ key: 'usage', dims: [{ key: 'plan' }], rows: [{ d: { plan: 'pro' }, v: 42 }] }],
};

function writeAppInsight(slug: string): void {
  createInsight(root, { slug, title: slug, render: 'app' });
}

describe('checkLab — app cache shape', () => {
  it('WARNS when the stored app spec is not a valid app/v1 payload', () => {
    writeAppInsight('breakdown-app');
    writeCache(root, 'breakdown-app', {
      slug: 'breakdown-app', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      // `pages: []` fails parseAppSpec's non-empty check — simulates a cache
      // written by an older build whose caps have since tightened.
      app: { spec: { kind: 'app/v1', entry: 'x', pages: [] } as unknown as AppSpec, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
    });
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('breakdown-app') && r.message.includes('not a valid app/v1 spec'))).toBe(true);
  });

  it('WARNS with a cap-violation notice when the stored app spec re-parses with a coercion', () => {
    writeAppInsight('coerced-app');
    // A page missing `title` is not a throw (parseAppSpec falls back to the
    // id) but it IS a notice — the same "hand-edited or older build" signal
    // the funnel/matrix blocks surface.
    const spec = { kind: 'app/v1', entry: 'overview', pages: [{ id: 'overview', html: '<div>x</div>' }] } as unknown as AppSpec;
    writeCache(root, 'coerced-app', {
      slug: 'coerced-app', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      app: { spec, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
    });
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('app cache violates a cap') && r.message.includes('lab sync coerced-app --force'))).toBe(true);
  });

  it('does not warn when the stored app spec re-parses cleanly', () => {
    writeAppInsight('clean-app');
    writeCache(root, 'clean-app', {
      slug: 'clean-app', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      app: { spec: VALID_SPEC, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
    });
    expect(checkLab(root).filter((r) => r.message.includes('app cache'))).toEqual([]);
  });

  it('WARNS when the stored dataset bundle is not a valid dataset/v1 payload', () => {
    writeAppInsight('empty-bundle');
    writeCache(root, 'empty-bundle', {
      slug: 'empty-bundle', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      datasets: { bundle: { kind: 'dataset/v1', datasets: [] } as unknown as DatasetBundle, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
    });
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('empty-bundle') && r.message.includes('not a valid dataset/v1 bundle'))).toBe(true);
  });

  it('WARNS with a cap-violation notice when a dataset dimension re-collapses top-8 + Other', () => {
    writeAppInsight('overcap-bundle');
    // 9 distinct `plan` values — one over MAX_MATRIX_DIM_VALUES (8), so
    // re-parsing collapses the tail into "Other" and reports the notice.
    const rows = Array.from({ length: 9 }, (_, i) => ({ d: { plan: `plan-${i}` }, v: i }));
    const bundle: DatasetBundle = { kind: 'dataset/v1', datasets: [{ key: 'usage', dims: [{ key: 'plan' }], rows }] };
    writeCache(root, 'overcap-bundle', {
      slug: 'overcap-bundle', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      datasets: { bundle, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
    });
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('dataset cache violates a cap') && r.message.includes('collapsed'))).toBe(true);
  });

  it('does not warn when the stored dataset bundle re-parses cleanly', () => {
    writeAppInsight('clean-bundle');
    writeCache(root, 'clean-bundle', {
      slug: 'clean-bundle', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      datasets: { bundle: VALID_BUNDLE, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
    });
    expect(checkLab(root).filter((r) => r.message.includes('dataset cache'))).toEqual([]);
  });

  it('WARNS when datasetHistory exceeds the snapshot COUNT cap', () => {
    writeAppInsight('long-history');
    const snapshot: DatasetSnapshot = { at: '2026-02-01T00:00:00.000Z', range: { fromISO: '2026-01-25', toISO: '2026-02-01' }, bundle: VALID_BUNDLE };
    const datasetHistory: DatasetSnapshot[] = Array.from({ length: 61 }, () => snapshot); // cap is 60
    writeCache(root, 'long-history', {
      slug: 'long-history', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      datasets: { bundle: VALID_BUNDLE, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
      datasetHistory,
    });
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('datasetHistory has 61 snapshots (cap 60)'))).toBe(true);
  });

  it('WARNS when datasetHistory exceeds the BYTE cap even under the count cap', () => {
    writeAppInsight('heavy-history');
    // 3 snapshots (well under the count cap of 60), each padded past ~400KB —
    // together over the 1,000,000-byte cap, proving the byte check is wired
    // independently of the count check.
    const pad = 'x'.repeat(400_000);
    const heavyBundle: DatasetBundle = { kind: 'dataset/v1', datasets: [{ key: 'usage', dims: [{ key: 'plan' }], rows: [{ d: { plan: pad }, v: 1 }] }] };
    const datasetHistory: DatasetSnapshot[] = Array.from({ length: 3 }, () => ({
      at: '2026-02-01T00:00:00.000Z', range: { fromISO: '2026-01-25', toISO: '2026-02-01' }, bundle: heavyBundle,
    }));
    writeCache(root, 'heavy-history', {
      slug: 'heavy-history', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      datasets: { bundle: VALID_BUNDLE, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
      datasetHistory,
    });
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && /datasetHistory is \d+ bytes \(cap 1000000\)/.test(r.message))).toBe(true);
  });

  it('WARNS (render-agnostic) when a cache carries BOTH an app body and an html body', () => {
    writeAppInsight('both-bodies');
    writeCache(root, 'both-bodies', {
      slug: 'both-bodies', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      app: { spec: VALID_SPEC, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
      html: '<div>legacy body</div>',
    });
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('both-bodies') && r.message.includes('BOTH an `app` body and an `html` body'))).toBe(true);
  });

  it('does not warn about app/html coexistence for a cache with only one body', () => {
    writeAppInsight('app-only');
    writeCache(root, 'app-only', {
      slug: 'app-only', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: null, series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      app: { spec: VALID_SPEC, notices: [], range: { fromISO: '2026-02-01', toISO: '2026-02-08' } },
    });
    expect(checkLab(root).filter((r) => r.message.includes('BOTH an `app` body'))).toEqual([]);
  });
});
