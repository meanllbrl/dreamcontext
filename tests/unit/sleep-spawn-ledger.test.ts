import { describe, it, expect } from 'vitest';
import { upsertSessionOnStop, type SleepState, type StopUpsertInput } from '../../src/lib/sleep-consolidation.js';
import type { SpawnMarker } from '../../src/lib/session-origin.js';

/**
 * A spawned session (builder, automation run, background sleep, nested claude -p) is recorded
 * for task linkage but carries no debt: the invariant lives in upsertSessionOnStop so no caller
 * can get it wrong.
 */

const BUILDER: SpawnMarker = { by: 'develop', via: 'env' };

function state(overrides: Partial<SleepState> = {}): SleepState {
  return {
    debt: 0,
    last_sleep: null,
    last_sleep_summary: null,
    sleep_started_at: null,
    last_consolidated_at: null,
    sessions_since_last_sleep: 0,
    sessions: [],
    bookmarks: [],
    triggers: [],
    knowledge_access: {},
    dashboard_changes: [],
    compaction_log: [],
    recall_mode: null,
    consolidation_depth: null,
    pendingMigrationNotices: [],
    ...overrides,
  } as SleepState;
}

function stop(id: string, score: number | null, extra: Partial<StopUpsertInput> = {}): StopUpsertInput {
  return {
    session_id: id,
    transcript_path: `/tmp/${id}.jsonl`,
    stopped_at: '2026-09-29T12:00:00.000Z',
    last_assistant_message: 'done',
    change_count: 5,
    tool_count: 20,
    score,
    task_slugs: ['demo-task'],
    ...extra,
  };
}

describe('upsertSessionOnStop: spawned sessions carry no debt', () => {
  it('a new spawned session is recorded with score 0, its marker and slugs, and no rhythm bump', () => {
    const next = upsertSessionOnStop(state({ debt: 10, sessions_since_last_sleep: 3 }), stop('b1', 6, { spawn: BUILDER }));
    expect(next.debt).toBe(10);
    expect(next.sessions_since_last_sleep).toBe(3);
    expect(next.sessions[0]).toMatchObject({ session_id: 'b1', score: 0, spawn: BUILDER, task_slugs: ['demo-task'], change_count: 5 });
  });

  it('a spawned session whose transcript was not on disk is never pending', () => {
    const next = upsertSessionOnStop(state(), stop('b1', null, { change_count: null, tool_count: null, spawn: BUILDER }));
    expect(next.sessions[0].score).toBe(0);
  });

  it('the marker is sticky: a later Stop that cannot resolve it still scores 0', () => {
    let s = upsertSessionOnStop(state(), stop('b1', 5, { spawn: BUILDER }));
    s = upsertSessionOnStop(s, stop('b1', 7));
    expect(s.debt).toBe(0);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ score: 0, spawn: BUILDER });
  });

  it('a record that turns out spawned drops the debt it had carried', () => {
    let s = upsertSessionOnStop(state(), stop('b1', 5));
    expect(s.debt).toBe(5);
    s = upsertSessionOnStop(s, stop('b1', 6, { spawn: { by: 'goal-skill', via: 'goal-live' } }));
    expect(s.debt).toBe(0);
    expect(s.sessions_since_last_sleep).toBe(1);
    expect(s.sessions[0].spawn).toEqual({ by: 'goal-skill', via: 'goal-live' });
  });

  it('human sessions are unchanged: score counts, rhythm bumps, no spawn field', () => {
    let s = upsertSessionOnStop(state(), stop('h1', 4));
    s = upsertSessionOnStop(s, stop('b1', 9, { spawn: BUILDER }));
    s = upsertSessionOnStop(s, stop('h1', 5));
    expect(s.debt).toBe(5);
    expect(s.sessions_since_last_sleep).toBe(1);
    const human = s.sessions.find(x => x.session_id === 'h1')!;
    expect(human.score).toBe(5);
    expect('spawn' in human).toBe(false);
  });

  it('does not mutate its input', () => {
    const before = state();
    upsertSessionOnStop(before, stop('b1', 5, { spawn: BUILDER }));
    expect(before.sessions).toHaveLength(0);
  });
});
