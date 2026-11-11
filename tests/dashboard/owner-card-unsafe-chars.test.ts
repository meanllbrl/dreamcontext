/**
 * The dashboard's copy of the Telegram run path's refusal rules (sahip-karti-yerinde K4, K7):
 * dashboard/src/lib/unsafeChars.ts MIRRORS src/server/telegram/runs.ts `UNSAFE_CHARS` and its
 * 8-space rule. This test reads the server file BY PATH and fails when either side drifts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BAR_COMMAND_MAX, SPACE_RUN, UNSAFE_CHARS, barCanRun, commandUnsafe, escapeUnsafe,
} from '../../dashboard/src/lib/unsafeChars.js';

const RUNS = readFileSync(join(__dirname, '../../src/server/telegram/runs.ts'), 'utf-8');

describe('unsafeChars mirrors the Telegram run path', () => {
  it('UNSAFE_CHARS matches exactly the characters the server pattern matches', () => {
    // By MEANING, not by text: both sides are compiled and every code point is tried, so an
    // escaped and a raw spelling of the same character class compare equal, and any real
    // difference (a range added or dropped on either side) names the first code point that differs.
    const m = /const UNSAFE_CHARS = \/(.+)\/([a-z]*);\s*$/m.exec(RUNS);
    expect(m, 'UNSAFE_CHARS not found in src/server/telegram/runs.ts').not.toBeNull();
    const server = new RegExp(m![1], m![2]);
    expect(UNSAFE_CHARS.flags).toBe(server.flags);
    const differs: string[] = [];
    for (let cp = 0; cp <= 0xffff && differs.length < 5; cp++) {
      const ch = String.fromCharCode(cp);
      if (UNSAFE_CHARS.test(ch) !== server.test(ch)) differs.push(cp.toString(16));
    }
    expect(differs).toEqual([]);
    // A sanity row: the two line terminators and a bidi override are in both.
    for (const ch of ['\u2028', '\u2029', '\u202e', '\u3164']) expect(UNSAFE_CHARS.test(ch)).toBe(true);
  });

  it('the dashboard copy is pure ASCII source (a raw U+2028 would end the regex literal)', () => {
    const src = readFileSync(join(__dirname, '../../dashboard/src/lib/unsafeChars.ts'), 'utf-8');
    const line = src.split('\n').find((l) => l.startsWith('export const UNSAFE_CHARS')) ?? '';
    expect(line).not.toBe('');
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
  });

  it('the 8-space rule is the server one', () => {
    const fn = /export function commandShowable[\s\S]*?\n}/.exec(RUNS)?.[0] ?? '';
    expect(fn).toContain(`/${SPACE_RUN.source}/.test(command)`);
    expect(fn).toContain('UNSAFE_CHARS.test(command)');
  });
});

describe('a command that could hide what runs', () => {
  it('is drawn with visible escapes and gets no Run', () => {
    const rlo = 'echo safe\u202e;rm -rf tmp';
    expect(commandUnsafe(rlo)).toBe(true);
    expect(escapeUnsafe(rlo)).toBe('echo safe\\u{202e};rm -rf tmp');
    expect(barCanRun(rlo)).toBe(false);
  });

  it('a run of 8 spaces is drawn as an escape with its length', () => {
    const cmd = `npm test${' '.repeat(12)}&& curl x`;
    expect(commandUnsafe(cmd)).toBe(true);
    expect(escapeUnsafe(cmd)).toBe('npm test\\u{20}×12&& curl x');
  });

  it('a zero-width or control character is escaped', () => {
    expect(escapeUnsafe('a\u200bb')).toBe('a\\u{200b}b');
    expect(escapeUnsafe('a\x07b')).toBe('a\\u{7}b');
  });

  it('a safe command is unchanged and may run on the bar when short enough', () => {
    const cmd = 'node scripts/verify/look-export.mjs --widths 1440,390';
    expect(commandUnsafe(cmd)).toBe(false);
    expect(escapeUnsafe(cmd)).toBe(cmd);
    expect(barCanRun(cmd)).toBe(true);
  });

  it('a command too long for the row gets Show on the bar, never ▶ Run', () => {
    const long = `node scripts/x.mjs ${'--flag value '.repeat(20)}`.trim();
    expect(long.length).toBeGreaterThan(BAR_COMMAND_MAX);
    expect(commandUnsafe(long)).toBe(false);
    expect(barCanRun(long)).toBe(false);
  });
});
