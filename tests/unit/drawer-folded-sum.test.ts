import { describe, expect, it } from 'vitest';
import { buildDrawerRows, fanoutTargets, type DrawerFacts, type DrawerProjectInput, type FanoutFacts } from '../../dashboard/src/components/layout/newshell/drawerModel.js';

const project = (over: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name: 'acme', logo: false, logoStamp: null, mounted: true, asleep: false, otherWindow: false, rollup: null, ...over,
});
const win = (id: string, working: number, over = {}) => ({ id, name: id, working, asking: 0, flagged: 0, other: 0, tabs: 1, ...over });
const facts = (over: Partial<DrawerFacts> = {}): DrawerFacts => ({ superOn: true, superSelected: false, chatOpen: false, team: [], ...over });

function both(f: { facts?: Record<string, DrawerFacts>; fanout?: Record<string, FanoutFacts>; p?: Partial<DrawerProjectInput> }) {
  const input = { projects: [project(f.p)], activeVault: 'acme', facts: f.facts ?? {}, fanout: f.fanout ?? {} };
  return { open: buildDrawerRows({ ...input, expanded: ['acme'] })[0], folded: buildDrawerRows({ ...input, expanded: [] })[0] };
}

describe('a folded project reads the sum of its rows', () => {
  it('counts the Super Agent row with the chat rows: 2 + 1 + 1 + 1 + 1 = 6, the reported case', () => {
    const { open, folded } = both({ facts: { acme: facts({
      superMarks: { working: 2, asking: false },
      windows: [win('apps', 1), win('chat4', 1), win('codex', 1), win('chat3', 1)],
      shown: { live: 4, asking: 0, working: 4, flagged: 0 },
    }) } });
    const rows = open.children.reduce((n, c) => n + (c.kind === 'super' || c.kind === 'window' ? c.working : 0), 0);
    expect(rows).toBe(6);
    expect(folded.sum).toMatchObject({ working: 6, live: 6 });
  });

  it('a project whose only work is the Super Agent still gets its ring', () => {
    const { folded } = both({ facts: { acme: facts({
      superMarks: { working: 1, asking: false },
      windows: [win('chat2', 0)],
      shown: { live: 0, asking: 0, working: 0, flagged: 0 },
    }) } });
    expect(folded.sum).toEqual({ live: 1, asking: 0, working: 1, idle: 0, flagged: 0 });
  });

  it('carries every number a chat row shows, and no ring when nothing is live', () => {
    const { folded } = both({ facts: { acme: facts({
      windows: [win('a', 1, { asking: 1, flagged: 1 }), win('b', 0, { other: 2 })],
    }) } });
    expect(folded.sum).toEqual({ live: 4, asking: 1, working: 1, idle: 2, flagged: 1 });
    expect(both({ facts: { acme: facts({ windows: [win('a', 0)] }) } }).folded.sum).toBeUndefined();
  });

  it('a window list empty of tabs adds nothing, and a team row has no number', () => {
    const { folded } = both({ facts: { acme: facts({
      team: [{ slug: 's', title: 'S', hasPhoto: false, status: 'working' }],
      windows: [win('gone', 3, { tabs: 0 })],
    }) } });
    expect(folded.sum).toBeUndefined();
  });

  it('with no window list yet it still sums the rows the fallback row shows', () => {
    const { folded } = both({ facts: { acme: facts({
      superMarks: { working: 2, asking: false }, shown: { live: 3, asking: 0, working: 1, flagged: 0 },
    }) } });
    expect(folded.sum).toEqual({ live: 5, asking: 0, working: 3, idle: 2, flagged: 0 });
  });

  it('a project not mounted shows its Super Agent, never its saved tabs as a count', () => {
    const fanout = { acme: { tabs: 4, superOn: true, team: [], windows: [{ id: 'main', name: 'Chat', tabs: 4 }], superMarks: { working: 1, asking: false } } };
    expect(both({ fanout, p: { mounted: false } }).folded.sum).toEqual({ live: 1, asking: 0, working: 1, idle: 0, flagged: 0 });
    const idle = { acme: { ...fanout.acme, superMarks: { working: 0, asking: false } } };
    expect(both({ fanout: idle, p: { mounted: false } }).folded.sum).toBeUndefined();
  });

  it('a question on the Super Agent still lights the folded row', () => {
    const { folded } = both({ facts: { acme: facts({ superMarks: { working: 0, asking: true }, windows: [] }) } });
    expect(folded.superAsking).toBe(true);
    expect(folded.children).toEqual([]);
  });
});

describe('the fan-out reads a folded project that is not mounted', () => {
  it('expanded first, then folded, within the cap; mounted never', () => {
    expect(fanoutTargets(['a'], ['m'], true, 2, ['b', 'm', 'c'])).toEqual({ poll: ['a', 'b'], once: [] });
  });
  it('an expanded project past the cap is still read once, a folded one is not', () => {
    expect(fanoutTargets(['a', 'b'], [], true, 1, ['c'])).toEqual({ poll: ['a'], once: ['b'] });
  });
  it('the window out of focus reads each once', () => {
    expect(fanoutTargets(['a'], [], false, 8, ['c'])).toEqual({ poll: [], once: ['a', 'c'] });
  });
});
