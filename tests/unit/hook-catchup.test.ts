import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCatchupFinalization,
  resolveStopCaptureBookmarks,
  analyzeTranscript,
} from '../../src/cli/commands/hook.js';
import { resolveTranscript, listSubagentTranscripts } from '../../src/lib/transcript-locate.js';
import { distillTranscript, distillSubagents, mergeDistilled } from '../../src/cli/commands/transcript.js';
import { NEVER_FLUSHED_FINALIZE_MS, NEVER_FLUSHED_FLOOR_SCORE } from '../../src/lib/sleep-consolidation.js';
import type { SessionRecord } from '../../src/lib/sleep-consolidation.js';

/**
 * SessionStart catch-up wiring (improve-sleep-quality, T7): AC2 (transcript-less
 * finalization + Stop-hook capture), AC3 (flat/dir layout fallback wired into
 * the finalize decision), AC4 (catchup_finalized stamped on every catch-up
 * result), AC8 (task_slugs MERGE + sub-agent harvest composition). Exercises
 * the pure helpers hook.ts's unexported action closures delegate to.
 */

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return dir;
}

function assistantLine(text: string): string {
  return JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

const NOW = Date.parse('2026-07-18T12:00:00.000Z');

function pendingSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: 's-1',
    transcript_path: '/tmp/nonexistent.jsonl',
    stopped_at: '2026-07-18T00:00:00.000Z',
    last_assistant_message: null,
    change_count: null,
    tool_count: null,
    score: null,
    task_slugs: [],
    ...overrides,
  };
}

describe('resolveCatchupFinalization — AC2 (7-day floor) + AC4 (catchup_finalized)', () => {
  it('no main transcript under either layout, younger than 7 days → stays pending (null)', () => {
    const session = pendingSession({ stopped_at: new Date(NOW - (NEVER_FLUSHED_FINALIZE_MS - 1)).toISOString() });
    const loc = { mainPath: null, sessionDir: null, layout: 'none' as const };
    expect(resolveCatchupFinalization(session, loc, NOW)).toBeNull();
  });

  it('no main transcript, EXACTLY 7 days old, non-empty last_assistant_message → floor score 1', () => {
    const session = pendingSession({
      stopped_at: new Date(NOW - NEVER_FLUSHED_FINALIZE_MS).toISOString(),
      last_assistant_message: 'Fixed the bug and shipped it.',
    });
    const loc = { mainPath: null, sessionDir: null, layout: 'none' as const };
    const result = resolveCatchupFinalization(session, loc, NOW);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(NEVER_FLUSHED_FLOOR_SCORE);
    expect(result!.score).toBe(1);
    expect(result!.debtDelta).toBe(1);
    expect(result!.catchupFinalized).toBe(true);
  });

  it('no main transcript, aged out, EMPTY last_assistant_message → floor score 0', () => {
    const session = pendingSession({
      stopped_at: new Date(NOW - NEVER_FLUSHED_FINALIZE_MS).toISOString(),
      last_assistant_message: null,
    });
    const loc = { mainPath: null, sessionDir: null, layout: 'none' as const };
    const result = resolveCatchupFinalization(session, loc, NOW);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);
    expect(result!.debtDelta).toBe(0);
    expect(result!.catchupFinalized).toBe(true);
  });

  it('unparseable stopped_at counts as aged out — finalizes immediately rather than pending forever', () => {
    const session = pendingSession({ stopped_at: 'not-a-date', last_assistant_message: 'did work' });
    const loc = { mainPath: null, sessionDir: null, layout: 'none' as const };
    const result = resolveCatchupFinalization(session, loc, NOW);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
  });

  it('debtDelta always equals score — no divergence possible from recomputeDebt', () => {
    const cases = [
      { msg: null, stoppedAt: new Date(NOW - NEVER_FLUSHED_FINALIZE_MS).toISOString() },
      { msg: 'work happened', stoppedAt: new Date(NOW - NEVER_FLUSHED_FINALIZE_MS).toISOString() },
    ];
    for (const c of cases) {
      const session = pendingSession({ stopped_at: c.stoppedAt, last_assistant_message: c.msg });
      const loc = { mainPath: null, sessionDir: null, layout: 'none' as const };
      const result = resolveCatchupFinalization(session, loc, NOW)!;
      expect(result.debtDelta).toBe(result.score);
    }
  });

  it('catchupFinalized is true on every non-null result, including the transcript-analyzed path', () => {
    const dir = makeTmpDir('dc-catchup-tx');
    const tx = join(dir, 'sess.jsonl');
    writeFileSync(tx, [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }),
    ].join('\n'));
    const session = pendingSession({ transcript_path: tx });
    const loc = resolveTranscript(tx, { sessionId: 's-1' });
    const result = resolveCatchupFinalization(session, loc, NOW)!;
    expect(result.catchupFinalized).toBe(true);
  });
});

describe('resolveCatchupFinalization — AC3 (flat/dir layout wiring)', () => {
  it('flat transcript present → scored normally via analyzeTranscript', () => {
    const dir = makeTmpDir('dc-catchup-flat');
    const sessionId = 'flat-sess';
    const tx = join(dir, `${sessionId}.jsonl`);
    const lines = Array.from({ length: 4 }, () =>
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write' }] } }),
    ).join('\n');
    writeFileSync(tx, lines);

    const session = pendingSession({ session_id: sessionId, transcript_path: tx });
    const loc = resolveTranscript(tx, { sessionId });
    expect(loc.layout).toBe('flat');
    const result = resolveCatchupFinalization(session, loc, NOW);
    expect(result).not.toBeNull();
    expect(result!.changeCount).toBe(4);
    expect(result!.score).toBeGreaterThan(0);
  });

  it('dir layout with NO main transcript inside (subagents/ only) → treated exactly like "no transcript" (pending then floor)', () => {
    const dir = makeTmpDir('dc-catchup-dironly');
    const sessionId = 'dir-sess';
    const recordedPath = join(dir, `${sessionId}.jsonl`); // recorded but never flushed
    const sessionDir = join(dir, sessionId);
    mkdirSync(join(sessionDir, 'subagents'), { recursive: true });
    writeFileSync(join(sessionDir, 'subagents', 'agent-abc123.jsonl'), assistantLine('sub work'));

    const loc = resolveTranscript(recordedPath, { sessionId });
    expect(loc.mainPath).toBeNull();
    expect(loc.layout).toBe('dir');

    // Young → still pending.
    const youngSession = pendingSession({
      session_id: sessionId,
      transcript_path: recordedPath,
      stopped_at: new Date(NOW - 1000).toISOString(),
    });
    expect(resolveCatchupFinalization(youngSession, loc, NOW)).toBeNull();

    // Aged out → floors exactly like the flat-missing case.
    const agedSession = pendingSession({
      session_id: sessionId,
      transcript_path: recordedPath,
      stopped_at: new Date(NOW - NEVER_FLUSHED_FINALIZE_MS).toISOString(),
      last_assistant_message: 'closed it out',
    });
    const result = resolveCatchupFinalization(agedSession, loc, NOW);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
  });

  it('dir layout WITH a main transcript inside (future-layout case) → resolves and scores it', () => {
    const dir = makeTmpDir('dc-catchup-dirmain');
    const sessionId = 'dir-main-sess';
    const recordedPath = join(dir, `${sessionId}.jsonl`);
    const sessionDir = join(dir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }),
    );

    const loc = resolveTranscript(recordedPath, { sessionId });
    expect(loc.mainPath).not.toBeNull();
    expect(loc.layout).toBe('dir');

    const session = pendingSession({ session_id: sessionId, transcript_path: recordedPath });
    const result = resolveCatchupFinalization(session, loc, NOW);
    expect(result).not.toBeNull();
    expect(result!.changeCount).toBe(1);
  });
});

describe('resolveCatchupFinalization — AC8b (task_slugs MERGE, never replace)', () => {
  it('the evidence-baseline case: task_slugs starts [], transcript names a task via file_path → merged in', () => {
    const dir = makeTmpDir('dc-catchup-slug');
    const sessionId = 'slug-sess';
    const tx = join(dir, `${sessionId}.jsonl`);
    writeFileSync(
      tx,
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/_dream_context/state/improve-sleep-quality.md' } }],
        },
      }),
    );
    const session = pendingSession({ session_id: sessionId, transcript_path: tx, task_slugs: [] });
    const loc = resolveTranscript(tx, { sessionId });
    const result = resolveCatchupFinalization(session, loc, NOW)!;
    expect(result.taskSlugs).toEqual(['improve-sleep-quality']);
  });

  it('pre-existing task_slugs are UNIONED with transcript-extracted ones, never replaced', () => {
    const dir = makeTmpDir('dc-catchup-slugmerge');
    const sessionId = 'slug-merge-sess';
    const tx = join(dir, `${sessionId}.jsonl`);
    writeFileSync(
      tx,
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/_dream_context/state/from-edit.md' } }],
        },
      }),
    );
    const session = pendingSession({ session_id: sessionId, transcript_path: tx, task_slugs: ['from-bookmark'] });
    const loc = resolveTranscript(tx, { sessionId });
    const result = resolveCatchupFinalization(session, loc, NOW)!;
    expect(result.taskSlugs).toEqual(expect.arrayContaining(['from-bookmark', 'from-edit']));
    expect(result.taskSlugs).toHaveLength(2);
  });

  it('duplicate slugs across pre-existing and transcript collapse (Set union, no duplicates)', () => {
    const dir = makeTmpDir('dc-catchup-slugdupe');
    const sessionId = 'slug-dupe-sess';
    const tx = join(dir, `${sessionId}.jsonl`);
    writeFileSync(
      tx,
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/_dream_context/state/shared-task.md' } }],
        },
      }),
    );
    const session = pendingSession({ session_id: sessionId, transcript_path: tx, task_slugs: ['shared-task'] });
    const loc = resolveTranscript(tx, { sessionId });
    const result = resolveCatchupFinalization(session, loc, NOW)!;
    expect(result.taskSlugs).toEqual(['shared-task']);
  });

  it('no transcript path at all (aged-out floor path) preserves existing task_slugs untouched', () => {
    const session = pendingSession({
      transcript_path: null,
      task_slugs: ['already-there'],
      stopped_at: new Date(NOW - NEVER_FLUSHED_FINALIZE_MS).toISOString(),
    });
    const loc = { mainPath: null, sessionDir: null, layout: 'none' as const };
    const result = resolveCatchupFinalization(session, loc, NOW)!;
    expect(result.taskSlugs).toEqual(['already-there']);
  });
});

describe('analyzeTranscript — AC8b widened verb alternation (status/start/reopen/rename)', () => {
  const makeCmdLine = (cmd: string): string =>
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] } });

  it.each([
    ['status', 'dreamcontext tasks status improve-sleep-quality in_progress'],
    ['start', 'dreamcontext tasks start improve-sleep-quality'],
    ['reopen', 'dreamcontext tasks reopen improve-sleep-quality'],
    ['rename', 'dreamcontext tasks rename improve-sleep-quality "New name"'],
  ])('verb "%s" extracts the task slug', (_verb, cmd) => {
    const dir = makeTmpDir('dc-verb');
    const tx = join(dir, 'tx.jsonl');
    writeFileSync(tx, makeCmdLine(cmd));
    const analysis = analyzeTranscript(tx);
    expect(analysis.taskSlugs).toContain('improve-sleep-quality');
  });

  it('the original verbs (log/insert/complete/create) still match (regression)', () => {
    const dir = makeTmpDir('dc-verb-orig');
    const tx = join(dir, 'tx.jsonl');
    writeFileSync(tx, makeCmdLine('dreamcontext tasks log improve-sleep-quality "did a thing"'));
    const analysis = analyzeTranscript(tx);
    expect(analysis.taskSlugs).toContain('improve-sleep-quality');
  });

  it('an unrelated verb outside the alternation does NOT match', () => {
    const dir = makeTmpDir('dc-verb-neg');
    const tx = join(dir, 'tx.jsonl');
    writeFileSync(tx, makeCmdLine('dreamcontext tasks delete improve-sleep-quality'));
    const analysis = analyzeTranscript(tx);
    expect(analysis.taskSlugs).not.toContain('improve-sleep-quality');
  });
});

describe('resolveStopCaptureBookmarks — AC2a (transcript-less Stop capture)', () => {
  it('null message → []', () => {
    expect(resolveStopCaptureBookmarks(null, new Set(), ctx())).toEqual([]);
  });

  it('a decision-marker message produces one capture:true bookmark with session_id + task_slug set', () => {
    const bookmarks = resolveStopCaptureBookmarks(
      'We decided to switch to BM25 for recall.',
      new Set(),
      ctx({ sessionId: 'sess-42', taskSlug: 'my-task' }),
    );
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0].capture).toBe(true);
    expect(bookmarks[0].session_id).toBe('sess-42');
    expect(bookmarks[0].task_slug).toBe('my-task');
    expect(bookmarks[0].salience).toBe(2);
  });

  it('a message whose moment ALREADY exists in existingMessages produces no duplicate (re-stop idempotence)', () => {
    const first = resolveStopCaptureBookmarks('We decided to switch to BM25 for recall.', new Set(), ctx());
    const existing = new Set(first.map(b => b.message));
    const second = resolveStopCaptureBookmarks('We decided to switch to BM25 for recall.', existing, ctx());
    expect(second).toEqual([]);
  });

  it('no marker → []', () => {
    expect(resolveStopCaptureBookmarks('Done. All good.', new Set(), ctx())).toEqual([]);
  });

  function ctx(overrides: Partial<{ sessionId: string; taskSlug: string | null }> = {}) {
    return {
      sessionId: overrides.sessionId ?? 'sess-1',
      taskSlug: overrides.taskSlug ?? null,
      nowISO: '2026-07-18T12:00:00.000Z',
      makeId: () => 'bm-fixed',
    };
  }
});

describe('AC8a — sub-agent harvest composition (resolveTranscript + distillSubagents + mergeDistilled)', () => {
  it('merges main-transcript content with a sub-agent transcript, prefixed [subagent:<id>]', () => {
    const dir = makeTmpDir('dc-subagent-harvest');
    const sessionId = 'harvest-sess';
    const mainPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(mainPath, assistantLine('Main session did the primary work.'));

    const sessionDir = join(dir, sessionId);
    mkdirSync(join(sessionDir, 'subagents'), { recursive: true });
    writeFileSync(join(sessionDir, 'subagents', 'agent-a80407b6.jsonl'), assistantLine('Sub-agent finding: edited config.'));

    const loc = resolveTranscript(mainPath, { sessionId });
    expect(loc.mainPath).toBe(mainPath);

    const mainDistilled = distillTranscript(loc.mainPath!);
    const subagentDistilled = distillSubagents(loc);
    const merged = mergeDistilled([mainDistilled, subagentDistilled]);

    expect(merged.agentDecisions).toContain('Main session did the primary work.');
    expect(merged.agentDecisions.some(d => d.startsWith('[subagent:a80407b6]') && d.includes('Sub-agent finding'))).toBe(true);
  });

  it('a session with no subagents/ dir merges to an unchanged main-only section (no-op merge)', () => {
    const dir = makeTmpDir('dc-subagent-none');
    const sessionId = 'no-subagent-sess';
    const mainPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(mainPath, assistantLine('Solo session, no fan-out.'));

    const loc = resolveTranscript(mainPath, { sessionId });
    const mainDistilled = distillTranscript(loc.mainPath!);
    const subagentDistilled = distillSubagents(loc);
    const merged = mergeDistilled([mainDistilled, subagentDistilled]);

    expect(merged).toEqual(mainDistilled);
    expect(listSubagentTranscripts(loc)).toEqual([]);
  });
});
