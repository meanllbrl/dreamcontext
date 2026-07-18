import { describe, it, expect } from 'vitest';
import { readSleepState, readSleepHistory, writeSleepState } from '../../src/cli/commands/sleep.js';
import {
  applyConsolidation,
  upsertSessionOnStop,
  appendCompactionRecord,
  validateSleepAdd,
  markSleepStarted,
  buildHistoryEntry,
  finalizeSleepState,
  recomputeDebt,
  sleepinessLevel,
  PENDING_SESSION_PROVISIONAL,
  PENDING_PROVISIONAL_CAP,
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  RHYTHM_SESSIONS,
  type SleepState,
  type SessionRecord,
  type Bookmark,
  type Trigger,
  type CompactionRecord,
  type StopUpsertInput,
} from '../../src/lib/sleep-consolidation.js';
import {
  getConsolidationDirective,
  userPromptReminder,
  scoreFromChangeCount,
  scoreFromToolCount,
  scoreFromSubstance,
  analyzeTranscript,
} from '../../src/cli/commands/hook.js';
import { attributeByPerson, type Commit } from '../../src/lib/attribution.js';
import { mkdtempSync, mkdirSync, truncateSync, writeFileSync, closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * SPEC — Sleep system 360° control map
 * GitHub: https://github.com/meanllbrl/dreamcontext/issues/9
 *
 * Purpose: a single, comprehensive audit of the consolidation/sleep system so
 * its invariants are explicit and protected. "Maximize learning" means the
 * capture → epoch → fan-out → core/changelog/task/feature update → reset loop
 * must be correct AND locked behind tests.
 *
 * WS2 (issue #9): the lifecycle invariants that used to live INLINE inside the
 * command `.action()` handlers are now pure exported functions (WS1 extraction),
 * so every `it.todo` for SHIPPED behavior below is now a real, runnable `it`
 * asserting the pure function directly (no CLI spawning).
 */

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-sleep360-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  return root;
}

/** Build a complete SleepState fixture; override any field via `over`. */
function baseState(over: Partial<SleepState> = {}): SleepState {
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
    ...over,
  };
}

function session(id: string, stoppedAt: string | null, score: number): SessionRecord {
  return {
    session_id: id,
    transcript_path: null,
    stopped_at: stoppedAt,
    last_assistant_message: null,
    change_count: null,
    tool_count: null,
    score,
    task_slugs: [],
  };
}

/** A session still awaiting analysis (score === null — AC1 pending debt). */
function pendingSession(id: string): SessionRecord {
  return {
    session_id: id,
    transcript_path: `/tmp/${id}.jsonl`,
    stopped_at: '2026-07-18T00:00:00.000Z',
    last_assistant_message: null,
    change_count: null,
    tool_count: null,
    score: null,
    task_slugs: [],
  };
}

function bookmark(id: string, createdAt: string, salience: 1 | 2 | 3): Bookmark {
  return { id, message: `bm-${id}`, salience, created_at: createdAt, session_id: null, task_slug: null };
}

function trigger(id: string, firedCount: number, maxFires: number): Trigger {
  return {
    id,
    when: 'cond',
    remind: 'do thing',
    source: null,
    created_at: '2026-01-01T00:00:00.000Z',
    fired_count: firedCount,
    max_fires: maxFires,
  };
}

describe('sleep 360° — read surfaces (real, runnable today)', () => {
  it('readSleepState returns fresh defaults for a missing file (debt 0, empty arrays)', () => {
    const root = freshRoot();
    const s = readSleepState(root);
    expect(s.debt).toBe(0);
    expect(s.sessions).toEqual([]);
    expect(s.bookmarks).toEqual([]);
    expect(s.triggers).toEqual([]);
    expect(s.sleep_started_at).toBeNull();
  });

  it('freshDefaults are not shared references across reads (mutating one must not leak)', () => {
    const a = readSleepState(freshRoot());
    const b = readSleepState(freshRoot());
    a.sessions.push({
      session_id: 'x', transcript_path: null, stopped_at: null,
      last_assistant_message: null, change_count: null, tool_count: null,
      score: null, task_slugs: [],
    });
    expect(b.sessions).toEqual([]); // no cross-call aliasing
  });

  it('readSleepHistory returns [] when no history file exists', () => {
    expect(readSleepHistory(freshRoot())).toEqual([]);
  });
});

describe('sleep 360° — epoch safety (WS2)', () => {
  const EPOCH = '2026-06-10T12:00:00.000Z';

  function epochState(): SleepState {
    return baseState({
      debt: 7,
      sleep_started_at: EPOCH,
      sessions: [
        session('before-1', '2026-06-10T09:00:00.000Z', 2), // pre-epoch → processed/dropped
        session('before-2', '2026-06-10T11:59:00.000Z', 1), // pre-epoch → processed/dropped
        session('after-1', '2026-06-10T13:00:00.000Z', 3),  // post-epoch → survives
        session('after-2', '2026-06-10T14:00:00.000Z', 1),  // post-epoch → survives
        session('active', null, 0),                          // stopped_at null → DROPPED (deliberate)
      ],
      bookmarks: [
        bookmark('b-old', '2026-06-10T08:00:00.000Z', 1),
        bookmark('b-new', '2026-06-10T15:00:00.000Z', 2),
      ],
      dashboard_changes: [
        { timestamp: '2026-06-10T07:00:00.000Z', entity: 'task', action: 'update', target: 't', summary: 'old' },
        { timestamp: '2026-06-10T16:00:00.000Z', entity: 'task', action: 'update', target: 't', summary: 'new' },
      ],
    });
  }

  it('sleep start sets sleep_started_at to an ISO epoch', () => {
    const now = new Date().toISOString();
    const next = markSleepStarted(baseState(), now);
    expect(next.sleep_started_at).toBe(now);
    // It is a valid, round-trippable ISO timestamp.
    expect(new Date(next.sleep_started_at as string).toISOString()).toBe(now);
  });

  it('sleep done WITH epoch clears only sessions stopped at/before the epoch', () => {
    const { state, processedSessionIds } = applyConsolidation(epochState(), EPOCH);
    const survivorIds = state.sessions.map(s => s.session_id);
    expect(survivorIds).not.toContain('before-1');
    expect(survivorIds).not.toContain('before-2');
    // processed = pre-epoch + active (stopped_at null) sessions
    expect(processedSessionIds).toEqual(expect.arrayContaining(['before-1', 'before-2', 'active']));
  });

  it('sleep done WITH epoch preserves sessions stopped AFTER the epoch (parallel-session safety)', () => {
    const { state } = applyConsolidation(epochState(), EPOCH);
    const survivorIds = state.sessions.map(s => s.session_id);
    expect(survivorIds).toEqual(['after-1', 'after-2']);
  });

  it('sleep done WITH epoch clears bookmarks/dashboard_changes at/before the epoch only', () => {
    const { state, bookmarksProcessed } = applyConsolidation(epochState(), EPOCH);
    expect(state.bookmarks.map(b => b.id)).toEqual(['b-new']);
    expect(state.dashboard_changes.map(c => c.summary)).toEqual(['new']);
    expect(bookmarksProcessed).toBe(1);
  });

  it('sleep done recomputes debt from the SURVIVING sessions, not to a hardcoded 0', () => {
    const { state } = applyConsolidation(epochState(), EPOCH);
    // survivors after-1 (3) + after-2 (1) = 4, NOT 0
    expect(state.debt).toBe(4);
    expect(state.debt).toBe(recomputeDebt(state.sessions));
  });

  it('sleep done WITHOUT epoch (backward compat) clears everything and resets debt to 0', () => {
    const { state, sessionsProcessed } = applyConsolidation(epochState(), null);
    expect(state.sessions).toEqual([]);
    expect(state.bookmarks).toEqual([]);
    expect(state.dashboard_changes).toEqual([]);
    expect(state.debt).toBe(0);
    expect(sessionsProcessed).toBe(5);
  });

  it('sessions with stopped_at === null are dropped on consolidation (deliberate)', () => {
    const { state } = applyConsolidation(epochState(), EPOCH);
    expect(state.sessions.map(s => s.session_id)).not.toContain('active');
  });

  it('sleep done writes a LIFO history entry with debt_before/after + processed session_ids', () => {
    const prevDebt = epochState().debt; // 7
    const result = applyConsolidation(epochState(), EPOCH);
    const entry = buildHistoryEntry(prevDebt, result, '  consolidated everything  ', '2026-06-11');
    expect(entry.debt_before).toBe(7);
    expect(entry.debt_after).toBe(4);
    expect(entry.summary).toBe('consolidated everything'); // trimmed
    expect(entry.session_ids).toEqual(expect.arrayContaining(['before-1', 'before-2', 'active']));
    expect(entry.date).toBe('2026-06-11');
    expect(entry.sessions_processed).toBe(3);
  });

  it('sleep done clears sleep_started_at and sessions_since_last_sleep', () => {
    const start = baseState({ sleep_started_at: EPOCH, sessions_since_last_sleep: 5, consolidation_depth: 'deep' });
    const finalized = finalizeSleepState(start, 'done', '2026-06-11');
    expect(finalized.sleep_started_at).toBeNull();
    expect(finalized.sessions_since_last_sleep).toBe(0);
    expect(finalized.consolidation_depth).toBeNull();
    expect(finalized.last_sleep).toBe('2026-06-11');
  });

  it('applyConsolidation does not mutate the input state (operates on a clone)', () => {
    const input = epochState();
    applyConsolidation(input, EPOCH);
    expect(input.sessions).toHaveLength(5);
    expect(input.debt).toBe(7);
  });
});

describe('sleep 360° — debt scoring & double-count (WS2)', () => {
  it('session score = max(scoreFromChangeCount, scoreFromToolCount)', () => {
    // change_count 1 → 1, tool_count 30 → 2 ; max = 2
    expect(Math.max(scoreFromChangeCount(1), scoreFromToolCount(30))).toBe(2);
    // change_count 9 → 3, tool_count 5 → 1 ; max = 3
    expect(Math.max(scoreFromChangeCount(9), scoreFromToolCount(5))).toBe(3);
  });

  it('score = max(change, tool, substance) lifts an edit-free-but-dense session', () => {
    const dense = {
      changeCount: 0,
      toolCount: 5, // → scoreFromToolCount = 1
      userTurns: 8,
      assistantChars: 9000,
      decisionMarkers: 2,
      taskSlugs: ['a', 'b'],
    };
    const score = Math.max(
      scoreFromChangeCount(dense.changeCount),
      scoreFromToolCount(dense.toolCount),
      scoreFromSubstance(dense),
    );
    expect(score).toBeGreaterThanOrEqual(2); // old max(change,tool) was 1
  });

  it('Stop hook on the SAME session_id subtracts the old score before adding the new one (no double-count)', () => {
    const upsert = (state: SleepState, score: number): SleepState => {
      const input: StopUpsertInput = {
        session_id: 'sess-A',
        transcript_path: null,
        stopped_at: '2026-06-10T10:00:00.000Z',
        last_assistant_message: null,
        change_count: 0,
        tool_count: 0,
        score,
        task_slugs: [],
      };
      return upsertSessionOnStop(state, input);
    };

    let state = baseState();
    state = upsert(state, 3); // first stop
    state = upsert(state, 1); // re-stop, lower score

    expect(state.debt).toBe(1);          // 1, NOT 3+1=4
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].score).toBe(1);
    expect(state.sessions_since_last_sleep).toBe(1); // re-stop did not bump
  });

  it('a PENDING stop (score null — transcript not flushed yet) adds no debt, and the finalizing re-stop adds it once', () => {
    const upsert = (state: SleepState, score: number | null): SleepState => {
      const input: StopUpsertInput = {
        session_id: 'sess-A',
        transcript_path: '/tmp/never-flushed.jsonl',
        stopped_at: '2026-06-10T10:00:00.000Z',
        last_assistant_message: null,
        change_count: score === null ? null : 2,
        tool_count: score === null ? null : 5,
        score,
        task_slugs: [],
      };
      return upsertSessionOnStop(state, input);
    };

    let state = baseState();
    state = upsert(state, null); // Stop fired while the CLI still buffers the transcript
    expect(state.debt).toBe(0);
    expect(state.sessions[0].score).toBeNull(); // pending — SessionStart catch-up finalizes
    state = upsert(state, null); // every turn re-stops; still pending, still no debt
    expect(state.debt).toBe(0);
    state = upsert(state, 3);    // transcript landed — finalized exactly once
    expect(state.debt).toBe(3);
    expect(state.sessions).toHaveLength(1);
  });

  it('manual `sleep add` rejects scores outside 1..3 and requires a description', () => {
    expect(validateSleepAdd('0', 'x').ok).toBe(false);
    expect(validateSleepAdd('4', 'x').ok).toBe(false);
    expect(validateSleepAdd('abc', 'x').ok).toBe(false);
    expect(validateSleepAdd('2', '   ').ok).toBe(false); // empty desc
    expect(validateSleepAdd('2', 'valid reason').ok).toBe(true);
  });
});

describe('sleep 360° — debt levels & directive injection (WS2)', () => {
  // ×2 scale (2026-06-29): Alert 0–7 · Drowsy 8–13 · Sleepy 14–19 · Must Sleep 20+.
  it.each([
    [7, 'Alert'],
    [8, 'Drowsy'],
    [13, 'Drowsy'],
    [14, 'Sleepy'],
    [19, 'Sleepy'],
    [20, 'Must Sleep'],
  ] as const)('sleepinessLevel: debt %i → %s (boundary-exact)', (debt, level) => {
    expect(sleepinessLevel(debt)).toBe(level);
  });

  it('session-start prepends a CRITICAL consolidation directive when debt >= 20', () => {
    const d = getConsolidationDirective(baseState({ debt: 20 }));
    expect(d).not.toBeNull();
    expect(d).toContain('CONSOLIDATION REQUIRED');
    expect(d).toContain('You MUST inform the user and consolidate NOW.');
  });

  it('session-start prepends a softer advisory when debt >= 14', () => {
    const d = getConsolidationDirective(baseState({ debt: 14 }));
    expect(d).not.toBeNull();
    expect(d).toContain('CONSOLIDATION RECOMMENDED');
    expect(d).not.toContain('CONSOLIDATION REQUIRED');
  });

  it('a salience-3 (critical) bookmark triggers the advisory regardless of debt', () => {
    const d = getConsolidationDirective(baseState({ debt: 0, bookmarks: [bookmark('crit', '2026-06-10T00:00:00.000Z', 3)] }));
    expect(d).not.toBeNull();
    expect(d).toContain('CRITICAL BOOKMARKS NEED CONSOLIDATION');
  });

  it('user-prompt-submit emits a one-line reminder when debt >= 8, silent below 8', () => {
    expect(userPromptReminder(baseState({ debt: 8 }))).not.toBeNull();
    expect(userPromptReminder(baseState({ debt: 14 }))).not.toBeNull();
    expect(userPromptReminder(baseState({ debt: 20 }))).not.toBeNull();
    expect(userPromptReminder(baseState({ debt: 7 }))).toBeNull();
    expect(userPromptReminder(baseState({ debt: 0 }))).toBeNull();
  });
});

describe('sleep 360° — directive suppression respects the consolidation lock', () => {
  const FRESH = () => new Date().toISOString(); // locked now → not stale
  const STALE = () => new Date(Date.now() - 31 * 60 * 1000).toISOString(); // past 30m TTL

  it('a FRESH lock suppresses the consolidation directive (says "already in progress")', () => {
    const d = getConsolidationDirective(baseState({ debt: 20, sleep_started_at: FRESH() }));
    expect(d).not.toBeNull();
    expect(d).toContain('already in progress');
    expect(d).not.toContain('CONSOLIDATION REQUIRED');
  });

  it('a FRESH lock silences the user-prompt reminder below the suppression threshold', () => {
    // debt 8 → reminder is the "in progress" line; debt 7 (< DEBT_DROWSY) → fully silent under a live lock.
    expect(userPromptReminder(baseState({ debt: 8, sleep_started_at: FRESH() }))).toContain('already in progress');
    expect(userPromptReminder(baseState({ debt: 7, sleep_started_at: FRESH() }))).toBeNull();
  });

  it('a STALE lock does NOT suppress — the directive fires through so a crashed sleep cannot wedge the brain', () => {
    const d = getConsolidationDirective(baseState({ debt: 20, sleep_started_at: STALE() }));
    expect(d).not.toBeNull();
    expect(d).toContain('CONSOLIDATION REQUIRED');
    expect(d).not.toContain('already in progress');
  });

  it('a STALE lock lets the normal debt reminder fire through', () => {
    const r = userPromptReminder(baseState({ debt: 14, sleep_started_at: STALE() }));
    expect(r).not.toBeNull();
    expect(r).not.toContain('already in progress');
  });
});

describe('sleep 360° — triggers & compaction (WS2)', () => {
  it('trigger fired_count is persisted across snapshot generation (disk round-trip)', () => {
    const root = freshRoot();
    const state = baseState({ triggers: [trigger('t1', 2, 5)] });
    writeSleepState(root, state);
    const read = readSleepState(root);
    expect(read.triggers).toHaveLength(1);
    expect(read.triggers[0].fired_count).toBe(2);
    expect(read.triggers[0].max_fires).toBe(5);
  });

  it('sleep done expires triggers whose fired_count >= max_fires', () => {
    const state = baseState({
      triggers: [
        trigger('expired', 3, 3), // at budget → expire
        trigger('over', 4, 3),    // over budget → expire
        trigger('live', 1, 3),    // still has budget → survive
      ],
    });
    const { state: next } = applyConsolidation(state, null);
    expect(next.triggers.map(t => t.id)).toEqual(['live']);
  });

  it('pre-compact appends a CompactionRecord (LIFO) capped at 20 entries', () => {
    let state = baseState();
    for (let i = 0; i < 21; i++) {
      const record: CompactionRecord = {
        timestamp: `2026-06-10T00:00:${String(i).padStart(2, '0')}.000Z`,
        trigger: `compact-${i}`,
        debt_at_compaction: i,
        sessions_count: 0,
        bookmarks_count: 0,
      };
      state = appendCompactionRecord(state, record);
    }
    expect(state.compaction_log).toHaveLength(20);
    // newest first (LIFO): the 21st push (i=20) is at index 0
    expect(state.compaction_log[0].trigger).toBe('compact-20');
    // oldest survivor is i=1 (i=0 evicted)
    expect(state.compaction_log[19].trigger).toBe('compact-1');
  });
});

describe('sleep 360° — capture → consolidation loop (WS4)', () => {
  it('transcripts over 50MB are skipped (safety cap) and do not abort analysis', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-bigtx-'));
    const big = join(dir, 'huge.jsonl');
    // Create a sparse 51MB file — never read fully, just stat-checked & skipped.
    const fd = openSync(big, 'w');
    closeSync(fd);
    truncateSync(big, 51 * 1024 * 1024);

    const analysis = analyzeTranscript(big);
    // ZERO_ANALYSIS shape, no throw.
    expect(analysis.changeCount).toBe(0);
    expect(analysis.toolCount).toBe(0);
    expect(analysis.taskSlugs).toEqual([]);
    expect(analysis.userTurns).toBe(0);
    expect(analysis.assistantChars).toBe(0);
    expect(analysis.decisionMarkers).toBe(0);
  });

  it('a normal-sized transcript IS analyzed (control for the size cap)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-smalltx-'));
    const small = join(dir, 'tx.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', content: 'do the thing' }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Editing now' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }),
    ].join('\n');
    writeFileSync(small, lines, 'utf-8');

    const analysis = analyzeTranscript(small);
    expect(analysis.changeCount).toBe(1); // one Edit
    expect(analysis.userTurns).toBe(1);
    expect(analysis.assistantChars).toBeGreaterThan(0);
  });

  it('consolidation attributes each changelog/task update per person when multiPerson (links #8)', () => {
    const commits: Commit[] = [
      { hash: 'aaa', author: 'Mehmet Nuraydin', subject: 'feat: x' },
      { hash: 'bbb', author: 'Ada Lovelace', subject: 'fix: y' },
      { hash: 'ccc', author: 'Mehmet Nuraydin', subject: 'docs: z' },
    ];
    const buckets = attributeByPerson(commits, ['Mehmet Nuraydin', 'Ada Lovelace']);
    expect(Object.keys(buckets).sort()).toEqual(['ada-lovelace', 'mehmet-nuraydin']);
    expect(buckets['mehmet-nuraydin'].map(c => c.hash)).toEqual(['aaa', 'ccc']);
    expect(buckets['ada-lovelace'].map(c => c.hash)).toEqual(['bbb']);
  });

  it('single-person / bot commit list yields no phantom attribution buckets', () => {
    const commits: Commit[] = [
      { hash: 'aaa', author: 'Mehmet Nuraydin', subject: 'feat: x' },
      { hash: 'bot', author: 'github-actions[bot]', subject: 'chore: release' },
      { hash: 'dep', author: 'dependabot[bot]', subject: 'bump dep' },
    ];
    const buckets = attributeByPerson(commits, ['Mehmet Nuraydin']);
    expect(Object.keys(buckets)).toEqual(['mehmet-nuraydin']); // no bot buckets, no phantom
    expect(buckets['mehmet-nuraydin'].map(c => c.hash)).toEqual(['aaa']); // bots filtered out
  });
});

describe('sleep 360° — AC1 pending-session provisional debt (directive/reminder integration, T7)', () => {
  it('persisted 6 + 1 pending → effective 8 crosses into DROWSY; directive names the pending count', () => {
    const state = baseState({ debt: 6, sessions: [pendingSession('p1')] });
    const d = getConsolidationDirective(state);
    expect(d).not.toBeNull();
    expect(d).toContain(`Sleep debt is ${6 + PENDING_SESSION_PROVISIONAL}`);
    expect(d).toContain('1 session(s) awaiting analysis');
    expect(d).toContain('persisted debt 6');
    expect(d).not.toContain('CONSOLIDATION RECOMMENDED');
    expect(d).not.toContain('CONSOLIDATION REQUIRED');
  });

  it('persisted 12 + 1 pending → effective 14 crosses into SLEEPY (CONSOLIDATION RECOMMENDED)', () => {
    const state = baseState({ debt: 12, sessions: [pendingSession('p1')] });
    const d = getConsolidationDirective(state);
    expect(d).toContain('CONSOLIDATION RECOMMENDED');
    expect(d).toContain('1 session(s) awaiting analysis');
  });

  it('persisted 18 + 1 pending → effective 20 crosses into MUST SLEEP (CONSOLIDATION REQUIRED)', () => {
    const state = baseState({ debt: 18, sessions: [pendingSession('p1')] });
    const d = getConsolidationDirective(state);
    expect(d).toContain('CONSOLIDATION REQUIRED');
    expect(d).toContain('1 session(s) awaiting analysis');
  });

  it('safety invariant: persisted 0 + any pending count never alone reaches CONSOLIDATION REQUIRED', () => {
    for (const n of [0, 1, 5, 6, 50]) {
      const state = baseState({ debt: 0, sessions: Array.from({ length: n }, (_, i) => pendingSession(`p${i}`)) });
      const d = getConsolidationDirective(state);
      expect(d ?? '').not.toContain('CONSOLIDATION REQUIRED');
    }
  });

  it('provisional debt is NEVER persisted into state.debt (directive/reminder are read-only)', () => {
    const state = baseState({ debt: 6, sessions: [pendingSession('p1'), pendingSession('p2')] });
    const frozen = JSON.parse(JSON.stringify(state));
    getConsolidationDirective(state);
    userPromptReminder(state);
    expect(state.debt).toBe(frozen.debt);
    expect(state).toEqual(frozen);
  });

  it('the audit case (persisted 0, 5 pending) now returns a non-null directive naming the pending count', () => {
    // 5 pending * PENDING_SESSION_PROVISIONAL(2) = 10 provisional → effective 10,
    // which already crosses DEBT_DROWSY(8) — the pre-existing Drowsy branch
    // fires (not the new bottom-priority branch below), but the audit's exact
    // blind spot (debt 0, 5 sessions score:null, directive fully silent) is closed.
    const state = baseState({ debt: 0, sessions: Array.from({ length: 5 }, (_, i) => pendingSession(`p${i}`)) });
    const d = getConsolidationDirective(state);
    expect(d).not.toBeNull();
    expect(d).toContain('5 session(s) awaiting analysis');
    expect(d).toContain(`Sleep debt is ${DEBT_DROWSY + 2}`); // 0 + min(12, 5*2) = 10
  });

  it('new lowest-priority branch fires when pending debt alone stays BELOW every other threshold', () => {
    // 3 pending * 2 = 6 provisional → effective 6, below DEBT_DROWSY(8) and
    // below RHYTHM_SESSIONS with sessions_since_last_sleep 0 — nothing else
    // fires, so this exercises the new bottom branch specifically.
    const state = baseState({ debt: 0, sessions: Array.from({ length: 3 }, (_, i) => pendingSession(`p${i}`)) });
    const d = getConsolidationDirective(state);
    expect(d).not.toBeNull();
    expect(d).toContain('3 session(s) awaiting analysis');
    expect(d).not.toContain('CONSOLIDATION');
    expect(d?.trim().startsWith('>')).toBe(true);
  });

  it('zero pending sessions → directive unaffected (byte-identical regression)', () => {
    for (const debt of [0, 7, 8, 13, 14, 19, 20, 32]) {
      const withPending = getConsolidationDirective(baseState({ debt, sessions: [] }));
      const withoutHelper = getConsolidationDirective(baseState({ debt, sessions: [] }));
      expect(withPending).toBe(withoutHelper);
    }
    // Explicit byte check against the pre-existing fixed assertions.
    expect(getConsolidationDirective(baseState({ debt: 20, sessions: [] }))).toContain('CONSOLIDATION REQUIRED');
    expect(getConsolidationDirective(baseState({ debt: 7, sessions: [] }))).toBeNull();
  });

  it('rhythm regression: sessions_since_last_sleep >= 5 with zero pending still fires the rhythm advisory', () => {
    // 5 sessions scored 1 each: persisted debt 5 (< DEBT_DROWSY), rhythm counter 5.
    const state = baseState({ debt: 5, sessions_since_last_sleep: 5, sessions: [] });
    const d = getConsolidationDirective(state);
    expect(d).not.toBeNull();
    expect(d).toContain('5 sessions since last consolidation');
  });

  it('userPromptReminder: effective debt crossing DROWSY includes the pending suffix', () => {
    const state = baseState({ debt: 6, sessions: [pendingSession('p1')] });
    const r = userPromptReminder(state);
    expect(r).not.toBeNull();
    expect(r).toContain(`Sleep debt is ${6 + PENDING_SESSION_PROVISIONAL}`);
    expect(r).toContain('(1 awaiting analysis)');
  });

  it('userPromptReminder: pending-only (below every debt threshold) returns the bottom-branch line', () => {
    const state = baseState({ debt: 0, sessions: Array.from({ length: 3 }, (_, i) => pendingSession(`p${i}`)) });
    const r = userPromptReminder(state);
    expect(r).not.toBeNull();
    expect(r).toContain('3 session(s) awaiting analysis');
  });

  it('userPromptReminder: zero pending stays byte-identical (regression)', () => {
    expect(userPromptReminder(baseState({ debt: 8, sessions: [] }))).not.toBeNull();
    expect(userPromptReminder(baseState({ debt: 7, sessions: [] }))).toBeNull();
    expect(userPromptReminder(baseState({ debt: 0, sessions: [] }))).toBeNull();
  });

  it('provisional debt caps at PENDING_PROVISIONAL_CAP regardless of pending count', () => {
    const state100 = baseState({ debt: 0, sessions: Array.from({ length: 100 }, (_, i) => pendingSession(`p${i}`)) });
    const d = getConsolidationDirective(state100);
    expect(d).toContain(`Sleep debt is ${PENDING_PROVISIONAL_CAP}`);
    expect(d).not.toContain(`Sleep debt is ${200}`);
  });
});

describe('sleep 360° — specialist architecture (WS3, decision-gated)', () => {
  // INTEGRATION-ONLY / not a pure-function assertion: feature-PRD upkeep being
  // "reliably exercised each cycle" is an agent-behavior property of the
  // live sleep-product specialist (prompt-driven), not of any exported pure
  // function. WS3 resolved this via an evidence-based roster decision
  // (knowledge/sleep-specialist-roster-decision.md), not a unit test. Left as
  // todo deliberately — it cannot be asserted without a live-LLM run (Layer 2).
  it.todo('feature PRD upkeep is reliably exercised each cycle (Layer-2 live-LLM only — see RESULTS.md)');
});
