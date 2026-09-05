/**
 * `claude-limit-signal.ts` — reading the API's OWN refusal off the stream.
 *
 * The frames in this file are not invented. `REAL_REJECTION` is copied field-for-field out
 * of a transcript written by CLI 2.1.260 on a turn that was actually refused, which is the
 * only reason the readers can be trusted to look for the right spellings.
 *
 * The rule the false-positive tests protect: a MISSED signal costs one visible limit error
 * (the status quo), while a FALSE one restarts a healthy conversation on another account and
 * bills it there. So the cheap reader is gated hard, and the gate is tested from both sides.
 */
import { describe, it, expect } from 'vitest';
import { readLimitSignal } from '../../src/lib/claude-limit-signal.js';

/** Verbatim from a real refused turn — see the module header. */
const REAL_REJECTION = {
  type: 'assistant',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: "You've hit your session limit · resets 9:30pm (Europe/Istanbul)" }],
  },
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  quotaLimits: {
    status: 'rejected',
    resetsAt: 1788546600,
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'group_zero_credit_limit',
    isUsingOverage: false,
  },
};

describe('the real frame', () => {
  it('reads the window, the true reset and the reason', () => {
    const sig = readLimitSignal(REAL_REJECTION)!;
    expect(sig).not.toBeNull();
    expect(sig.via).toBe('quotaLimits');
    // `five_hour` is the CLI's name for what every surface here calls the SESSION window.
    expect(sig.window).toBe('session');
    // Epoch SECONDS on this frame, millis everywhere else on our wire.
    expect(sig.resetsAtMs).toBe(1788546600 * 1000);
    expect(sig.detail).toBe('group_zero_credit_limit');
  });

  it('survives losing its structured half — the text alone still fires', () => {
    // Whether a given CLI build puts `quotaLimits`/`error` on the STREAM frame as well as in
    // the transcript is not ours to assume. The synthetic text provably arrives: the user
    // read it in a surface that renders nothing but stream frames.
    const { quotaLimits: _q, error: _e, apiErrorStatus: _a, isApiErrorMessage: _i, ...textOnly } = REAL_REJECTION;
    const sig = readLimitSignal(textOnly)!;
    expect(sig.via).toBe('syntheticText');
    expect(sig.window).toBe('session');
    expect(sig.resetsAtMs).toBeNull();
  });

  it('fires on the error flags when only they survive', () => {
    const sig = readLimitSignal({ type: 'assistant', error: 'rate_limit', apiErrorStatus: 429 })!;
    expect(sig.via).toBe('apiError');
    expect(sig.window).toBe('unknown');
  });

  it('reads a weekly refusal as weekly', () => {
    const sig = readLimitSignal({
      ...REAL_REJECTION,
      quotaLimits: { ...REAL_REJECTION.quotaLimits, rateLimitType: 'seven_day' },
    })!;
    expect(sig.window).toBe('weekly');
  });

  it('reads a dedicated rate_limit_event frame', () => {
    const sig = readLimitSignal({ type: 'rate_limit_event', rateLimitType: 'five_hour', resetsAt: 1788546600 })!;
    expect(sig.via).toBe('rateLimitEvent');
    expect(sig.window).toBe('session');
    expect(sig.resetsAtMs).toBe(1788546600 * 1000);
  });
});

describe('a false positive is the expensive direction', () => {
  it('an ORDINARY assistant turn quoting the banner is not a refusal', () => {
    // This exact file does that. So does any agent explaining the feature. The gate is the
    // model name: a real turn always names a real model, never `<synthetic>`.
    const sig = readLimitSignal({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'text', text: "The CLI says: You've hit your session limit · resets 4:10am" }],
      },
    });
    expect(sig).toBeNull();
  });

  it('a USER frame typing the same words is not a refusal', () => {
    const sig = readLimitSignal({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: "I've hit your session limit again?" }] },
    });
    expect(sig).toBeNull();
  });

  it('an unrelated synthetic bubble is not a refusal', () => {
    // `/effort` answers with exactly this shape, on every effort change.
    const sig = readLimitSignal({
      type: 'assistant',
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'Set effort level to high' }] },
    });
    expect(sig).toBeNull();
  });

  it('the bare word "limit" is not enough', () => {
    for (const text of [
      'The rate limit on their API is 100 req/s.',
      'We hit the context limit, so I compacted.',
      'Their spending limit is configurable.',
    ]) {
      expect(readLimitSignal({
        type: 'assistant',
        message: { model: '<synthetic>', content: [{ type: 'text', text }] },
      })).toBeNull();
    }
  });

  it('quotaLimits that ALLOWED the turn is not a refusal', () => {
    const sig = readLimitSignal({
      type: 'assistant',
      message: { model: 'claude-opus-5', content: [] },
      quotaLimits: { status: 'allowed', resetsAt: 1788546600, rateLimitType: 'five_hour' },
    });
    expect(sig).toBeNull();
  });

  it('a 429 that is NOT a rate limit does not fire — an outage is not a quota', () => {
    expect(readLimitSignal({ type: 'assistant', apiErrorStatus: 429, isApiErrorMessage: true })).toBeNull();
    expect(readLimitSignal({ type: 'assistant', error: 'overloaded', apiErrorStatus: 529 })).toBeNull();
  });
});

describe('totality — the relay runs this on every line', () => {
  it('ordinary traffic returns null without throwing', () => {
    for (const frame of [
      null, undefined, 42, 'a string', [], {},
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', is_error: false },
      { type: 'stream_event', event: { type: 'content_block_delta' } },
      { type: 'assistant', message: { model: 'claude-opus-5', content: 'plain string content' } },
    ]) {
      expect(readLimitSignal(frame)).toBeNull();
    }
  });

  it('a malformed reset yields an ABSENT time, never a fabricated one', () => {
    const bad = (resetsAt: unknown) => readLimitSignal({
      quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt },
    })!.resetsAtMs;
    expect(bad('not a date')).toBeNull();
    expect(bad(-1)).toBeNull();
    expect(bad(null)).toBeNull();
    // A reset years out is a shape change, not a reset.
    expect(bad(Date.now() + 900 * 86_400_000)).toBeNull();
  });

  it('an ISO reset is read too, in case a build sends one', () => {
    const at = '2026-09-05T04:19:59.000Z';
    const sig = readLimitSignal({ quotaLimits: { status: 'rejected', resetsAt: at, rateLimitType: 'five_hour' } })!;
    expect(sig.resetsAtMs).toBe(Date.parse(at));
  });
});
