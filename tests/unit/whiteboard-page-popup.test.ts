/**
 * The board's page panel, pure half (dashboard/src/components/whiteboard/pagePopupModel.ts):
 * which file a card or link opens, the type chip a page ref wears, the owning app page and
 * page ref a file maps back to, the back/forward stack, and the panel's Expand toggle, ⋯ menu
 * rows, menu keys and Esc order.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSED_STACK, MAX_STACK, canGoBack, canGoForward, currentPage, escapeCloses, menuIndexAfter, owningPage,
  pageFileName, pageStackReducer, pageTitleFromPath, pageTypeChip, panelMenuItems, pathToPageRef, targetPath, taskPath,
  togglePanelWidth, vaultRelativePath, type PageStack, type PageStackAction,
} from '../../dashboard/src/components/whiteboard/pagePopupModel';
import { isValidRefFor } from '../../dashboard/src/components/whiteboard/widgetModel';

const run = (actions: PageStackAction[], from: PageStack = CLOSED_STACK) => actions.reduce(pageStackReducer, from);

describe('targetPath: what a card or a dreamcontext:// link opens', () => {
  it('a knowledge slug opens its knowledge file', () => {
    expect(targetPath({ kind: 'knowledge', ref: 'patterns/build-and-propagate' }))
      .toBe('_dream_context/knowledge/patterns/build-and-propagate.md');
  });

  it('a page path opens the file itself, whatever its type', () => {
    expect(targetPath({ kind: 'knowledge', ref: 'docs/spec.pdf' })).toBe('docs/spec.pdf');
    expect(targetPath({ kind: 'knowledge', ref: 'reports/q3.html' })).toBe('reports/q3.html');
    expect(targetPath({ kind: 'knowledge', ref: 'README.md' })).toBe('README.md');
  });

  it('a task slug opens the task\'s own markdown file', () => {
    expect(targetPath({ kind: 'task', ref: 'fix-login' })).toBe('_dream_context/state/fix-login.md');
    expect(taskPath('fix-login')).toBe('_dream_context/state/fix-login.md');
  });

  it('refuses anything that could leave the project or is not a page', () => {
    for (const ref of ['../etc/passwd.md', '/abs/file.md', '~/x.md', 'a/../b.md', 'notes.txt', 'C:/x.md', '']) {
      expect(targetPath({ kind: 'knowledge', ref }), ref).toBeNull();
    }
    for (const ref of ['../x', 'a/../b', 'Fix Login', 'docs/spec.pdf', '']) {
      expect(targetPath({ kind: 'task', ref }), ref).toBeNull();
    }
  });
});

describe('pageTypeChip: the type a page card and a picker row show', () => {
  it('MD for a knowledge slug or a .md path, PDF, HTML for .html and .htm', () => {
    expect(pageTypeChip('some-knowledge')).toBe('MD');
    expect(pageTypeChip('docs/notes.md')).toBe('MD');
    expect(pageTypeChip('docs/Spec.PDF')).toBe('PDF');
    expect(pageTypeChip('site/index.html')).toBe('HTML');
    expect(pageTypeChip('site/old.htm')).toBe('HTML');
  });

  it('null for what is not a page ref', () => {
    expect(pageTypeChip('../x.md')).toBeNull();
    expect(pageTypeChip('image.png')).toBeNull();
    expect(pageTypeChip(42)).toBeNull();
  });

  it('pageFileName is the last segment', () => {
    expect(pageFileName('docs/specs/api.pdf')).toBe('api.pdf');
    expect(pageFileName('README.md')).toBe('README.md');
  });
});

describe('owningPage / pathToPageRef / vaultRelativePath', () => {
  it('a knowledge file belongs to Knowledge by slug; a task file to Tasks', () => {
    expect(owningPage('_dream_context/knowledge/patterns/x.md')).toEqual({ page: 'knowledge', id: 'patterns/x' });
    expect(owningPage('_dream_context/state/fix-login.md')).toEqual({ page: 'tasks', id: 'fix-login' });
  });

  it('any other file has no owner page', () => {
    expect(owningPage('docs/spec.pdf')).toBeNull();
    expect(owningPage('_dream_context/core/0.soul.md')).toBeNull();
    expect(owningPage('_dream_context/knowledge/Not A Slug.md')).toBeNull();
  });

  it('Expand hands the wiki a page ref: the slug for knowledge, the path otherwise', () => {
    expect(pathToPageRef('_dream_context/knowledge/patterns/x.md')).toBe('patterns/x');
    expect(pathToPageRef('docs/spec.pdf')).toBe('docs/spec.pdf');
    expect(pathToPageRef('_dream_context/state/fix-login.md')).toBe('_dream_context/state/fix-login.md');
    expect(pathToPageRef('pictures/a.png')).toBeNull();
  });

  it('vaultRelativePath strips the brain folder, and only that', () => {
    expect(vaultRelativePath('_dream_context/knowledge/x.md')).toBe('knowledge/x.md');
    expect(vaultRelativePath('docs/x.md')).toBeNull();
    expect(vaultRelativePath('_dream_context/')).toBeNull();
    expect(vaultRelativePath('_dream_contextual/x.md')).toBeNull();
  });
});

describe('pageStackReducer: the popup\'s back/forward stack', () => {
  it('open starts a fresh stack with one page', () => {
    const s = run([{ type: 'open', path: 'a.md' }, { type: 'push', path: 'b.md' }, { type: 'open', path: 'c.md' }]);
    expect(s).toEqual({ entries: ['c.md'], index: 0 });
    expect(canGoBack(s)).toBe(false);
    expect(canGoForward(s)).toBe(false);
  });

  it('push, back, forward walk the stack', () => {
    let s = run([{ type: 'open', path: 'a.md' }, { type: 'push', path: 'b.md' }, { type: 'push', path: 'c.md' }]);
    expect(currentPage(s)).toBe('c.md');
    s = run([{ type: 'back' }, { type: 'back' }], s);
    expect(currentPage(s)).toBe('a.md');
    expect(canGoBack(s)).toBe(false);
    s = run([{ type: 'back' }], s);
    expect(currentPage(s)).toBe('a.md');
    s = run([{ type: 'forward' }], s);
    expect(currentPage(s)).toBe('b.md');
    expect(canGoForward(s)).toBe(true);
  });

  it('a push after going back drops what was ahead', () => {
    const s = run([
      { type: 'open', path: 'a.md' }, { type: 'push', path: 'b.md' }, { type: 'push', path: 'c.md' },
      { type: 'back' }, { type: 'back' }, { type: 'push', path: 'd.md' },
    ]);
    expect(s).toEqual({ entries: ['a.md', 'd.md'], index: 1 });
    expect(canGoForward(s)).toBe(false);
  });

  it('following a link to the page already showing changes nothing', () => {
    const s = run([{ type: 'open', path: 'a.md' }]);
    expect(pageStackReducer(s, { type: 'push', path: 'a.md' })).toBe(s);
  });

  it('close empties it; forward on a closed stack stays closed', () => {
    const s = run([{ type: 'open', path: 'a.md' }, { type: 'close' }, { type: 'forward' }, { type: 'back' }]);
    expect(s).toEqual(CLOSED_STACK);
    expect(currentPage(s)).toBeNull();
  });

  it('the depth is capped, keeping the newest pages', () => {
    const actions: PageStackAction[] = [{ type: 'open', path: 'p0.md' }];
    for (let i = 1; i < MAX_STACK + 10; i++) actions.push({ type: 'push', path: `p${i}.md` });
    const s = run(actions);
    expect(s.entries).toHaveLength(MAX_STACK);
    expect(currentPage(s)).toBe(`p${MAX_STACK + 9}.md`);
    expect(s.entries[0]).toBe('p10.md');
  });
});

describe('isValidRefFor: a page card takes a slug or a path, every other kind a slug', () => {
  it('knowledge accepts both shapes', () => {
    expect(isValidRefFor('knowledge', 'patterns/x')).toBe(true);
    expect(isValidRefFor('knowledge', 'docs/spec.pdf')).toBe(true);
    expect(isValidRefFor('knowledge', 'docs/../x.md')).toBe(false);
  });

  it('task and insight still take a slug only', () => {
    expect(isValidRefFor('task', 'fix-login')).toBe(true);
    expect(isValidRefFor('task', 'docs/spec.pdf')).toBe(false);
    expect(isValidRefFor('insight', 'docs/spec.md')).toBe(false);
  });
});

describe('the side panel: Expand, the ⋯ menu, Esc', () => {
  it('Expand and Collapse are one toggle between side and full width', () => {
    expect(togglePanelWidth('side')).toBe('full');
    expect(togglePanelWidth('full')).toBe('side');
    expect(togglePanelWidth(togglePanelWidth('side'))).toBe('side');
  });

  it('a knowledge page gets "Open in Knowledge" first, then the three OS actions', () => {
    expect(panelMenuItems('_dream_context/knowledge/patterns/x.md')).toEqual([
      { id: 'open-owner', page: 'knowledge', ownerId: 'patterns/x' },
      { id: 'open-computer' }, { id: 'reveal' }, { id: 'copy-path' },
    ]);
  });

  it('a task gets "Open in Tasks"', () => {
    expect(panelMenuItems('_dream_context/state/fix-login.md')[0])
      .toEqual({ id: 'open-owner', page: 'tasks', ownerId: 'fix-login' });
  });

  it('a PDF, an HTML page or any other file has no owner row, and is ALWAYS openable on the computer', () => {
    for (const path of ['docs/spec.pdf', 'reports/q3.html', 'README.md', '_dream_context/core/0.soul.md']) {
      const ids = panelMenuItems(path).map((i) => i.id);
      expect(ids, path).toEqual(['open-computer', 'reveal', 'copy-path']);
    }
  });

  it('arrow keys wrap, Home and End jump, other keys leave the row', () => {
    expect(menuIndexAfter(-1, 'ArrowDown', 4)).toBe(0);
    expect(menuIndexAfter(-1, 'ArrowUp', 4)).toBe(3);
    expect(menuIndexAfter(3, 'ArrowDown', 4)).toBe(0);
    expect(menuIndexAfter(0, 'ArrowUp', 4)).toBe(3);
    expect(menuIndexAfter(1, 'ArrowDown', 4)).toBe(2);
    expect(menuIndexAfter(2, 'Home', 4)).toBe(0);
    expect(menuIndexAfter(0, 'End', 4)).toBe(3);
    expect(menuIndexAfter(2, 'Enter', 4)).toBe(2);
    expect(menuIndexAfter(0, 'ArrowDown', 0)).toBe(-1);
  });

  it('Esc closes the menu first, then the panel', () => {
    expect(escapeCloses(true)).toBe('menu');
    expect(escapeCloses(false)).toBe('panel');
  });
});

describe('pageTitleFromPath: the heading of a file with no title of its own', () => {
  it('drops the extension, reads dashes and underscores as spaces, raises the first letter', () => {
    expect(pageTitleFromPath('docs/pricing-sheet.pdf')).toBe('Pricing sheet');
    expect(pageTitleFromPath('reports/q3_board_review.html')).toBe('Q3 board review');
    expect(pageTitleFromPath('README.md')).toBe('README');
  });

  it('never returns an empty heading', () => {
    expect(pageTitleFromPath('docs/.pdf')).toBe('.pdf');
    expect(pageTitleFromPath('docs/---.md')).toBe('---.md');
  });
});
