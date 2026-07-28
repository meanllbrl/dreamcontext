/**
 * Two things a scheduled run owes the person who is not at the keyboard:
 *
 *  - The NOTIFICATION must say what the run found, not that a file exists. The
 *    user's complaint that produced this: "the job was 'update the insights' —
 *    the notification should have carried the updated insights."
 *  - The SESSION must be inspectable afterwards. The output document is the
 *    conclusion with the working thrown away, which is exactly the wrong half
 *    when a run does something surprising.
 */

import { describe, it, expect } from 'vitest';
import { extractNotificationSummary } from '../../src/lib/automations/runner.js';
import { digestTranscript, resolveRunSession } from '../../src/lib/automations/session.js';
import { NOTIFY_BODY_MAX_CHARS, type AutomationCache, type RunEvent } from '../../src/lib/automations/types.js';

describe('extractNotificationSummary', () => {
  it('takes the opening sentence — what the preamble asks every run to write', () => {
    expect(extractNotificationSummary('6 of 7 insights synced. MRR moved 857 → 867.\n\n# Report\n\n…'))
      .toBe('6 of 7 insights synced. MRR moved 857 → 867.');
  });

  it('skips a leading heading rather than notifying the title', () => {
    expect(extractNotificationSummary('# Daily digest\n\nAll good.\n')).toBe('All good.');
  });

  it('skips a leading TABLE — the specific trap that made banners useless', () => {
    // A results-first document would otherwise notify "| Insight | Before |".
    const md = '# Sync\n\n| Insight | Before | After |\n| - | - | - |\n| dau | 550 | 554 |\n\nFour insights changed.';
    expect(extractNotificationSummary(md)).toBe('Four insights changed.');
  });

  it('skips YAML frontmatter', () => {
    expect(extractNotificationSummary('---\ntitle: x\n---\nThe real summary.')).toBe('The real summary.');
  });

  it('skips a leading code fence and its contents', () => {
    expect(extractNotificationSummary('```\nnot prose\n```\n\nThe summary.')).toBe('The summary.');
  });

  it('lets an explicit ## Notification section win', () => {
    const md = 'The opening line.\n\n## Notification\n\nSay this instead.\n\n## Detail\n\nmore';
    expect(extractNotificationSummary(md)).toBe('Say this instead.');
  });

  it('accepts the Turkish ## Bildirim heading too', () => {
    expect(extractNotificationSummary('Opening.\n\n## Bildirim\n\nBunu söyle.')).toBe('Bunu söyle.');
  });

  it('strips markdown emphasis — a banner renders it as literal asterisks', () => {
    expect(extractNotificationSummary('**867** USD, up from `857`.')).toBe('867 USD, up from 857.');
  });

  it('takes one paragraph, not the whole document', () => {
    expect(extractNotificationSummary('First para.\n\nSecond para.')).toBe('First para.');
  });

  it('caps the length and marks the cut, rather than letting macOS chop mid-word', () => {
    const summary = extractNotificationSummary('word '.repeat(200));
    expect(summary!.length).toBeLessThanOrEqual(NOTIFY_BODY_MAX_CHARS);
    expect(summary!.endsWith('…')).toBe(true);
  });

  it('returns null when the document offers nothing usable, so the caller can fall back', () => {
    expect(extractNotificationSummary('')).toBeNull();
    expect(extractNotificationSummary('# Only a heading\n\n## And another\n')).toBeNull();
  });

  it('unwraps a bullet or a quote — both are prose a human wrote as the summary', () => {
    expect(extractNotificationSummary('- 4 insights changed.')).toBe('4 insights changed.');
    expect(extractNotificationSummary('> 4 insights changed.')).toBe('4 insights changed.');
  });
});

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    firedAt: '2026-07-27T13:45:00.000Z',
    startedAt: '2026-07-27T13:45:00.000Z',
    finishedAt: '2026-07-27T13:45:30.000Z',
    status: 'ok',
    durationMs: 30_000,
    outputPath: '/o/2026-07-27.md',
    error: null,
    exitCode: 0,
    sessionId: 'sess-1',
    costUsd: 0.01,
    numTurns: 3,
    permissionDenials: 0,
    ...overrides,
  };
}

function cache(history: RunEvent[]): AutomationCache {
  return {
    slug: 'x', lastRunAt: null, lastFireAt: null, status: 'ok',
    durationMs: null, outputPath: null, error: null, exitCode: null, history,
  };
}

describe('resolveRunSession', () => {
  const home = '/nonexistent-home-for-tests';

  it('returns null when nothing has ever run', () => {
    expect(resolveRunSession(null, { home })).toBeNull();
    expect(resolveRunSession(cache([]), { home })).toBeNull();
  });

  it('indexes the history AS STORED — recordRun prepends, so it is already newest-first', () => {
    // The bug this pins, caught by dogfooding: reversing here made `--run 1`
    // the OLDEST run, which reads as perfectly plausible right up until you
    // notice the session you opened is a week old. `recordRun` builds
    // `[event, ...existing]`; nothing downstream may reverse that again.
    const history = [
      event({ sessionId: 'newest', firedAt: '2026-07-27T00:00:00.000Z' }),
      event({ sessionId: 'middle', firedAt: '2026-07-26T00:00:00.000Z' }),
      event({ sessionId: 'oldest', firedAt: '2026-07-25T00:00:00.000Z' }),
    ];
    expect(resolveRunSession(cache(history), { home })!.sessionId).toBe('newest');
    expect(resolveRunSession(cache(history), { runNumber: 1, home })!.sessionId).toBe('newest');
    expect(resolveRunSession(cache(history), { runNumber: 3, home })!.sessionId).toBe('oldest');
  });

  it('defaults to the most recent run that HAS a session, not simply the most recent', () => {
    // A blocked run records no session. Answering "nothing to show" for it
    // would be technically true and useless — the run the user is asking about
    // is the last one that actually ran.
    const resolved = resolveRunSession(
      cache([
        event({ sessionId: null, status: 'blocked', firedAt: '2026-07-27T00:00:00.000Z' }),
        event({ sessionId: 'newer', firedAt: '2026-07-26T00:00:00.000Z' }),
        event({ sessionId: 'older', firedAt: '2026-07-25T00:00:00.000Z' }),
      ]),
      { home },
    );
    expect(resolved!.sessionId).toBe('newer');
    expect(resolved!.runNumber).toBe(2);
  });

  it('returns null for a run number past the end, rather than clamping to a different run', () => {
    expect(resolveRunSession(cache([event()]), { runNumber: 9, home })).toBeNull();
    expect(resolveRunSession(cache([event()]), { runNumber: 0, home })).toBeNull();
  });

  it('reports a missing transcript as null, never as an error — it is a normal state', () => {
    const resolved = resolveRunSession(cache([event({ sessionId: 'never-written' })]), { home });
    expect(resolved!.sessionId).toBe('never-written');
    expect(resolved!.transcriptPath).toBeNull();
  });

  it('survives a malformed history — the cache is user-editable JSON', () => {
    const broken = { ...cache([]), history: 'not an array' } as unknown as AutomationCache;
    expect(resolveRunSession(broken, { home })).toBeNull();
  });

  it('never turns a hostile sessionId into a path — the cache is BRAIN-SYNCED', () => {
    // `automations/cache/<slug>.json` travels with a shared automation and is
    // hand-editable, so a teammate's edit (or a corrupted record) reaches this
    // as untrusted input. Whitelist before the filesystem, same ordering as the
    // sanitizeUuid family.
    for (const hostile of ['../../../../etc/passwd', 'a/b', '..', 'x\u0000y', 'has space', 'a'.repeat(200)]) {
      const resolved = resolveRunSession(cache([event({ sessionId: hostile })]), { home });
      expect(resolved!.sessionId).toBe(hostile); // reported verbatim…
      expect(resolved!.transcriptPath).toBeNull(); // …but never resolved to a path
    }
  });
});

describe('digestTranscript', () => {
  const line = (o: unknown) => JSON.stringify(o);
  const raw = [
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'do the job' } }),
    line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running the sync.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'dreamcontext lab sync --all' } },
        ],
      },
    }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } }),
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x.md' } }] },
    }),
    'not json at all',
    '',
  ].join('\n');

  it('counts tool calls by name and notices the failures', () => {
    const d = digestTranscript(raw);
    expect(d.toolCalls).toBe(2);
    expect(d.toolCounts).toEqual({ Bash: 1, Read: 1 });
    expect(d.toolErrors).toBe(1);
    expect(d.assistantMessages).toBe(1);
  });

  it('skips malformed lines rather than failing the whole digest', () => {
    // A transcript is an append-only log written by a different program than
    // ours, so unknown and broken shapes are the norm, not an error.
    expect(digestTranscript(raw).items.length).toBeGreaterThan(0);
    expect(digestTranscript('garbage\n{').items).toEqual([]);
  });

  it('is empty, not thrown, for an empty transcript', () => {
    expect(digestTranscript('')).toEqual({
      items: [], toolCounts: {}, toolCalls: 0, toolErrors: 0, assistantMessages: 0,
    });
  });
});
