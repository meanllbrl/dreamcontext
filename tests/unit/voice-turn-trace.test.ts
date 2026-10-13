/**
 * A notch voice turn timed end to end (`dashboard/src/lib/voice/turnTrace.ts`) and the server's
 * reduction of it into voice.jsonl (`parseTurnTrace` in `src/lib/voice/voiceLog.ts`).
 *
 * The clock and timers are injected, so every offset below is exact.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createTurnTracer, guarded, TRACED_VAULT, AFTER_END_MS, MAX_TURN_MS, type TurnRecord,
} from '../../dashboard/src/lib/voice/turnTrace.js';
import { parseTurnTrace } from '../../src/lib/voice/voiceLog.js';

const V = TRACED_VAULT;

function rig() {
  let t = 1_000_000;
  const out: TurnRecord[] = [];
  const pending = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const timers = {
    set: (fn: () => void, ms: number) => { pending.set(++id, { at: t + ms, fn }); return id; },
    clear: (h: unknown) => { pending.delete(h as number); },
  };
  const tracer = createTurnTracer((r) => out.push(r), () => t, timers);
  const advance = (ms: number) => {
    t += ms;
    for (const [k, p] of [...pending]) if (p.at <= t) { pending.delete(k); p.fn(); }
  };
  return { tracer, out, advance, now: () => t };
}

describe('turnTrace', () => {
  it('times a whole answered turn from the hotkey release, first mark of each stage winning', () => {
    const { tracer, out, advance, now } = rig();
    tracer.noteRelease(now());
    advance(40);
    tracer.arm(V);                                   // the stop() lands 40 ms after the edge
    advance(700); tracer.mark(V, 'stt'); tracer.sttAttempts(V, 1);
    advance(10); tracer.mark(V, 'sent');
    tracer.usage(V, { input: 3, cacheRead: 60_000, cacheCreation: 2_000, model: 'claude-sonnet-5-5' });
    tracer.usage(V, { input: 9, cacheRead: 1, cacheCreation: 1 });          // later frames ignored
    advance(2000); tracer.mark(V, 'firstToken');
    advance(1500); tracer.mark(V, 'firstText');
    advance(5); tracer.mark(V, 'firstToken'); tracer.mark(V, 'firstText');  // more deltas: no-ops
    advance(300); tracer.markSpeech('ttsAsked');
    advance(1200); tracer.markSpeech('ttsReady');
    tracer.markSpeech('audio', now() + 25);
    expect(out).toHaveLength(0);                     // still talking: no end yet
    advance(3000); tracer.mark(V, 'end');
    expect(out).toEqual([{
      kind: 'turn',
      outcome: 'answered',
      stages: { stt: 740, sent: 750, firstToken: 2750, firstText: 4250, ttsAsked: 4555, ttsReady: 5755, audio: 5780, end: 8755 },
      usage: { input: 3, cacheRead: 60_000, cacheCreation: 2_000, model: 'claude-sonnet-5-5' },
      toolsBeforeText: 0,
      sttAttempts: 1,
    }]);
  });

  it('a result before the first audio is written when the audio starts', () => {
    const { tracer, out, advance } = rig();
    tracer.arm(V); tracer.mark(V, 'stt'); tracer.mark(V, 'sent');
    advance(3000); tracer.mark(V, 'firstText'); tracer.mark(V, 'end');
    expect(out).toHaveLength(0);
    advance(400); tracer.markSpeech('ttsAsked');
    advance(1100); tracer.markSpeech('audio');
    expect(out[0].outcome).toBe('answered');
    expect(out[0].stages.audio).toBe(4500);
  });

  it('speech off: the turn is written as no_audio after the grace, with no audio stage at all', () => {
    const { tracer, out, advance } = rig();
    tracer.arm(V); tracer.mark(V, 'sent'); advance(2000); tracer.mark(V, 'end');
    advance(AFTER_END_MS - 1);
    expect(out).toHaveLength(0);
    advance(1);
    expect(out[0].outcome).toBe('no_audio');
    expect('audio' in out[0].stages).toBe(false);
  });

  it('counts only the tool calls before the first answer text', () => {
    const { tracer, out } = rig();
    tracer.arm(V);
    tracer.toolUse(V);                               // before the prompt: not this turn's
    tracer.mark(V, 'sent');
    tracer.toolUse(V); tracer.toolUse(V);
    tracer.mark(V, 'firstText');
    tracer.toolUse(V);
    tracer.mark(V, 'end'); tracer.markSpeech('audio');
    expect(out[0].toolsBeforeText).toBe(2);
  });

  it('ignores other vaults, and speech that belongs to the previous answer', () => {
    const { tracer, out, advance } = rig();
    tracer.arm('kader-matematik');                   // not the notch: nothing armed
    tracer.mark('kader-matematik', 'sent');
    expect(out).toHaveLength(0);
    tracer.arm(V);
    tracer.markSpeech('ttsAsked'); tracer.markSpeech('audio');   // still playing the last answer
    tracer.mark('kader-matematik', 'end');
    advance(500);
    tracer.mark(V, 'sent'); tracer.mark(V, 'end'); tracer.markSpeech('audio');
    expect(out).toHaveLength(1);
    expect(out[0].stages).toEqual({ sent: 500, end: 500, audio: 500 });
  });

  it('a silent take or a failed transcription is a record of its own, and nothing after it counts', () => {
    const { tracer, out } = rig();
    tracer.arm(V); tracer.drop(V, 'silent');
    tracer.arm(V); tracer.drop(V, 'stt_failed');
    tracer.mark(V, 'end');
    expect(out.map((r) => r.outcome)).toEqual(['silent', 'stt_failed']);
  });

  it('a new take supersedes an unfinished one, and a turn that never ends is abandoned', () => {
    const { tracer, out, advance } = rig();
    tracer.arm(V); tracer.mark(V, 'sent');
    tracer.arm(V);
    expect(out[0].outcome).toBe('superseded');
    advance(MAX_TURN_MS);
    expect(out[1].outcome).toBe('abandoned');
  });

  it('a stale hotkey release is not the start of a later take', () => {
    const { tracer, out, advance, now } = rig();
    tracer.noteRelease(now());
    advance(60_000);
    tracer.arm(V); tracer.mark(V, 'sent'); tracer.mark(V, 'end'); tracer.markSpeech('audio');
    expect(out[0].stages.sent).toBe(0);
  });

  it('the default timers are called as plain functions (a method-call setTimeout throws in a browser)', () => {
    const real = globalThis.setTimeout;
    const seen: unknown[] = [];
    globalThis.setTimeout = function (this: unknown, fn: () => void, ms?: number) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      seen.push(ms);
      return real(fn, ms);
    } as typeof setTimeout;
    try {
      const tracer = createTurnTracer(() => {});
      expect(() => tracer.arm(V)).not.toThrow();
      expect(seen).toEqual([MAX_TURN_MS]);
      tracer.drop(V, 'silent');
    } finally {
      globalThis.setTimeout = real;
    }
  });

  it('the page tracer swallows its own failures', () => {
    const tracer = guarded(createTurnTracer(() => { throw new Error('disk full'); }));
    tracer.arm(V);
    expect(() => tracer.drop(V, 'silent')).not.toThrow();
  });

  it('TRACED_VAULT mirrors the notch\'s ASSISTANT_VAULT', () => {
    const notch = readFileSync(new URL('../../dashboard/src/components/assistant/Notch.tsx', import.meta.url), 'utf-8');
    expect(notch).toMatch(new RegExp(`export const ASSISTANT_VAULT = '${TRACED_VAULT}'`));
  });
});

describe('parseTurnTrace', () => {
  it('keeps the known fields as Ms offsets and drops everything else', () => {
    expect(parseTurnTrace({
      kind: 'turn', outcome: 'answered',
      stages: { stt: 740.4, sent: 750, audio: 5780, end: -1, bogus: 3 },
      usage: { input: 3, cacheRead: 60000, cacheCreation: 2000, model: 'claude-sonnet-5-5', extra: 'x' },
      toolsBeforeText: 2, sttAttempts: 1, note: 'ignored',
    })).toEqual({
      kind: 'turn', outcome: 'answered', sttMs: 740, sentMs: 750, audioMs: 5780,
      input: 3, cacheRead: 60000, cacheCreation: 2000, model: 'claude-sonnet-5-5',
      toolsBeforeText: 2, sttAttempts: 1,
    });
  });

  it('refuses an unknown kind or outcome, and an odd model string', () => {
    expect(parseTurnTrace({ kind: 'turn', outcome: 'great' })).toBeNull();
    expect(parseTurnTrace({ kind: 'take', outcome: 'answered' })).toBeNull();
    expect(parseTurnTrace(null)).toBeNull();
    expect(parseTurnTrace({ kind: 'turn', outcome: 'silent', usage: { model: '<script>' } }))
      .toEqual({ kind: 'turn', outcome: 'silent' });
  });
});
