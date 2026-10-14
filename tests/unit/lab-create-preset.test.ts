import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
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
import { legacySnapshotScript } from '../../scripts/verify/fixtures/legacy-snapshot-script.mjs';

/**
 * `lab create --preset funnel-explorer` at the store level: the manifest, the
 * live KB MCP script and its lib-kb-mcp.mjs, the Meaning skeleton, the
 * refusals, a sync that fails loudly until the script is filled, a filled
 * script against a stand-in KB, and the deprecated snapshot fallback (an old
 * vault's snapshot-reading script).
 */

let root: string;
const SLUG = 'acme-storefront-funnels';
const manifestPath = () => join(root, 'lab', 'insights', `${SLUG}.md`);
const scriptPath = () => join(root, 'lab', 'scripts', `${SLUG}.mjs`);
const dataPath = () => join(root, 'lab', 'data', `${SLUG}.json`);
const libPath = () => join(root, 'lab', 'scripts', 'lib-kb-mcp.mjs');
const SHIPPED_LIB = readFileSync(join(__dirname, '../../src/templates/lab/lib-kb-mcp.mjs'), 'utf-8');
/** An old vault's explorer: the pre-v2.0 script that reads only the snapshot. */
const installLegacyScript = (): void => writeFileSync(scriptPath(), legacySnapshotScript(SLUG), 'utf-8');

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
  it('writes render funnel, a script adapter, the preset, no range tweak, TTL 240, KB_MCP_KEY, and no data file', () => {
    const m = createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', category: 'Acme Funnel', preset: 'funnel-explorer' });
    expect(m.render).toBe('funnel');
    expect(m.preset).toBe('funnel-explorer');
    expect(m.source).toEqual({ adapter: 'script', file: `scripts/${SLUG}.mjs` });
    expect(m.tweaks).toEqual([]);
    expect(m.refresh.ttl_minutes).toBe(240);
    expect(m.credentials_used).toEqual(['KB_MCP_KEY']);
    expect(JSON.parse(readFileSync(join(root, 'lab', 'credentials.example.json'), 'utf-8'))).toHaveProperty('KB_MCP_KEY', '');
    // An explicit --ttl still wins.
    expect(createInsight(root, { slug: 'other-funnels', title: 'x', preset: 'funnel-explorer', ttl_minutes: 60 }).refresh.ttl_minutes).toBe(60);
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
    expect(m.body).toContain('KB_MCP_KEY');
    expect(m.body).toContain(`dreamcontext lab sync ${SLUG}`);
    expect(m.body).toContain('A 401 means the script key died');
    expect(m.body).not.toContain('lab data write');
    expect(m.body).not.toContain('lab/data/');
    expect(m.body).toBe(funnelExplorerMeaning('Acme storefront funnels', null, SLUG).trim());
    expect(m.body).not.toMatch(/—/);
  });

  it('writes the live script: pulls through ./lib-kb-mcp.mjs, never reads a lab/data snapshot', () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    const script = readFileSync(scriptPath(), 'utf-8');
    expect(script).toBe(funnelExplorerScriptTemplate(SLUG));
    expect(script).toMatch(/^import \{ chartQuery, F, freshnessOf, lastFullDays, valueOf \} from '\.\/lib-kb-mcp\.mjs';$/m);
    expect(script).not.toContain('../data/');
    expect(script).not.toContain('lab/data');
    expect(script).not.toMatch(/node:fs|readFile/);
    expect(script).not.toMatch(/NEONBI_API_TOKEN|lib-neonbi|nbi_/);
    // The constants to fill, and the guard that refuses an unfilled scaffold.
    expect(script).toContain("const VAULT = '';");
    expect(script).toContain('const PRODUCTS = [];');
    expect(script).toContain('const WINDOW_DAYS = 30;');
    expect(script).toContain('const QUERIES = {');
    expect(script).toContain('function build(results, window) {');
    expect(script).toContain('fill QUERIES/build() first');
    expect(script).toContain("source: 'KB MCP · kb_chart_query'");
    expect(script).toContain('return { data: Object.assign({ window, provenance }, set), freshness };');
    expect(script).not.toMatch(/—/);
  });

  it('writes lib-kb-mcp.mjs byte-identical to the shipped helper when absent', () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    expect(readFileSync(libPath(), 'utf-8')).toBe(SHIPPED_LIB);
    expect(SHIPPED_LIB).toContain('export async function chartQuery(');
  });

  it('never overwrites an existing lib-kb-mcp.mjs, and says so when it differs', () => {
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(libPath(), '// my own edits\n', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
      expect(readFileSync(libPath(), 'utf-8')).toBe('// my own edits\n');
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/lib-kb-mcp\.mjs differs .*kept yours/);
      warn.mockClear();
      // An identical one is kept silently.
      writeFileSync(libPath(), SHIPPED_LIB, 'utf-8');
      createInsight(root, { slug: 'second-funnels', title: 'Second', preset: 'funnel-explorer' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a plain funnel script insight writes no lib-kb-mcp.mjs', () => {
    createInsight(root, { slug: 'plain', title: 'Plain', render: 'funnel', adapter: 'script' });
    expect(existsSync(libPath())).toBe(false);
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

describe('deprecated fallback: an old snapshot-reading explorer script refuses unsafe snapshots', () => {
  it('a symlinked snapshot fails the sync without reading or echoing the target', async () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    installLegacyScript();
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
    installLegacyScript();
    mkdirSync(join(root, 'lab', 'data'), { recursive: true });
    writeFileSync(dataPath(), 'SECRET-TOKEN-abc123 is not json', 'utf-8');
    const r = await syncInsight(root, SLUG, { force: 'hard' });
    expect(r.status).toBe('failed');
    expect(r.error).toContain(`lab/data/${SLUG}.json is not valid JSON.`);
    expect(r.error).not.toContain('SECRET');
    expect(readCache(root, SLUG)?.error ?? '').not.toContain('SECRET');
  });
});

describe('deprecated fallback: an old snapshot-reading explorer script at sync', () => {
  it('fails loudly before the snapshot exists; reads it once written; a later missing snapshot keeps the prior cache', async () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    installLegacyScript();

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

describe('the live preset script at sync', () => {
  /** A stand-in KB `/mcp`: answers every kb_chart_query with rows for the asked window. */
  let server: Server;
  let calls: { auth: string | undefined; args: Record<string, unknown> }[];
  const prevUrl = process.env.KB_MCP_URL;

  beforeEach(async () => {
    calls = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString('utf-8'); });
      req.on('end', () => {
        const args = (JSON.parse(body) as { params: { arguments: Record<string, unknown> } }).params.arguments;
        calls.push({ auth: req.headers.authorization, args });
        const date = (args.filters as { op: string; values?: string[] }[]).find((f) => f.op === 'between');
        const prev = calls.length > 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: {
              rows: [{ funnel_id_calc: 'quiz', sum_users: prev ? 800 : 1000, buyers: 40 }],
              columns: [],
              key_map: { metrics: { users: 'sum_users' } },
              applied_filters: [
                { field: 'product', op: '=', value: 'Acme', source: 'request' },
                { field: 'event_date', op: 'between', values: date?.values, source: 'request' },
              ],
              dropped_filters: [],
              data_age: { known: true, iso: '2026-10-14T06:00:00Z', hours: 3, note: null },
              cached: false,
              row_count: 1,
            },
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.KB_MCP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    if (prevUrl === undefined) delete process.env.KB_MCP_URL;
    else process.env.KB_MCP_URL = prevUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('an unfilled scaffold fails loudly, calls nothing and caches no funnel', async () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    const r = await syncInsight(root, SLUG, { force: 'hard' });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('fill QUERIES/build() first');
    expect(calls).toHaveLength(0);
    expect(readCache(root, SLUG)?.funnel).toBeUndefined();
  });

  it('a filled script pulls the window and the previous one with KB_MCP_KEY and builds the set with window and provenance', async () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    writeFileSync(join(root, 'lab', 'credentials.json'), JSON.stringify({ KB_MCP_KEY: 'nmk_test_key' }), 'utf-8');
    const filled = readFileSync(scriptPath(), 'utf-8')
      .replace("const VAULT = '';", "const VAULT = 'acme';")
      .replace('const PRODUCTS = [];', "const PRODUCTS = ['Acme'];")
      .replace(/const QUERIES = \{[\s\S]*?\n\};/, "const QUERIES = { funnels: { chart: 'cht_funnel', dateField: 'event_date', dimensions: ['funnel_id_calc'], metrics: ['users'], prev: true } };")
      .replace(/function build\(results, window\) \{[\s\S]*?\n\}\n/, `function build(results) {
  const now = results.funnels;
  const before = results['funnels:prev'];
  return {
    kind: 'funnel-set/v1',
    dimensions: [],
    funnels: now.rows.map((row, i) => ({
      id: String(row.funnel_id_calc),
      name: 'Quiz',
      metrics: { users: { v: valueOf(now, row, 'users'), format: 'count', prev: valueOf(before, before.rows[i], 'users') } },
      steps: [{ key: 'visit', label: 'Visit', users: valueOf(now, row, 'users') }, { key: 'buy', label: 'Buy', users: valueOf(now, row, 'buyers') }],
    })),
  };
}
`);
    expect(filled).not.toContain('NOT_FILLED);\n  //');
    writeFileSync(scriptPath(), filled, 'utf-8');

    const r = await syncInsight(root, SLUG, { force: 'hard' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('ok');

    // Two calls (window, then the previous window), each signed with the member's key, each with product + between.
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.auth).toBe('Bearer nmk_test_key');
      expect(c.args).toMatchObject({ vault_slug: 'acme', chart_id: 'cht_funnel', dimensions: ['funnel_id_calc'], metrics: ['users'] });
      expect(c.args.filters).toContainEqual({ field: 'product', op: '=', value: 'Acme' });
    }
    const [now, prev] = calls.map((c) => (c.args.filters as { op: string; values: string[] }[]).find((f) => f.op === 'between')!.values);
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
    expect(day(now[1]) - day(now[0])).toBe(29);
    expect(day(prev[1]) - day(prev[0])).toBe(29);
    expect(day(now[0]) - day(prev[1])).toBe(1);

    const cache = readCache(root, SLUG);
    expect(cache?.funnel?.set.funnels[0].steps.map((s) => s.users)).toEqual([1000, 40]);
    expect(cache?.funnel?.set.funnels[0].metrics.users.prev).toBe(800);
    expect(cache?.funnel?.set.window).toEqual({ from: now[0], to: now[1], prev_from: prev[0], prev_to: prev[1] });
    expect(cache?.funnel?.range).toEqual({ fromISO: now[0], toISO: now[1] });
    const provenance = cache?.funnel?.set.provenance;
    expect(provenance?.source).toBe('KB MCP · kb_chart_query');
    expect(provenance?.freshness).toContain('NeonBI');
    expect(provenance?.filters).toContain('product = Acme');
    expect(provenance?.filters).toContain(`event_date between ${now[0]}..${now[1]}`);
    expect(cache?.sourceFreshness?.marker).toBe('2026-10-14T06:00:00Z');
  });

  it('a 401 from the KB fails the sync with the script-key message and keeps no funnel', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { res.statusCode = 401; res.end('unauthorized'); });
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', preset: 'funnel-explorer' });
    writeFileSync(join(root, 'lab', 'credentials.json'), JSON.stringify({ KB_MCP_KEY: 'nmk_dead_key' }), 'utf-8');
    writeFileSync(scriptPath(), readFileSync(scriptPath(), 'utf-8')
      .replace("const VAULT = '';", "const VAULT = 'acme';")
      .replace('const PRODUCTS = [];', "const PRODUCTS = ['Acme'];")
      .replace(/const QUERIES = \{[\s\S]*?\n\};/, "const QUERIES = { funnels: { chart: 'cht_funnel', dateField: 'event_date', dimensions: ['funnel_id_calc'], metrics: ['users'] } };"), 'utf-8');
    const r = await syncInsight(root, SLUG, { force: 'hard' });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('401');
    expect(r.error).not.toContain('nmk_dead_key');
    expect(readCache(root, SLUG)?.funnel).toBeUndefined();
  });
});
