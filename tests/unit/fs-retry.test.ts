import { describe, it, expect } from 'vitest';
import { renameWithRetry } from '../../src/lib/fs-retry.js';

const err = (code: string) => Object.assign(new Error(code), { code });

describe('renameWithRetry', () => {
  it('on win32 retries a rename that lost a sharing race (EPERM/EACCES/EBUSY), then succeeds', async () => {
    const codes = ['EPERM', 'EACCES', 'EBUSY'];
    let calls = 0;
    await renameWithRetry('a', 'b', {
      platform: 'win32', sleep: async () => {},
      rename: async () => { calls += 1; if (codes.length) throw err(codes.shift()!); },
    });
    expect(calls).toBe(4);
  });

  it('gives up after the attempts, and never retries another error', async () => {
    let calls = 0;
    await expect(renameWithRetry('a', 'b', { platform: 'win32', sleep: async () => {}, attempts: 3, rename: async () => { calls += 1; throw err('EPERM'); } })).rejects.toThrow('EPERM');
    expect(calls).toBe(3);
    calls = 0;
    await expect(renameWithRetry('a', 'b', { platform: 'win32', sleep: async () => {}, rename: async () => { calls += 1; throw err('ENOENT'); } })).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  it('is exactly one rename off Windows', async () => {
    let calls = 0;
    await expect(renameWithRetry('a', 'b', { platform: 'darwin', rename: async () => { calls += 1; throw err('EPERM'); } })).rejects.toThrow('EPERM');
    expect(calls).toBe(1);
  });
});
