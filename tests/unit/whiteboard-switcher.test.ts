/**
 * The board switcher's pure logic (A16): the "All boards" list's filter and order, the default
 * board's protection, keyboard selection, and the create field's name rule. The component is
 * dashboard TSX (not loadable here); what it decides lives in `boardSwitcherLogic.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_BOARD_SLUG, canDeleteBoard, filterBoards, isDefaultBoard, moveActive, newBoardName, pickActive,
  type SwitcherBoard,
} from '../../dashboard/src/pages/whiteboards/boardSwitcherLogic';

const ROOT = join(import.meta.dirname, '..', '..');

const boards: SwitcherBoard[] = [
  { slug: 'gunluk', name: 'Günlük', updatedAt: '2026-09-28T10:00:00Z', elements: 4 },
  { slug: 'roadmap-q4', name: 'Roadmap Q4', description: 'Launch planning', updatedAt: '2026-09-30T09:00:00Z' },
  { slug: DEFAULT_BOARD_SLUG, name: 'Control Panel', updatedAt: '2026-09-01T00:00:00Z' },
  { slug: 'old', name: 'Old sketches' },
];

describe('whiteboard switcher — the list (A16)', () => {
  it('puts the default board first, then the most recently updated', () => {
    expect(filterBoards(boards, '').map((b) => b.slug)).toEqual([DEFAULT_BOARD_SLUG, 'roadmap-q4', 'gunluk', 'old']);
  });

  it('matches name, slug and description, ignoring case and accents', () => {
    expect(filterBoards(boards, 'gunluk').map((b) => b.slug)).toEqual(['gunluk']);
    expect(filterBoards(boards, 'GÜNL').map((b) => b.slug)).toEqual(['gunluk']);
    expect(filterBoards(boards, 'launch').map((b) => b.slug)).toEqual(['roadmap-q4']);
    expect(filterBoards(boards, 'q4').map((b) => b.slug)).toEqual(['roadmap-q4']);
    // Turkish dotted/dotless i meet their ASCII spelling in either direction.
    const tr: SwitcherBoard[] = [{ slug: 'isler', name: 'İşler' }, { slug: 'insights', name: 'Insights' }];
    expect(filterBoards(tr, 'isler').map((b) => b.slug)).toEqual(['isler']);
    expect(filterBoards(tr, 'ıns').map((b) => b.slug)).toEqual(['insights']);
    expect(filterBoards(tr, 'ins').map((b) => b.slug)).toEqual(['insights']);
  });

  it('needs every word to match, and an unmatched query yields nothing', () => {
    expect(filterBoards(boards, 'control panel').map((b) => b.slug)).toEqual([DEFAULT_BOARD_SLUG]);
    expect(filterBoards(boards, 'control roadmap')).toEqual([]);
    expect(filterBoards(boards, 'nothing-like-this')).toEqual([]);
  });

  it('does not reorder the caller\'s array', () => {
    const copy = boards.map((b) => b.slug);
    filterBoards(boards, '');
    expect(boards.map((b) => b.slug)).toEqual(copy);
  });
});

describe('whiteboard switcher — the default board is protected (A15/A16)', () => {
  it('is control-panel, and it alone cannot be deleted', () => {
    expect(DEFAULT_BOARD_SLUG).toBe('control-panel');
    expect(isDefaultBoard('control-panel')).toBe(true);
    expect(canDeleteBoard('control-panel')).toBe(false);
    for (const slug of ['gunluk', 'control-panel-2', 'roadmap-q4']) {
      expect(canDeleteBoard(slug), slug).toBe(true);
    }
  });

  it('the component gates the delete button on canDeleteBoard and never uses a browser dialog', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/pages/whiteboards/BoardSwitcher.tsx'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''); // a comment may NAME confirm()
    expect(src).toMatch(/canDeleteBoard\(board\.slug\) && \(/);
    // confirm()/alert() are silent no-ops in the desktop WKWebView.
    expect(src).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\(/);
  });

  it('the page asks the server for the default board and never creates it itself', () => {
    const hook = readFileSync(join(ROOT, 'dashboard/src/hooks/useWhiteboards.ts'), 'utf-8');
    expect(hook).toContain('`${LIST_PATH}/default`');
    const page = readFileSync(join(ROOT, 'dashboard/src/pages/WhiteboardsPage.tsx'), 'utf-8');
    expect(page).toContain('useDefaultWhiteboard(');
    expect(page).not.toContain('useCreateWhiteboard');
    // Switching boards re-keys the editor so the old save loop flushes before its canvas goes.
    expect(page).toMatch(/<WhiteboardEditor key=\{openSlug\}/);
  });
});

describe('whiteboard switcher — keyboard selection (A16)', () => {
  it('arrows move and wrap', () => {
    expect(moveActive(0, 'ArrowDown', 3)).toBe(1);
    expect(moveActive(2, 'ArrowDown', 3)).toBe(0);
    expect(moveActive(0, 'ArrowUp', 3)).toBe(2);
    expect(moveActive(2, 'ArrowUp', 3)).toBe(1);
  });

  it('Home/End jump; other keys keep the row, clamped into range', () => {
    expect(moveActive(1, 'Home', 4)).toBe(0);
    expect(moveActive(1, 'End', 4)).toBe(3);
    expect(moveActive(1, 'a', 4)).toBe(1);
    // The list shrank under a query: the highlight follows it down.
    expect(moveActive(5, '', 2)).toBe(1);
    expect(moveActive(-1, '', 2)).toBe(0);
    expect(moveActive(-1, 'ArrowDown', 2)).toBe(0);
  });

  it('an empty list has no highlight, and Enter picks nothing', () => {
    expect(moveActive(0, 'ArrowDown', 0)).toBe(-1);
    expect(pickActive([], -1)).toBeNull();
    expect(pickActive(['a', 'b'], 1)).toBe('b');
    expect(pickActive(['a', 'b'], 2)).toBeNull();
  });
});

describe('whiteboard switcher — creating a board inline (A16)', () => {
  it('takes a trimmed non-empty name, verbatim otherwise', () => {
    expect(newBoardName('   ')).toBeNull();
    expect(newBoardName('')).toBeNull();
    expect(newBoardName('  Günlük plan ')).toBe('Günlük plan');
  });
});
