import { describe, it, expect } from 'vitest';
import { mirrorHomeForChild } from '../setup/windows-home.js';

/** The Windows test-harness rule (tests/setup/windows-home.ts) for a spawned child's env. */
describe('mirrorHomeForChild', () => {
  const parent = { USERPROFILE: 'C:\\Users\\runner', HOME: undefined };

  it('a HOME the test chose becomes the child\'s USERPROFILE (what os.homedir reads on Windows)', () => {
    expect(mirrorHomeForChild({ HOME: 'C:\\t\\home', USERPROFILE: 'C:\\Users\\runner' }, parent).USERPROFILE).toBe('C:\\t\\home');
    expect(mirrorHomeForChild({ HOME: 'C:\\t\\home' }, parent).USERPROFILE).toBe('C:\\t\\home');
  });

  it('keeps a USERPROFILE the test set itself, and an env without HOME untouched', () => {
    expect(mirrorHomeForChild({ HOME: 'C:\\a', USERPROFILE: 'C:\\b' }, parent).USERPROFILE).toBe('C:\\b');
    const env = { PATH: 'x' };
    expect(mirrorHomeForChild(env, parent)).toBe(env);
  });
});
