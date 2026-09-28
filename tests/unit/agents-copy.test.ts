/**
 * The #agents page's copy carries no em dash (owner rule: user-visible text never does).
 *
 * A TEXT SCAN of `I18nContext.tsx`, because root vitest cannot import a dashboard `.tsx`. It
 * reads only the string VALUES of the `agents.*` and `scheduler.*` keys, so a comment in that
 * block is free to use whatever punctuation it likes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const I18N = join(import.meta.dirname, '..', '..', 'dashboard', 'src', 'context', 'I18nContext.tsx');

function values(prefixes: string[]): { key: string; value: string }[] {
  const src = readFileSync(I18N, 'utf-8');
  const out: { key: string; value: string }[] = [];
  // 'key': 'value' or 'key': "value" (a value with an apostrophe is double-quoted).
  const re = /'([a-zA-Z0-9_.]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (prefixes.some((p) => m![1].startsWith(p))) out.push({ key: m[1], value: m[2] ?? m[3] ?? '' });
  }
  return out;
}

describe('#agents copy', () => {
  const rows = values(['agents.', 'scheduler.']);

  it('finds the keys it is meant to scan', () => {
    // Guards the scan itself: a regex that matched nothing would pass the next test vacuously.
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.some((r) => r.key === 'agents.thread.stale')).toBe(true);
    expect(rows.some((r) => r.key === 'scheduler.toast.offFailed')).toBe(true);
  });

  it('no agents.* or scheduler.* string contains an em dash', () => {
    expect(rows.filter((r) => r.value.includes('—')).map((r) => r.key)).toEqual([]);
  });
});
