/**
 * Navigation B, C6: a rail badge's marks come from the project's row as the drawer builds it
 * EXPANDED, so the red count is the sum of the NEEDS YOU rows' own numbers and equals what the
 * project's folded drawer row counts.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDrawerRows, foldedMark, type DrawerChild, type DrawerFacts, type DrawerProjectInput,
} from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import { needsYouOf, railMarksOf } from '../../dashboard/src/components/layout/newshell/railMarks.js';
import type { EkipMember } from '../../dashboard/src/components/aiteam/teamModel.js';

const project = (over: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name: 'pocket-ledger', logo: false, logoStamp: null, mounted: true, asleep: false, otherWindow: false, rollup: null, ...over,
});
const facts = (over: Partial<DrawerFacts> = {}): DrawerFacts => ({ superOn: true, superSelected: false, chatOpen: false, team: [], ...over });
const member = (over: Partial<EkipMember> = {}): EkipMember => ({
  slug: 'atlas', title: 'Atlas', hasPhoto: false, global: false, enabled: true, ownerWorking: 0, asking: false,
  approval: false, unread: 0, superOnly: false, lastAt: 0, question: null, ...over,
});
const team = (members: EkipMember[]): DrawerChild => ({ kind: 'team', vault: 'pocket-ledger', members, count: members.length, asking: true, selected: false });

function rows(f: Record<string, DrawerFacts>) {
  const input = { projects: [project()], activeVault: 'northwind', facts: f, fanout: {} };
  return { open: buildDrawerRows({ ...input, expanded: ['pocket-ledger'] })[0], folded: buildDrawerRows({ ...input, expanded: [] })[0] };
}

describe('rail marks (C6)', () => {
  it('the Super Agent asking and a window with two asking chats: count 3, the folded drawer row says 3 too', () => {
    const { open, folded } = rows({ 'pocket-ledger': facts({
      superMarks: { working: 1, asking: true },
      windows: [{ id: 'w1', name: 'Launch', working: 0, asking: 2, flagged: 1, other: 0, tabs: 2 }],
    }) });
    const needs = needsYouOf(open);
    expect(needs.map((r) => [r.kind, r.count])).toEqual([['super', 1], ['window', 2]]);
    expect(needs[0].intent).toEqual({ kind: 'super' });
    expect(needs[1].intent).toEqual({ kind: 'open-window', windowId: 'w1' });
    const marks = railMarksOf(open);
    expect(marks).toEqual({ count: 3, working: true, fresh: true });
    expect(folded.mark?.asking).toBe(marks.count);
  });

  it('a member with 3 waiting is one row showing 3, and an approval card is its own number', () => {
    const children: DrawerChild[] = [
      { kind: 'super', on: true, selected: false, working: 0, asking: false, waiting: 0 },
      team([member({ asking: true, waiting: 3 }), member({ slug: 'conor', title: 'Conor', approval: true })]),
    ];
    const needs = needsYouOf({ children });
    expect(needs.map((r) => [r.label, r.count, !!r.approval])).toEqual([['Atlas', 3, false], ['Conor', 1, true]]);
    expect(needs[0].intent).toEqual({ kind: 'member', slug: 'atlas', title: 'Atlas' });
    expect(railMarksOf({ children }).count).toBe(4);
    expect(foldedMark(children)?.asking).toBe(4);
  });

  it('a member working only for the Super, or switched off, waits on nobody', () => {
    const children: DrawerChild[] = [team([member({ asking: true, superOnly: true }), member({ slug: 'off', asking: true, enabled: false })])];
    expect(needsYouOf({ children })).toEqual([]);
    expect(railMarksOf({ children })).toEqual({ count: 0, working: false, fresh: false });
  });

  it('a device shell row (chats only): an asking chat counts 1 and opens that chat; a working chat rings', () => {
    const row = { kind: 'chat' as const, id: 'c1', vault: 'pocket-ledger', title: 'Which price for Pro?', state: 'asking' as const, flagged: false, selected: false, closable: false, row: { kind: 'tab', id: 'c1' } as never };
    const children: DrawerChild[] = [row, { ...row, id: 'c2', title: 'Import', state: 'working' }];
    expect(needsYouOf({ children }).map((r) => [r.label, r.count])).toEqual([['Which price for Pro?', 1]]);
    expect(needsYouOf({ children })[0].intent).toEqual({ kind: 'open-chat', row: row.row });
    expect(railMarksOf({ children })).toEqual({ count: 1, working: true, fresh: false });
  });

  it('nothing waiting, nothing running: no mark', () => {
    const { open } = rows({ 'pocket-ledger': facts() });
    expect(railMarksOf(open)).toEqual({ count: 0, working: false, fresh: false });
  });
});
