// Mac mode's remembered choices (Bag mode): prefs.json outlives a run, reads the default when
// missing or unreadable, and is written 0600 through a temp file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { macPrefsPathOf, readMacPrefs, writeMacPrefs } from '../../src/lib/handsfree/mac/prefs.js';
import { MAC_BAG_MODE_DEFAULT } from '../../src/lib/handsfree/mac/contract.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mac-prefs-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('mac prefs', () => {
  it('lives in ~/.dreamcontext/handsfree-mac/prefs.json', () => {
    expect(macPrefsPathOf(home)).toBe(join(home, '.dreamcontext', 'handsfree-mac', 'prefs.json'));
  });

  it('never chosen: Bag mode on (the default)', () => {
    expect(MAC_BAG_MODE_DEFAULT).toBe(true);
    expect(readMacPrefs(home)).toEqual({ bagMode: true });
  });

  it('an unreadable or malformed file reads as the default, never a throw', () => {
    mkdirSync(dirname(macPrefsPathOf(home)), { recursive: true });
    for (const bad of ['{', '{"bagMode":"no"}', '[]', 'null', '{}']) {
      writeFileSync(macPrefsPathOf(home), bad);
      expect(readMacPrefs(home)).toEqual({ bagMode: MAC_BAG_MODE_DEFAULT });
    }
  });

  it('write then read: the choice is remembered, 0600, no temp file left, the folder made 0700', () => {
    writeMacPrefs(home, { bagMode: false });
    expect(readMacPrefs(home)).toEqual({ bagMode: false });
    if (process.platform !== 'win32') expect(statSync(macPrefsPathOf(home)).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    const dir = dirname(macPrefsPathOf(home));
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700); // Windows has no POSIX mode bits
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    writeMacPrefs(home, { bagMode: true });
    expect(readMacPrefs(home)).toEqual({ bagMode: true });
  });

  it('a failed write is reported, not thrown', () => {
    // A FILE where the folder should be: mkdir fails.
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'handsfree-mac'), 'not a folder');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => writeMacPrefs(home, { bagMode: false })).not.toThrow();
      expect(warn).toHaveBeenCalledWith('[handsfree-mac] could not save the bag-mode choice:', expect.any(String));
    } finally { warn.mockRestore(); }
    expect(existsSync(macPrefsPathOf(home))).toBe(false);
  });
});
