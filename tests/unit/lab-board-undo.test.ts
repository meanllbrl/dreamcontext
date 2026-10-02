/**
 * The board's undo stack (plan D3, r2 Edge 7): ⌘Z / ⇧⌘Z over whole board specs, cleared on a
 * 409 because every remembered spec would rewrite a file that no longer exists.
 *
 * Pure tests over `board/boardUndo.ts`, the card edits in `board/boardEdits.ts` that feed it, and
 * a source check that BoardPage clears the stack on a conflict signal.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('../../dashboard/src/context/VaultContext', () => ({ useApi: () => null }));

import { createBoardSaver } from '../../dashboard/src/hooks/useBoards';
import {
  UNDO_DEPTH, createRevGuard, createUndoStack, settleMoveUndo, undoKey,
} from '../../dashboard/src/components/lab/board/boardUndo';
import {
  addCard, duplicateCard, moveCard, removeCard, uniqueCardId,
} from '../../dashboard/src/components/lab/board/boardEdits';
import type { Board, BoardSpec, Card } from '../../dashboard/src/components/lab/board/boardTypes';

const card = (id: string, x = 0, y = 0, w = 4, h = 3): Card => ({ id, at: { x, y, w, h }, insight: id.replace(/^c-/, '') });
const spec = (title: string, cards: Card[] = []): BoardSpec => ({ title, order: 1, cards, body: '' });

describe('undo / redo', () => {
  it('undo returns the spec an edit replaced, redo returns the one undo left', () => {
    const u = createUndoStack();
    const a = spec('A');
    const b = spec('B');
    const c = spec('C');
    u.record(a); // A -> B
    u.record(b); // B -> C
    expect(u.undo(c)).toBe(b);
    expect(u.undo(b)).toBe(a);
    expect(u.undo(a)).toBeNull();
    expect(u.redo(a)).toBe(b);
    expect(u.redo(b)).toBe(c);
    expect(u.redo(c)).toBeNull();
  });

  it('a new edit after an undo drops the redo branch', () => {
    const u = createUndoStack();
    u.record(spec('A'));
    expect(u.undo(spec('B'))?.title).toBe('A');
    expect(u.canRedo()).toBe(true);
    u.record(spec('A'));
    expect(u.canRedo()).toBe(false);
  });

  it('clear() (a 409, a board switch) forgets both directions', () => {
    const u = createUndoStack();
    u.record(spec('A'));
    u.undo(spec('B'));
    u.record(spec('C'));
    u.clear();
    expect(u.canUndo()).toBe(false);
    expect(u.canRedo()).toBe(false);
    expect(u.undo(spec('D'))).toBeNull();
  });

  it('is capped, keeping the newest edits', () => {
    const u = createUndoStack(3);
    for (const t of ['1', '2', '3', '4', '5']) u.record(spec(t));
    expect([u.undo(spec('6'))?.title, u.undo(spec('5'))?.title, u.undo(spec('4'))?.title, u.undo(spec('3'))]).toEqual(['5', '4', '3', null]);
    expect(UNDO_DEPTH).toBeGreaterThanOrEqual(20);
  });
});

describe('keys', () => {
  const ev = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, tagName?: string) => ({
    key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods, target: tagName ? { tagName } : null,
  });

  it('⌘Z undoes, ⇧⌘Z redoes, Ctrl+Z / Ctrl+Y on other platforms', () => {
    expect(undoKey(ev('z', { metaKey: true }))).toBe('undo');
    expect(undoKey(ev('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(undoKey(ev('z', { ctrlKey: true }))).toBe('undo');
    expect(undoKey(ev('y', { ctrlKey: true }))).toBe('redo');
  });

  it('leaves typing alone: a field keeps its own undo, plain z does nothing', () => {
    expect(undoKey(ev('z', { metaKey: true }, 'INPUT'))).toBeNull();
    expect(undoKey(ev('z', { metaKey: true }, 'TEXTAREA'))).toBeNull();
    expect(undoKey(ev('z'))).toBeNull();
    expect(undoKey(ev('z', { metaKey: true, altKey: true }))).toBeNull();
  });
});

describe('card edits feed the stack whole card lists', () => {
  it('duplicate copies blocks and size under a fresh id at a free slot', () => {
    const cards = [{ ...card('c-a', 0, 0, 4, 3), blocks: [{ type: 'stat' as const, data: 'a', options: { spark: true } }] }];
    const next = duplicateCard(cards, 'c-a');
    expect(next).toHaveLength(2);
    expect(next[1].id).toBe('c-a-2');
    expect(next[1].blocks).toEqual(cards[0].blocks);
    expect(next[1].blocks).not.toBe(cards[0].blocks);
    expect(next[1].at).toEqual({ x: 4, y: 0, w: 4, h: 3 });
  });

  it('ids stay unique within a board', () => {
    expect(uniqueCardId([card('c-a'), card('c-a-2')], 'c-a')).toBe('c-a-3');
    expect(uniqueCardId([card('c-a')], 'c-b')).toBe('c-b');
  });

  it('remove drops only that card', () => {
    expect(removeCard([card('c-a'), card('c-b', 4)], 'c-a').map((c) => c.id)).toEqual(['c-b']);
  });

  it('move takes the card off the source and lands it on the target, renamed if its id is taken', () => {
    const moved = moveCard([card('c-a'), card('c-b', 4)], [card('c-a', 0, 0, 12, 2)], 'c-a');
    expect(moved?.source.map((c) => c.id)).toEqual(['c-b']);
    expect(moved?.target.map((c) => c.id)).toEqual(['c-a', 'c-a-2']);
    expect(moved?.target[1].at).toEqual({ x: 0, y: 2, w: 4, h: 3 });
    expect(moveCard([card('c-a')], [], 'nope')).toBeNull();
    expect(addCard([], card('c-z', 8, 9)).map((c) => c.at)).toEqual([{ x: 0, y: 0, w: 4, h: 3 }]);
  });
});

describe('BoardPage wiring', () => {
  const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/board/BoardPage.tsx'), 'utf8');

  it('clears the undo stack when a save comes back 409', () => {
    const at = src.indexOf("if (s.kind === 'conflict')");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toMatch(/undo\.current\.clear\(\)/);
  });

  it('every edit records the spec it replaces before it is queued', () => {
    expect(src).toMatch(/undo\.current\.record\(specOf\(board\)\);[\s\S]{0,80}save\(next, board\.rev\)/);
  });

  it('⌘Z / ⇧⌘Z are wired through undoKey', () => {
    expect(src).toMatch(/const dir = undoKey\(e\)/);
  });
});

describe('an external write voids the undo stack (never a silent overwrite)', () => {
  it('the guard keeps our own revs, clears on anyone else\'s, and waits while we are saving', () => {
    const g = createRevGuard();
    const ctx = (ownRev: string | null, saving = false) => ({ slug: 'growth', ownRev, saving });
    expect(g.observe('r1', ctx(null))).toBe('keep'); // baseline
    expect(g.observe('r1', ctx(null))).toBe('keep');
    expect(g.observe('r2', ctx('r1', true))).toBe('keep'); // our PUT in flight: decide later
    expect(g.observe('r2', ctx('r2'))).toBe('keep'); // it was ours
    expect(g.observe('r3', ctx('r2'))).toBe('clear'); // an agent / the CLI / a pull
    expect(g.observe('r3', ctx('r2'))).toBe('keep');
    expect(g.observe(null, ctx('r2'))).toBe('keep');
  });

  it('a new board\'s first rev is its baseline, not someone else\'s write', () => {
    const g = createRevGuard();
    expect(g.observe('a1', { slug: 'a', ownRev: null, saving: false })).toBe('keep');
    expect(g.observe('b7', { slug: 'b', ownRev: null, saving: false })).toBe('keep');
    expect(g.observe('b8', { slug: 'b', ownRev: null, saving: false })).toBe('clear');
  });

  /** A rev-checked store, the page's undo stack + guard, and the real save queue. */
  async function scenario(guarded: boolean) {
    let rev = 'r0';
    let seq = 0;
    let disk: BoardSpec = spec('Growth', [card('c-a')]);
    const put = async (_slug: string, next: BoardSpec, expected: string): Promise<Board> => {
      if (expected !== rev) throw Object.assign(new Error('rev-conflict'), { status: 409 });
      disk = next;
      rev = `r${++seq}`;
      return { ...next, slug: 'growth', rev, derived: false, error: null, warnings: [] };
    };
    const saver = createBoardSaver({ put });
    const undo = createUndoStack();
    const guard = createRevGuard();
    const observe = () => {
      if (guard.observe(rev, { slug: 'growth', ownRev: saver.savedRev('growth'), saving: saver.status('growth') === 'saving' }) === 'clear') undo.clear();
    };
    observe();
    // The page's own edit: record, save.
    const before = disk;
    undo.record(before);
    await saver.saveAndWait('growth', spec('Growth', [card('c-a'), card('c-b', 4)]), rev);
    observe();
    // An agent runs `lab board set` (not through this page), and a sync tick refetches.
    disk = spec('Growth', [card('c-a'), card('c-b', 4), card('c-agent', 8)]);
    rev = `r${++seq}`;
    if (guarded) observe();
    // ⌘Z: the page saves the popped spec against the rev it now holds (the refetched one).
    const prev = undo.undo(disk);
    if (prev) await saver.saveAndWait('growth', prev, rev);
    return { disk, undone: prev !== null };
  }

  it('undo after an agent\'s write does nothing: the agent\'s card survives', async () => {
    const { disk, undone } = await scenario(true);
    expect(undone).toBe(false);
    expect(disk.cards.map((c) => c.id)).toEqual(['c-a', 'c-b', 'c-agent']);
  });

  it('control: without the guard the same ⌘Z silently overwrites the agent\'s card', async () => {
    const { disk, undone } = await scenario(false);
    expect(undone).toBe(true);
    expect(disk.cards.map((c) => c.id)).toEqual(['c-a']);
  });

  it('the save queue reports the rev its own last PUT produced', async () => {
    const saver = createBoardSaver({ put: async (_s, next) => ({ ...next, slug: 'g', rev: 'mine-1', derived: false, error: null, warnings: [] }) });
    expect(saver.savedRev('g')).toBeNull();
    await saver.saveAndWait('g', spec('G'), 'r0');
    expect(saver.savedRev('g')).toBe('mine-1');
  });
});

describe('a move is never on the one-board undo stack', () => {
  it('settleMoveUndo clears the SOURCE board\'s stack only while it is still on screen, and records nothing', () => {
    const u = createUndoStack();
    u.record(spec('A'));
    expect(settleMoveUndo(u, 'growth', 'revenue')).toBe(false); // user switched boards mid-move
    expect(u.canUndo()).toBe(true);
    expect(settleMoveUndo(u, 'growth', 'growth')).toBe(true);
    expect(u.canUndo()).toBe(false);
    expect(u.canRedo()).toBe(false);
  });

  it('BoardPage: moveTo records no undo entry, shows no Undo toast, and checks the board on screen at completion', () => {
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/board/BoardPage.tsx'), 'utf8');
    const start = src.indexOf('const moveTo = useCallback(');
    const body = src.slice(start, src.indexOf('const targets = useMemo', start));
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toMatch(/undo\.current\.record/);
    expect(body).not.toMatch(/say\('undo'/);
    expect(body).toMatch(/settleMoveUndo\(undo\.current, from, activeRef\.current\)/);
    expect(body).toMatch(/unsaved: writer\.unsaved/);
  });

  it('BoardPage: every server rev goes through the guard', () => {
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/board/BoardPage.tsx'), 'utf8');
    expect(src).toMatch(/revGuard\.current\.observe\(serverRev, \{ slug, ownRev: savedRev, saving: saveStatus === 'saving' \}\) === 'clear'\)/);
  });
});
