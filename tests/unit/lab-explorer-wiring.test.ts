import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { boardsDir, deriveBoards, deriveBoardsFromLegacy, getBoard, putBoard } from '../../src/lib/lab/boards.js';
import { parseFunnelSet } from '../../src/lib/lab/funnel.js';
import { frameKey, resolveBoardFrames, resolveFrame } from '../../src/lib/lab/frames.js';
import { buildBoardResponse } from '../../src/server/routes/lab-boards.js';
import { FUNNEL_EXPLORER_SIZE, funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import type { FunnelFrame } from '../../src/lib/lab/frameOps.js';
import type { InsightCache } from '../../src/lib/lab/types.js';
import { explorerSet } from '../fixtures/lab/explorer-set.js';

/**
 * The engine wiring behind the funnel explorer (T4): the frame builder maps
 * every explorer field of a funnel set, a card with a funnel picker projects
 * every funnel to its blocks (sharing identical projections), a preset insight
 * derives as the explorer card, and a tab's labelKey survives a board write.
 * Every name here is synthetic.
 */

const SLUG = 'acme-storefront-funnels';

function cacheOf(set: Record<string, unknown>): InsightCache {
  const parsed = parseFunnelSet(set);
  return {
    slug: SLUG, fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily', unit: null,
    series: [], latest: null, error: null, errorAt: null, scriptHash: null,
    funnel: { set: parsed.set, notices: parsed.notices, range: { fromISO: '2026-09-07', toISO: '2026-10-04' } },
  } as InsightCache;
}

let projectRoot: string;
let root: string;

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-explorer-wiring-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

describe('buildFunnel maps every explorer field of the set (snake -> camel)', () => {
  beforeEach(() => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', category: 'Acme Funnel', preset: 'funnel-explorer' });
    writeCache(root, SLUG, cacheOf(explorerSet()));
  });

  it('steps keep basis, measured and reason; notes carry their scope; unmeasured parts travel', () => {
    const f = resolveFrame(root, SLUG, ['funnel']) as FunnelFrame;
    const f100 = f.funnels[0];
    expect(f100.steps).toEqual([
      { key: 'users', label: 'Users', users: 5000 },
      { key: 'lead', label: 'Lead', users: 1200, basis: 'derived' },
      { key: 'finish', label: 'Finish', users: 0, measured: false, reason: 'finish event not recorded' },
      { key: 'subs', label: 'Subscribed', users: 60 },
    ]);
    expect(f100.notes).toEqual([{ code: 'C1', text: 'no checkout event in this series', level: 'trap', keys: ['subs'], scope: 'funnel' }]);
    expect(f.notes).toEqual([
      { code: null, text: 'refund rate not used: it ignores the date filter', level: 'info', keys: [], scope: 'set' },
      { code: 'R1', text: 'RU is a language, not a country', level: 'trap', keys: ['dim:country'], scope: 'set' },
    ]);
    expect(f.funnels[1].unmeasured).toEqual({ segments: 'breakdowns are pulled for the larger funnels only' });
  });

  it('payment (cohort all by default), payment reasons, access, window, provenance, hints, rates, intersections, ladder', () => {
    const f = resolveFrame(root, SLUG, ['funnel']) as FunnelFrame;
    expect(f.funnels[0].payment).toEqual({
      measured: true,
      reason: null,
      cells: [
        { dims: {}, cohort: 'all', attempts: 400, declines: 80, reasons: { insufficient: 30 } },
        { dims: { country: 'TR' }, cohort: 'all', attempts: 50, declines: 10, reasons: { insufficient: 4 } },
      ],
    });
    expect(f.paymentReasons).toEqual([{ key: 'insufficient', label: 'Insufficient funds', note: null }]);
    expect(f.access).toEqual({
      stages: [{ key: 'paid', label: 'Paid' }, { key: 'app', label: 'Opened the app' }],
      rows: [{ funnel: null, dims: {}, counts: { paid: 60, app: 45 } }, { funnel: '100', dims: {}, counts: { paid: 40, app: 30 } }],
      asOf: '2026-10-08',
    });
    expect(f.window).toEqual({ from: '2026-09-07', to: '2026-10-04', prevFrom: '2026-08-10', prevTo: '2026-09-06' });
    expect(f.provenance).toEqual({ source: 'Funnel Analysis via KB MCP', pulledAt: '2026-10-08T14:33:48Z', freshness: 'data 2h old', filters: ['product = Acme'] });
    expect(f.hints).toEqual({ daily: 'pull the daily series by funnel and day' });
    expect(f.rates).toEqual({ click_to_sub: { num: 'subs', den: 'users' } });
    expect(f.intersections).toEqual([{ dims: ['country', 'platform'], minUsers: 300 }]);
    expect(f.ladder).toEqual(['click_to_sub']);
  });

  it('a ladder-derived band says which input won each bound and the weeks behind it', () => {
    const f = resolveFrame(root, SLUG, ['funnel']) as FunnelFrame;
    // Set weeks before the window: 0.4, 0.6, 0.8, 1.0 -> own p25 0.55 beats the book 0.5; the book 1.5 beats own p75 0.85.
    expect(f.bands?.click_to_sub).toMatchObject({ floor: 0.55, target: 1.5, floorFrom: 'own', targetFrom: 'book', weeks: 4, better: 'higher' });
  });

  it('a set without the explorer fields maps exactly as before (no new keys)', () => {
    const plain = explorerSet();
    for (const k of ['window', 'provenance', 'hints', 'rates', 'intersections', 'ladder', 'weekly', 'notes', 'payment_reasons', 'access']) delete plain[k];
    for (const fn of plain.funnels as Record<string, unknown>[]) {
      for (const k of ['notes', 'payment', 'unmeasured']) delete fn[k];
      fn.steps = (fn.steps as Record<string, unknown>[]).map(({ key, label, users }) => ({ key, label, users }));
    }
    writeCache(root, SLUG, cacheOf(plain));
    const f = resolveFrame(root, SLUG, ['funnel']) as FunnelFrame;
    for (const k of ['window', 'provenance', 'notes', 'hints', 'rates', 'intersections', 'ladder', 'payment', 'paymentReasons', 'access', 'bands']) {
      expect(f, k).not.toHaveProperty(k);
    }
    for (const fn of f.funnels) {
      for (const k of ['notes', 'payment', 'unmeasured', 'bands']) expect(fn, k).not.toHaveProperty(k);
      for (const s of fn.steps) expect(Object.keys(s).sort()).toEqual(['key', 'label', 'users']);
    }
  });
});

describe('a card with a funnel picker projects every funnel to its blocks', () => {
  beforeEach(() => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', category: 'Acme Funnel', preset: 'funnel-explorer' });
    writeCache(root, SLUG, cacheOf(explorerSet()));
  });

  async function board() {
    const dims = [{ key: 'platform', label: 'Platform' }, { key: 'country', label: 'Country' }];
    await putBoard(root, 'explorer', {
      title: 'Explorer',
      order: 1,
      cards: [
        { id: 'x', at: { x: 0, y: 0, ...FUNNEL_EXPLORER_SIZE }, insight: SLUG, blocks: funnelExplorerBlocks(SLUG, dims, 'en') },
        // The same benchmark on a card without a picker: the first funnel in full, the rest as heads.
        { id: 'plain', at: { x: 0, y: FUNNEL_EXPLORER_SIZE.h, w: 6, h: 6 }, blocks: [{ breakdown: { data: SLUG } }, { benchmark: { data: SLUG } }] },
      ],
    } as never);
    return getBoard(root, 'explorer')!;
  }

  it('the picker card carries every funnel in full; a plain card keeps the first-funnel projection', async () => {
    const frames = resolveBoardFrames(root, await board());
    const bench = frames[frameKey('x', [1, 1, 0])] as FunnelFrame;
    expect(bench.funnels[1].metrics?.click_to_sub?.v).toBe(0.78);
    const plain = frames[frameKey('plain', [1])] as FunnelFrame;
    expect(plain.funnels[1].metrics).toBeUndefined();
    // Notes and not-measured reasons travel on every funnel of every projection, heads included.
    expect(plain.funnels[1].notes?.[0].code).toBe('C8');
    expect(plain.funnels[1].unmeasured).toEqual({ segments: 'breakdowns are pulled for the larger funnels only' });
    // Only the payment and access blocks carry their parts.
    expect((frames[frameKey('x', [1, 6, 0])] as FunnelFrame).funnels[0].payment?.cells).toHaveLength(2);
    expect((frames[frameKey('x', [1, 7, 0])] as FunnelFrame).access?.rows).toHaveLength(2);
    expect(bench.access).toBeUndefined();
    expect(bench.funnels[0].payment).toBeUndefined();
  });

  it('the rates blocks of the picker card share one copy on the wire; the steps blocks another', async () => {
    const wire = JSON.parse(JSON.stringify(buildBoardResponse(root, await board())));
    for (const path of ['1.1.0', '1.2.0', '1.8.0', '1.9.0']) expect(wire.frameAliases[`x:${path}`], path).toBe('x:0');
    expect(wire.frameAliases['x:1.4.0']).toBe('x:1.3.0');
    expect(wire.frameAliases['x:1.5.0']).toBe('x:1.3.0');
    expect(wire.frames['plain:1']).toBeDefined();
  });
});

describe('a funnel-explorer insight derives as the explorer card', () => {
  it('deriveBoardsFromLegacy: a 12x18 preset card with the axis tabs, other insights unchanged', () => {
    const base = { category: 'Acme Funnel', group: null, render: 'funnel' as const, size: null, width: null, height: null };
    const [b] = deriveBoardsFromLegacy([
      { ...base, slug: 'acme-a', title: 'A', preset: 'funnel-explorer', presetDims: [{ key: 'country', label: 'Country' }] },
      { ...base, slug: 'acme-b', title: 'B' },
    ]);
    const [explorer, legacy] = b.spec.cards;
    expect(explorer).toEqual({
      id: 'c-acme-a',
      at: { x: 0, y: 0, ...FUNNEL_EXPLORER_SIZE },
      insight: 'acme-a',
      blocks: funnelExplorerBlocks('acme-a', [{ key: 'country', label: 'Country' }], 'en'),
    });
    expect(legacy.blocks).toBeUndefined();
    expect(legacy.at.y).toBe(FUNNEL_EXPLORER_SIZE.h);
  });

  it('deriveBoards reads the manifest preset and the cached client dims (none before the first sync)', () => {
    createInsight(root, { slug: SLUG, title: 'Acme storefront funnels', category: 'Acme Funnel', preset: 'funnel-explorer' });
    createInsight(root, { slug: 'acme-signups', title: 'Signups', category: 'Acme Funnel' });
    const before = deriveBoards(root)[0].spec.cards.find((c) => c.id === `c-${SLUG}`)!;
    expect(before.blocks![1].tabs!.map((t) => t.label)).toEqual(['Daily', 'Benchmark', 'Ranking', 'Flow', 'Steps', 'Compare', 'Payment', 'Access']);
    writeCache(root, SLUG, cacheOf(explorerSet()));
    const after = deriveBoards(root)[0].spec.cards;
    const card = after.find((c) => c.id === `c-${SLUG}`)!;
    expect(card.blocks).toEqual(funnelExplorerBlocks(SLUG, [{ key: 'platform', label: 'Platform' }, { key: 'country', label: 'Country' }], 'en'));
    expect(after.find((c) => c.id === 'c-acme-signups')!.blocks).toBeUndefined();
  });
});

describe('a tab labelKey round-trips through a board write', () => {
  it('an explorer key is kept and written; any other key is dropped', async () => {
    await putBoard(root, 'keys', {
      title: 'Keys',
      order: 1,
      cards: [{ id: 't', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ tabs: { tabs: [
        { label: 'Daily', labelKey: 'lab.explorer.tab.daily', blocks: [{ text: { markdown: 'a' } }] },
        { label: 'Ülke', labelKey: 'lab.explorer.tab.dim.country', blocks: [{ text: { markdown: 'b' } }] },
        { label: 'Other', labelKey: 'lab.board.other', blocks: [{ text: { markdown: 'c' } }] },
      ] } }] }],
    } as never);
    const tabs = getBoard(root, 'keys')!.cards[0].blocks![0].tabs!;
    expect(tabs.map((t) => t.labelKey)).toEqual(['lab.explorer.tab.daily', 'lab.explorer.tab.dim.country', undefined]);
    const file = readFileSync(join(boardsDir(root), 'keys.md'), 'utf-8');
    expect(file).toContain('labelKey: lab.explorer.tab.dim.country');
    expect(file).not.toContain('lab.board.other');
  });
});
