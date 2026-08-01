import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  logPoints,
  scoreSession,
  scoreFromSubstanceV2,
  mergeAnalyses,
  analyzeSession,
  analyzeTranscript,
  SCORE_AXES,
} from '../../src/cli/commands/hook.js';
import { resolveTranscript } from '../../src/lib/transcript-locate.js';
import { migration0230 } from '../../src/migrations/0.23.0.js';
import { REGISTRY } from '../../src/migrations/index.js';
import {
  SESSION_SCORE_MAX,
  SCORING_VERSION,
  LEGACY_SCORE_RESCALE,
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  DEBT_DEEP_AUTHORITY,
  sleepinessLevel,
  consolidationDepth,
  rescaleLegacySessions,
  validateSleepAdd,
  upsertSessionOnStop,
  recomputeDebt,
  type SleepState,
  type SessionRecord,
} from '../../src/lib/sleep-consolidation.js';

/**
 * Weighted session scoring (2026-07-29 rescale). The scorer this replaces
 * composed three saturating 0–3 buckets with max(); measured over 395 real
 * transcripts, 77% of sessions hit its ceiling of 3, so debt degenerated into a
 * session counter and token volume counted for nothing at all.
 *
 * These tests pin the three properties that fix depends on: the axes are
 * log-compressed and bounded, they SUM (so breadth accumulates), and novel
 * tokens are counted while cache re-reads are not.
 */

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** One assistant record carrying a usage block. */
function usageLine(u: Record<string, number>): string {
  return JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u },
  });
}

function toolLine(name: string): string {
  return JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] },
  });
}

const ZERO = {
  changeCount: 0, toolCount: 0, taskSlugs: [] as string[],
  userTurns: 0, assistantChars: 0, decisionMarkers: 0, novelTokens: 0,
};

describe('logPoints — log-compressed bounded contribution', () => {
  it('is 0 at x=0 and for non-positive / non-finite input', () => {
    expect(logPoints(0, 10, 100, 5)).toBe(0);
    expect(logPoints(-5, 10, 100, 5)).toBe(0);
    expect(logPoints(NaN, 10, 100, 5)).toBe(0);
    // Garbage yields NO credit rather than maximum credit: corrupt input must
    // not be able to manufacture debt and force a spurious consolidation.
    // (`novelTokensFromUsage` already filters non-finite usage fields, so this
    // is the second line of defence, not the first.)
    expect(logPoints(Infinity, 10, 100, 5)).toBe(0);
  });

  it('reaches exactly the full weight at x=full', () => {
    expect(logPoints(100, 10, 100, 5)).toBeCloseTo(5, 10);
  });

  it('clamps at the weight beyond full — an outlier cannot dominate', () => {
    expect(logPoints(1_000_000, 10, 100, 5)).toBe(5);
  });

  it('is monotonically non-decreasing', () => {
    let prev = -1;
    for (let x = 0; x <= 500; x += 7) {
      const v = logPoints(x, 10, 100, 5);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('compresses: the SAME absolute increment is worth less the higher you are', () => {
    // This is what "log-compressed" buys, and why one huge session cannot swamp
    // every threshold. (Note it is NOT "each doubling adds less" — a log curve
    // adds a constant amount per doubling by construction.)
    const lowGain = logPoints(10, 10, 1000, 5) - logPoints(0, 10, 1000, 5);
    const highGain = logPoints(110, 10, 1000, 5) - logPoints(100, 10, 1000, 5);
    expect(lowGain).toBeGreaterThan(highGain);
  });
});

describe('novel-token extraction', () => {
  it('sums output + cache_creation + input across records', () => {
    const dir = makeTmpDir('dc-tok');
    const p = join(dir, 's.jsonl');
    writeFileSync(p, [
      usageLine({ output_tokens: 100, cache_creation_input_tokens: 200, input_tokens: 5 }),
      usageLine({ output_tokens: 50, cache_creation_input_tokens: 0, input_tokens: 3 }),
    ].join('\n'));
    expect(analyzeTranscript(p).novelTokens).toBe(358);
  });

  it('EXCLUDES cache_read_input_tokens — the same context re-read every turn', () => {
    const dir = makeTmpDir('dc-tok');
    const p = join(dir, 's.jsonl');
    writeFileSync(p, usageLine({
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      input_tokens: 0,
      cache_read_input_tokens: 9_999_999,
    }));
    expect(analyzeTranscript(p).novelTokens).toBe(10);
  });

  it('tolerates missing, null and negative usage fields without throwing', () => {
    const dir = makeTmpDir('dc-tok');
    const p = join(dir, 's.jsonl');
    writeFileSync(p, [
      JSON.stringify({ message: { role: 'assistant', content: [] } }),          // no usage
      JSON.stringify({ message: { role: 'assistant', usage: null } }),           // null usage
      JSON.stringify({ usage: { output_tokens: -5, input_tokens: 7 } }),         // flat + negative
      'not json at all',
    ].join('\n'));
    expect(analyzeTranscript(p).novelTokens).toBe(7);
  });
});

describe('scoreFromSubstanceV2', () => {
  const base = { userTurns: 0, assistantChars: 0, decisionMarkers: 0, taskSlugs: [] as string[] };

  it('is 0 when no signal fires', () => {
    expect(scoreFromSubstanceV2(base)).toBe(0);
  });

  it('caps at the substance weight when every signal fires', () => {
    expect(scoreFromSubstanceV2({
      userTurns: 100, assistantChars: 999_999, decisionMarkers: 50, taskSlugs: ['a', 'b', 'c'],
    })).toBe(SCORE_AXES.substance.weight);
  });

  it('fires on the documented thresholds, not below them', () => {
    expect(scoreFromSubstanceV2({ ...base, userTurns: 7 })).toBe(0);
    expect(scoreFromSubstanceV2({ ...base, userTurns: 8 })).toBeGreaterThan(0);
    expect(scoreFromSubstanceV2({ ...base, decisionMarkers: 3 })).toBe(0);
    expect(scoreFromSubstanceV2({ ...base, decisionMarkers: 4 })).toBeGreaterThan(0);
    expect(scoreFromSubstanceV2({ ...base, taskSlugs: ['only-one'] })).toBe(0);
    expect(scoreFromSubstanceV2({ ...base, taskSlugs: ['a', 'b'] })).toBeGreaterThan(0);
  });
});

describe('scoreSession', () => {
  it('scores an empty session 0 and is bounded by SESSION_SCORE_MAX', () => {
    expect(scoreSession(ZERO)).toBe(0);
    expect(scoreSession({
      ...ZERO, novelTokens: 1e9, changeCount: 5000, toolCount: 5000,
      userTurns: 999, assistantChars: 1e7, decisionMarkers: 999, taskSlugs: ['a', 'b'],
    })).toBe(SESSION_SCORE_MAX);
  });

  it('returns an integer, so debt never accumulates float drift', () => {
    for (const tokens of [1, 5_000, 137_000, 900_000, 4_000_000]) {
      const s = scoreSession({ ...ZERO, novelTokens: tokens, changeCount: 3, toolCount: 17 });
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it('DISCRIMINATES sessions the old max()-of-buckets scorer rated identically', () => {
    // Both of these scored exactly 3 under the old scale (both clear 9 changes
    // and 41 tools). These are real shapes from this project's own history.
    const heavy = { ...ZERO, novelTokens: 6_000_000, changeCount: 42, toolCount: 155 };
    const lighter = { ...ZERO, novelTokens: 700_000, changeCount: 13, toolCount: 103 };
    expect(scoreSession(heavy)).toBeGreaterThan(scoreSession(lighter));
  });

  it('counts token volume even with zero edits — the reported bug', () => {
    const quiet = { ...ZERO, novelTokens: 20_000, toolCount: 3 };
    const talkative = { ...ZERO, novelTokens: 2_000_000, toolCount: 3 };
    expect(scoreSession(talkative)).toBeGreaterThan(scoreSession(quiet));
  });

  it('SUMS across axes rather than taking a max — breadth accumulates', () => {
    const onlyChanges = { ...ZERO, changeCount: 20 };
    const onlyTokens = { ...ZERO, novelTokens: 1_500_000 };
    const both = { ...ZERO, changeCount: 20, novelTokens: 1_500_000 };
    expect(scoreSession(both)).toBeGreaterThan(Math.max(scoreSession(onlyChanges), scoreSession(onlyTokens)));
  });

  it('axis weights sum to exactly SESSION_SCORE_MAX', () => {
    const total = SCORE_AXES.tokens.weight + SCORE_AXES.changes.weight
      + SCORE_AXES.tools.weight + SCORE_AXES.substance.weight;
    expect(total).toBe(SESSION_SCORE_MAX);
  });
});

describe('mergeAnalyses — sub-agent folding', () => {
  it('sums tokens, changes and tools, and unions task slugs', () => {
    const main = { ...ZERO, novelTokens: 100, changeCount: 2, toolCount: 5, taskSlugs: ['a'] };
    const sub = { ...ZERO, novelTokens: 900, changeCount: 8, toolCount: 40, taskSlugs: ['a', 'b'] };
    const m = mergeAnalyses(main, [sub, sub]);
    expect(m.novelTokens).toBe(1900);
    expect(m.changeCount).toBe(18);
    expect(m.toolCount).toBe(85);
    expect([...m.taskSlugs].sort()).toEqual(['a', 'b']);
  });

  it('takes userTurns from the MAIN transcript only', () => {
    // A sub-agent's user-role records are injected prompts and tool results, not
    // human turns — counting them would fake the "long human exchange" signal.
    const main = { ...ZERO, userTurns: 3 };
    const sub = { ...ZERO, userTurns: 500 };
    expect(mergeAnalyses(main, [sub]).userTurns).toBe(3);
  });

  it('is a no-op with no sub-agents', () => {
    const main = { ...ZERO, novelTokens: 42, taskSlugs: ['x'] };
    expect(mergeAnalyses(main, [])).toEqual(main);
  });
});

describe('analyzeSession — main + subagents/', () => {
  it('folds sub-agent transcripts into the session analysis', () => {
    const dir = makeTmpDir('dc-sess');
    const sessionId = 'sess-1';
    const mainPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(mainPath, [
      usageLine({ output_tokens: 100, input_tokens: 0 }),
      toolLine('Task'),
    ].join('\n'));

    const subDir = join(dir, sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-aaa.jsonl'), [
      usageLine({ output_tokens: 5_000, cache_creation_input_tokens: 50_000 }),
      toolLine('Edit'), toolLine('Edit'),
    ].join('\n'));

    const loc = resolveTranscript(mainPath, { sessionId });
    const solo = analyzeTranscript(mainPath);
    const full = analyzeSession(loc);

    expect(solo.novelTokens).toBe(100);
    expect(solo.changeCount).toBe(0);
    // Sub-agent work is otherwise invisible: the main transcript shows one Task call.
    expect(full.novelTokens).toBe(55_100);
    expect(full.changeCount).toBe(2);
    expect(scoreSession(full)).toBeGreaterThan(scoreSession(solo));
  });

  it('returns the main analysis unchanged when there is no subagents/ dir', () => {
    const dir = makeTmpDir('dc-sess');
    const sessionId = 'sess-2';
    const mainPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(mainPath, usageLine({ output_tokens: 7 }));
    const loc = resolveTranscript(mainPath, { sessionId });
    expect(analyzeSession(loc)).toEqual(analyzeTranscript(mainPath));
  });
});

describe('debt thresholds and levels', () => {
  it('orders the thresholds and puts deep authority strictly above Must Sleep', () => {
    expect(DEBT_DROWSY).toBeLessThan(DEBT_SLEEPY);
    expect(DEBT_SLEEPY).toBeLessThan(DEBT_MUST_SLEEP);
    expect(DEBT_DEEP_AUTHORITY).toBeGreaterThan(DEBT_MUST_SLEEP);
  });

  it('labels each band at its exact boundary', () => {
    expect(sleepinessLevel(DEBT_DROWSY - 1)).toBe('Alert');
    expect(sleepinessLevel(DEBT_DROWSY)).toBe('Drowsy');
    expect(sleepinessLevel(DEBT_SLEEPY - 1)).toBe('Drowsy');
    expect(sleepinessLevel(DEBT_SLEEPY)).toBe('Sleepy');
    expect(sleepinessLevel(DEBT_MUST_SLEEP - 1)).toBe('Sleepy');
    expect(sleepinessLevel(DEBT_MUST_SLEEP)).toBe('Must Sleep');
  });

  it('does NOT authorize destructive ops merely because consolidation is overdue', () => {
    // The root coupling this rescale broke: debt >= Must Sleep used to imply
    // 'deep', so the cycle with the most piled-up material got the most
    // destructive authority.
    expect(consolidationDepth(DEBT_MUST_SLEEP).depth).toBe('standard');
    expect(consolidationDepth(DEBT_DEEP_AUTHORITY - 1).depth).toBe('standard');
    expect(consolidationDepth(DEBT_DEEP_AUTHORITY).depth).toBe('deep');
  });

  it('still lets an explicit --deep override win at any debt', () => {
    expect(consolidationDepth(0, { userRequestedDeep: true }).depth).toBe('deep');
  });

  it('accepts manual debt across the whole new range', () => {
    expect(validateSleepAdd('10', 'x').ok).toBe(true);
    expect(validateSleepAdd('4', 'x').ok).toBe(true);
    expect(validateSleepAdd('11', 'x').ok).toBe(false);
    expect(validateSleepAdd('0', 'x').ok).toBe(false);
  });
});

describe('rescaleLegacySessions — 0-3 → 0-10 migration', () => {
  function stateWith(sessions: SessionRecord[]): SleepState {
    return {
      debt: recomputeDebt(sessions),
      last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
      last_consolidated_at: null, sessions_since_last_sleep: sessions.length,
      sessions, bookmarks: [], triggers: [], knowledge_access: {},
      dashboard_changes: [], compaction_log: [], recall_mode: 'hybrid',
      consolidation_depth: null, pendingMigrationNotices: [],
    };
  }
  function session(id: string, score: number | null, extra: Partial<SessionRecord> = {}): SessionRecord {
    return {
      session_id: id, transcript_path: null, stopped_at: '2026-07-01T00:00:00.000Z',
      last_assistant_message: 'work', change_count: 1, tool_count: 1, score,
      task_slugs: [], ...extra,
    };
  }

  it('multiplies legacy scores and recomputes debt from the result', () => {
    const r = rescaleLegacySessions(stateWith([session('a', 3), session('b', 2)]));
    expect(r.rescaled).toBe(2);
    expect(r.debtBefore).toBe(5);
    expect(r.debtAfter).toBe(3 * LEGACY_SCORE_RESCALE + 2 * LEGACY_SCORE_RESCALE);
    expect(r.state.debt).toBe(recomputeDebt(r.state.sessions));
  });

  it('is idempotent — a second run finds nothing to do', () => {
    const first = rescaleLegacySessions(stateWith([session('a', 3), session('b', 1)]));
    const second = rescaleLegacySessions(first.state);
    expect(second.rescaled).toBe(0);
    expect(second.debtAfter).toBe(first.debtAfter);
    expect(second.state.sessions).toEqual(first.state.sessions);
  });

  it('leaves sessions already scored by the new scorer alone', () => {
    const r = rescaleLegacySessions(stateWith([session('new', 9, { scoring_version: SCORING_VERSION })]));
    expect(r.rescaled).toBe(0);
    expect(r.state.sessions[0].score).toBe(9);
  });

  it('leaves PENDING sessions pending, for the catch-up to score with the new scorer', () => {
    const r = rescaleLegacySessions(stateWith([session('pending', null)]));
    expect(r.state.sessions[0].score).toBeNull();
    expect(r.state.sessions[0].scoring_version).toBeUndefined();
    expect(r.rescaled).toBe(0);
  });

  it('never exceeds the new ceiling', () => {
    const r = rescaleLegacySessions(stateWith([session('a', 3)]));
    expect(r.state.sessions[0].score).toBeLessThanOrEqual(SESSION_SCORE_MAX);
  });

  it('does not mutate the input state', () => {
    const input = stateWith([session('a', 3)]);
    const before = JSON.stringify(input);
    rescaleLegacySessions(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('migration 0.23.0 — rescale-legacy-sleep-debt', () => {
  function vaultWith(sleepJson: unknown | null): string {
    const root = makeTmpDir('dc-mig');
    mkdirSync(join(root, 'state'), { recursive: true });
    if (sleepJson !== null) {
      writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify(sleepJson, null, 2));
    }
    return root;
  }
  const run = (root: string) => migration0230.steps[0](root);
  const readBack = (root: string) =>
    JSON.parse(readFileSync(join(root, 'state', '.sleep.json'), 'utf-8'));

  it('rescales scores and recomputes debt', () => {
    const root = vaultWith({
      debt: 5,
      recall_mode: 'hybrid',
      sessions: [{ session_id: 'a', score: 3 }, { session_id: 'b', score: 2 }],
    });
    const r = run(root);
    expect(r.detected).toBe(false);
    expect(r.filesTouched).toHaveLength(1);
    const after = readBack(root);
    expect(after.debt).toBe(5 * LEGACY_SCORE_RESCALE);
    expect(after.sessions.map((s: SessionRecord) => s.score)).toEqual([9, 6]);
  });

  it('leaves every unrelated field byte-identical', () => {
    const root = vaultWith({
      debt: 3,
      recall_mode: 'hybrid',
      last_sleep: '2026-07-01',
      bookmarks: [{ id: 'bm-1', message: 'keep me' }],
      sessions: [{ session_id: 'a', score: 1 }],
    });
    run(root);
    const after = readBack(root);
    expect(after.recall_mode).toBe('hybrid');
    expect(after.last_sleep).toBe('2026-07-01');
    expect(after.bookmarks).toEqual([{ id: 'bm-1', message: 'keep me' }]);
  });

  it('is idempotent — a second run touches nothing', () => {
    const root = vaultWith({ debt: 3, sessions: [{ session_id: 'a', score: 3 }] });
    run(root);
    const afterFirst = readFileSync(join(root, 'state', '.sleep.json'), 'utf-8');
    const second = run(root);
    expect(second.detected).toBe(true);
    expect(second.filesTouched).toHaveLength(0);
    expect(readFileSync(join(root, 'state', '.sleep.json'), 'utf-8')).toBe(afterFirst);
  });

  it('reports "detected" (and writes nothing) with no .sleep.json at all', () => {
    const root = vaultWith(null);
    const r = run(root);
    expect(r.detected).toBe(true);
    expect(r.filesTouched).toHaveLength(0);
  });

  it('never throws on a torn .sleep.json', () => {
    const root = makeTmpDir('dc-mig');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', '.sleep.json'), '{ this is not json');
    const r = run(root);
    expect(r.detected).toBe(true);
    expect(r.filesTouched).toHaveLength(0);
  });

  it('the rescale step is registered exactly once (0.23.0 holds TWO migrations by design)', () => {
    // people-first + soul-split both ship as 0.23.0 — the runner gates steps
    // by id, so the invariant is per-STEP uniqueness, not one-entry-per-version.
    const v0230 = REGISTRY.filter(m => m.version === '0.23.0');
    expect(v0230).toHaveLength(2);
    // Steps only reveal their ids when run (which would touch a vault), so the
    // per-entry uniqueness is asserted on the statically-known agentTask ids.
    expect(new Set(v0230.map((m) => m.agentTask?.id)).size).toBe(2);
  });

  it('does not import the CLI sleep module (no circular registry import)', async () => {
    // The registry is imported by cli/commands/sleep.ts; a migration importing
    // that module back closes the cycle and throws at load time. Importing the
    // registry in isolation is the regression guard.
    await expect(import('../../src/migrations/index.js')).resolves.toBeTruthy();
  });
});

describe('upsertSessionOnStop carries the new fields', () => {
  const empty: SleepState = {
    debt: 0, last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
    last_consolidated_at: null, sessions_since_last_sleep: 0, sessions: [],
    bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
    compaction_log: [], recall_mode: 'hybrid', consolidation_depth: null,
    pendingMigrationNotices: [],
  };

  it('persists novel_tokens and scoring_version on insert and on re-stop', () => {
    const first = upsertSessionOnStop(empty, {
      session_id: 's', transcript_path: null, stopped_at: '2026-07-29T00:00:00.000Z',
      last_assistant_message: null, change_count: 2, tool_count: 9, score: 4,
      task_slugs: [], novel_tokens: 123_456, scoring_version: SCORING_VERSION,
    });
    expect(first.sessions[0].novel_tokens).toBe(123_456);
    expect(first.sessions[0].scoring_version).toBe(SCORING_VERSION);
    expect(first.debt).toBe(4);

    const second = upsertSessionOnStop(first, {
      session_id: 's', transcript_path: null, stopped_at: '2026-07-29T01:00:00.000Z',
      last_assistant_message: null, change_count: 5, tool_count: 30, score: 7,
      task_slugs: [], novel_tokens: 900_000, scoring_version: SCORING_VERSION,
    });
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].novel_tokens).toBe(900_000);
    expect(second.debt).toBe(7); // old score subtracted, not added twice
  });

  it('omits both fields when the transcript was not on disk (score pending)', () => {
    const s = upsertSessionOnStop(empty, {
      session_id: 's', transcript_path: null, stopped_at: '2026-07-29T00:00:00.000Z',
      last_assistant_message: null, change_count: null, tool_count: null, score: null,
      task_slugs: [],
    });
    expect(s.sessions[0].novel_tokens).toBeUndefined();
    expect(s.sessions[0].scoring_version).toBeUndefined();
  });
});
