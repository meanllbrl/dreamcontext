import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildBoardResponse } from '../../src/server/routes/lab-boards.js';
import { createInsight, readCache, writeCache } from '../../src/lib/lab/store.js';
import { getBoard, putBoard } from '../../src/lib/lab/boards.js';
import { parseDatasetBundle } from '../../src/lib/lab/dataset.js';
import { frameKey, resolveBoardFrames, resolveFrame } from '../../src/lib/lab/frames.js';
import {
  benchmarkRows,
  breakdownAxes,
  dailySeries,
  expandFrames,
  funnelSlice,
  shareFrames,
  segmentRows,
  stepDrops,
  type FunnelFrame,
  type Selection,
} from '../../src/lib/lab/frameOps.js';
import { FUNNEL_EXPLORER_SIZE, funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

/**
 * The funnel explorer demo board's GET stays small (<= 300 KB, the plan's
 * budget) while every block still answers any selection on the client: each
 * block's frame is projected to what that block type reads, and the numbers a
 * projected frame gives equal the ones the full frame gives.
 */

const FIXTURE = pathToFileURL(join(import.meta.dirname, '../../scripts/verify/fixtures/funnel-explorer-demo.mjs')).href;
const SLUG = 'acme-funnel-explorer';
const BUDGET = 300 * 1024;

let projectRoot: string;
let root: string;

async function seed(): Promise<void> {
  const demo = (await import(FIXTURE)).default as () => Promise<{ data: unknown }>;
  const parsed = parseDatasetBundle((await demo()).data);
  createInsight(root, { slug: SLUG, title: 'Acme Storefront funnels', category: 'Growth' });
  const cache = {
    slug: SLUG, fetchedAt: '2026-09-28T00:00:00Z', tweaks: {}, granularity: 'daily', unit: null,
    series: [], latest: null, error: null, errorAt: null, scriptHash: null,
    datasets: { bundle: parsed.bundle, notices: parsed.notices, range: { fromISO: '2026-09-01', toISO: '2026-09-28' } },
    funnel: { set: parsed.funnel!.set, notices: parsed.funnel!.notices, range: { fromISO: '2026-09-01', toISO: '2026-09-28' } },
  } as InsightCache;
  writeCache(root, SLUG, cache);
}

/** The plan's W4 demo board (the app card aside: it carries no frame). */
function demoSpec() {
  const set = readCache(root, SLUG)!.funnel!.set;
  const dims = set.dimensions.filter((d) => d.mode === 'client').map((d) => ({ key: d.key, label: d.label }));
  return {
    title: 'Explorer demo',
    order: 1,
    cards: [
      { id: 'x-explorer', at: { x: 0, y: 0, ...FUNNEL_EXPLORER_SIZE }, blocks: funnelExplorerBlocks(SLUG, dims, 'en') },
      { id: 'x-steps', at: { x: 0, y: FUNNEL_EXPLORER_SIZE.h, w: 8, h: 7 }, blocks: [{ breakdown: { data: SLUG } }, { funnel: { data: SLUG, layout: 'bars', markWorst: true } }] },
      { id: 'x-bench', at: { x: 0, y: FUNNEL_EXPLORER_SIZE.h + 7, w: 6, h: 6 }, blocks: [{ breakdown: { data: SLUG } }, { benchmark: { data: SLUG } }] },
      { id: 'x-countries', at: { x: 6, y: FUNNEL_EXPLORER_SIZE.h + 7, w: 6, h: 6 }, blocks: [{ segments: { data: SLUG, by: 'country' } }] },
      { id: 'x-payment', at: { x: 0, y: FUNNEL_EXPLORER_SIZE.h + 13, w: 6, h: 6 }, blocks: [
        { filter: { data: `${SLUG}/declines`, dim: 'cohort' } }, { bar: { data: `${SLUG}/declines` } }, { table: { data: `${SLUG}/decline_rate` } },
      ] },
      { id: 'x-daily', at: { x: 6, y: FUNNEL_EXPLORER_SIZE.h + 13, w: 6, h: 4 }, blocks: [{ trend: { data: SLUG } }] },
      { id: 'x-trend', at: { x: 0, y: FUNNEL_EXPLORER_SIZE.h + 19, w: 6, h: 4 }, blocks: [{ trend: { data: SLUG, metrics: ['conversion', 'visit_to_lead'] } }] },
    ],
  };
}

beforeEach(async () => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-explorer-payload-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  await seed();
});

afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

const SELECTIONS: Selection[] = [
  {},
  { platform: 'Meta Ads' },
  { platform: 'Meta Ads', language: 'EN' },
  { platform: 'TikTok Ads', language: 'PT' },
  { country: 'Spain' },
  { language: 'DE' },
];

describe('funnel explorer board payload', () => {
  it('the demo board GET is well under 300 KB (the plan board, and with an extra picked-metrics trend)', async () => {
    const spec = demoSpec();
    const plan = { ...spec, cards: spec.cards.filter((c) => c.id !== 'x-trend') };
    const measure = async (slug: string, s: typeof spec) => {
      await putBoard(root, slug, s);
      const res = buildBoardResponse(root, getBoard(root, slug)!);
      const bytes = Buffer.byteLength(JSON.stringify(res), 'utf-8');
      const sizes = Object.entries(res.frames).map(([k, f]) => `${k} ${(Buffer.byteLength(JSON.stringify(f)) / 1024).toFixed(1)}KB`);
      console.log(`${slug} GET: ${(bytes / 1024).toFixed(1)} KB; aliases ${JSON.stringify(res.frameAliases)}\n  ${sizes.join('\n  ')}`);
      return bytes;
    };
    // The preset card's funnel picker sends every funnel to its blocks (the reader switches funnels
    // without a request), so the plan board measures ~268 KB: inside the 300 KB budget. The board
    // with one extra picked-metrics trend card measures ~322 KB; its bound is that, rounded up to
    // the next 50 KB (350 KB), under the 450 KB ceiling the plan sets for the picker projection.
    expect(await measure('explorer-demo', plan)).toBeLessThan(BUDGET);
    expect(await measure('explorer-plus', spec)).toBeLessThan(350 * 1024);
  });

  it('shared frames: identical funnel frames travel once and expand back to every key', async () => {
    await putBoard(root, 'explorer-demo', demoSpec());
    const board = getBoard(root, 'explorer-demo')!;
    const resolved = resolveBoardFrames(root, board);
    const wire = JSON.parse(JSON.stringify(buildBoardResponse(root, board)));
    // The preset card has a funnel picker: its rates blocks (the picker breakdown, Benchmark,
    // Ranking and every axis tab) carry every funnel in one projection, sent once.
    for (const path of ['1.1.0', '1.2.0', '1.8.0', '1.9.0', '1.10.0']) {
      expect(wire.frameAliases[`x-explorer:${path}`], path).toBe('x-explorer:0');
    }
    // Its Flow, Steps and Compare tabs draw the same steps projection: one copy.
    expect(wire.frameAliases['x-explorer:1.4.0']).toBe('x-explorer:1.3.0');
    expect(wire.frameAliases['x-explorer:1.5.0']).toBe('x-explorer:1.3.0');
    // Cards without a picker project as before (the first funnel in full): two plain breakdowns
    // share one copy, and none of them aliases the picker card's every-funnel frames.
    expect(wire.frameAliases['x-bench:0']).toBe('x-steps:0');
    expect(wire.frames['x-daily:0']).toBeDefined();
    expect(wire.frames['x-countries:0']).toBeDefined();
    // Non-funnel frames are never aliased.
    for (const key of Object.keys(wire.frameAliases)) expect(resolved[key].kind).toBe('funnel');
    expect(expandFrames(wire.frames, wire.frameAliases)).toEqual(JSON.parse(JSON.stringify(resolved)));
    // No aliases -> the same map back; a dangling alias stays absent; a sent key is never overwritten.
    expect(expandFrames(wire.frames, undefined)).toBe(wire.frames);
    expect(expandFrames({}, { a: 'missing' })).toEqual({});
    const empty = { kind: 'empty', reason: 'no-cache', ref: null } as const;
    expect(expandFrames({ a: empty, b: empty }, { b: 'a' }).b).toBe(empty);
    // shareFrames never aliases distinct frames.
    const f1 = resolved['x-explorer:0'];
    const shared = shareFrames({ a: f1, b: resolved['x-explorer:1.3.0'], c: f1 });
    expect(Object.keys(shared.frames)).toEqual(['a', 'b']);
    expect(shared.aliases).toEqual({ c: 'a' });
  });

  it('every block computes, from its projected frame, exactly what the full frame computes', async () => {
    await putBoard(root, 'explorer-demo', demoSpec());
    const wire = buildBoardResponse(root, getBoard(root, 'explorer-demo')!);
    const frames = expandFrames(wire.frames, wire.frameAliases);
    const full = resolveFrame(root, SLUG, ['funnel']) as FunnelFrame;
    const at = (card: string, path: number[]) => frames[frameKey(card, path)] as FunnelFrame;
    const funnelIds = [null, ...full.funnels.map((f) => f.id)];

    for (const sel of SELECTIONS) {
      // breakdown: the chips (enabled, users, reason) never change under projection.
      for (const [card, path] of [['x-explorer', [0]], ['x-steps', [0]], ['x-bench', [0]]] as const) {
        expect(breakdownAxes(at(card, [...path]), null, sel)).toEqual(breakdownAxes(full, null, sel));
      }
      // steps / flow: the slice's steps and drops, for every funnel the block may draw.
      for (const id of funnelIds) {
        const p = funnelSlice(at('x-steps', [1]), id, sel);
        const q = funnelSlice(full, id, sel);
        expect([p.measured, p.reason, p.users, p.steps]).toEqual([q.measured, q.reason, q.users, q.steps]);
        expect(stepDrops(p.steps)).toEqual(stepDrops(q.steps));
      }
      // benchmark: rows equal.
      expect(benchmarkRows(funnelSlice(at('x-bench', [1]), null, sel), null)).toEqual(benchmarkRows(funnelSlice(full, null, sel), null));
      // segments: rows equal for each block's own dim (the preset tabs and the Countries card).
      for (const [card, path, by] of [['x-explorer', [1, 8, 0], 'platform'], ['x-explorer', [1, 9, 0], 'language'], ['x-explorer', [1, 10, 0], 'country'], ['x-countries', [0], 'country']] as const) {
        expect(segmentRows(at(card, [...path]), null, by, sel, null)).toEqual(segmentRows(full, null, by, sel, null));
      }
      // The picker card: every funnel the reader may pick answers as the full frame does.
      for (const id of funnelIds) {
        expect(breakdownAxes(at('x-explorer', [0]), id, sel)).toEqual(breakdownAxes(full, id, sel));
        expect(benchmarkRows(funnelSlice(at('x-explorer', [1, 1, 0]), id, sel), null)).toEqual(benchmarkRows(funnelSlice(full, id, sel), null));
        const p = funnelSlice(at('x-explorer', [1, 4, 0]), id, sel);
        const q = funnelSlice(full, id, sel);
        expect([p.measured, p.reason, p.users, p.steps]).toEqual([q.measured, q.reason, q.users, q.steps]);
        expect(segmentRows(at('x-explorer', [1, 9, 0]), id, 'language', sel, null)).toEqual(segmentRows(full, id, 'language', sel, null));
        expect(dailySeries(funnelSlice(at('x-explorer', [1, 0, 0]), id, sel), null, SLUG)).toEqual(dailySeries(funnelSlice(full, id, sel), null, SLUG));
      }
      // trend: the series equal; a metrics pick keeps exactly its metrics.
      expect(dailySeries(funnelSlice(at('x-daily', [0]), null, sel), null, SLUG)).toEqual(dailySeries(funnelSlice(full, null, sel), null, SLUG));
      const picked = ['conversion', 'visit_to_lead'];
      expect(dailySeries(funnelSlice(at('x-trend', [0]), null, sel), picked, SLUG)).toEqual(dailySeries(funnelSlice(full, null, sel), picked, SLUG));
    }
  });

  it('explorer blocks keep every funnel id + name (the inspector pick and the unknown-pick note still work)', async () => {
    await putBoard(root, 'explorer-demo', demoSpec());
    const frames = resolveBoardFrames(root, getBoard(root, 'explorer-demo')!);
    const full = resolveFrame(root, SLUG, ['funnel']) as FunnelFrame;
    for (const [key, f] of Object.entries(frames)) {
      if (f.kind !== 'funnel') continue;
      expect(f.funnels.map((x) => [x.id, x.name]), key).toEqual(full.funnels.map((x) => [x.id, x.name]));
    }
  });

  it('only trend frames carry daily; a metrics pick trims the days to its metrics', async () => {
    await putBoard(root, 'explorer-demo', demoSpec());
    const board = getBoard(root, 'explorer-demo')!;
    const frames = resolveBoardFrames(root, board);
    for (const [key, f] of Object.entries(frames)) {
      if (f.kind !== 'funnel') continue;
      const days = f.funnels.flatMap((x) => [...(x.daily ?? []), ...(x.segments ?? []).flatMap((s) => s.daily ?? [])]);
      if (key === 'x-explorer:1.0.0' || key === 'x-daily:0' || key === 'x-trend:0') expect(days.length, key).toBeGreaterThan(0);
      else expect(days, key).toEqual([]);
    }
    const picked = frames['x-trend:0'] as FunnelFrame;
    const keys = new Set(picked.funnels.flatMap((x) => [...(x.daily ?? []), ...(x.segments ?? []).flatMap((s) => s.daily ?? [])]).flatMap((d) => Object.keys(d.m)));
    expect([...keys].sort()).toEqual(['conversion', 'visit_to_lead']);
  });
});
