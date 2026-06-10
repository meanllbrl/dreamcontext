import { describe, it, expect } from 'vitest';
import { readSleepState, readSleepHistory } from '../../src/cli/commands/sleep.js';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
 * Coverage reality (audited 2026-06-09):
 *   ALREADY COVERED (do not duplicate — referenced here for the full map):
 *     - debt scoring (scoreFromChangeCount / scoreFromToolCount / max) ...... tests/unit/hook.test.ts
 *     - transcript analysis + task-slug extraction .......................... tests/unit/hook.test.ts
 *     - readSleepState defaults/malformed + history migration ............... tests/unit/sleep-state.test.ts
 *     - sleep history LIFO persistence ..................................... tests/unit/sleep-history.test.ts
 *     - auto-salience (EN/TR corrections, error→fix, decisions, cap) ....... tests/unit/salience.test.ts
 *     - session digests + capture rank-penalty + K=50 cap ................. tests/unit/session-digest.test.ts
 *     - transcript distillation (filters, since-timestamp) ................. tests/unit/transcript-distill.test.ts
 *     - reflection pattern extraction ...................................... tests/unit/reflection.test.ts
 *
 *   NOT COVERED (the gap this spec pins). The critical lifecycle invariants
 *   live INLINE inside command `.action()` handlers (src/cli/commands/sleep.ts)
 *   and private helpers, so they are not unit-testable today. Issue #9 / WS1
 *   extracts pure exported functions; each `it.todo` below becomes a real `it`
 *   once that lands:
 *     - applyConsolidation(state, epoch)  ← inline in `sleep done` (sleep.ts:356-431)
 *     - sleepinessLevel(debt)             ← private getSleepinessLevel (sleep.ts:232-244)
 *     - recomputeDebt(sessions)           ← inline `sessions.reduce(...)` (sleep.ts:390)
 *     - re-stop dedupe                    ← Stop hook (hook.ts)
 *     - directive injection thresholds    ← session-start / user-prompt-submit (hook.ts)
 */

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-sleep360-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  return root;
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

describe('sleep 360° — epoch safety (WS2, needs WS1 extraction)', () => {
  it.todo('sleep start sets sleep_started_at to an ISO epoch');
  it.todo('sleep done WITH epoch clears only sessions stopped at/before the epoch');
  it.todo('sleep done WITH epoch preserves sessions stopped AFTER the epoch (parallel-session safety)');
  it.todo('sleep done WITH epoch clears bookmarks/dashboard_changes at/before the epoch only');
  it.todo('sleep done recomputes debt from the SURVIVING sessions, not to a hardcoded 0');
  it.todo('sleep done WITHOUT epoch (backward compat) clears everything and resets debt to 0');
  it.todo('sleep done writes a LIFO history entry with debt_before/after + processed session_ids');
  it.todo('sleep done clears sleep_started_at and sessions_since_last_sleep');
});

describe('sleep 360° — debt scoring & double-count (WS2)', () => {
  it.todo('session score = max(scoreFromChangeCount, scoreFromToolCount)');
  it.todo('Stop hook on the SAME session_id subtracts the old score before adding the new one (no double-count)');
  it.todo('manual `sleep add` rejects scores outside 1..3 and requires a description');
});

describe('sleep 360° — debt levels & directive injection (WS2)', () => {
  it.todo('sleepinessLevel: 0-3 Alert, 4-6 Drowsy, 7-9 Sleepy, 10+ Must Sleep (boundary-exact)');
  it.todo('session-start prepends a CRITICAL consolidation directive when debt >= 10');
  it.todo('session-start prepends a softer advisory when debt >= 7');
  it.todo('user-prompt-submit emits a one-line reminder when debt >= 4, silent below 4');
  it.todo('a salience-3 (critical) bookmark triggers the advisory regardless of debt');
});

describe('sleep 360° — triggers & compaction (WS2)', () => {
  it.todo('trigger fired_count is persisted across snapshot generation');
  it.todo('sleep done expires triggers whose fired_count >= max_fires');
  it.todo('pre-compact appends a CompactionRecord (LIFO) capped at 20 entries');
});

describe('sleep 360° — capture → consolidation loop (WS4)', () => {
  it.todo('auto-captured digests/bookmarks from undigested sessions are consumed by the next consolidation');
  it.todo('transcripts over 50MB are skipped (safety cap) and do not abort analysis');
  it.todo('consolidation attributes each changelog/task update per person when multiPerson (links #8)');
});

describe('sleep 360° — specialist architecture (WS3, decision-gated)', () => {
  it.todo('feature PRD upkeep is reliably exercised each cycle (decide: keep sleep-product or add a feature pass)');
});
