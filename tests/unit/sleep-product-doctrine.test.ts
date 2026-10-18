/**
 * The old "sleep never folds a user correction into a pattern" rule is gone
 * everywhere it was written (C7 card criterion 1; plan r3 § W3, r4 R4-3 M1).
 *
 * The owner never made that decision (2026-10-15) and wants the opposite: a
 * style or rule the owner repeated becomes a pattern. Each file worded the ban
 * its own way, so each is checked for its own phrases, and each must name the
 * writer that replaced the ban (`patterns learn`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf-8');

const BANNED: Record<string, string[]> = {
  'agents/sleep-product.md': [
    'Never fold a user correction into a pattern',
    'never silently rewritten',
  ],
  'skill/references/sleep.md': [
    'Sleep does NOT fold user corrections into patterns',
    'NOT their content',
    'nobody can defend later',
    'rather than quietly rewriting it',
  ],
  'skill/references/sleep-specialists.md': [
    'the one place sleep folds corrections into a pattern by itself',
    'Pattern *content* is not yours to change on a user correction',
  ],
  'skill/references/knowledge-and-recall.md': [
    'not a sleep chore',
    'Why it cannot wait for sleep',
    'which no longer folds corrections in',
  ],
  'src/cli/commands/hook.ts': [
    'not a sleep chore',
  ],
};

const MUST_NAME_THE_WRITER = [
  'agents/sleep-product.md',
  'skill/references/sleep.md',
  'skill/references/sleep-specialists.md',
  'skill/references/knowledge-and-recall.md',
];

describe('the sleep-never-folds-corrections ban is lifted', () => {
  for (const [file, phrases] of Object.entries(BANNED)) {
    for (const phrase of phrases) {
      it(`${file} no longer says "${phrase}"`, () => {
        expect(read(file)).not.toContain(phrase);
      });
    }
  }

  for (const file of MUST_NAME_THE_WRITER) {
    it(`${file} names \`patterns learn\``, () => {
      expect(read(file)).toContain('patterns learn');
    });
  }

  it('sleep-state B0a routes a repeated style correction to sleep-product', () => {
    const text = read('agents/sleep-state.md');
    const b0a = text.slice(text.indexOf('#### B0a.'), text.indexOf('#### B0b.'));
    expect(b0a).toContain('pattern signal for sleep-product');
  });

  it('the awake fast path stays: the hook still tells the agent to keep injected patterns true', () => {
    expect(read('src/cli/commands/hook.ts')).toContain('AND KEEP THEM TRUE');
  });
});
