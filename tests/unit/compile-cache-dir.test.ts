import { describe, it, expect } from 'vitest';
import { compileCacheDir } from '../../src/cli/compile-cache-dir.js';

/**
 * The compile cache is code the CLI runs, so its folder is always under the user's own absolute
 * home, never a temp folder and never a relative path (which would resolve inside the project).
 */
describe('compileCacheDir', () => {
  it('uses the user cache folder of each platform', () => {
    expect(compileCacheDir('darwin', {}, '/Users/ada')).toBe('/Users/ada/Library/Caches/dreamcontext/node-compile-cache');
    expect(compileCacheDir('linux', {}, '/home/ada')).toBe('/home/ada/.cache/dreamcontext/node-compile-cache');
    expect(compileCacheDir('linux', { XDG_CACHE_HOME: '/data/cache' }, '/home/ada')).toBe('/data/cache/dreamcontext/node-compile-cache');
    expect(compileCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'C:\\Users\\ada'))
      .toBe('C:\\Users\\ada\\AppData\\Local\\dreamcontext\\node-compile-cache');
    expect(compileCacheDir('win32', {}, 'C:\\Users\\ada')).toBe('C:\\Users\\ada\\AppData\\Local\\dreamcontext\\node-compile-cache');
  });

  it('never follows TMPDIR or a temp folder', () => {
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      const dir = compileCacheDir(p, { TMPDIR: '/tmp', TEMP: 'C:\\Windows\\Temp', TMP: '/tmp' }, p === 'win32' ? 'C:\\Users\\ada' : '/home/ada');
      expect(dir).not.toMatch(/tmp|temp/i);
    }
  });

  it('gives no cache, or ignores the variable, when a base is not absolute', () => {
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      expect(compileCacheDir(p, {}, '')).toBeNull();
      expect(compileCacheDir(p, {}, 'relative/home')).toBeNull();
    }
    expect(compileCacheDir('win32', {}, 'C:drive-relative')).toBeNull();
    expect(compileCacheDir('linux', { XDG_CACHE_HOME: '.cache' }, '/home/ada')).toBe('/home/ada/.cache/dreamcontext/node-compile-cache');
    expect(compileCacheDir('win32', { LOCALAPPDATA: 'AppData' }, 'C:\\Users\\ada')).toBe('C:\\Users\\ada\\AppData\\Local\\dreamcontext\\node-compile-cache');
  });
});
