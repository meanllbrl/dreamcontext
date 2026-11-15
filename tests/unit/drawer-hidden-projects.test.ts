import { describe, expect, it } from 'vitest';
import {
  effectiveHidden, foldedTargets, hiddenGroupMark, moveAmong, splitHiddenRows, type DrawerProjectRow,
} from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import { coerceLauncherUiPartial } from '../../src/server/routes/launcher.js';

const row = (name: string, over: Partial<DrawerProjectRow> = {}): DrawerProjectRow => ({
  name, logo: false, logoStamp: null, active: false, held: false, asleep: false, otherWindow: false,
  expanded: false, source: 'none', children: [], ...over,
});

describe('drawer: hidden projects (option A)', () => {
  it('splits the rows into the list and the Hidden group, each in the owner order', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')];
    const { shown, hidden } = splitHiddenRows(rows, ['d', 'b', 'gone']);
    expect(shown.map((r) => r.name)).toEqual(['a', 'c']);
    expect(hidden.map((r) => r.name)).toEqual(['b', 'd']);
  });

  it('the group mark sums every hidden project, folded or open, plus Super unread', () => {
    const rows = [
      row('a', { mark: { asking: 1, questions: 1, working: false, unread: 0 } }),
      row('b', { mark: { asking: 0, working: true, unread: 2 } }),
      row('c', { expanded: true, children: [{ kind: 'super', vault: 'c', selected: false, on: true, working: 0, asking: true } as never] }),
    ];
    expect(hiddenGroupMark(rows, 3)).toEqual({ asking: 2, questions: 2, approvals: 0, working: true, unread: 5 });
    expect(hiddenGroupMark([row('quiet')])).toBeUndefined();
  });

  it('a hidden project is read on top of the poll cap, never capped out', () => {
    const folded = ['v1', 'v2', 'v3', 'h1', 'h2'];
    expect(foldedTargets(folded, ['v2'], 1, ['h1', 'h2'])).toEqual(['v1', 'h1', 'h2']);
    expect(foldedTargets(folded, ['h1'], 2, ['h1', 'h2'])).toEqual(['v1', 'v2', 'h2']);
  });

  it('the project hidden while on screen stays in the list until the owner switches away', () => {
    expect(effectiveHidden(['a', 'b'], 'a')).toEqual(['b']);
    expect(effectiveHidden(['a', 'b'], null)).toEqual(['a', 'b']);
  });

  it('⌥↑/⌥↓ moves among the same part, hopping over the other part', () => {
    const order = ['a', 'h', 'b', 'c'];
    expect(moveAmong(order, ['h'], 'b', -1)).toEqual(['b', 'a', 'h', 'c']);
    expect(moveAmong(order, ['h'], 'a', 1)).toEqual(['h', 'b', 'a', 'c']);
    expect(moveAmong(order, ['h'], 'a', -1)).toEqual(order);
    expect(moveAmong(order, ['h'], 'h', 1)).toEqual(order);
  });

  it('the server keeps hiddenProjects as project names only', () => {
    expect(coerceLauncherUiPartial({ hiddenProjects: ['acme', '../x', 'acme', 3] }).hiddenProjects).toEqual(['acme']);
    expect('hiddenProjects' in coerceLauncherUiPartial({})).toBe(false);
  });
});
