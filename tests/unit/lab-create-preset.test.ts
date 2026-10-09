import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createInsight,
  funnelExplorerMeaning,
  funnelExplorerScriptTemplate,
  getInsight,
  readCache,
  writeInsightBinding,
  writeInsightTweaks,
} from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { readFrontmatter } from '../../src/lib/frontmatter.js';

/**
 * `lab create --preset funnel-explorer` at the store level: the manifest, the
 * snapshot-reading script, the Meaning skeleton, the refusals, and a sync that
 * fails loudly until the snapshot exists.
 */

let root: string;
const SLUG = 'acme-storefront-funnels';
const manifestPath = () => join(root, 'lab', 'insights', `${SLUG}.md`);
const scriptPath = () => join(root, 'lab', 'scripts', `${SLUG}.mjs`);
const dataPath = () => join(root, 'lab', 'data', `${SLUG}.json`);

const SNAPSHOT = {
  source: {
    vault: 'acme',
    chart_name: 'Funnel Analysis',
    applied_filters: [
      { field: 'product', op: '=', value: 'Acme Storefront', source: 'request' },
      { field: 'event_date', op: 'between', values: ['2026-09-07', '2026-10-04'], source: 'request' },
    ],
    freshness: 'data 2h old',
    pulled_at: '2026-10-08T14:33:48Z',
    via: 'KB MCP kb_chart_query',
  },
  data: {
    kind: 'funnel-set/v1',
    dimensions: [],
    window: { from: '2026-09-07', to: '2026-10-04' },
    funnels: [{
      id: 'quiz',
      name: 'Quiz',
      metrics: { users: { v: 1000, format: 'count' } },
      steps: [{ key: 'visit', label: 'Visit', users: 1000 }, { key: 'buy', label: 'Buy', users: 40 }],
    }],
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-preset-'));
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createInsight({preset: "funnel-explorer"})', () => {
  it('writes render funnel, a script adapter, the preset, no range tweak, and no data file', () => {
    const m = createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', category: 'Acme Funnel', preset: 'funnel-explorer' });
    expect(m.render).toBe('funnel');
    expect(m.preset).toBe('funnel-explorer');
    expect(m.source).toEqual({ adapter: 'script', file: `scripts/${SLUG}.mjs` });
    expect(m.tweaks).toEqual([]);
    const { data } = readFrontmatter<Record<string, unknown>>(manifestPath());
    expect(data.preset).toBe('funnel-explorer');
    expect(data.tweaks).toEqual([]);
    expect(existsSync(dataPath())).toBe(false);
    expect(existsSync(join(root, 'lab', 'data'))).toBe(false);
  });

  it('the Meaning skeleton carries the explorer sections and names the slug in the refresh line', () => {
    const m = createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    for (const heading of ['## Meaning', '### Source and filters', '### Window', '### Steps', '### Reading traps', '### Refresh']) {
      expect(m.body).toContain(heading);
    }
    expect(m.body).toContain(`dreamcontext lab data write ${SLUG} --file <path>`);
    expect(m.body).toBe(funnelExplorerMeaning('Acme storefront funnels', null, SLUG).trim());
    expect(m.body).not.toMatch(/—/);
  });

  it('writes the snapshot-reading script: no network, no credentials, the missing-snapshot message', () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    const script = readFileSync(scriptPath(), 'utf-8');
    expect(script).toBe(funnelExplorerScriptTemplate(SLUG));
    expect(script).toContain(`new URL('../data/${SLUG}.json', import.meta.url)`);
    expect(script).toContain(`const NAME = 'lab/data/${SLUG}.json';`);
    expect(script).toContain("const MISSING = 'No snapshot yet at ' + NAME + '.");
    // Never through a link, never outside lab/data, never echoing the file in an error.
    expect(script).toContain('st.isSymbolicLink() || !st.isFile()');
    expect(script).toContain("dir.endsWith(sep + 'lab' + sep + 'data')");
    expect(script).toContain("throw new Error(NAME + ' is not valid JSON.");
    expect(script).toMatch(/^import \{ lstat, readFile, realpath \} from 'node:fs\/promises';$/m);
    expect(script).toMatch(/^import \{ sep \} from 'node:path';$/m);
    expect(script).not.toMatch(/\bfetch\s*\(/);
    expect(script).not.toMatch(/credentials|ctx\./);
    expect(script).not.toMatch(/—/);
  });

  it('refuses a conflicting render, an http adapter and an unknown preset', () => {
    expect(() => createInsight(root, { slug: SLUG, title: 'x', preset: 'funnel-explorer', render: 'bar' })).toThrow(/--render funnel/);
    expect(() => createInsight(root, { slug: SLUG, title: 'x', preset: 'funnel-explorer', adapter: 'http' })).toThrow(/--adapter http/);
    expect(() => createInsight(root, { slug: SLUG, title: 'x', preset: 'nope' as never })).toThrow(/preset must be one of/);
    expect(existsSync(manifestPath())).toBe(false);
    // An explicit --render funnel is fine.
    expect(createInsight(root, { slug: SLUG, title: 'x', preset: 'funnel-explorer', render: 'funnel' }).preset).toBe('funnel-explorer');
  });

  it('a manifest without a preset reads with no preset key (unchanged)', () => {
    const m = createInsight(root, { slug: 'plain', title: 'Plain', render: 'funnel', adapter: 'script' });
    expect('preset' in m).toBe(false);
    const { data } = readFrontmatter<Record<string, unknown>>(join(root, 'lab', 'insights', 'plain.md'));
    expect('preset' in data).toBe(false);
  });

  it('later manifest writes (binding, tweaks) keep the preset', () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    writeInsightBinding(root, SLUG, { objective: 'grow-acme', value: 'latest' });
    writeInsightTweaks(root, SLUG, { range: 'last_7_days' });
    expect(getInsight(root, SLUG)?.preset).toBe('funnel-explorer');
  });
});

describe('the preset script refuses unsafe snapshots', () => {
  it('a symlinked snapshot fails the sync without reading or echoing the target', async () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    mkdirSync(join(root, 'lab', 'data'), { recursive: true });
    const outside = join(root, 'outside-secret.json');
    writeFileSync(outside, JSON.stringify(SNAPSHOT), 'utf-8');
    symlinkSync(outside, dataPath());
    const r = await syncInsight(root, SLUG, { force: 'hard' });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('is a symlink or not a regular file');
    expect(readCache(root, SLUG)?.funnel).toBeUndefined();
  });

  it('a snapshot that is not JSON fails with a fixed message, never its content', async () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    mkdirSync(join(root, 'lab', 'data'), { recursive: true });
    writeFileSync(dataPath(), 'SECRET-TOKEN-abc123 is not json', 'utf-8');
    const r = await syncInsight(root, SLUG, { force: 'hard' });
    expect(r.status).toBe('failed');
    expect(r.error).toContain(`lab/data/${SLUG}.json is not valid JSON.`);
    expect(r.error).not.toContain('SECRET');
    expect(readCache(root, SLUG)?.error ?? '').not.toContain('SECRET');
  });
});

describe('the preset script at sync', () => {
  it('fails loudly before the snapshot exists; reads it once written; a later missing snapshot keeps the prior cache', async () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });

    const before = await syncInsight(root, SLUG, { force: true });
    expect(before.status).toBe('failed');
    expect(before.error).toContain(`No snapshot yet at lab/data/${SLUG}.json`);

    mkdirSync(join(root, 'lab', 'data'), { recursive: true });
    writeFileSync(dataPath(), JSON.stringify(SNAPSHOT), 'utf-8');
    const ok = await syncInsight(root, SLUG, { force: true });
    expect(ok.status).toBe('ok');
    const cache = readCache(root, SLUG);
    expect(cache?.funnel?.set.funnels[0].steps.map((s) => s.users)).toEqual([1000, 40]);
    expect(cache?.funnel?.range).toEqual({ fromISO: '2026-09-07', toISO: '2026-10-04' });
    expect(cache?.funnel?.set.provenance).toEqual({
      source: 'Funnel Analysis via KB MCP kb_chart_query',
      pulled_at: '2026-10-08T14:33:48Z',
      freshness: 'data 2h old',
      filters: ['product = Acme Storefront', 'event_date between 2026-09-07..2026-10-04'],
    });
    expect(cache?.sourceFreshness?.marker).toBe('2026-10-08T14:33:48Z');

    unlinkSync(dataPath());
    const after = await syncInsight(root, SLUG, { force: 'hard' });
    expect(after.status).toBe('failed');
    expect(after.error).toContain('No snapshot yet');
    const kept = readCache(root, SLUG);
    expect(kept?.error).toContain('No snapshot yet');
    expect(kept?.funnel?.set.funnels[0].steps.map((s) => s.users)).toEqual([1000, 40]);
  });
});
