import { describe, it, expect } from 'vitest';
import {
  GROUP_MAX, addEmptyGroup, buildExplorer, emptyExplorerPrefs, groupLength, groupSpelling, keepGroupIfEmptied,
  pruneExplorerPrefs, realGroupNames, renameGroupInPrefs, sanitizeExplorerPrefs, toggleCollapsed, togglePin,
  touchRecent, validGroupName, RECENT_MAX,
} from '../../dashboard/src/pages/whiteboards/explorerLogic';
import { fold } from '../../dashboard/src/pages/whiteboards/boardSwitcherLogic';
import * as server from '../../src/lib/whiteboards/validate.js';

/** The board explorer's pure half (dashboard/src/pages/whiteboards/explorerLogic.ts). */

const b = (slug: string, group?: string, name = slug) => ({ slug, name, description: '', ...(group ? { group } : {}) });

describe('mirrors of the server rules', () => {
  it('GROUP_MAX, the code-point length, the fold and the name check agree with src/lib/whiteboards/validate.ts', () => {
    expect(GROUP_MAX).toBe(server.GROUP_MAX);
    for (const s of ['Satış', 'SATIS', 'Tilki metrics', 'İş', 'ğğ😀', 'Ünite']) {
      expect(fold(s)).toBe(server.foldGroup(s));
      expect(groupLength(s)).toBe(server.groupLength(s));
    }
    for (const s of ['ok', ' padded ', 'a/b', '', 'x'.repeat(61), '😀'.repeat(60), 'line\nbreak']) {
      expect(validGroupName(s)).toBe(server.readGroup(s));
    }
  });
});

describe('prefs', () => {
  it('sanitize keeps only the shape; nothing is pruned on read', () => {
    expect(sanitizeExplorerPrefs(null)).toEqual(emptyExplorerPrefs());
    const p = sanitizeExplorerPrefs({ open: 'yes', pinned: ['a', 'a', 3, 'gone'], recent: ['1', '2', '3', '4', '5', '6'], emptyGroups: ['ok', 'a/b'], collapsed: ['x'] });
    expect(p).toEqual({ open: null, pinned: ['a', 'gone'], recent: ['1', '2', '3', '4', '5'], emptyGroups: ['ok'], collapsed: ['x'] });
  });

  it('recent keeps the newest first, at most RECENT_MAX', () => {
    let p = emptyExplorerPrefs();
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'b']) p = touchRecent(p, s);
    expect(p.recent).toEqual(['b', 'f', 'e', 'd', 'c']);
    expect(p.recent.length).toBe(RECENT_MAX);
    expect(touchRecent(p, 'b')).toBe(p);
  });

  it('prune drops deleted boards and empty groups a board now carries — and returns the same object when nothing changed', () => {
    const p = { ...emptyExplorerPrefs(), pinned: ['a', 'gone'], recent: ['gone', 'a'], emptyGroups: ['Tilki', 'Fresh'] };
    const boards = [b('a', 'tilki')];
    const next = pruneExplorerPrefs(p, boards);
    expect(next).toMatchObject({ pinned: ['a'], recent: ['a'], emptyGroups: ['Fresh'] });
    expect(pruneExplorerPrefs(next, boards)).toBe(next);
  });

  it('pin, collapse (by fold) and empty groups', () => {
    let p = togglePin(emptyExplorerPrefs(), 'a');
    expect(p.pinned).toEqual(['a']);
    p = togglePin(p, 'a');
    expect(p.pinned).toEqual([]);
    p = toggleCollapsed(p, 'Satış');
    expect(p.collapsed).toEqual([fold('Satış')]);
    p = addEmptyGroup(p, 'New', ['Old']);
    expect(addEmptyGroup(p, 'new', ['Old'])).toBe(p);
    expect(addEmptyGroup(p, 'OLD', ['Old'])).toBe(p);
  });

  it('a group rename carries its collapsed and empty entries; ungroup drops them', () => {
    const p = { ...emptyExplorerPrefs(), collapsed: [fold('Satis')], emptyGroups: ['Satis'] };
    const r = renameGroupInPrefs(p, 'Satis', 'Satış');
    expect(r.emptyGroups).toEqual(['Satış']);
    expect(r.collapsed).toEqual([fold('Satış')]);
    expect(renameGroupInPrefs(p, 'satis', null)).toMatchObject({ collapsed: [], emptyGroups: [] });
  });

  it('moving or deleting the last board of a group keeps it as an empty group', () => {
    const boards = [b('a', 'Solo'), b('x', 'Pair'), b('y', 'Pair')];
    expect(keepGroupIfEmptied(emptyExplorerPrefs(), boards, 'a').emptyGroups).toEqual(['Solo']);
    expect(keepGroupIfEmptied(emptyExplorerPrefs(), boards, 'x').emptyGroups).toEqual([]);
    expect(keepGroupIfEmptied(emptyExplorerPrefs(), [b('n')], 'n').emptyGroups).toEqual([]);
  });
});

describe('buildExplorer', () => {
  const boards = [
    b('revenue', 'Tilki metrics', 'REVENUE'),
    b('crm', 'tilki metrics', 'CRM'),
    b('acq', 'Tilki metrics', 'ACQUISITION'),
    b('onb', 'Product screens', 'Onboarding'),
    b('control-panel', undefined, 'Control Panel'),
    b('test', undefined, 'Test'),
    { ...b('proto', '__proto__', 'Proto') },
  ];

  it('groups by fold with the majority spelling, sorted, boards by name; ungrouped last', () => {
    const v = buildExplorer(boards, emptyExplorerPrefs(), '', null);
    expect(v.groups.map((g) => [g.name, g.boards.map((x) => x.name)])).toEqual([
      ['__proto__', ['Proto']],
      ['Product screens', ['Onboarding']],
      ['Tilki metrics', ['ACQUISITION', 'CRM', 'REVENUE']],
    ]);
    expect(v.ungrouped.map((x) => x.slug)).toEqual(['control-panel', 'test']);
    expect(groupSpelling(['tilki', 'Tilki', 'Tilki'])).toBe('Tilki');
    expect(groupSpelling(['b', 'a'])).toBe('a');
    expect(realGroupNames(boards)).toEqual(['__proto__', 'Product screens', 'Tilki metrics']);
  });

  it('collapse follows the prefs, the open board\'s group included (a click on it must fold it)', () => {
    const prefs = toggleCollapsed(emptyExplorerPrefs(), 'Product screens');
    const v = buildExplorer(boards, prefs, '', 'onb');
    expect(v.groups.find((g) => g.name === 'Product screens')!.collapsed).toBe(true);
    expect(v.groups.find((g) => g.name === 'Tilki metrics')!.collapsed).toBe(false);
  });

  it('pinned and recent: recent leaves out the open board and shows at most 3', () => {
    const prefs = { ...emptyExplorerPrefs(), pinned: ['control-panel', 'gone'], recent: ['onb', 'crm', 'test', 'acq', 'revenue'] };
    const v = buildExplorer(boards, prefs, '', 'onb');
    expect(v.pinned.map((x) => x.slug)).toEqual(['control-panel']);
    expect(v.recent.map((x) => x.slug)).toEqual(['crm', 'test', 'acq']);
  });

  it('search matches name, slug and group by fold; groups open, pinned/recent/empty hide', () => {
    const prefs = { ...toggleCollapsed(emptyExplorerPrefs(), 'Tilki metrics'), pinned: ['test'], emptyGroups: ['Later'] };
    const v = buildExplorer(boards, prefs, 'TILKI rev', null);
    expect(v.searching).toBe(true);
    expect(v.hits.map((x) => x.slug)).toEqual(['revenue']);
    expect(v.groups[0].collapsed).toBe(false);
    expect(v.pinned).toEqual([]);
    expect(v.groups.some((g) => g.empty)).toBe(false);
    expect(buildExplorer(boards, prefs, 'nothing-like-this', null).hits).toEqual([]);
  });

  it('an empty group shows unless a real group folds the same way', () => {
    const prefs = { ...emptyExplorerPrefs(), emptyGroups: ['Later', 'PRODUCT SCREENS'] };
    const v = buildExplorer(boards, prefs, '', null);
    expect(v.groups.filter((g) => g.empty).map((g) => g.name)).toEqual(['Later']);
  });
});

describe('the group PATCH body', () => {
  it('always sends expectGroup, null for an ungrouped board (undefined would skip the check)', async () => {
    const { groupPatchBody } = await import('../../dashboard/src/hooks/useWhiteboards');
    expect(JSON.parse(JSON.stringify(groupPatchBody('G', undefined)))).toEqual({ group: 'G', expectGroup: null });
    expect(groupPatchBody(null, 'Old')).toEqual({ group: null, expectGroup: 'Old' });
  });
});
