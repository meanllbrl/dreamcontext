/**
 * `claude-limit-rejections.ts` — the memory that makes the fix STAY fixed.
 *
 * Reacting to a refusal without remembering it means the next turn re-reads the same
 * percentage that just lied, clears the walled account, and walks back into it. That is the
 * loop the 2026-09-05 screenshot captured: the user's "devam" came back byte-identical.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COOLDOWN_MS,
  claudeRejectionsFilePath,
  clearAccountRejection,
  readAccountRejections,
  recordAccountRejection,
} from '../../src/lib/claude-limit-rejections.js';
import type { LimitSignal } from '../../src/lib/claude-limit-signal.js';

const NOW = Date.parse('2026-09-05T00:00:00Z');
const HOUR = 3_600_000;

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(join(tmpdir(), 'dc-rejections-')); });
afterEach(() => { rmSync(HOME, { recursive: true, force: true }); });

const stated = (resetsAtMs: number): LimitSignal =>
  ({ window: 'session', resetsAtMs, via: 'quotaLimits', detail: 'group_zero_credit_limit' });
const guessed: LimitSignal = { window: 'unknown', resetsAtMs: null, via: 'syntheticText' };

describe('a refusal is written down', () => {
  it('a STATED reset becomes the exile, exactly', () => {
    const entry = recordAccountRejection('a', stated(NOW + 2 * HOUR), HOME, NOW);
    expect(entry.until).toBe(NOW + 2 * HOUR);
    expect(entry.estimated).toBeUndefined();
    expect(entry.window).toBe('session');
    expect(entry.detail).toBe('group_zero_credit_limit');
    expect(readAccountRejections(HOME, NOW).a?.until).toBe(NOW + 2 * HOUR);
  });

  it('no stated reset still records, on a bounded GUESS that says it is one', () => {
    // The text reader carries no time. Recording nothing there would make the weakest signal
    // also the most useless one — and the text reader is the one that cannot go missing.
    const entry = recordAccountRejection('a', guessed, HOME, NOW);
    expect(entry.until).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(entry.estimated).toBe(true);
  });

  it('a reset already in the PAST falls back to the guess, never to "not rejected"', () => {
    const entry = recordAccountRejection('a', stated(NOW - HOUR), HOME, NOW);
    expect(entry.until).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(entry.estimated).toBe(true);
  });

  it('an absurd reset is capped — one frame must not exile an account for a month', () => {
    const entry = recordAccountRejection('a', stated(NOW + 400 * 86_400_000), HOME, NOW);
    expect(entry.until).toBeLessThanOrEqual(NOW + 8 * 86_400_000);
  });
});

describe('it expires on its own', () => {
  it('an elapsed rejection is not returned', () => {
    recordAccountRejection('a', stated(NOW + HOUR), HOME, NOW);
    expect(readAccountRejections(HOME, NOW + 30 * 60_000).a).toBeDefined();
    expect(readAccountRejections(HOME, NOW + 2 * HOUR).a).toBeUndefined();
  });

  it('a probe that proves the window reopened can clear it early', () => {
    recordAccountRejection('a', stated(NOW + HOUR), HOME, NOW);
    clearAccountRejection('a', HOME, NOW);
    expect(readAccountRejections(HOME, NOW).a).toBeUndefined();
  });
});

describe('two panes share one quota', () => {
  it('the LONGER exile wins, so a guess cannot shorten a known reset', () => {
    // Pane 1 learned a real `resetsAt` two hours out. Pane 2 hit the same wall a second later
    // but only got the text reader, whose guess is 20 minutes. Letting the guess win would
    // send both panes back into the wall 100 minutes early.
    recordAccountRejection('a', stated(NOW + 2 * HOUR), HOME, NOW);
    const merged = recordAccountRejection('a', guessed, HOME, NOW + 1000);
    expect(merged.until).toBe(NOW + 2 * HOUR);
    expect(merged.estimated).toBeUndefined();
  });

  it('but a LATER stated reset does extend it', () => {
    recordAccountRejection('a', guessed, HOME, NOW);
    const merged = recordAccountRejection('a', stated(NOW + 3 * HOUR), HOME, NOW + 1000);
    expect(merged.until).toBe(NOW + 3 * HOUR);
    expect(merged.estimated).toBeUndefined();
  });

  it('accounts do not contaminate each other', () => {
    recordAccountRejection('a', stated(NOW + HOUR), HOME, NOW);
    recordAccountRejection('b', stated(NOW + 2 * HOUR), HOME, NOW);
    const all = readAccountRejections(HOME, NOW);
    expect(all.a!.until).toBe(NOW + HOUR);
    expect(all.b!.until).toBe(NOW + 2 * HOUR);
  });
});

describe('totality — a bad file degrades to the old behaviour, never to a crash', () => {
  it('a missing file reads as "nothing is rejected"', () => {
    expect(readAccountRejections(HOME, NOW)).toEqual({});
  });

  it('malformed JSON reads as "nothing is rejected"', () => {
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeRejectionsFilePath(HOME), '{not json', 'utf-8');
    expect(readAccountRejections(HOME, NOW)).toEqual({});
  });

  it('entries with an unusable `until` are dropped, not defaulted', () => {
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeRejectionsFilePath(HOME), JSON.stringify({
      rejected: { a: { until: 'soon' }, b: {}, c: { until: NOW + HOUR } },
    }), 'utf-8');
    expect(Object.keys(readAccountRejections(HOME, NOW))).toEqual(['c']);
  });

  it('an unrecognised window reads as `unknown`, so the surface never claims a wrong cap', () => {
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeRejectionsFilePath(HOME), JSON.stringify({
      rejected: { a: { until: NOW + HOUR, window: 'fortnightly' } },
    }), 'utf-8');
    expect(readAccountRejections(HOME, NOW).a!.window).toBe('unknown');
  });
});
