/**
 * The update relaunch must not cut an agent off mid-work. The countdown is held while the
 * server reports a live tab at work (chat-park.ts `countWorkingAgents`, served on /api/health
 * as `agentsWorking`), and the banner's gate (relaunchGate.ts) reads that number.
 */
import { describe, it, expect } from 'vitest';
import { TERMINAL_WORKING_RECENT_MS, countWorkingAgents, type Parkable } from '../../src/server/chat-park.js';
import { relaunchHeld } from '../../dashboard/src/components/layout/relaunchGate.js';

const tab = (over: Partial<Parkable> = {}): Parkable => ({
  id: Math.random().toString(36).slice(2),
  kind: 'chat',
  projectRoot: '/tmp/fictional-project',
  exempt: () => null,
  busy: () => false,
  asking: () => false,
  backgroundTasks: () => 0,
  idleSince: () => 0,
  focusedAt: () => 0,
  park: async () => 'parked',
  ...over,
});

describe('countWorkingAgents', () => {
  it('counts a running turn, a waiting question and background work; idle tabs are free', () => {
    expect(countWorkingAgents([tab(), tab()])).toBe(0);
    expect(countWorkingAgents([tab({ busy: () => true }), tab()])).toBe(1);
    expect(countWorkingAgents([tab({ asking: () => true })])).toBe(1);
    // The reported case: the turn ended but a background shell and sub-agents still run.
    expect(countWorkingAgents([tab({ backgroundTasks: () => 3 }), tab()])).toBe(1);
  });

  it('a terminal counts only while it shows a sign of life, so a stale hook state never holds forever', () => {
    const NOW = 50_000_000;
    const quiet = () => ({ readable: true, at: 0, subagentAt: 0 });
    // Turn running: the TUI redrew a second ago.
    expect(countWorkingAgents([tab({ kind: 'terminal', busy: () => true, idleSince: () => NOW - 1_000 })], NOW, quiet)).toBe(1);
    // "Not ready" after an Esc / before the first prompt / no hooks, and silent: free.
    expect(countWorkingAgents([tab({ kind: 'terminal', busy: () => true, idleSince: () => NOW - TERMINAL_WORKING_RECENT_MS - 1 })], NOW, quiet)).toBe(0);
    // Silent screen but a sub-agent is still writing its transcript: working.
    expect(countWorkingAgents(
      [tab({ kind: 'terminal', busy: () => true, idleSince: () => 0 })], NOW,
      () => ({ readable: true, at: NOW - 5_000, subagentAt: NOW - 5_000 }),
    )).toBe(1);
    // Hook says ready: free whatever the screen does.
    expect(countWorkingAgents([tab({ kind: 'terminal', busy: () => false, idleSince: () => NOW })], NOW, quiet)).toBe(0);
  });

  it('a tab whose probe throws counts as working (never kill what we cannot read)', () => {
    expect(countWorkingAgents([tab({ busy: () => { throw new Error('gone'); } })])).toBe(1);
  });
});

describe('relaunchHeld', () => {
  it('holds while any agent works, runs when none does', () => {
    expect(relaunchHeld(2)).toBe(true);
    expect(relaunchHeld(0)).toBe(false);
  });

  it('an older server that does not report the count keeps the old countdown', () => {
    expect(relaunchHeld(undefined)).toBe(false);
    expect(relaunchHeld(null)).toBe(false);
  });
});
