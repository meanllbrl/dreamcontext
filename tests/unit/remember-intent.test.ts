import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMEMBER_INTENT_LINE, detectRememberIntent } from '../../src/lib/remember-intent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, '../fixtures/learn/turns.synthetic.json'), 'utf-8')) as {
  intent: { explicit: string[]; reminders: string[]; questions: string[]; negatives: string[] };
};

describe('remember-intent (C4, criterion 4)', () => {
  it('the synthetic fixture has at least 40 explicit and 40 negative turns', () => {
    expect(fixture.intent.explicit.length).toBeGreaterThanOrEqual(40);
    const negatives = [...fixture.intent.reminders, ...fixture.intent.questions, ...fixture.intent.negatives];
    expect(negatives.length).toBeGreaterThanOrEqual(40);
  });

  it('flags at least 95% of the explicit asks', () => {
    const missed = fixture.intent.explicit.filter((t) => !detectRememberIntent(t));
    const share = 1 - missed.length / fixture.intent.explicit.length;
    expect(share, `missed: ${missed.join(' | ')}`).toBeGreaterThanOrEqual(0.95);
  });

  it('flags no reminder and no question', () => {
    const flagged = [...fixture.intent.reminders, ...fixture.intent.questions].filter((t) => detectRememberIntent(t));
    expect(flagged).toEqual([]);
  });

  it('flags none of the ordinary turns', () => {
    expect(fixture.intent.negatives.filter((t) => detectRememberIntent(t))).toEqual([]);
  });

  it('finds the ask in a later sentence and ignores empty input', () => {
    expect(detectRememberIntent('Fix the header. Also, bunu hatırla: başlıklar kısa olsun.')).toBe(true);
    expect(detectRememberIntent('')).toBe(false);
    expect(detectRememberIntent(null)).toBe(false);
  });

  it('the line names learn and asks for its line to be repeated, with no em dash', () => {
    expect(REMEMBER_INTENT_LINE).toContain('dreamcontext learn');
    expect(REMEMBER_INTENT_LINE).toContain('repeat its line');
    expect(REMEMBER_INTENT_LINE).not.toContain(String.fromCharCode(0x2014));
  });
});
