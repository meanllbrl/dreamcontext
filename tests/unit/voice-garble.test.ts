/**
 * The garble score and the pick (task sesli-giris-bozuk…, AC2/AC3/AC5). Every fixture here is
 * SYNTHETIC: the owner's own takes are never committed; their measured numbers (good takes
 * -0.02..-0.14, weak -0.57/-0.80, Icelandic misdetections -0.67..-1.04) set the values.
 */

import { describe, it, expect } from 'vitest';
import { score, pick, compressionRatio, hasRepeatedNgram, weightedLogprob, type ScoredInput } from '../../src/lib/voice/garble.js';

const seg = (avg_logprob: number, no_speech_prob = 0.01, start = 0, end = 3) => ({ start, end, avg_logprob, no_speech_prob });
const pass = (over: Partial<ScoredInput>): ScoredInput => ({
  text: 'Ne durumdayız, nasıl gidiyor?', language: 'tr', forced: true, segments: [seg(-0.08)], ...over,
});
const TR = { set: ['tr'] };

describe('score', () => {
  it('a good Turkish take is clean', () => {
    expect(score(pass({}), TR)).toMatchObject({ verdict: 'clean', reasons: [], scriptFlag: false, inContext: true });
  });

  it('Icelandic spelling of a Turkish take, detected under auto: weak and out of context, never clean', () => {
    const s = score(pass({ text: 'Nei þurfum það í skanki, hvað segirðu?', language: 'is', forced: false, segments: [seg(-0.67)] }), TR);
    expect(s.verdict).toBe('garbled');
    expect(s.reasons).toEqual(expect.arrayContaining(['weak', 'out-of-context']));
    // Unclear and out of context: read against the context's alphabet too.
    expect(s.scriptFlag).toBe(true);
  });

  it('out of context and only mildly weak: suspect', () => {
    const s = score(pass({ text: 'Hallo wie geht es', language: 'de', forced: false, segments: [seg(-0.4)] }), TR);
    expect(s.verdict).toBe('suspect');
    expect(s.reasons).toContain('out-of-context');
  });

  it('a single ð under tr is suspect and flags the script', () => {
    const s = score(pass({ text: 'Ne durumdayız, nasıl gidiyorð' }), TR);
    expect(s.verdict).toBe('suspect');
    expect(s.scriptFlag).toBe(true);
  });

  it('AC3: a clear take in a NEW language is accepted (German at -0.15, no other signal)', () => {
    const s = score(pass({ text: 'Wie spät ist es heute Abend?', language: 'de', forced: false, segments: [seg(-0.15)] }), TR);
    expect(s).toMatchObject({ verdict: 'clean', inContext: false, scriptFlag: false });
  });

  it('weak thresholds: below -0.5 garbled, -0.5..-0.35 suspect', () => {
    expect(score(pass({ segments: [seg(-0.57)] }), TR).verdict).toBe('garbled');
    expect(score(pass({ segments: [seg(-0.4)] }), TR).verdict).toBe('suspect');
    expect(score(pass({ segments: [seg(-0.3)] }), TR).verdict).toBe('clean');
  });

  it('the logprob is duration-weighted', () => {
    expect(weightedLogprob([seg(-0.1, 0, 0, 9), seg(-1, 0, 9, 10)])).toBeCloseTo(-0.19, 2);
    expect(weightedLogprob([])).toBeNull();
  });

  it('AC5: a loop is garbled (repeated n-gram and compression ratio)', () => {
    const loop = 'bir yürüyen bir yürüyen bir yürüyen bir yürüyen bir yürüyen';
    expect(hasRepeatedNgram(loop)).toBe(true);
    expect(hasRepeatedNgram('bir yürüyen adam gördüm, bir yürüyen kadın')).toBe(false);
    expect(compressionRatio('tamam '.repeat(40))).toBeGreaterThan(2.4);
    expect(score(pass({ text: loop }), TR)).toMatchObject({ verdict: 'garbled', loop: true });
  });

  it('AC5: no speech above 0.6 while text exists is garbled', () => {
    expect(score(pass({ segments: [seg(-0.1, 0.8)] }), TR).verdict).toBe('garbled');
  });

  it('an EMPTY transcript is never garbled, however weak (a breath stays "nothing heard", review)', () => {
    expect(score(pass({ text: '  ', segments: [seg(-0.9)] }), TR).verdict).toBe('clean');
  });

  it('no segments (an old server) is not a signal by itself', () => {
    expect(score(pass({ segments: [] }), TR).verdict).toBe('clean');
  });

  it('an empty context set accepts any language', () => {
    expect(score(pass({ language: 'de', text: 'Guten Morgen', forced: false }), { set: [] }).verdict).toBe('clean');
  });
});

describe('pick', () => {
  const cand = (p: Partial<ScoredInput>, ctx = TR) => { const x = pass(p); return { pass: x, score: score(x, ctx) }; };

  it('a forced Turkish retry beats the Icelandic first pass', () => {
    const first = cand({ text: 'Nei þurfum það í skanki', language: 'is', forced: false, segments: [seg(-0.8)] });
    const second = cand({ segments: [seg(-0.1)] });
    expect(pick([first, second])).toMatchObject({ verdict: 'clean', winner: second });
  });

  it('a script-flagged in-context suspect loses to an unflagged out-of-context suspect', () => {
    const flagged = cand({ text: 'Ne durumdayız ð', segments: [seg(-0.1)] });
    const outside = cand({ text: 'Hallo wie geht es', language: 'de', forced: false, segments: [seg(-0.4)] });
    expect(flagged.score.verdict).toBe('suspect');
    expect(outside.score.verdict).toBe('suspect');
    expect(pick([flagged, outside]).winner).toBe(outside);
  });

  it('a script-flagged WINNER under tr/en is garbled: never sent', () => {
    const only = cand({ text: 'Ne durumdayız ð', segments: [seg(-0.1)] });
    expect(pick([only]).verdict).toBe('garbled');
  });

  it('both garbled: garbled', () => {
    expect(pick([cand({ segments: [seg(-0.8)] }), cand({ segments: [seg(-0.9)] })]).verdict).toBe('garbled');
  });

  it('a tie on verdict goes to the higher logprob', () => {
    const a = cand({ segments: [seg(-0.4)] });
    const b = cand({ segments: [seg(-0.36)] });
    expect(pick([a, b]).winner).toBe(b);
  });
});
