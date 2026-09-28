/**
 * A party card's clock (SubAgentCard.tsx partyClockMs) is that party's OWN duration: its first
 * spawn to its last finish, frozen once every member is done, and ticking only while one
 * still runs. The owner's run showed 398:08 next to "cleared": minutes since the chat's first
 * spawn on a card whose builders had long finished.
 */

import { describe, it, expect } from 'vitest';
import { partyClockMs } from '../../dashboard/src/components/sleepy/chat/SubAgentCard.js';

const T0 = Date.parse('2026-09-26T10:00:00Z');
const MIN = 60_000;

describe('partyClockMs', () => {
  it('a finished party is its own span, frozen: first start to last end, whatever now is', () => {
    const runs = [
      { status: 'completed' as const, startedAt: T0 + 2 * MIN, endedAt: T0 + 9 * MIN },
      { status: 'completed' as const, startedAt: T0 + 3 * MIN, endedAt: T0 + 14 * MIN },
      { status: 'error' as const, startedAt: T0 + 4 * MIN, endedAt: T0 + 6 * MIN },
    ];
    expect(partyClockMs(runs, T0 + 15 * MIN)).toBe(12 * MIN);
    expect(partyClockMs(runs, T0 + 400 * MIN)).toBe(12 * MIN);
  });

  it('a party with a member still running ticks from its first start to now', () => {
    const runs = [
      { status: 'completed' as const, startedAt: T0 + 2 * MIN, endedAt: T0 + 5 * MIN },
      { status: 'running' as const, startedAt: T0 + 3 * MIN },
    ];
    expect(partyClockMs(runs, T0 + 10 * MIN)).toBe(8 * MIN);
    expect(partyClockMs(runs, T0 + 20 * MIN)).toBe(18 * MIN);
  });

  it('a stopped member without an end time ends where it started, and never ticks', () => {
    const runs = [
      { status: 'completed' as const, startedAt: T0, endedAt: T0 + 4 * MIN },
      { status: 'stopped' as const, startedAt: T0 + 7 * MIN },
    ];
    expect(partyClockMs(runs, T0 + 60 * MIN)).toBe(7 * MIN);
    expect(partyClockMs([{ status: 'stopped' as const, startedAt: T0 }], T0 + 60 * MIN)).toBe(0);
  });

  it('no runs, or none with a start time, has no clock', () => {
    expect(partyClockMs([], T0)).toBeNull();
    expect(partyClockMs([{ status: 'running' as const, startedAt: 0 }], T0)).toBeNull();
    expect(partyClockMs([{ status: 'running' as const, startedAt: Number.NaN }], T0)).toBeNull();
  });
});
