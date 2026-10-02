import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gitMock from '../../src/lib/git-sync/git.js';
import { classifyPath, mergeLabBoard, resolveConflicts } from '../../src/lib/git-sync/semantic-merge.js';
import { boardsDir, getBoard, parseBoardText, putBoard, serializeBoardSpec, type BoardSpec } from '../../src/lib/lab/boards.js';
import { findOverlaps } from '../../src/lib/lab/grid.js';
import { createInsight } from '../../src/lib/lab/store.js';

/**
 * The `lab-board` merge class (D7 + r3.2): board files union their cards by
 * id, deterministically, so two teammates whose first edits each materialize
 * every board do not hand the agent a conflict per board.
 */

vi.mock('../../src/lib/git-sync/git.js', () => {
  const fixtures = new Map<string, { base: string; ours: string; theirs: string }>();
  return {
    __setFixture: (path: string, v: { base: string; ours: string; theirs: string }) => fixtures.set(path, v),
    readOursTheirsBase: (_cwd: string, path: string) => fixtures.get(path) ?? { base: '', ours: '', theirs: '' },
    addPath: () => {},
  };
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setFixture = (gitMock as any).__setFixture as (path: string, v: { base: string; ours: string; theirs: string }) => void;

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** One machine's vault: the same insights, its own local prefs, plus `extra` insights. */
async function machine(prefs: Record<string, unknown>, extra: Array<{ slug: string; category: string }> = []): Promise<Record<string, string>> {
  const root = tmp('dc-lab-merge-machine-');
  mkdirSync(join(root, 'state'), { recursive: true });
  for (const [slug, category, group] of [
    ['signups', 'Growth', 'Top'], ['visits', 'Growth', 'Top'], ['activation', 'Growth', null],
    ['mrr', 'Revenue', null], ['churn', 'Revenue', null], ['latency', null, null],
  ] as const) {
    createInsight(root, { slug, title: slug, category, group });
  }
  for (const e of extra) createInsight(root, { slug: e.slug, title: e.slug, category: e.category });
  writeFileSync(join(root, 'state', '.lab-prefs.json'), JSON.stringify(prefs));
  // The first edit (an unchanged save of one board) materializes every board.
  const first = getBoard(root, 'growth')!;
  await putBoard(root, 'growth', first, { expectedRev: first.rev });
  return Object.fromEntries(readdirSync(boardsDir(root)).map((f) => [f, readFileSync(join(boardsDir(root), f), 'utf-8')]));
}

const card = (id: string, y: number, extra: Record<string, unknown> = {}) => ({ id, at: { x: 0, y, w: 4, h: 3 }, insight: id.replace(/^c-/, ''), ...extra });
const board = (cards: unknown[], extra: Partial<BoardSpec> = {}): string =>
  serializeBoardSpec({ title: 'Growth', order: 1, body: '', cards: cards as BoardSpec['cards'], ...extra });
const ids = (text: string): string[] => parseBoardText('growth', text).cards.map((c) => c.id);

describe('classification', () => {
  it('lab/boards/*.md is the lab-board class; lab/blocks/*.md stays on the prose path', () => {
    expect(classifyPath('lab/boards/growth.md')).toBe('lab-board');
    expect(classifyPath('_dream_context/lab/boards/growth.md')).toBe('lab-board');
    expect(classifyPath('lab/blocks/cohort-grid.md')).toBe('other');
    expect(classifyPath('lab/boards/nested/x.md')).toBe('other');
  });
});

describe('two machines materializing independently', () => {
  it('different prefs: the same board slugs, merged with no duplicate card and no board swap', async () => {
    const a = await machine({ catOrder: ['Revenue', 'Growth'], order: { 'Growth / Top': ['visits', 'signups'] } });
    const b = await machine({ catOrder: ['Growth', 'Revenue'], order: { 'Growth / Top': ['signups', 'visits'] } }, [{ slug: 'arpu', category: 'Revenue' }]);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Object.keys(a).sort()).toEqual(['growth.md', 'other.md', 'revenue.md']);

    for (const file of Object.keys(a)) {
      const slug = file.replace(/\.md$/, '');
      const { merged, notes } = mergeLabBoard('', a[file], b[file], slug);
      const got = parseBoardText(slug, merged);
      expect(got.error).toBeNull();
      const cardIds = got.cards.map((c) => c.id);
      expect(new Set(cardIds).size).toBe(cardIds.length);
      expect(findOverlaps(got.cards)).toEqual([]);
      // Each board keeps its own category's insights: no swap.
      const insights = got.cards.map((c) => c.insight).filter(Boolean).sort();
      if (slug === 'growth') expect(insights).toEqual(['activation', 'signups', 'visits']);
      if (slug === 'revenue') expect(insights).toEqual(['arpu', 'churn', 'mrr']);
      if (slug === 'other') expect(insights).toEqual(['latency']);
      expect(got.title).toBe(parseBoardText(slug, a[file]).title);
      expect(notes.filter((n) => n.includes('kept ours') && n.includes('validation'))).toEqual([]);
    }
  });
});

describe('card-level rules', () => {
  const BASE = board([card('c-a', 0), card('c-b', 3), card('c-c', 6)]);

  it('a card deleted on one side and changed on the other is KEPT and reported', () => {
    const ours = board([card('c-b', 3), card('c-c', 6)]); // deleted c-a
    const theirs = board([card('c-a', 0, { title: 'Renamed' }), card('c-b', 3), card('c-c', 6)]); // changed c-a
    const { merged, notes } = mergeLabBoard(BASE, ours, theirs, 'growth');
    const got = parseBoardText('growth', merged);
    expect(got.cards.find((c) => c.id === 'c-a')?.title).toBe('Renamed');
    expect(notes.some((n) => n.includes('"c-a"') && n.includes('deleted') && n.includes('kept'))).toBe(true);

    // ...and the mirror image.
    const mirrored = mergeLabBoard(BASE, theirs, ours, 'growth');
    expect(ids(mirrored.merged)).toContain('c-a');
    expect(mirrored.notes.some((n) => n.includes('"c-a"'))).toBe(true);
  });

  it('a card deleted on one side and UNCHANGED on the other is deleted', () => {
    const ours = board([card('c-b', 3), card('c-c', 6)]);
    const { merged, notes } = mergeLabBoard(BASE, ours, BASE, 'growth');
    expect(ids(merged)).toEqual(['c-b', 'c-c']);
    expect(notes).toEqual([]);
    expect(ids(mergeLabBoard(BASE, BASE, ours, 'growth').merged)).toEqual(['c-b', 'c-c']);
  });

  it('one side changed -> that side; both changed -> ours (reported); additions union', () => {
    const ours = board([card('c-a', 0, { title: 'Ours' }), card('c-b', 3), card('c-c', 6), card('c-new', 9)]);
    const theirs = board([card('c-a', 0, { title: 'Theirs' }), card('c-b', 3, { title: 'B2' }), card('c-c', 6), card('c-them', 12)]);
    const { merged, notes } = mergeLabBoard(BASE, ours, theirs, 'growth');
    const got = parseBoardText('growth', merged);
    expect(got.cards.map((c) => c.id)).toEqual(['c-a', 'c-b', 'c-c', 'c-new', 'c-them']);
    expect(got.cards[0].title).toBe('Ours');
    expect(got.cards[1].title).toBe('B2');
    expect(notes.some((n) => n.includes('"c-a"') && n.includes('both sides'))).toBe(true);
  });

  it('overlaps left by the union are resolved by compaction (the result validates strictly)', () => {
    const ours = board([card('c-a', 0), card('c-b', 3), card('c-c', 6), card('c-x', 9)]);
    const theirs = board([card('c-a', 0), card('c-b', 3), card('c-c', 6), card('c-y', 9)]);
    const { merged } = mergeLabBoard(BASE, ours, theirs, 'growth');
    const got = parseBoardText('growth', merged);
    expect(got.cards.map((c) => c.id)).toEqual(['c-a', 'c-b', 'c-c', 'c-x', 'c-y']);
    expect(findOverlaps(got.cards)).toEqual([]);
    expect(got.warnings).toEqual([]);
  });

  it('board fields: the side that changed wins', () => {
    const theirs = board([card('c-a', 0), card('c-b', 3), card('c-c', 6)], { title: 'Growth 2026' });
    expect(parseBoardText('growth', mergeLabBoard(BASE, BASE, theirs, 'growth').merged).title).toBe('Growth 2026');
  });
});

describe('unreadable sides', () => {
  const CONFLICTED = '---\ntitle: Growth\n<<<<<<< HEAD\ncards: []\n=======\ncards: [{id: c-a}]\n>>>>>>> theirs\n---\n';

  it('conflict markers on a side: ours is kept and reported; a marked file reads as an error board', () => {
    const good = board([card('c-a', 0)]);
    const theirsBad = mergeLabBoard('', good, CONFLICTED, 'growth');
    expect(theirsBad.merged).toBe(good);
    expect(theirsBad.notes.join(' ')).toMatch(/unreadable/);

    const oursBad = mergeLabBoard('', CONFLICTED, good, 'growth');
    expect(oursBad.merged).toBe(CONFLICTED);
    expect(parseBoardText('growth', oursBad.merged).error?.kind).toBe('conflict');
  });

  it('resolveConflicts routes a board file through the class, writes it and reports its notes', () => {
    const cwd = tmp('dc-lab-merge-resolve-');
    mkdirSync(join(cwd, 'lab', 'boards'), { recursive: true });
    const base = board([card('c-a', 0), card('c-b', 3)]);
    setFixture('lab/boards/growth.md', {
      base,
      ours: board([card('c-b', 3)]),
      theirs: board([card('c-a', 0, { title: 'Changed' }), card('c-b', 3)]),
    });
    const r = resolveConflicts(cwd, ['lab/boards/growth.md']);
    expect(r.resolved).toEqual(['lab/boards/growth.md']);
    expect(r.deferredToAgent).toEqual([]);
    expect(ids(readFileSync(join(cwd, 'lab', 'boards', 'growth.md'), 'utf-8'))).toEqual(['c-b', 'c-a']);
    expect(r.notes?.some((n) => n.startsWith('lab/boards/growth.md:') && n.includes('"c-a"'))).toBe(true);
  });
});

describe('an invalid merge result keeps ours', () => {
  it('a merged spec that fails strict validation falls back to ours, reported', () => {
    // Theirs carries an html block with BOTH html and ref: the lenient read keeps it (a warning), the strict check refuses it.
    const ours = board([card('c-a', 0)]);
    const theirs = `---\ntitle: Growth\norder: 1\ncards:\n  - id: c-a\n    at: {x: 0, y: 0, w: 4, h: 3}\n    insight: a\n  - id: c-h\n    at: {x: 0, y: 3, w: 4, h: 3}\n    blocks:\n      - html: {html: '<p></p>', ref: lib}\n---\n`;
    const { merged, notes } = mergeLabBoard('', ours, theirs, 'growth');
    expect(merged).toBe(ours);
    expect(notes.join(' ')).toMatch(/failed validation/);
  });
});
