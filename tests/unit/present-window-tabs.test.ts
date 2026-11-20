/**
 * The presentation window's tabs (W3 D14, criterion 10): a second present arrives as a background
 * tab with the dot and the front tab stays; a tab click brings it to the front; a tab's × (or the
 * red light) closes it, a group being one tab with one ×; shift-select + "Close N tabs" closes
 * several; only the app's own drag type mentions a tab on the Super's chat.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { emptySuperState, ownerQueueTabs, presentCards, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { sanitizeSuperState } from '../../src/lib/super/store.js';
import { applyOwnerLayout, readQueueTabs } from '../../src/server/routes/super.js';
import { checkRemoteLayout } from '../../src/server/routes/super-remote.js';
import { nextSelection, tabsToClose } from '../../dashboard/src/components/sleepy/super/PresentWindow.js';

const img = (id: string): SuperContainer => ({ id, kind: 'image', ref: `${id}.png`, shape: 'square', place: 'float' });
const stage = (): SuperState => ({ ...emptySuperState(), containers: ['a', 'b', 'c', 'd'].map((x) => img(`image-${x}`)) });
const store = (s: SuperState): SuperState => sanitizeSuperState(JSON.parse(JSON.stringify(s)));
const ids = (s: SuperState) => s.presentQueue?.items.map((i) => i.id) ?? [];

function three(): SuperState {
  const s = stage();
  presentCards(s, ['image-a']);
  presentCards(s, ['image-b']);
  presentCards(s, ['image-c', 'image-d']);
  return s;
}

describe('a background tab never steals the front', () => {
  it('a second and third present wait behind the front, never shown, and survive the store', () => {
    const s = three();
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-a'] });
    const q = store(s).presentQueue!;
    expect(q.items.map((i) => !!i.shown)).toEqual([true, false, false]);
  });
  it('a tab click brings it to the front, the one he looked at stays as a tab behind it, seen', () => {
    const s = three();
    const [a, b] = ids(s);
    expect(ownerQueueTabs(s, 'show', [b])).toBe(true);
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-b'] });
    expect(ids(s).slice(0, 2)).toEqual([b, a]);
    expect(store(s).presentQueue!.items.map((i) => !!i.shown)).toEqual([true, true, false]);
    // The front one again: nothing to do.
    expect(ownerQueueTabs(s, 'show', [b])).toBe(false);
  });
});

describe('closing tabs', () => {
  it('a background tab closes and the front stays', () => {
    const s = three();
    const [, b] = ids(s);
    expect(ownerQueueTabs(s, 'close', [b])).toBe(true);
    expect(s.view).toMatchObject({ cards: ['image-a'] });
    expect(ids(s)).toHaveLength(2);
  });
  it('the front tab closes: the next opens; a group tab goes whole with its one ×', () => {
    const s = three();
    const [a, b, g] = ids(s);
    ownerQueueTabs(s, 'close', [a]);
    expect(s.view).toMatchObject({ cards: ['image-b'] });
    ownerQueueTabs(s, 'close', [b]);
    expect(s.view).toMatchObject({ cards: ['image-c', 'image-d'] });
    ownerQueueTabs(s, 'close', [g]);
    expect(s.view).toEqual({ mode: 'float' });
    expect(ids(s)).toEqual([]);
  });
  it('shift-selected tabs close together; unknown ids are skipped', () => {
    const s = three();
    const [a, , g] = ids(s);
    expect(ownerQueueTabs(s, 'close', [a, g, 'pq999'])).toBe(true);
    expect(s.view).toMatchObject({ cards: ['image-b'] });
    expect(ids(s)).toHaveLength(1);
    expect(ownerQueueTabs(s, 'close', ['pq999'])).toBe(false);
  });
  it('the layout door reads the gesture; junk is refused whole; the phone door does not take it', () => {
    const s = three();
    const [a, b] = ids(s);
    applyOwnerLayout(s, { tabs: { op: 'show', items: [b] } });
    expect(s.view).toMatchObject({ cards: ['image-b'] });
    expect(readQueueTabs({ tabs: { op: 'close', items: [a, '../x'] } })).toBeNull();
    expect(readQueueTabs({ tabs: { op: 'open', items: [a] } })).toBeNull();
    expect(readQueueTabs({ tabs: { op: 'close', items: [] } })).toBeNull();
    expect(() => checkRemoteLayout({ tabs: { op: 'close', items: [a] } })).toThrow();
  });
});

describe('selection and the context menu', () => {
  it('shift-click toggles, a plain click selects one; "Close N tabs" takes the selection it was opened on', () => {
    let sel = nextSelection(new Set(), 'pq1', false);
    sel = nextSelection(sel, 'pq3', true);
    expect([...sel]).toEqual(['pq1', 'pq3']);
    expect(tabsToClose('pq3', sel)).toEqual(['pq1', 'pq3']);
    expect(tabsToClose('pq2', sel)).toEqual(['pq2']);
    expect([...nextSelection(sel, 'pq1', true)]).toEqual(['pq3']);
    expect([...nextSelection(sel, 'pq2', false)]).toEqual(['pq2']);
  });
});

describe('a tab dropped on the Super chat (source)', () => {
  const surface = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperSurface.tsx', import.meta.url), 'utf-8');
  it('only the app\'s own drag type is taken, through the record-checked Ask-about door', () => {
    expect(surface).toMatch(/Array\.from\(e\.dataTransfer\.types\)\.includes\(PRESENT_TAB_DRAG\)/);
    expect(surface).toMatch(/if \(!ours\(e\)\) return;\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*askAboutRef\.current\(/);
    expect(surface).toMatch(/askAboutRef\.current = actions\.onAskAbout;/);
  });
});
