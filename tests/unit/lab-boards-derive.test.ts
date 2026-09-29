import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import {
  deriveBoards,
  deriveBoardsFromLegacy,
  listBoards,
  validateBoardSpec,
  type LegacyInsight,
} from '../../src/lib/lab/boards.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

const ins = (slug: string, extra: Partial<LegacyInsight> = {}): LegacyInsight => ({
  slug,
  title: slug,
  category: null,
  group: null,
  render: 'number',
  size: null,
  width: null,
  height: null,
  ...extra,
});

describe('deriveBoardsFromLegacy (pure)', () => {
  it('makes one board per category, named alphabetical then Other last, with deterministic card ids', () => {
    const boards = deriveBoardsFromLegacy([
      ins('b-signups', { category: 'Marketing' }),
      ins('a-revenue', { category: 'Finance' }),
      ins('loose'),
    ]);
    expect(boards.map((b) => b.slug)).toEqual(['finance', 'marketing', 'other']);
    expect(boards.map((b) => b.spec.order)).toEqual([1, 2, 3]);
    expect(boards[2].spec.titleKey).toBe('lab.board.other');
    expect(boards[0].spec.cards.map((c) => c.id)).toEqual(['c-a-revenue']);
    expect(boards[0].spec.cards[0].insight).toBe('a-revenue');
    expect(boards[0].spec.cards[0].blocks).toBeUndefined(); // legacy insight render
  });

  it('with no categories at all makes one localized "Insights" board', () => {
    const boards = deriveBoardsFromLegacy([ins('x'), ins('y')]);
    expect(boards).toHaveLength(1);
    expect(boards[0].slug).toBe('insights');
    expect(boards[0].spec.titleKey).toBe('lab.board.insights');
  });

  it('takes board order from catOrder and card order from order[...] without changing slugs or ids', () => {
    const list = [
      ins('a1', { category: 'Alpha', group: 'G' }),
      ins('a2', { category: 'Alpha', group: 'G' }),
      ins('b1', { category: 'Beta' }),
    ];
    const plain = deriveBoardsFromLegacy(list);
    const withPrefs = deriveBoardsFromLegacy(list, { catOrder: ['Beta', 'Alpha'], order: { 'Alpha / G': ['a2', 'a1'] } });
    expect(withPrefs.map((b) => b.slug)).toEqual(['beta', 'alpha']);
    const alpha = withPrefs.find((b) => b.slug === 'alpha')!;
    const cards = alpha.spec.cards.filter((c) => c.insight);
    expect(cards.map((c) => c.id)).toEqual(['c-a2', 'c-a1']);
    expect(cards[0].at.x).toBe(0);
    // Same slugs and ids either way: prefs never feed identity.
    const ids = (bs: typeof plain) => bs.flatMap((b) => b.spec.cards.map((c) => `${b.slug}:${c.id}`)).sort();
    expect(ids(withPrefs)).toEqual(ids(plain));
  });

  it('turns each group into a full-width text heading (w12 h1) with id h-<board>-<group>, Ungrouped last', () => {
    const [board] = deriveBoardsFromLegacy([
      ins('z', { category: 'Growth' }),
      ins('m', { category: 'Growth', group: 'Activation' }),
    ]);
    const headings = board.spec.cards.filter((c) => c.blocks);
    expect(headings.map((h) => h.id)).toEqual(['h-growth-activation', 'h-growth-ungrouped']);
    for (const h of headings) {
      expect(h.at).toMatchObject({ x: 0, w: 12, h: 1 });
      expect(h.blocks![0].type).toBe('text');
    }
    expect(headings[0].blocks![0].options.markdown).toBe('### Activation');
    expect(board.spec.cards.map((c) => c.id)).toEqual(['h-growth-activation', 'c-m', 'h-growth-ungrouped', 'c-z']);
  });

  it('adds no heading when a category has only ungrouped insights', () => {
    const [board] = deriveBoardsFromLegacy([ins('a', { category: 'Solo' })]);
    expect(board.spec.cards.map((c) => c.id)).toEqual(['c-a']);
  });

  it('maps width 1/2/3 -> w 4/8/12 and height s/m/l/xl -> h 3/4/6/8, packing rows left to right', () => {
    const [board] = deriveBoardsFromLegacy([
      ins('a', { width: 1, height: 's' }),
      ins('b', { width: 2, height: 'xl' }),
      ins('c', { width: 3, height: 'l' }),
      ins('d', { height: 'm' }),
    ]);
    const at = Object.fromEntries(board.spec.cards.map((c) => [c.insight, c.at]));
    expect(at.a).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(at.b).toEqual({ x: 4, y: 0, w: 8, h: 8 });
    expect(at.c).toEqual({ x: 0, y: 8, w: 12, h: 6 });
    expect(at.d).toEqual({ x: 0, y: 14, w: 4, h: 4 });
  });

  it('falls back to legacy size, then the render default span (from the engine catalog), then h 4; app and html bodies get h 6', () => {
    const [board] = deriveBoardsFromLegacy([
      ins('a-size-l', { size: 'l' }),
      ins('b-table', { render: 'table' }),
      ins('c-app', { render: 'app' }),
      ins('d-html', { hasHtmlBody: true }),
      ins('e-plain'),
    ]);
    const at = Object.fromEntries(board.spec.cards.map((c) => [c.insight, c.at]));
    expect(at['a-size-l']).toMatchObject({ w: 8, h: 6 });
    expect(at['b-table']).toMatchObject({ w: 8, h: 4 });
    expect(at['c-app']).toMatchObject({ w: 8, h: 6 });
    expect(at['d-html']).toMatchObject({ w: 4, h: 6 });
    expect(at['e-plain']).toMatchObject({ w: 4, h: 4 });
  });

  it('every derived board passes strict validation (materialize writes them as-is)', () => {
    const boards = deriveBoardsFromLegacy([
      ins('a', { category: 'Ürün Büyümesi', group: 'Aktivasyon', width: 3 }),
      ins('b', { category: 'Ürün Büyümesi', group: 'Gelir', render: 'funnel' }),
      ins('c', { category: 'Other', size: 's' }),
      ins('d'),
    ]);
    for (const b of boards) {
      const v = validateBoardSpec(b.spec, b.slug);
      expect(v.errors).toEqual([]);
    }
    expect(boards.map((b) => b.slug)).toEqual(['urun-buyumesi', 'other']);
  });

  it('is deterministic: the same input derives byte-equal specs', () => {
    const list = [ins('a', { category: 'X', group: 'g1' }), ins('b', { category: 'Y' })];
    expect(JSON.stringify(deriveBoardsFromLegacy(list))).toBe(JSON.stringify(deriveBoardsFromLegacy([...list].reverse())));
  });
});

describe('deriveBoards (vault)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-lab-derive-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const cache = (slug: string, extra: Partial<InsightCache> = {}): InsightCache => ({
    slug, fetchedAt: '2026-09-01T00:00:00Z', tweaks: {}, granularity: 'daily', unit: null,
    series: [], latest: 1, error: null, errorAt: null, scriptHash: null, ...extra,
  });

  it('reads manifests + .lab-prefs.json, detects html/v1 bodies, and writes nothing to disk', () => {
    createInsight(root, { slug: 'signups', title: 'Signups', category: 'Growth' });
    createInsight(root, { slug: 'revenue', title: 'Revenue', category: 'Finance' });
    createInsight(root, { slug: 'custom', title: 'Custom', category: 'Growth', adapter: 'script' });
    writeCache(root, 'custom', cache('custom', { html: '<p>hi</p>' }));
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', '.lab-prefs.json'), JSON.stringify({ catOrder: ['Growth'], order: { 'Growth / Ungrouped': ['signups', 'custom'] }, columns: { x: ['a'] } }));
    const before = readdirSync(join(root, 'lab')).sort();

    const boards = deriveBoards(root);
    expect(boards.map((b) => b.slug)).toEqual(['growth', 'finance']);
    const growth = boards[0].spec.cards;
    expect(growth.map((c) => c.id)).toEqual(['c-signups', 'c-custom']);
    expect(growth[1].at.h).toBe(6);

    const listed = listBoards(root);
    expect(listed.derived).toBe(true);
    expect(listed.boards.every((b) => b.derived && b.rev.length === 16)).toBe(true);
    expect(readdirSync(join(root, 'lab')).sort()).toEqual(before);
    expect(existsSync(join(root, 'lab', 'boards'))).toBe(false);
    expect(existsSync(join(root, 'state', '.locks'))).toBe(false);
  });

  it('every insight is present on exactly one derived board', () => {
    for (const [i, cat] of ['A', 'B', null, 'A', null].entries()) {
      createInsight(root, { slug: `i${i}`, title: `I${i}`, category: cat, group: i % 2 ? 'g' : null });
    }
    const placed = deriveBoards(root).flatMap((b) => b.spec.cards.map((c) => c.insight).filter(Boolean));
    expect(placed.sort()).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
  });
});
