/**
 * Unit tests for agentSession.ts's `nextLineShadow` — the pure transition behind the
 * terminal's readline line-shadow. `Session.runCommand` (the draft-preserving `/model` /
 * `/effort` switch) replays this log into a fresh prompt, so the reset rules are
 * load-bearing: a wrong "still drafting" call replays stale bytes; a wrong "submitted"
 * call loses the user's draft.
 */
import { describe, it, expect } from 'vitest';
import { nextLineShadow } from '../../dashboard/src/lib/lineShadow.js';

const fold = (chunks: string[]) => chunks.reduce(nextLineShadow, '');

describe('nextLineShadow', () => {
  it('accumulates ordinary typed chunks verbatim (per-keystroke and pasted)', () => {
    expect(fold(['h', 'e', 'llo '])).toBe('hello ');
  });

  it('keeps editing bytes in the log unparsed — replay is what reproduces their effect', () => {
    expect(fold(['abc', '\x7f', '\x17', '\x1b[D'])).toBe('abc\x7f\x17\x1b[D');
  });

  it('a bare Enter chunk empties the shadow (the line was submitted)', () => {
    expect(fold(['hello', '\r'])).toBe('');
  });

  it('a composer-style submit (text with trailing \\r in ONE chunk) also empties it', () => {
    expect(fold(['draft ', 'send this\r'])).toBe('');
  });

  it('the ⇧↵ continuation (\\\\\\r — newline WITHOUT submit) stays part of the draft', () => {
    expect(fold(['line one', '\\\r', 'line two'])).toBe('line one\\\rline two');
  });

  it('a lone Ctrl+C or Esc empties the shadow (line cleared / turn aborted)', () => {
    expect(fold(['half a thought', '\x03'])).toBe('');
    expect(fold(['half a thought', '\x1b'])).toBe('');
  });

  it('an Esc-prefixed SEQUENCE (arrow key) is not a lone Esc — it appends', () => {
    expect(fold(['ab', '\x1b[A'])).toBe('ab\x1b[A');
  });

  it('an empty chunk is a no-op', () => {
    expect(fold(['abc', ''])).toBe('abc');
  });

  it('typing resumes cleanly after a submit', () => {
    expect(fold(['first message', '\r', 'second '])).toBe('second ');
  });
});
