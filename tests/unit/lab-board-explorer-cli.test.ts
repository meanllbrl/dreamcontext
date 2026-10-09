import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProgram } from '../../src/cli/program.js';
import { handleLabBoardShow } from '../../src/server/routes/lab-boards.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { getBoard, putBoard } from '../../src/lib/lab/boards.js';
import { parseFunnelSet } from '../../src/lib/lab/funnel.js';
import { frameKey } from '../../src/lib/lab/frames.js';
import {
  benchmarkRows,
  breakdownAxes,
  dailySeries,
  funnelSlice,
  segmentRows,
  stepDrops,
  type FunnelFrame,
  type Selection,
} from '../../src/lib/lab/frameOps.js';
import { FUNNEL_EXPLORER_SIZE, funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import type { InsightCache } from '../../src/lib/lab/types.js';
import { pathToFileURL } from 'node:url';

/** The synthetic Acme lab script (a plain .mjs), run the way a sync runs it. */
const FIXTURE = pathToFileURL(join(import.meta.dirname, '../../scripts/verify/fixtures/funnel-explorer-demo.mjs')).href;

/**
 * CLI parity for the funnel explorer: `lab board show --select` computes each
 * explorer block's view with the SAME frameOps functions the dashboard blocks
 * call, over the SAME per-block frames the board route returns; and
 * `lab board add-card --preset funnel-explorer` writes the presets.ts card
 * (refusing an unsynced insight and a --block alongside).
 */

const SLUG = 'acme-funnel-explorer';
const SEL = 'platform=Meta Ads,language=EN';
const UNMEASURED = 'platform=Meta Ads,language=PT';

let projectRoot: string;
let root: string;
let cwd: string;

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
  const log = vi.spyOn(console, 'log').mockImplementation(push);
  const err = vi.spyOn(console, 'error').mockImplementation(push);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(push);
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    warnSpy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  return { code, out: lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '') };
}

function routeShow(slug: string): Promise<any> {
  let body: unknown = null;
  const res = {
    writeHead() {},
    end(data: string) { body = JSON.parse(data); },
    setHeader() {},
  } as unknown as ServerResponse;
  const req = Object.assign(Readable.from([]), { method: 'GET', url: `/api/lab/boards/${slug}`, headers: {} }) as unknown as IncomingMessage;
  return handleLabBoardShow(req, res, { slug }, root).then(() => body);
}

async function syncedCache(): Promise<InsightCache> {
  const demo = (await import(FIXTURE)).default as () => Promise<{ data: { funnel: unknown } }>;
  const out = await demo();
  const parsed = parseFunnelSet(out.data.funnel);
  return {
    slug: SLUG, fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily', unit: null,
    series: [], latest: null, error: null, errorAt: null, scriptHash: null,
    funnel: { set: parsed.set, notices: parsed.notices, range: { fromISO: '2026-09-01', toISO: '2026-09-28' } },
  } as InsightCache;
}

const SPEC = {
  title: 'Explorer demo',
  order: 1,
  cards: [
    { id: 'c-explorer', at: { x: 0, y: 0, w: 12, h: 8 }, insight: SLUG, blocks: [
      { breakdown: { data: SLUG } },
      { tabs: { tabs: [
        { label: 'Daily', blocks: [{ trend: { data: SLUG } }] },
        { label: 'Benchmark', blocks: [{ benchmark: { data: SLUG } }] },
        { label: 'Steps', blocks: [{ funnel: { data: SLUG, layout: 'bars', markWorst: true } }] },
        { label: 'Country', blocks: [{ segments: { data: SLUG, by: 'country', sort: '-users', limit: 5 } }] },
      ] } },
      { funnel: { data: SLUG } },
    ] },
  ],
};

beforeEach(async () => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-explorer-cli-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  createInsight(root, { slug: SLUG, title: 'Acme Storefront funnels', category: 'Growth' });
  writeCache(root, SLUG, await syncedCache());
  process.chdir(projectRoot);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('lab board show --select (explorer parity)', () => {
  it('each explorer block prints exactly what frameOps computes on the route frame', async () => {
    await putBoard(root, 'explorer-demo', SPEC);
    const { code, out } = await run(['lab', 'board', 'show', 'explorer-demo', '--select', SEL, '--json']);
    expect(code).toBe(0);
    const view = JSON.parse(out);
    const route = await routeShow('explorer-demo');
    const blocks = Object.fromEntries(view.cards[0].blocks.map((b: any) => [b.path, b]));
    const frame = (path: number[]) => route.frames[frameKey('c-explorer', path)] as FunnelFrame;
    const sel: Selection = { platform: 'Meta Ads', language: 'EN' };

    // The selection is a measured lookup path: nothing summed, the fixture's own users.
    const slice = funnelSlice(frame([0]), null, sel);
    expect(slice.measured).toBe(true);
    expect(blocks['0'].explorer.selection).toEqual(sel);
    expect(blocks['0'].explorer.axes).toEqual(breakdownAxes(frame([0]), null, sel));

    const trendSlice = funnelSlice(frame([1, 0, 0]), null, sel);
    expect(blocks['1.0.0'].explorer.series).toEqual(dailySeries(trendSlice, null, SLUG));
    expect(blocks['1.0.0'].explorer.series.series.length).toBeGreaterThan(0);

    const benchFrame = frame([1, 1, 0]);
    const benchSlice = funnelSlice(benchFrame, null, sel);
    const levels = benchFrame.funnels[0].metrics ?? {};
    const rows = blocks['1.1.0'].explorer.rows;
    expect(rows.map((r: any) => r.key)).toEqual(Object.keys(levels));
    const raw = benchmarkRows(benchSlice, Object.keys(levels));
    expect(rows.map((r: any) => [r.key, r.current, r.status, r.floor, r.target])).toEqual(raw.map((r) => [r.key, r.current, r.status, r.floor, r.target]));

    const stepsSlice = funnelSlice(frame([1, 2, 0]), null, sel);
    expect(blocks['1.2.0'].explorer.slice.steps).toEqual(stepsSlice.steps);
    expect(blocks['1.2.0'].explorer.drops).toEqual(stepDrops(stepsSlice.steps));
    expect(blocks['1.2.0'].explorer.drops.filter((d: any) => d.worst)).toHaveLength(1);

    const segFrame = frame([1, 3, 0]);
    const segRaw = segmentRows(segFrame, null, 'country', sel, Object.keys(segFrame.funnels[0].metrics ?? {}));
    const segOut = blocks['1.3.0'].explorer.rows;
    expect(blocks['1.3.0'].explorer.by).toBe('country');
    expect(segOut.length).toBe(Math.min(5, segRaw.length));
    // Sorted by users descending, unmeasured last, never a 0 in place of "not measured".
    const measuredUsers = segOut.filter((r: any) => r.measured).map((r: any) => r.users);
    expect(measuredUsers).toEqual([...measuredUsers].sort((a, b) => b - a));
    for (const r of segOut) expect(segRaw).toContainEqual(r);
  });

  it('a funnel block with default options and no selection keeps today\'s view (no explorer field)', async () => {
    await putBoard(root, 'explorer-demo', SPEC);
    const view = JSON.parse((await run(['lab', 'board', 'show', 'explorer-demo', '--json'])).out);
    const plain = view.cards[0].blocks.find((b: any) => b.path === '2');
    expect(plain.explorer).toBeUndefined();
    expect(plain.frame.kind).toBe('funnel');
  });

  it('an unmeasured selection reads "Not measured: reason" and no step users (not zero)', async () => {
    await putBoard(root, 'explorer-demo', SPEC);
    const json = JSON.parse((await run(['lab', 'board', 'show', 'explorer-demo', '--select', UNMEASURED, '--json'])).out);
    const steps = json.cards[0].blocks.find((b: any) => b.path === '1.2.0').explorer;
    expect(steps.slice.measured).toBe(false);
    expect(steps.slice.reason).toBe('fewer than 300 users in the window');
    expect(steps.drops).toEqual([]);
    const bench = json.cards[0].blocks.find((b: any) => b.path === '1.1.0').explorer;
    for (const r of bench.rows) {
      expect(r.status).toBe('unmeasured');
      expect(r.current).toBeNull();
    }

    const { code, out } = await run(['lab', 'board', 'show', 'explorer-demo', '--select', UNMEASURED]);
    expect(code).toBe(0);
    expect(out).toContain('Not measured: fewer than 300 users in the window');
  });

  it('human output prints the selection, the benchmark rows and marks the biggest drop', async () => {
    await putBoard(root, 'explorer-demo', SPEC);
    const { code, out } = await run(['lab', 'board', 'show', 'explorer-demo', '--select', SEL]);
    expect(code).toBe(0);
    expect(out).toContain('selection language=EN, platform=Meta Ads');
    expect(out).toContain('biggest drop');
    expect(out).toContain('country=');
  });
});

describe('lab board add-card --preset funnel-explorer', () => {
  it('writes the presets.ts card for the insight\'s dims at 12x18, titled like the insight', async () => {
    expect((await run(['lab', 'board', 'create', 'ops', '--title', 'Ops'])).code).toBe(0);
    const { code, out } = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer', '--insight', SLUG]);
    expect(code, out).toBe(0);
    const card = getBoard(root, 'ops')!.cards.find((c) => c.id === `c-${SLUG}`)!;
    expect(card.at).toMatchObject(FUNNEL_EXPLORER_SIZE);
    expect(card.title).toBe('Acme Storefront funnels');
    expect(card.insight).toBe(SLUG);
    const dims = [{ key: 'platform', label: 'Platform' }, { key: 'language', label: 'Language' }, { key: 'country', label: 'Country' }];
    const route = await routeShow('ops');
    expect(route.board.cards[0].blocks).toEqual(funnelExplorerBlocks(SLUG, dims, 'en'));
  });

  it('--locale tr writes the Turkish tab labels', async () => {
    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    expect((await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer', '--insight', SLUG, '--locale', 'tr'])).code).toBe(0);
    const tabs = getBoard(root, 'ops')!.cards[0].blocks![1].tabs!.map((t) => t.label);
    expect(tabs.slice(0, 8)).toEqual(['Günlük', 'Benchmark', 'Sıralama', 'Akış', 'Adımlar', 'Karşılaştır', 'Ödeme', 'Erişim']);
  });

  it('refuses an unsynced insight with exit 1 and names the sync', async () => {
    createInsight(root, { slug: 'acme-unsynced', title: 'Acme unsynced', category: 'Growth' });
    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    const { code, out } = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer', '--insight', 'acme-unsynced']);
    expect(code).toBe(1);
    expect(out).toContain('sync acme-unsynced first: the preset needs its funnel dimensions');
    expect(getBoard(root, 'ops')!.cards).toHaveLength(0);
  });

  it('tells a v1 app explorer with no funnel member exactly how to convert, and writes nothing', async () => {
    createInsight(root, { slug: 'acme-app-explorer', title: 'Acme app explorer', category: 'Growth' });
    writeCache(root, 'acme-app-explorer', {
      slug: 'acme-app-explorer', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: null, unit: null,
      series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      app: { spec: { kind: 'app/v1', entry: 'daily', pages: [{ id: 'daily', title: 'Daily', html: '<p>x</p>' }] } },
    } as unknown as InsightCache);
    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    const { code, out } = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer', '--insight', 'acme-app-explorer']);
    expect(code).toBe(1);
    expect(out).toContain('acme-app-explorer is an app insight with no funnel data');
    expect(out).toContain('`data.funnel`');
    expect(out).toContain('dreamcontext lab sync acme-app-explorer');
    expect(getBoard(root, 'ops')!.cards).toHaveLength(0);
  });

  it('refuses --preset with --block, an unknown preset, and a missing --insight', async () => {
    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    const both = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer', '--insight', SLUG, '--block', '{"line": {}}']);
    expect(both.code).toBe(1);
    expect(both.out).toContain('mutually exclusive');
    const unknown = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'nope', '--insight', SLUG]);
    expect(unknown.code).toBe(1);
    const noInsight = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer']);
    expect(noInsight.code).toBe(1);
    expect(getBoard(root, 'ops')!.cards).toHaveLength(0);
  });
});
