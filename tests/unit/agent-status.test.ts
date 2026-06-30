/**
 * Unit tests for deriveSessionStatus — the pure five-state taxonomy that drives BOTH
 * the expanded session-list rail and the collapsed status bubbles. The user's #1 need is
 * being able to tell "is it working or not", so each input combination must map to a
 * single, distinct kind/label/mood.
 *
 * Imports the type-only-dependency module (SleepyMascot/agentSession imports are erased),
 * so it runs in node without any DOM/CSS.
 */

import { describe, it, expect } from 'vitest';
import { deriveSessionStatus } from '../../dashboard/src/components/sleepy/agentStatus.js';

describe('deriveSessionStatus', () => {
  it('dormant restored tab → saved (sleeps), regardless of any stale status/busy', () => {
    expect(deriveSessionStatus({ dormant: true })).toEqual({ kind: 'saved', label: 'saved', mood: 'sleeps' });
    // dormant WINS over a leaked live status/busy.
    expect(deriveSessionStatus({ dormant: true, status: 'open', busy: true }))
      .toEqual({ kind: 'saved', label: 'saved', mood: 'sleeps' });
  });

  it('connecting → starting (thinking)', () => {
    expect(deriveSessionStatus({ status: 'connecting' }))
      .toEqual({ kind: 'starting', label: 'starting', mood: 'thinking' });
  });

  it('open + busy → working (working, pulsing)', () => {
    expect(deriveSessionStatus({ status: 'open', busy: true }))
      .toEqual({ kind: 'working', label: 'working', mood: 'working' });
  });

  it('open + idle → ready (waving)', () => {
    expect(deriveSessionStatus({ status: 'open', busy: false }))
      .toEqual({ kind: 'ready', label: 'ready', mood: 'waving' });
    // busy omitted reads the same as idle.
    expect(deriveSessionStatus({ status: 'open' }))
      .toEqual({ kind: 'ready', label: 'ready', mood: 'waving' });
  });

  it('closed → ended (sleeps)', () => {
    expect(deriveSessionStatus({ status: 'closed' }))
      .toEqual({ kind: 'ended', label: 'ended', mood: 'sleeps' });
  });

  it('no live session yet (undefined status, not dormant) → starting, never blank', () => {
    expect(deriveSessionStatus({}))
      .toEqual({ kind: 'starting', label: 'starting', mood: 'thinking' });
  });

  it('every kind is visually distinct (no two inputs collapse to the same kind)', () => {
    const kinds = [
      deriveSessionStatus({ dormant: true }).kind,
      deriveSessionStatus({ status: 'connecting' }).kind,
      deriveSessionStatus({ status: 'open', busy: true }).kind,
      deriveSessionStatus({ status: 'open', busy: false }).kind,
      deriveSessionStatus({ status: 'closed' }).kind,
    ];
    expect(new Set(kinds).size).toBe(5);
  });
});
