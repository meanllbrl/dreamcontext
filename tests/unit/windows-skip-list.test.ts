import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOWS_SKIPS } from '../windows-skip.js';

/** The Windows skip list is a record, not a dumping ground: every entry names a real test file
 *  once, with the reason it cannot pass on Windows. */
describe('tests/windows-skip.ts', () => {
  const root = join(__dirname, '..', '..');

  it('names only test files that exist, each whole-file entry once', () => {
    const files = WINDOWS_SKIPS.filter((s) => !s.test).map((s) => s.file);
    expect(new Set(files).size).toBe(files.length);
    const keys = WINDOWS_SKIPS.map((s) => `${s.file}::${s.test ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of WINDOWS_SKIPS.map((s) => s.file)) {
      expect(f, f).toMatch(/^tests\/.+\.test\.ts$/);
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it('gives every entry a real reason', () => {
    for (const s of WINDOWS_SKIPS) expect(s.reason.trim().length, s.file).toBeGreaterThan(30);
  });

  it('a per-test entry matches its file and test name only', async () => {
    const { matchesSkip } = await import('../setup/windows-skips.js');
    const e = { file: 'tests/unit/a.test.ts', test: 'suite > one', reason: 'x'.repeat(40) };
    expect(matchesSkip(e, 'D:\\r\\tests\\unit\\a.test.ts', 'tests/unit/a.test.ts > suite > one thing')).toBe(true);
    expect(matchesSkip(e, '/r/tests/unit/b.test.ts', 'suite > one')).toBe(false);
    expect(matchesSkip(e, '/r/tests/unit/a.test.ts', 'suite > two')).toBe(false);
    expect(matchesSkip({ file: e.file, reason: e.reason }, '/r/tests/unit/a.test.ts', 'suite > one')).toBe(false);
  });
});
