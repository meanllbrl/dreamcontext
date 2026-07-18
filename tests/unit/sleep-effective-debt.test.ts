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
  it('persisted 6, pending 1 → effective 8 (crosses into DROWSY)', () => {
    const state = baseState({ debt: 6, sessions: [session({ score: null })] });
    const eff = effectiveDebt(state);
    expect(eff.persisted).toBe(6);
    expect(eff.pendingCount).toBe(1);
    expect(eff.provisional).toBe(PENDING_SESSION_PROVISIONAL);
    expect(eff.effective).toBe(8);
    expect(eff.effective).toBeGreaterThanOrEqual(DEBT_DROWSY);
  });

  it('persisted 7, pending 0 → effective 7 (stays Alert)', () => {
    const state = baseState({ debt: 7, sessions: [] });
    expect(effectiveDebt(state).effective).toBe(7);
  });

  it('persisted 12, pending 1 → effective 14 (crosses into SLEEPY)', () => {
    const state = baseState({ debt: 12, sessions: [session({ score: null })] });
    expect(effectiveDebt(state).effective).toBe(14);
    expect(effectiveDebt(state).effective).toBeGreaterThanOrEqual(DEBT_SLEEPY);
  });

  it('persisted 13, pending 0 → effective 13 (stays Drowsy)', () => {
    const state = baseState({ debt: 13, sessions: [] });
    expect(effectiveDebt(state).effective).toBe(13);
  });

  it('persisted 18, pending 1 → effective 20 (crosses into MUST SLEEP)', () => {
    const state = baseState({ debt: 18, sessions: [session({ score: null })] });
    expect(effectiveDebt(state).effective).toBe(20);
    expect(effectiveDebt(state).effective).toBeGreaterThanOrEqual(DEBT_MUST_SLEEP);
  });

  it('persisted 19, pending 0 → effective 19 (stays Sleepy)', () => {
    const state = baseState({ debt: 19, sessions: [] });
    expect(effectiveDebt(state).effective).toBe(19);
  });
});

describe('effectiveDebt — provisional cap', () => {
  it('6 pending sessions → provisional caps at PENDING_PROVISIONAL_CAP (12)', () => {
    const state = baseState({ debt: 0, sessions: Array.from({ length: 6 }, () => session({ score: null })) });
    expect(effectiveDebt(state).provisional).toBe(PENDING_PROVISIONAL_CAP);
  });

  it('7, 20, and 100 pending sessions all still cap at 12', () => {
    for (const n of [7, 20, 100]) {
      const state = baseState({ debt: 0, sessions: Array.from({ length: n }, () => session({ score: null })) });
      expect(effectiveDebt(state).provisional).toBe(12);
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
  it('non-empty last_assistant_message → floor score 1', () => {
    expect(floorScoreForNeverFlushed('Fixed the bug and shipped it.')).toBe(NEVER_FLUSHED_FLOOR_SCORE);
    expect(floorScoreForNeverFlushed('Fixed the bug and shipped it.')).toBe(1);
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
