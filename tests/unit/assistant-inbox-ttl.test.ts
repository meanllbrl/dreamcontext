/**
 * The notch inbox's running-agents memo (src/server/assistant-inbox.ts) — task: the desktop app
 * stays light on an 8GB MacBook Air, plan S9.
 *
 * The notch polls the inbox every 4 s; a 4 s memo missed on nearly every tick. The memo now
 * outlives two polls, and a seen / mute write still drops it at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ listVaults: 0 }));

vi.mock('../../src/lib/vaults.js', () => ({
  listVaults: () => { calls.listVaults += 1; return []; },
}));

const { RUNNING_TTL_MS, invalidateAutomationInbox, runningAutomations } = await import('../../src/server/assistant-inbox.js');

beforeEach(() => {
  invalidateAutomationInbox();
  calls.listVaults = 0;
});

describe('runningAutomations memo', () => {
  it('outlives two 4 s notch polls', () => {
    expect(RUNNING_TTL_MS).toBeGreaterThan(2 * 4_000);
  });

  it('polls at 4 s inside the TTL walk the projects once', () => {
    const t0 = 1_000_000;
    runningAutomations(t0);
    runningAutomations(t0 + 4_000);
    runningAutomations(t0 + 8_000);
    expect(calls.listVaults).toBe(1);
    runningAutomations(t0 + RUNNING_TTL_MS);
    expect(calls.listVaults).toBe(2);
  });

  it('a seen / mute write drops the memo at once', () => {
    const t0 = 2_000_000;
    runningAutomations(t0);
    invalidateAutomationInbox();
    runningAutomations(t0 + 1_000);
    expect(calls.listVaults).toBe(2);
  });
});
