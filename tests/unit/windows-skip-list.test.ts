import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOWS_SKIPS } from '../windows-skip.js';

/** The Windows skip list is a record, not a dumping ground: every entry names a real test file
 *  once, with the reason it cannot pass on Windows. */
describe('tests/windows-skip.ts', () => {
  const root = join(__dirname, '..', '..');

  it('names only test files that exist, each once', () => {
    const files = WINDOWS_SKIPS.map((s) => s.file);
    expect(new Set(files).size).toBe(files.length);
    for (const f of files) {
      expect(f, f).toMatch(/^tests\/.+\.test\.ts$/);
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it('gives every entry a real reason', () => {
    for (const s of WINDOWS_SKIPS) expect(s.reason.trim().length, s.file).toBeGreaterThan(30);
  });
});
