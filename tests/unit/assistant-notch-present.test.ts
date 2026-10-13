/**
 * When the notch opens for a reply, and when it stays (owner, 2026-10-13): open, and stay until
 * closed, for a decision or approval, something to click, or a long or structured answer. The
 * Assistant's cue decides most of the time; `presentationOf` keeps the rule when it does not.
 * The notch's own open/fold behaviour is driven end to end by scripts/verify/assistant-present.mjs.
 */
import { describe, it, expect } from 'vitest';
import { presentationOf, LONG_ANSWER_CHARS } from '../../dashboard/src/lib/notchCue.js';

const present = { kind: 'present' as const, stay: false };
const progress = { kind: 'progress' as const, stay: false };

describe('presentationOf', () => {
  it('keeps the cue for a short spoken answer, and an uncued block is an answer', () => {
    expect(presentationOf(present, 'Tamam, açtım.')).toEqual({ kind: 'present', stay: false });
    expect(presentationOf(null, 'Tamam, açtım.')).toEqual({ kind: 'present', stay: false });
    expect(presentationOf({ kind: 'present', stay: true }, 'Hangisi?')).toEqual({ kind: 'present', stay: true });
  });

  it('STAYS for something to click, whatever the cue said', () => {
    const buttons = 'İki seçenek var.\n\n```dream-actions\n[{"label":"Aç","action":"task","id":"x"}]\n```';
    expect(presentationOf(present, buttons).stay).toBe(true);
    expect(presentationOf(null, '```dream-html\n<div class="dc-graph"></div>\n```').stay).toBe(true);
  });

  it('presents a progress line that carries buttons — a self-folding peek would take them away', () => {
    expect(presentationOf(progress, 'Bakıyorum.\n```dream-actions\n[]\n```')).toEqual({ kind: 'present', stay: true });
    expect(presentationOf(progress, 'Bakıyorum…')).toEqual(progress);
  });

  it('STAYS for a structured answer: a table or a list of three or more', () => {
    expect(presentationOf(present, '| Satıcı | Süre |\n|---|---|\n| Koçak | 14 gün |').stay).toBe(true);
    expect(presentationOf(present, '- bir\n- iki\n- üç').stay).toBe(true);
    expect(presentationOf(present, '- bir\n- iki').stay).toBe(false);
  });

  it(`STAYS for a long answer (> ${LONG_ANSWER_CHARS} characters)`, () => {
    expect(presentationOf(present, 'a '.repeat(LONG_ANSWER_CHARS)).stay).toBe(true);
    expect(presentationOf(present, 'a '.repeat(100)).stay).toBe(false);
  });
});
