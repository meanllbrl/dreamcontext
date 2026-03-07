import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readSleepState, readSleepHistory, SleepState } from '../../src/cli/commands/sleep.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-sleep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** New fields added by neuroscience update, always present in defaults */
const NEW_DEFAULTS = {
  sessions_since_last_sleep: 0,
  bookmarks: [],
  triggers: [],
  knowledge_access: {},
  compaction_log: [],
};

describe('readSleepState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default state when file does not exist', () => {
    const state = readSleepState(tmpDir);
    expect(state).toEqual({
      debt: 0,
      last_sleep: null,
      last_sleep_summary: null,
      sleep_started_at: null,
      sessions: [],
      dashboard_changes: [],
      ...NEW_DEFAULTS,
    });
  });

  it('reads persisted sleep state with sessions', () => {
    const persisted = {
      debt: 5,
      last_sleep: '2026-02-24',
      last_sleep_summary: 'Consolidated auth decisions',
      sessions: [
        {
          session_id: 'sess-2',
          transcript_path: '/tmp/t2.jsonl',
          stopped_at: '2026-02-25T12:00:00.000Z',
          last_assistant_message: 'Refactored auth module',
          change_count: 8,
          score: 2,
        },
        {
          session_id: 'sess-1',
          transcript_path: '/tmp/t1.jsonl',
          stopped_at: '2026-02-25T10:00:00.000Z',
          last_assistant_message: 'Added search endpoint',
          change_count: 5,
          score: 3,
        },
      ],
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(persisted, null, 2));
    const state = readSleepState(tmpDir);
    expect(state).toEqual({ ...persisted, sleep_started_at: null, dashboard_changes: [], ...NEW_DEFAULTS });
  });

  it('returns default state when file is malformed JSON', () => {
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), 'not json at all');
    const state = readSleepState(tmpDir);
    expect(state).toEqual({
      debt: 0,
      last_sleep: null,
      last_sleep_summary: null,
      sleep_started_at: null,
      sessions: [],
      dashboard_changes: [],
      ...NEW_DEFAULTS,
    });
  });

  it('returns default state when file is a JSON array', () => {
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), '[1, 2, 3]');
    const state = readSleepState(tmpDir);
    expect(state).toEqual({
      debt: 0,
      last_sleep: null,
      last_sleep_summary: null,
      sleep_started_at: null,
      sessions: [],
      dashboard_changes: [],
      ...NEW_DEFAULTS,
    });
  });

  it('reads state with empty sessions', () => {
    const minimal = {
      debt: 0,
      last_sleep: null,
      last_sleep_summary: null,
      sessions: [],
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(minimal, null, 2));
    const state = readSleepState(tmpDir);
    expect(state).toEqual({ ...minimal, sleep_started_at: null, dashboard_changes: [], ...NEW_DEFAULTS });
  });

  it('reads state after consolidation (debt 0 with last_sleep set)', () => {
    const postSleep = {
      debt: 0,
      last_sleep: '2026-02-25',
      last_sleep_summary: 'Consolidated everything',
      sessions: [],
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(postSleep, null, 2));
    const state = readSleepState(tmpDir);
    expect(state.debt).toBe(0);
    expect(state.last_sleep).toBe('2026-02-25');
    expect(state.last_sleep_summary).toBe('Consolidated everything');
    expect(state.sessions).toEqual([]);
  });

  it('backward compat: old format with entries/last_session_id gets sessions: []', () => {
    const oldFormat = {
      debt: 3,
      last_sleep: '2026-01-01',
      last_sleep_summary: 'old',
      entries: [{ date: '2026-02-25', score: 1, description: 'test' }],
      last_session_id: 'old-sess',
      last_transcript_path: '/tmp/old.jsonl',
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(oldFormat, null, 2));
    const state = readSleepState(tmpDir);
    expect(state.debt).toBe(3);
    expect(state.sessions).toEqual([]);
    expect(state.last_sleep).toBe('2026-01-01');
  });

  it('reads state with sleep_started_at set', () => {
    const persisted = {
      debt: 5,
      last_sleep: null,
      last_sleep_summary: null,
      sleep_started_at: '2026-02-25T10:00:00.000Z',
      sessions: [],
      dashboard_changes: [],
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(persisted, null, 2));
    const state = readSleepState(tmpDir);
    expect(state.sleep_started_at).toBe('2026-02-25T10:00:00.000Z');
  });

  it('returns sleep_started_at: null for old format without the field', () => {
    const oldFormat = {
      debt: 3,
      last_sleep: '2026-01-01',
      last_sleep_summary: 'old',
      sessions: [],
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(oldFormat, null, 2));
    const state = readSleepState(tmpDir);
    expect(state.sleep_started_at).toBeNull();
  });

  it('handles sessions field set to null gracefully', () => {
    const corrupted = {
      debt: 2,
      last_sleep: null,
      last_sleep_summary: null,
      sessions: null,
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(corrupted, null, 2));
    const state = readSleepState(tmpDir);
    expect(state.sessions).toEqual([]);
  });

  // New field backward compat tests
  it('returns default new fields when file lacks them', () => {
    const oldState = {
      debt: 2,
      last_sleep: null,
      last_sleep_summary: null,
      sleep_started_at: null,
      sessions: [],
      dashboard_changes: [],
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(oldState, null, 2));
    const state = readSleepState(tmpDir);
    expect(state.bookmarks).toEqual([]);
    expect(state.triggers).toEqual([]);
    expect(state.knowledge_access).toEqual({});
    expect(state.sessions_since_last_sleep).toBe(0);
  });

  it('reads persisted bookmarks and triggers', () => {
    const persisted = {
      debt: 0,
      sessions: [],
      bookmarks: [
        { id: 'bm_1', message: 'test', salience: 2, created_at: '2026-02-27T10:00:00Z', session_id: null },
      ],
      triggers: [
        { id: 'trg_1', when: 'auth', remind: 'check rate limits', source: null, created_at: '2026-02-27', fired_count: 0, max_fires: 3 },
      ],
      knowledge_access: { 'jwt-auth': { last_accessed: '2026-02-27', count: 5 } },
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(persisted, null, 2));
    const state = readSleepState(tmpDir);
    expect(state.bookmarks).toHaveLength(1);
    expect(state.bookmarks[0].message).toBe('test');
    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0].when).toBe('auth');
    expect(state.knowledge_access['jwt-auth'].count).toBe(5);
  });

  it('migrates sleep_history from .sleep.json to .sleep-history.json', () => {
    const persisted = {
      debt: 0,
      sessions: [],
      sleep_history: [
        { date: '2026-02-26', summary: 'migrated', debt_before: 5, debt_after: 0, sessions_processed: 3, bookmarks_processed: 2 },
      ],
    };
    writeFileSync(join(tmpDir, 'state', '.sleep.json'), JSON.stringify(persisted, null, 2));

    // Reading triggers migration
    const state = readSleepState(tmpDir);
    expect((state as Record<string, unknown>)['sleep_history']).toBeUndefined();

    // History is now in separate file
    const history = readSleepHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0].summary).toBe('migrated');

    // .sleep.json no longer has sleep_history
    const raw = JSON.parse(require('node:fs').readFileSync(join(tmpDir, 'state', '.sleep.json'), 'utf-8'));
    expect(raw.sleep_history).toBeUndefined();
  });
});
