/**
 * Unit tests for deriveSessionStatus — the pure six-state taxonomy that drives BOTH
 * the expanded session-list rail and the collapsed status bubbles. The user's #1 need is
 * being able to tell "is it working or not" (and, since the asking state, "is it BLOCKED
 * on me"), so each input combination must map to a single, distinct kind/label/mood.
 *
 * Imports the type-only-dependency module (SleepyMascot/agentSession imports are erased),
 * so it runs in node without any DOM/CSS.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveSessionStatus, orderRows, rollupKind, KIND_RANK,
  type SessionRow, type SessionStatusKind,
} from '../../dashboard/src/components/sleepy/agentStatus.js';

/** Minimal row factory — only the fields the pure helpers read. */
function row(id: string, kind: SessionStatusKind, sessionKind: SessionRow['kind'] = 'agent'): SessionRow {
  const infoByKind: Record<SessionStatusKind, () => SessionRow['info']> = {
    saved: () => deriveSessionStatus({ dormant: true }),
    starting: () => deriveSessionStatus({ status: 'connecting' }),
    working: () => deriveSessionStatus({ status: 'open', busy: true }),
    asking: () => deriveSessionStatus({ status: 'open', asking: true }),
    ready: () => deriveSessionStatus({ status: 'open' }),
    ended: () => deriveSessionStatus({ status: 'closed' }),
  };
  return { id, title: id, kind: sessionKind, info: infoByKind[kind](), attention: false };
}

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

  it('open + asking → asking (needs you), even while stale bytes keep busy set', () => {
    expect(deriveSessionStatus({ status: 'open', asking: true }))
      .toEqual({ kind: 'asking', label: 'needs you', mood: 'asking' });
    // asking WINS over busy: a question on screen means blocked-on-you no matter what
    // dialog redraws / keystroke echos still dribble through the stream.
    expect(deriveSessionStatus({ status: 'open', busy: true, asking: true }))
      .toEqual({ kind: 'asking', label: 'needs you', mood: 'asking' });
  });

  it('asking only applies to an OPEN session (a closed/dormant one cannot ask)', () => {
    expect(deriveSessionStatus({ status: 'closed', asking: true }).kind).toBe('ended');
    expect(deriveSessionStatus({ dormant: true, asking: true }).kind).toBe('saved');
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
      deriveSessionStatus({ status: 'open', asking: true }).kind,
      deriveSessionStatus({ status: 'open', busy: false }).kind,
      deriveSessionStatus({ status: 'closed' }).kind,
    ];
    expect(new Set(kinds).size).toBe(6);
  });

  it('asking outranks everything in the urgency order (drives dock sort + rollup)', () => {
    const ranks = Object.entries(KIND_RANK);
    for (const [kind, rank] of ranks) {
      if (kind === 'asking') continue;
      expect(KIND_RANK.asking).toBeGreaterThan(rank);
    }
    // Every kind has a distinct rank — a worst-of rollup must never tie.
    expect(new Set(Object.values(KIND_RANK)).size).toBe(ranks.length);
  });

  it('every kind carries a mascot mood — the dock figure can never render blank', () => {
    const kinds: SessionStatusKind[] = ['saved', 'starting', 'working', 'asking', 'ready', 'ended'];
    for (const k of kinds) expect(row('x', k).info.mood).toBeTruthy();
    // The urgent states each wear their OWN face (calm saved/ended sharing "sleeps" is fine).
    const urgent = ['starting', 'working', 'asking', 'ready'].map((k) => row('x', k as SessionStatusKind).info.mood);
    expect(new Set(urgent).size).toBe(urgent.length);
  });
});

describe('orderRows (dock ordering — questions jump the queue)', () => {
  it('floats asking rows to the top, keeping their relative order', () => {
    const rows = [row('a', 'working'), row('b', 'asking'), row('c', 'ready'), row('d', 'asking')];
    expect(orderRows(rows).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('never reorders anything else — roster order is stable (no churny urgency sort)', () => {
    const rows = [row('a', 'ready'), row('b', 'working'), row('c', 'ended'), row('d', 'starting')];
    expect(orderRows(rows).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    // No asking → the SAME array back (zero re-render churn for the common case).
    expect(orderRows(rows)).toBe(rows);
  });

  it('does not mutate its input', () => {
    const rows = [row('a', 'working'), row('b', 'asking')];
    orderRows(rows);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('rollupKind (worst-of for the collapsed anchor chip)', () => {
  it('surfaces the most urgent state across every session', () => {
    expect(rollupKind([row('a', 'ready'), row('b', 'working')])).toBe('working');
    expect(rollupKind([row('a', 'working'), row('b', 'asking'), row('c', 'ended')])).toBe('asking');
    expect(rollupKind([row('a', 'saved'), row('b', 'ended')])).toBe('saved');
  });

  it('empty input reads as ended (the calmest state), never throws', () => {
    expect(rollupKind([])).toBe('ended');
  });
});
