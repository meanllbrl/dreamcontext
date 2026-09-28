/**
 * `markdownToText` is what stands between an agent's `## Prompt` — an
 * operational markdown document — and a 300px card that has two lines to say
 * what the agent does. The owner's own screenshot is the fixture that matters:
 * a card reading `> **DURDURULDU 2026-09-19 (Day-44).** Cohort 3 paid spend'i
 * durdu` is the defect this function exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { markdownToText, summarize } from '../../dashboard/src/lib/markdownToText.js';

describe('markdownToText', () => {
  it('strips the exact shape the owner saw on a card', () => {
    const real = "> **DURDURULDU 2026-09-19 (Day-44).** Cohort 3 paid spend'i durdu: adset 1202535762419 >\nPAUSED (bütçe ₺1.500 dokunulmadı), kampanya kapandı.";
    const out = markdownToText(real);
    expect(out).not.toContain('**');
    expect(out).not.toMatch(/^>/);
    expect(out).toContain('DURDURULDU 2026-09-19 (Day-44).');
    expect(out).toContain("Cohort 3 paid spend'i durdu");
  });

  it('unwraps headings, lists, emphasis and links without eating the words', () => {
    expect(markdownToText('## Görev\n\n- **Her sabah** oku\n- [rapor](http://x) yaz'))
      .toBe('Görev Her sabah oku rapor yaz');
  });

  it('keeps inline code contents — an agent names real files and commands', () => {
    expect(markdownToText('Read `automations/output/x.md` then post'))
      .toBe('Read automations/output/x.md then post');
  });

  it('drops fenced blocks whole rather than leaking half a fence', () => {
    expect(markdownToText('Before\n```js\nconst x = 1;\n```\nAfter')).toBe('Before After');
  });

  it('collapses newlines — a card clamps by LINE, so a kept newline costs one', () => {
    expect(markdownToText('one\n\n\ntwo\n\nthree')).toBe('one two three');
  });

  it('is total on empty and syntax-only input', () => {
    expect(markdownToText('')).toBe('');
    expect(markdownToText('---')).toBe('');
    expect(markdownToText('> \n> \n')).toBe('');
  });
});

describe('summarize', () => {
  it('returns the whole thing untouched when it already fits, with no ellipsis', () => {
    expect(summarize('Short enough.', 150)).toBe('Short enough.');
  });

  it('cuts on a word boundary, never mid-word', () => {
    const out = summarize('Sen Tilki Öğretmen’in organik sosyal medya yöneticisisin ve kanallari yonetirsin', 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    // The last kept token is a whole word.
    expect(out.slice(0, -1).trim().split(' ').pop()).not.toBe('');
    expect('Sen Tilki Öğretmen’in organik sosyal medya yöneticisisin ve kanallari yonetirsin').toContain(
      out.slice(0, -1).trim().split(' ').pop()!,
    );
  });

  it('strips before it measures, so markup never eats the budget', () => {
    // 150 chars of `**` would otherwise consume most of the allowance.
    const bolded = `**${'word '.repeat(40)}**`;
    expect(summarize(bolded, 60)).not.toContain('*');
  });
});
