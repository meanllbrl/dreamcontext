// Windows claude resolution — pure: path.win32 + injected exists/listDir, so it runs on any host.
import { describe, it, expect } from 'vitest';
import { resolveWin32ClaudeBin, whichOnPathWin32, win32ClaudeFallback } from '../../src/lib/claude-path.js';

const HOME = 'C:\\Users\\me';
const ENV = { LOCALAPPDATA: `${HOME}\\AppData\\Local`, APPDATA: `${HOME}\\AppData\\Roaming` };

function probe(files: string[], env: NodeJS.ProcessEnv = {}, packages: string[] = []) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    env: { ...ENV, ...env },
    home: HOME,
    exists: (p: string) => set.has(p.toLowerCase()),
    listDir: () => packages,
  };
}

describe('resolveWin32ClaudeBin', () => {
  it('a claude.exe on PATH wins over the known install folders', () => {
    const onPath = 'C:\\tools\\claude.exe';
    const known = `${HOME}\\.local\\bin\\claude.exe`;
    expect(resolveWin32ClaudeBin(probe([onPath, known], { PATH: 'C:\\tools' }))).toBe(onPath);
  });

  it('follows an npm .cmd shim to the claude.exe it wraps', () => {
    const dir = `${HOME}\\AppData\\Roaming\\npm`;
    const exe = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(resolveWin32ClaudeBin(probe([`${dir}\\claude.cmd`, exe], { PATH: dir }))).toBe(exe);
  });

  it('skips a .cmd shim whose target is missing (it cannot be spawned without a shell)', () => {
    const dir = `${HOME}\\AppData\\Roaming\\npm`;
    expect(resolveWin32ClaudeBin(probe([`${dir}\\claude.cmd`], { PATH: dir }))).toBeNull();
  });

  it('finds the npm global bin even when PATH is empty', () => {
    const dir = `${HOME}\\AppData\\Roaming\\npm`;
    const exe = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(resolveWin32ClaudeBin(probe([`${dir}\\claude.cmd`, exe]))).toBe(exe);
  });

  it('falls back to the WinGet package folder', () => {
    const pkg = 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe';
    const exe = `${HOME}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\${pkg}\\claude.exe`;
    expect(resolveWin32ClaudeBin(probe([exe], {}, ['Other.Thing', pkg]))).toBe(exe);
  });

  it('strips quotes around PATH entries', () => {
    const exe = 'C:\\Program Files\\Claude\\claude.exe';
    expect(resolveWin32ClaudeBin(probe([exe], { PATH: '"C:\\Program Files\\Claude";C:\\x' }))).toBe(exe);
  });

  it('reads a mixed-case Path key', () => {
    const exe = 'C:\\tools\\claude.exe';
    expect(resolveWin32ClaudeBin(probe([exe], { Path: 'C:\\tools' }))).toBe(exe);
  });

  it('returns null when nothing is installed', () => {
    expect(resolveWin32ClaudeBin(probe([]))).toBeNull();
  });
});

describe('whichOnPathWin32', () => {
  it('finds npm.cmd on PATH', () => {
    const npm = 'C:\\Program Files\\nodejs\\npm.cmd';
    const exists = (p: string) => p === npm;
    expect(whichOnPathWin32(['npm.cmd', 'npm.exe'], { PATH: 'C:\\x;C:\\Program Files\\nodejs' }, exists)).toBe(npm);
  });

  it('returns null when absent', () => {
    expect(whichOnPathWin32(['npm.cmd'], { PATH: 'C:\\x' }, () => false)).toBeNull();
  });

  it('never looks in a relative PATH entry (that is the working folder again)', () => {
    const probed: string[] = [];
    whichOnPathWin32(['npm.cmd'], { PATH: '.;bin;C:\\x' }, (p) => { probed.push(p); return false; });
    expect(probed).toEqual(['C:\\x\\npm.cmd']);
  });
});

describe('win32ClaudeFallback', () => {
  it('is an absolute path under the profile, never the bare name', () => {
    expect(win32ClaudeFallback('C:\\Users\\me')).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
  });
});
