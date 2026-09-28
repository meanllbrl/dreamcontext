/**
 * The quest header of a Develop run whose LAST wave is under review (the owner's 2026-09-27
 * run, synthetic names): the live stage is the Boss gate, Build is done, and Build's clock is
 * that wave's build time, frozen at its hand-off to review. The owner saw "Build wave 7 of 7 ·
 * 6h 30m" tick on to 6h 32m while only the reviewer was working.
 */

import { describe, it, expect } from 'vitest';
import { applyGoalLiveEvent, type GoalLiveEvent, type GoalLiveState as WriterState } from '../../src/lib/goal-live.js';
import { normalizeGoalLive } from '../../dashboard/src/lib/goalLive.js';
import { goalQuest, questStageMeta } from '../../dashboard/src/lib/quest.js';

const T0 = Date.parse('2026-09-26T17:26:00Z');
const MIN = 60_000;

/** Fold events at the given minute offsets, then read the file back as the panel does. */
function fold(events: [number, GoalLiveEvent][]) {
  let s: WriterState | null = null;
  for (const [m, ev] of events) s = applyGoalLiveEvent(s, ev, new Date(T0 + m * MIN).toISOString());
  return normalizeGoalLive(JSON.parse(JSON.stringify(s)))!;
}

// Resumed at wave 6 of 7; wave 7 builds for 6h 29m, then its reviewer is seated and running.
const state = fold([
  [0, { type: 'start', goal: 'fox-notch-assistant', session: null, mode: 'develop', tab: 'tab-a' }],
  [1, { type: 'phase', phase: 'impl', wave: 6, waves: 7 }],
  [1, { type: 'actor', id: 'w6-A', role: 'implementer', kind: 'spawn', wave: 6, name: 'lane A' }],
  [12, { type: 'phase', phase: 'codereview', wave: 6 }],
  [12, { type: 'actor', id: 'w6-reviewer', role: 'reviewer', kind: 'fresh', wave: 6 }],
  [19, { type: 'state', id: 'w6-reviewer', verdict: 'PASS', wave: 6 }],
  [20, { type: 'phase', phase: 'impl', wave: 7 }],
  [20, { type: 'actor', id: 'w7-A', role: 'implementer', kind: 'spawn', wave: 7, name: 'lane A' }],
  [20, { type: 'actor', id: 'w7-B', role: 'implementer', kind: 'spawn', wave: 7, name: 'lane B' }],
  [409, { type: 'phase', phase: 'codereview', wave: 7 }],
  [409, { type: 'actor', id: 'w7-reviewer', role: 'reviewer', kind: 'fresh', wave: 7 }],
]);

describe('the Develop quest header while the last wave is under review', () => {
  it('the file is what the owner\'s was: develop, wave 7 of 7, in code review, reviewer running', () => {
    expect(state).toMatchObject({ mode: 'develop', phase: 'codereview', impl: { wave: 7, waves: 7 } });
    expect(state.judges?.find((j) => j.id === 'w7-reviewer')?.s).toBe('run');
  });

  it('the live stage is the Boss gate, and the Build it follows is done', () => {
    const q = goalQuest(state, T0 + 410 * MIN);
    const live = q.stages.filter((s) => s.state === 'active');
    expect(live.map((s) => s.id)).toEqual(['boss']);
    expect(q.stages[q.activeIndex].id).toBe('boss');
    expect(q.stages.find((s) => s.id === 'build')!.state).toBe('done');
    expect(q.cast.map((m) => m.key)).toEqual(['w7-reviewer']);
    expect(questStageMeta(q.stages.find((s) => s.id === 'boss')!)?.text).toBe('6 of 7 reviewed');
  });

  it('Build reads wave 7\'s own build time, frozen while the reviewer runs', () => {
    const at = (m: number) => questStageMeta(goalQuest(state, T0 + m * MIN).stages.find((s) => s.id === 'build')!)?.text;
    // Wave 7 was built from minute 20 to minute 409: 6h 29m, never the run's 6h 49m.
    expect(at(410)).toBe('wave 7 of 7 · 6h 29m');
    expect(at(412)).toBe('wave 7 of 7 · 6h 29m');
    expect(at(500)).toBe('wave 7 of 7 · 6h 29m');
  });
});
