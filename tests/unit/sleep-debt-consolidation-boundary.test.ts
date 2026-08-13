import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeTranscript,
  analyzeSession,
  scoreSession,
  resolveCatchupFinalization,
} from '../../src/cli/commands/hook.js';
import { resolveTranscript } from '../../src/lib/transcript-locate.js';

/**
 * Regression: sleep debt never reached 0 (team reports, Slack 2026-08-04).
 *
 * Consolidation deletes pre-epoch SESSION RECORDS, but the transcripts persist.
 * The Stop hook then scored each transcript from scratch, so:
 *  (A) the session that ORCHESTRATED the sleep re-booked the whole fan-out —
 *      every sleep specialist's sub-agent transcript folded into its score,
 *      putting a ~9-10 debt floor right back after every single sleep;
 *  (B) any tab that continued after a sleep re-booked its entire
 *      already-consolidated history as a "new" session (several tabs → 35).
 *
 * The fix bounds analysis at `last_consolidated_at`: records stamped at or
 * before it contribute to no scored axis.
 */

const BOUNDARY = '2026-08-04T17:00:00.000Z';
const BEFORE = '2026-08-04T16:00:00.000Z';
const AFTER = '2026-08-04T18:00:00.000Z';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function usageLine(u: Record<string, number>, timestamp?: string): string {
  return JSON.stringify({
    ...(timestamp ? { timestamp } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(100) }], usage: u },
  });
}

function toolLine(name: string, timestamp?: string): string {
  return JSON.stringify({
    ...(timestamp ? { timestamp } : {}),
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] },
  });
}

function userLine(timestamp?: string): string {
  return JSON.stringify({
    ...(timestamp ? { timestamp } : {}),
    message: { role: 'user', content: 'do the thing' },
  });
}

describe('analyzeTranscript — consolidation boundary', () => {
  it('excludes records at or before the boundary from every scored axis', () => {
    const dir = makeTmpDir('dc-bound');
    const p = join(dir, 's.jsonl');
    writeFileSync(p, [
      userLine(BEFORE),
      usageLine({ output_tokens: 1_000_000 }, BEFORE),
      toolLine('Edit', BEFORE),
      toolLine('Edit', BOUNDARY), // exactly AT the boundary — consolidated, excluded
      userLine(AFTER),
      usageLine({ output_tokens: 500 }, AFTER),
      toolLine('Write', AFTER),
    ].join('\n'));

    const bounded = analyzeTranscript(p, BOUNDARY);
    expect(bounded.novelTokens).toBe(500);
    expect(bounded.userTurns).toBe(1);
    expect(bounded.changeCount).toBe(1);
    expect(bounded.toolCount).toBe(1);
  });

  it('without a boundary the full transcript scores exactly as before', () => {
    const dir = makeTmpDir('dc-bound');
    const p = join(dir, 's.jsonl');
    const lines = [
      usageLine({ output_tokens: 1_000_000 }, BEFORE),
      toolLine('Edit', BEFORE),
      usageLine({ output_tokens: 500 }, AFTER),
    ].join('\n');
    writeFileSync(p, lines);

    const unbounded = analyzeTranscript(p);
    expect(unbounded.novelTokens).toBe(1_000_500);
    expect(unbounded.changeCount).toBe(1);
    expect(analyzeTranscript(p, null)).toEqual(unbounded);
  });

  it('a boundary older than every record changes nothing — counts stay on the legacy regex path', () => {
    const dir = makeTmpDir('dc-bound');
    const p = join(dir, 's.jsonl');
    writeFileSync(p, [
      usageLine({ output_tokens: 100 }, AFTER),
      toolLine('Edit', AFTER),
    ].join('\n'));

    expect(analyzeTranscript(p, BEFORE)).toEqual(analyzeTranscript(p));
  });

  it('records without a timestamp count (fail-open) even when a boundary is set', () => {
    const dir = makeTmpDir('dc-bound');
    const p = join(dir, 's.jsonl');
    writeFileSync(p, [
      usageLine({ output_tokens: 1_000 }, BEFORE), // excluded
      usageLine({ output_tokens: 70 }),            // no timestamp — kept
    ].join('\n'));

    expect(analyzeTranscript(p, BOUNDARY).novelTokens).toBe(70);
  });

  it('task slugs stay whole-transcript — linkage metadata is not debt', () => {
    const dir = makeTmpDir('dc-bound');
    const p = join(dir, 's.jsonl');
    writeFileSync(p, [
      JSON.stringify({
        timestamp: BEFORE,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'dreamcontext tasks log fix-the-thing "done"' } }],
        },
      }),
      usageLine({ output_tokens: 10 }, AFTER),
    ].join('\n'));

    const bounded = analyzeTranscript(p, BOUNDARY);
    expect(bounded.taskSlugs).toEqual(['fix-the-thing']);
    expect(bounded.toolCount).toBe(0); // ...but the pre-boundary tool call is not debt
  });
});

describe('analyzeSession — the sleep fan-out stops re-booking itself (leak A)', () => {
  it('sub-agent transcripts that predate the boundary contribute nothing', () => {
    const dir = makeTmpDir('dc-fanout');
    const sessionId = 'orchestrator';
    const mainPath = join(dir, `${sessionId}.jsonl`);
    // The orchestrating session: pre-sleep work, the Task dispatch, a tiny
    // post-`sleep done` summary turn.
    writeFileSync(mainPath, [
      usageLine({ output_tokens: 200_000 }, BEFORE),
      toolLine('Task', BEFORE),
      usageLine({ output_tokens: 300 }, AFTER),
    ].join('\n'));

    // The sleep specialists: heavy writes, all during the sleep window.
    const subDir = join(dir, sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    for (const agent of ['sleep-tasks', 'sleep-state', 'sleep-product']) {
      writeFileSync(join(subDir, `agent-${agent}.jsonl`), [
        usageLine({ output_tokens: 400_000, cache_creation_input_tokens: 900_000 }, BEFORE),
        ...Array.from({ length: 15 }, () => toolLine('Edit', BEFORE)),
      ].join('\n'));
    }

    const loc = resolveTranscript(mainPath, { sessionId });
    const unbounded = analyzeSession(loc);
    const bounded = analyzeSession(loc, BOUNDARY);

    // Unbounded, the fan-out books serious debt — the exact 9-10 floor reported.
    expect(scoreSession(unbounded)).toBeGreaterThanOrEqual(7);
    // Bounded, only the post-sleep summary turn counts.
    expect(bounded.novelTokens).toBe(300);
    expect(bounded.changeCount).toBe(0);
    expect(scoreSession(bounded)).toBeLessThanOrEqual(1);
  });
});

describe('resolveCatchupFinalization — a spanning session does not re-book (leak B)', () => {
  it('scores only post-boundary work when the catch-up finalizes a pending session', () => {
    const dir = makeTmpDir('dc-catchup');
    const sessionId = 'heavy-tab';
    const mainPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(mainPath, [
      // A full day of already-consolidated work…
      ...Array.from({ length: 30 }, () => toolLine('Edit', BEFORE)),
      usageLine({ output_tokens: 2_000_000 }, BEFORE),
      // …and one small post-sleep turn.
      usageLine({ output_tokens: 1_000 }, AFTER),
    ].join('\n'));

    const session = { stopped_at: AFTER, last_assistant_message: null, task_slugs: [] };
    const loc = resolveTranscript(mainPath, { sessionId });

    const unbounded = resolveCatchupFinalization(session, loc, Date.parse(AFTER));
    const bounded = resolveCatchupFinalization(session, loc, Date.parse(AFTER), BOUNDARY);

    expect(unbounded!.score).toBeGreaterThanOrEqual(5); // the old re-book
    expect(bounded!.score).toBeLessThanOrEqual(1);
    expect(bounded!.debtDelta).toBe(bounded!.score);
    expect(bounded!.changeCount).toBe(0);
    expect(bounded!.novelTokens).toBe(1_000);
  });
});
