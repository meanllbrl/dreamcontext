/**
 * The local new shell's single sidebar (tek-kenar C3): its body follows the page on screen, every
 * row of the projects and boards modes carries its end mark, board search, and the anchor layer's
 * arithmetic (the clicked row stays under the pointer). Source pins guard the wiring that a pure
 * test cannot reach.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anchorScroll, boardRowKey, buildDrawerRows, filterBoards, nearestRow, projectRowKey, sidebarMode,
} from '../../dashboard/src/components/layout/newshell/drawerModel';

const src = (p: string) => readFileSync(join(__dirname, '../../dashboard/src', p), 'utf8');

describe('sidebar mode', () => {
  it('is chat while Chat is open, boards on Whiteboards, projects anywhere else', () => {
    expect(sidebarMode({ onChat: true, page: 'whiteboards' })).toBe('chat');
    expect(sidebarMode({ onChat: false, page: 'whiteboards' })).toBe('boards');
    expect(sidebarMode({ onChat: false, page: 'tasks' })).toBe('projects');
    expect(sidebarMode({ onChat: false, page: 'roadmap' })).toBe('projects');
    expect(sidebarMode({ onChat: false, page: undefined })).toBe('projects');
  });
});

describe('collapseAll rows', () => {
  const project = (name: string) => ({ name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null });
  const fanout = {
    acme: { superOn: true, superMarks: { working: 0, asking: true, waiting: 0 } },
    beta: { superOn: true, superMarks: { working: 1, asking: false, waiting: 0 } },
  } as never;
  it('folds every project, the active and the expanded ones too, so each carries its mark', () => {
    const rows = buildDrawerRows({ projects: [project('acme'), project('beta')], activeVault: 'acme', expanded: ['acme', 'beta'], facts: {}, fanout, collapseAll: true });
    expect(rows.map((r) => r.expanded)).toEqual([false, false]);
    expect(rows[0].active).toBe(true);
    expect(rows[0].mark?.asking).toBeGreaterThan(0);
    expect(rows[1].mark?.working).toBe(true);
  });
  it('without it, the expanded set is kept (chat mode is unchanged)', () => {
    const rows = buildDrawerRows({ projects: [project('acme'), project('beta')], activeVault: 'acme', expanded: ['acme'], facts: {}, fanout });
    expect(rows.map((r) => r.expanded)).toEqual([true, false]);
  });
});

describe('board search and row keys', () => {
  it('filters by name or slug, folded for Turkish', () => {
    const boards = [{ slug: 'launch-plan', name: 'Launch plan' }, { slug: 'butce', name: 'Bütçe akışı' }];
    expect(filterBoards(boards, 'LAUNCH').map((b) => b.slug)).toEqual(['launch-plan']);
    expect(filterBoards(boards, 'bütçe').map((b) => b.slug)).toEqual(['butce']);
    expect(filterBoards(boards, '')).toHaveLength(2);
  });
  it('keys rows by project and by vault/slug', () => {
    expect(projectRowKey('acme')).toBe('project:acme');
    expect(boardRowKey('acme', 'launch-plan')).toBe('board:acme/launch-plan');
  });
});

describe('anchor layer', () => {
  it('picks the copy of a slug nearest the clicked y', () => {
    expect(nearestRow([{ top: 40 }, { top: 300 }, { top: 520 }], 310)).toEqual({ top: 300 });
    expect(nearestRow([], 10)).toBeNull();
  });
  it('scrolls by the row\'s shift when the range allows', () => {
    expect(anchorScroll({ scrollTop: 100, rowTop: 260, wantTop: 200, max: 1000 })).toEqual({ scrollTop: 160, spacerTop: 0, spacerBottom: 0 });
  });
  it('adds a top spacer when the row would need a negative scroll', () => {
    expect(anchorScroll({ scrollTop: 0, rowTop: 120, wantTop: 200, max: 0 })).toEqual({ scrollTop: 0, spacerTop: 80, spacerBottom: 0 });
  });
  it('adds a bottom spacer when the row would need more scroll than the body has', () => {
    expect(anchorScroll({ scrollTop: 50, rowTop: 400, wantTop: 200, max: 100 })).toEqual({ scrollTop: 250, spacerTop: 0, spacerBottom: 150 });
  });
});

describe('wiring (source pins)', () => {
  const chrome = src('components/layout/WindowChrome.tsx');
  const drawer = src('components/layout/newshell/ChatDrawer.tsx');
  it('docks the local sidebar on every page and floats it only when narrow', () => {
    expect(chrome).toContain('const drawerFloats = narrow || (deviceShell && !activeOnChat);');
  });
  it('the local new shell has no rail slot; a device shell keeps it', () => {
    expect(chrome).toContain('{deviceShell && <div className="ns-rail-slot" ref={setRailSlot} />}');
  });
  it('project and board rows are moves and carry their row key', () => {
    expect(drawer).toContain('data-row-key={projectRowKey(row.name)} data-move="true"');
    expect(src('components/layout/newshell/SidebarBoards.tsx')).toContain('data-row-key={boardRowKey(vault, b.slug)}');
  });
  it('the resize handle and the scroll body are the sidebar frame, not input', () => {
    expect(drawer).toContain('data-sidebar-frame="true"');
    expect(drawer).toContain('data-scroll-frame="true"');
  });
  it('the active project\'s explorer is portalled from the Whiteboards page into the sidebar', () => {
    const page = src('pages/WhiteboardsPage.tsx');
    expect(page).toContain('variant="embedded"');
    expect(page).toContain('slots.boards');
  });
});
