import { describe, it, expect } from 'vitest';
import {
  effectiveDebt,
  effectiveRhythm,
  countPendingSessions,
  floorScoreForNeverFlushed,
  PENDING_SESSION_PROVISIONAL,
  PENDING_PROVISIONAL_CAP,
  NEVER_FLUSHED_FINALIZE_MS,
  NEVER_FLUSHED_FLOOR_SCORE,
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
} from '../../src/lib/sleep-consolidation.js';
import type { SleepState, SessionRecord } from '../../src/lib/sleep-consolidation.js';

/**
 * AC1 (pending-session provisional debt) + AC2 (never-flushed floor score)
 * unit coverage (improve-sleep-quality, T1). Pure functions only — no disk.
 * Scope: this file tests ONLY what sleep-consolidation.ts exports. The
 * directive/reminder integration (hook.ts consuming effectiveDebt) is a
 * separate task (T7) and is NOT exercised here.
 */

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: 's-1',
    transcript_path: null,
    stopped_at: null,
    last_assistant_message: null,
    change_count: null,
    tool_count: null,
    score: null,
    task_slugs: [],
    ...overrides,
  };
}

function baseState(overrides: Partial<SleepState> = {}): SleepState {
  return {
    debt: 0,
    last_sleep: null,
    last_sleep_summary: null,
    sleep_started_at: null,
    sessions_since_last_sleep: 0,
    sessions: [],
    bookmarks: [],
    triggers: [],
    knowledge_access: {},
    dashboard_changes: [],
    compaction_log: [],
    recall_mode: 'haiku',
    consolidation_depth: null,
    pendingMigrationNotices: [],
    ...overrides,
  };
}

describe('countPendingSessions', () => {
  it('0 sessions → 0', () => {
    expect(countPendingSessions([])).toBe(0);
  });

  it('counts only score === null sessions', () => {
    const sessions = [
      session({ score: 3 }),
      session({ score: null }),
      session({ score: 0 }),
      session({ score: null }),
    ];
    expect(countPendingSessions(sessions)).toBe(2);
  });
});

describe('effectiveDebt — boundary-exact provisional crossing', () => {
  // Each pair is expressed RELATIVE to the threshold it straddles, so the
  // boundary stays exact across any rescale of the debt scale itself.
  it.each([
    ['DROWSY', DEBT_DROWSY],
    ['SLEEPY', DEBT_SLEEPY],
    ['MUST SLEEP', DEBT_MUST_SLEEP],
  ] as const)('one pending session carries persisted debt across %s', (_label, threshold) => {
    const justBelow = threshold - PENDING_SESSION_PROVISIONAL;
    const state = baseState({ debt: justBelow, sessions: [session({ score: null })] });
    const eff = effectiveDebt(state);
    expect(eff.persisted).toBe(justBelow);
    expect(eff.pendingCount).toBe(1);
    expect(eff.provisional).toBe(PENDING_SESSION_PROVISIONAL);
    expect(eff.effective).toBe(threshold);
    expect(eff.effective).toBeGreaterThanOrEqual(threshold);

    // …and with nothing pending, the same persisted debt stays below it.
    expect(effectiveDebt(baseState({ debt: threshold - 1, sessions: [] })).effective)
      .toBeLessThan(threshold);
  });
});

describe('effectiveDebt — provisional cap', () => {
  it('enough pending sessions → provisional caps at PENDING_PROVISIONAL_CAP', () => {
    const atCap = Math.ceil(PENDING_PROVISIONAL_CAP / PENDING_SESSION_PROVISIONAL);
    const state = baseState({ debt: 0, sessions: Array.from({ length: atCap }, () => session({ score: null })) });
    expect(effectiveDebt(state).provisional).toBe(PENDING_PROVISIONAL_CAP);
  });

  it('7, 20, and 100 pending sessions all still cap at PENDING_PROVISIONAL_CAP', () => {
    for (const n of [7, 20, 100]) {
      const state = baseState({ debt: 0, sessions: Array.from({ length: n }, () => session({ score: null })) });
      expect(effectiveDebt(state).provisional).toBe(PENDING_PROVISIONAL_CAP);
    }
  });

  it('safety invariant: persisted 0 + any pendingCount never reaches DEBT_MUST_SLEEP alone', () => {
    for (const n of [0, 1, 5, 6, 50, 1000]) {
      const state = baseState({ debt: 0, sessions: Array.from({ length: n }, () => session({ score: null })) });
      expect(effectiveDebt(state).effective).toBeLessThan(DEBT_MUST_SLEEP);
    }
  });
});

describe('effectiveDebt — never mutates persisted state', () => {
  it('state.debt is untouched after effectiveDebt / effectiveRhythm calls', () => {
    const state = baseState({ debt: 6, sessions: [session({ score: null }), session({ score: null })] });
    const frozen = JSON.parse(JSON.stringify(state));

    effectiveDebt(state);
    effectiveRhythm(state);

    expect(state.debt).toBe(frozen.debt);
    expect(state).toEqual(frozen);
  });
});

describe('effectiveRhythm — floor, never lowers', () => {
  it('sessions_since_last_sleep 5, pending 0 → 5 (unchanged)', () => {
    expect(effectiveRhythm(baseState({ sessions_since_last_sleep: 5, sessions: [] }))).toBe(5);
  });

  it('sessions_since_last_sleep 2, pending 4 → 4 (floor raises it)', () => {
    const state = baseState({
      sessions_since_last_sleep: 2,
      sessions: Array.from({ length: 4 }, () => session({ score: null })),
    });
    expect(effectiveRhythm(state)).toBe(4);
  });

  it('sessions_since_last_sleep 9, pending 1 → 9 (never lowers)', () => {
    const state = baseState({ sessions_since_last_sleep: 9, sessions: [session({ score: null })] });
    expect(effectiveRhythm(state)).toBe(9);
  });
});

describe('regression — sessions: [] behaves byte-identical to today', () => {
  it('effective === persisted when there are no sessions at all', () => {
    for (const debt of [0, 7, 8, 13, 14, 19, 20, 32]) {
      const eff = effectiveDebt(baseState({ debt, sessions: [] }));
      expect(eff.effective).toBe(debt);
      expect(eff.pendingCount).toBe(0);
      expect(eff.provisional).toBe(0);
    }
  });
});

describe('floorScoreForNeverFlushed (AC2 7-day finalization floor)', () => {
  it('non-empty last_assistant_message → the never-flushed floor score', () => {
    expect(floorScoreForNeverFlushed('Fixed the bug and shipped it.')).toBe(NEVER_FLUSHED_FLOOR_SCORE);
    expect(NEVER_FLUSHED_FLOOR_SCORE).toBeGreaterThan(0);
  });

  it('null → 0', () => {
    expect(floorScoreForNeverFlushed(null)).toBe(0);
  });

  it('undefined → 0', () => {
    expect(floorScoreForNeverFlushed(undefined)).toBe(0);
  });

  it('empty string → 0', () => {
    expect(floorScoreForNeverFlushed('')).toBe(0);
  });

  it('whitespace-only string → 0', () => {
    expect(floorScoreForNeverFlushed('   \n\t  ')).toBe(0);
  });

  it('NEVER_FLUSHED_FINALIZE_MS is exactly 7 days in ms', () => {
    expect(NEVER_FLUSHED_FINALIZE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
