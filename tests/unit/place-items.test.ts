/**
 * Navigation B, C4: a published item id is one its page opens again. Each page publishes the
 * SAME state its focus target (`navigate(page, id)`) sets, so a place recorded from what it
 * published lands on that item. Apps gains a plain-slug branch: a listed slug opens that app, an
 * unknown one leaves the list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ITEM_PAGES, appFocusAction, matchableItem, publishOpenItem, readOpenItem } from '../../dashboard/src/lib/openItem';
import { execSync } from 'node:child_process';

const src = (p: string) => readFileSync(join(__dirname, '../../dashboard/src', p), 'utf8');

describe('place items: each page publishes what its focus target opens', () => {
  it.each([
    // [file, the state the focus target sets, the publish call reading that same state]
    ['pages/WhiteboardsPage.tsx', 'useFocusTarget(focus, setOpenSlug)', "usePublishOpenItem(bus, 'whiteboards', openSlug,"],
    ['components/tasks/KanbanBoard.tsx', 'useFocusTarget(focus, (slug) => setSelectedSlug(slug))', "usePublishOpenItem(bus, 'tasks', selectedTask ? selectedTask.slug : null,"],
    ['pages/KnowledgePage.tsx', 'setSelected(slug);', "usePublishOpenItem(bus, 'knowledge', selectedEntry ? selectedEntry.slug : null,"],
    ['pages/AppsPage.tsx', 'if (action === \'open\') openPage(wantSlug);', "usePublishOpenItem(bus, 'apps', pageApp ? pageApp.slug : null,"],
  ])('%s', (file, opens, publishes) => {
    const s = src(file);
    expect(s).toContain(opens);
    expect(s).toContain(publishes);
  });

  it('Tasks and Knowledge publish only an item their list has (an unknown slug is never a place)', () => {
    expect(src('components/tasks/KanbanBoard.tsx')).toMatch(/selectedTask = selectedSlug \? tasks\.find/);
    expect(src('pages/KnowledgePage.tsx')).toMatch(/selectedEntry = selected \? entries\?\.find/);
  });
});

describe('place items: Apps plain slug', () => {
  it('a listed slug opens that app; an unknown or malformed one stays on the list', () => {
    expect(appFocusAction('funnel-masasi', ['yuk-izleme', 'funnel-masasi'])).toBe('open');
    expect(appFocusAction('gone-app', ['yuk-izleme'])).toBe('list');
    expect(appFocusAction('Bad Slug', ['Bad Slug'])).toBe('list');
  });

  it('install: ids keep their own branch', () => {
    expect(src('pages/AppsPage.tsx')).toContain("if (!id.startsWith('install:')) { if (APP_SLUG_FOCUS_RE.test(id)) setWantSlug(id); return; }");
  });
});

describe('place items: the store', () => {
  it('one item per instance bus; withdrawing clears it; two buses never mix', () => {
    const a = new EventTarget();
    const b = new EventTarget();
    publishOpenItem(a, { page: 'tasks', id: 't1', label: 'One' });
    expect(readOpenItem(a)).toEqual({ page: 'tasks', id: 't1', label: 'One' });
    expect(readOpenItem(b)).toBeNull();
    publishOpenItem(a, null);
    expect(readOpenItem(a)).toBeNull();
  });
});

describe('place items: a landing is matched on an item only where its page publishes one', () => {
  it('ITEM_PAGES is exactly the pages that call usePublishOpenItem (drift)', () => {
    const out = execSync("grep -rhoE \"usePublishOpenItem\\(bus, '[a-z]+'\" dashboard/src", { cwd: join(__dirname, '../..'), encoding: 'utf8' });
    const pages = [...new Set(out.trim().split('\n').map((l) => l.match(/'([a-z]+)'/)![1]))].sort();
    expect(pages).toEqual([...ITEM_PAGES].sort());
  });

  it('keeps the id on an item page, drops it elsewhere (a ⌘K objective or insight hit)', () => {
    expect(matchableItem('tasks', 'fix-login')).toBe('fix-login');
    expect(matchableItem('whiteboards', 'plan')).toBe('plan');
    expect(matchableItem('roadmap', 'grow-revenue')).toBeNull();
    expect(matchableItem('lab', 'weekly-active-users')).toBeNull();
    expect(matchableItem('tasks', null)).toBeNull();
    expect(matchableItem('apps', '')).toBeNull();
  });
});
