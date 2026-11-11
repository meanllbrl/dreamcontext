/**
 * Switching project keeps the page (owner 2026-11-03, mdh32v): dashboard/src/lib/projectSwitchPage.ts.
 * Root cause it fixes: each project is its own mounted instance with its own remembered page, so a
 * switch showed the OTHER project's last page (Whiteboards -> Chat, Chat -> Whiteboards).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Page } from '../../dashboard/src/components/layout/Sidebar';
import { _resetShownSurface, markProjectSwitch, planProjectSwitch, publishShownSurface, readShownSurface, takeProjectSwitch } from '../../dashboard/src/lib/projectSwitchPage';

const PAGES: Page[] = ['relations', 'tasks', 'roadmap', 'hypotheses', 'lab', 'automations', 'agents', 'core', 'knowledge', 'sleep', 'brain', 'council', 'packs', 'whiteboards', 'stats', 'apps'];
const all = () => true;

beforeEach(() => _resetShownSurface());

describe('switching project keeps the page', () => {
  it.each(PAGES)('on %s, the next project opens on %s (its list: no item id travels)', (page) => {
    const other: Page = page === 'tasks' ? 'whiteboards' : 'tasks';
    expect(planProjectSwitch({ page, chat: false }, { page: other, chat: false }, all)).toEqual({ navigate: page, chat: null });
  });

  it('already on the same page: nothing moves (its own open item stays)', () => {
    expect(planProjectSwitch({ page: 'whiteboards', chat: false }, { page: 'whiteboards', chat: false }, all)).toEqual({ navigate: null, chat: null });
  });

  it('on Chat, the next project opens Chat, over the same page behind', () => {
    expect(planProjectSwitch({ page: 'whiteboards', chat: true }, { page: 'tasks', chat: false }, all)).toEqual({ navigate: 'whiteboards', chat: true });
    expect(planProjectSwitch({ page: 'tasks', chat: true }, { page: 'tasks', chat: false }, all)).toEqual({ navigate: null, chat: true });
    expect(planProjectSwitch({ page: 'tasks', chat: true }, { page: 'tasks', chat: true }, all)).toEqual({ navigate: null, chat: null });
    // A navigation collapses its chat, so Chat is opened again after it.
    expect(planProjectSwitch({ page: 'tasks', chat: true }, { page: 'lab', chat: true }, all)).toEqual({ navigate: 'tasks', chat: true });
  });

  it('off Chat, the next project leaves its Chat (the old bug: whiteboard -> switch -> chat)', () => {
    expect(planProjectSwitch({ page: 'whiteboards', chat: false }, { page: 'whiteboards', chat: true }, all)).toEqual({ navigate: null, chat: false });
    expect(planProjectSwitch({ page: 'whiteboards', chat: false }, { page: 'tasks', chat: true }, all)).toEqual({ navigate: 'whiteboards', chat: false });
  });

  it('a page the next project cannot show keeps its own page; Settings never travels; nothing published = nothing moves', () => {
    expect(planProjectSwitch({ page: 'relations', chat: false }, { page: 'tasks', chat: false }, (p) => p !== 'relations')).toEqual({ navigate: null, chat: null });
    expect(planProjectSwitch({ page: 'settings', chat: false }, { page: 'tasks', chat: false }, all)).toEqual({ navigate: null, chat: null });
    expect(planProjectSwitch(null, { page: 'tasks', chat: true }, all)).toEqual({ navigate: null, chat: null });
  });

  it('the store keeps the last published surface, never an id', () => {
    expect(readShownSurface()).toBeNull();
    publishShownSurface({ page: 'whiteboards', chat: true, id: 'board-1' } as never);
    expect(readShownSurface()).toEqual({ page: 'whiteboards', chat: true });
  });

  it('only the owner\'s own switch carries: the mark is taken once, by its project, while fresh', () => {
    // A link, a start or a drawer row never marks: nothing to take.
    expect(takeProjectSwitch('globex', 1000)).toBe(false);
    markProjectSwitch('globex', 1000);
    expect(takeProjectSwitch('initech', 1001)).toBe(false);
    expect(takeProjectSwitch('globex', 1002)).toBe(true);
    expect(takeProjectSwitch('globex', 1003)).toBe(false);
    // A mark that never landed (the picked project was already on screen) goes stale.
    markProjectSwitch('globex', 1000);
    expect(takeProjectSwitch('globex', 1000 + 3_001)).toBe(false);
  });
});
