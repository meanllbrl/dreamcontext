// resolveOnPath on Windows: PATHEXT-style names, no exec bit. Pure — the filesystem is injected
// and the paths are path.win32, so it runs the same on any host.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOnPath } from '../../src/lib/git-sync/git.js';

const files = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

describe('resolveOnPath (win32)', () => {
  it('finds git.exe in a Git for Windows cmd dir', () => {
    const exe = 'C:\\Program Files\\Git\\cmd\\git.exe';
    expect(resolveOnPath('git', 'C:\\Windows;C:\\Program Files\\Git\\cmd', 'win32', files(exe))).toBe(exe);
  });

  it('prefers .exe over .cmd and .bat in the same folder', () => {
    const dir = 'C:\\tools';
    const all = files(`${dir}\\git.bat`, `${dir}\\git.cmd`, `${dir}\\git.exe`);
    expect(resolveOnPath('git', dir, 'win32', all)).toBe(`${dir}\\git.exe`);
  });

  it('falls back to .cmd then .bat', () => {
    expect(resolveOnPath('git', 'C:\\a', 'win32', files('C:\\a\\git.bat', 'C:\\a\\git.cmd'))).toBe('C:\\a\\git.cmd');
    expect(resolveOnPath('git', 'C:\\a', 'win32', files('C:\\a\\git.bat'))).toBe('C:\\a\\git.bat');
  });

  it('keeps PATH order: an earlier dir wins over a later .exe', () => {
    const early = 'C:\\a\\git.cmd';
    expect(resolveOnPath('git', 'C:\\a;C:\\b', 'win32', files(early, 'C:\\b\\git.exe'))).toBe(early);
  });

  it('strips quoted entries and ignores empty ones', () => {
    const exe = 'C:\\Program Files\\Git\\cmd\\git.exe';
    expect(resolveOnPath('git', ';;"C:\\Program Files\\Git\\cmd"', 'win32', files(exe))).toBe(exe);
  });

  it('does not accept the bare name (no extension) and returns null when absent', () => {
    expect(resolveOnPath('git', 'C:\\a', 'win32', files('C:\\a\\git'))).toBeNull();
    expect(resolveOnPath('git', '', 'win32', () => true)).toBeNull();
  });
});

describe('resolveOnPath (POSIX unchanged)', () => {
  it('still requires the exec bit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-resolve-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'tool'), 'x', { mode: 0o644 });
      expect(resolveOnPath('tool', dir, 'linux')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
