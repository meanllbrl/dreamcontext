/**
 * The board tab strip's pure logic: boards open as Chrome-style tabs, close without being
 * deleted, drag into place, and gather in named, coloured groups that are never split. The
 * component is dashboard TSX (not loadable here); what it decides lives in `tabStripLogic.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  GROUP_COLORS, addToGroup, addToNewGroup, closeGroup, closeOtherTabs, closeTab, emptyLayout, moveTab,
  neighbourAfterClose, nextGroupColor, normalizeLayout, openTab, pruneTabs, removeFromGroup, sanitizeLayout,
  stripItems, ungroup, updateGroup, type TabLayout,
} from '../../dashboard/src/pages/whiteboards/tabStripLogic';

const slugs = (l: TabLayout) => l.tabs.map((t) => (t.group ? `${t.slug}@${t.group}` : t.slug));
const open = (...s: string[]) => s.reduce(openTab, emptyLayout());

describe('opening and closing tabs', () => {
  it('opens at the end, once', () => {
    const l = openTab(open('a', 'b'), 'a');
    expect(slugs(openTab(l, 'c'))).toEqual(['a', 'b', 'c']);
    expect(slugs(l)).toEqual(['a', 'b']);
  });

  it('closing activates the right neighbour, else the left, else nothing', () => {
    const l = open('a', 'b', 'c');
    expect(neighbourAfterClose(l, 'b')).toBe('c');
    expect(neighbourAfterClose(l, 'c')).toBe('b');
    expect(neighbourAfterClose(open('a'), 'a')).toBeNull();
    expect(slugs(closeTab(l, 'b'))).toEqual(['a', 'c']);
  });

  it('close others keeps one tab', () => {
    expect(slugs(closeOtherTabs(open('a', 'b', 'c'), 'b'))).toEqual(['b']);
  });

  it('prunes tabs whose board is gone', () => {
    const l = open('a', 'b', 'c');
    expect(slugs(pruneTabs(l, new Set(['a', 'c'])))).toEqual(['a', 'c']);
    expect(pruneTabs(l, new Set(['a', 'b', 'c']))).toBe(l);
  });
});

describe('dragging', () => {
  it('moves before a tab, or to the end', () => {
    const l = open('a', 'b', 'c');
    expect(slugs(moveTab(l, 'c', 'a', null))).toEqual(['c', 'a', 'b']);
    expect(slugs(moveTab(l, 'a', null, null))).toEqual(['b', 'c', 'a']);
  });

  it('dropping onto a grouped tab joins that group; onto the end leaves it', () => {
    let l = addToNewGroup(open('a', 'b', 'c'), 'b', 'g');
    l = moveTab(l, 'a', 'b', 'g');
    expect(slugs(l)).toEqual(['a@g', 'b@g', 'c']);
    expect(slugs(moveTab(l, 'a', null, null))).toEqual(['b@g', 'c', 'a']);
  });
});

describe('groups', () => {
  it('a new group takes the next unused colour and starts unnamed', () => {
    let l = addToNewGroup(open('a', 'b'), 'a', 'g1');
    expect(l.groups[0]).toMatchObject({ id: 'g1', name: '', color: GROUP_COLORS[0], collapsed: false });
    l = addToNewGroup(l, 'b', 'g2');
    expect(l.groups[1].color).toBe(GROUP_COLORS[1]);
    expect(nextGroupColor(l)).toBe(GROUP_COLORS[2]);
  });

  it('is never split: a tab joining lands after the group\'s last tab', () => {
    let l = addToNewGroup(open('a', 'b', 'c', 'd'), 'a', 'g');
    l = addToGroup(l, 'd', 'g');
    expect(slugs(l)).toEqual(['a@g', 'd@g', 'b', 'c']);
  });

  it('a tab leaving steps out just right of the group', () => {
    let l = addToNewGroup(open('a', 'b', 'c'), 'a', 'g');
    l = addToGroup(addToGroup(l, 'b', 'g'), 'c', 'g');
    expect(slugs(removeFromGroup(l, 'a'))).toEqual(['b@g', 'c@g', 'a']);
  });

  it('a new group made from inside another moves out of it first', () => {
    let l = addToNewGroup(open('a', 'b', 'c'), 'a', 'g');
    l = addToGroup(addToGroup(l, 'b', 'g'), 'c', 'g');
    l = addToNewGroup(l, 'b', 'h');
    expect(slugs(l)).toEqual(['a@g', 'c@g', 'b@h']);
  });

  it('a group with no tabs left disappears', () => {
    const l = addToNewGroup(open('a', 'b'), 'a', 'g');
    expect(closeTab(l, 'a').groups).toEqual([]);
    expect(removeFromGroup(l, 'a').groups).toEqual([]);
  });

  it('ungroup keeps the tabs; close group closes them', () => {
    let l = addToNewGroup(open('a', 'b', 'c'), 'b', 'g');
    l = addToGroup(l, 'c', 'g');
    expect(slugs(ungroup(l, 'g'))).toEqual(['a', 'b', 'c']);
    expect(slugs(closeGroup(l, 'g'))).toEqual(['a']);
  });

  it('rename, recolour, collapse; an unknown colour is refused', () => {
    let l = addToNewGroup(open('a'), 'a', 'g');
    l = updateGroup(l, 'g', { name: 'Research', color: 'green', collapsed: true });
    expect(l.groups[0]).toMatchObject({ name: 'Research', color: 'green', collapsed: true });
    l = updateGroup(l, 'g', { color: 'chartreuse' as never });
    expect(l.groups[0].color).toBe('green');
  });
});

describe('the strip', () => {
  it('draws a chip before each group, and a collapsed group hides all but the open board', () => {
    let l = addToNewGroup(open('a', 'b', 'c'), 'a', 'g');
    l = addToGroup(l, 'b', 'g');
    const kinds = (active: string) => stripItems(l, active).map((i) => (i.kind === 'group' ? `[${i.count}]` : i.slug));
    expect(kinds('c')).toEqual(['[2]', 'a', 'b', 'c']);
    l = updateGroup(l, 'g', { collapsed: true });
    expect(kinds('c')).toEqual(['[2]', 'c']);
    expect(kinds('b')).toEqual(['[2]', 'b', 'c']);
  });
});

describe('reading a stored layout', () => {
  it('drops junk, duplicates and unknown groups, and gathers a split group', () => {
    const l = sanitizeLayout({
      tabs: [{ slug: 'a', group: 'g' }, { slug: 'b' }, { slug: 'a' }, 7, { slug: 'c', group: 'g' }, { slug: 'd', group: 'nope' }],
      groups: [{ id: 'g', name: 'G', color: 'mauve' }, { id: 'empty', name: 'E', color: 'red' }, null],
    });
    expect(slugs(l)).toEqual(['a@g', 'c@g', 'b', 'd']);
    expect(l.groups).toEqual([{ id: 'g', name: 'G', color: 'grey', collapsed: false }]);
  });

  it('anything not a layout is an empty one', () => {
    expect(sanitizeLayout(null)).toEqual(emptyLayout());
    expect(sanitizeLayout('x')).toEqual(emptyLayout());
    expect(normalizeLayout(emptyLayout())).toEqual(emptyLayout());
  });
});
