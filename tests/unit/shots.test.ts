import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SHOTS_USAGE_EXIT, runShots, type ShotsDeps } from '../../src/cli/commands/shots.js';

/**
 * `dreamcontext shots` (D7, AC2): what it refuses before any slot or browser. The one-browser-run
 * limit of a fast run is `refusal()`'s, tested in run-budget-fast.test.ts (shots asks it).
 */
let dir: string;
let err: string[];
let looked: number;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'shots-'))); err = []; looked = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (playwright: string | null = '/x/playwright/index.js'): ShotsDeps => ({
  cwd: () => dir, env: {}, print: () => {}, printErr: (l) => err.push(l), slotDir: () => join(dir, 'slots'),
  findPlaywright: () => { looked += 1; return playwright; },
});

describe('runShots refuses before it opens anything', () => {
  it.each([
    'file:///etc/passwd',
    'data:text/html,<b>x</b>',
    'http://user:pw@localhost:5173/',
    'javascript:alert(1)',
    'not a url',
  ])('%s is no URL it opens (exit 2)', async (u) => {
    expect(await runShots(deps(), u, {})).toBe(SHOTS_USAGE_EXIT);
    expect(err.join('\n')).toMatch(/not a URL it opens/);
    expect(looked).toBe(0);
  });

  it('bad widths, an empty --because, and --script with no ops card are usage errors', async () => {
    expect(await runShots(deps(), 'http://localhost:5173/', { width: '0' })).toBe(SHOTS_USAGE_EXIT);
    expect(await runShots(deps(), 'http://localhost:5173/', { width: '1,2,3,4,5' })).toBe(SHOTS_USAGE_EXIT);
    expect(await runShots(deps(), 'http://localhost:5173/', { because: '' })).toBe(SHOTS_USAGE_EXIT);
    expect(await runShots(deps(), 'http://localhost:5173/', { script: 'scripts/shots.mjs' })).toBe(SHOTS_USAGE_EXIT);
    expect(err.join('\n')).toMatch(/no ops card here/);
  });

  it('no playwright anywhere: says how to install it, runs nothing', async () => {
    expect(await runShots(deps(null), 'http://localhost:5173/', {})).toBe(SHOTS_USAGE_EXIT);
    expect(err.join('\n')).toMatch(/npm i -g playwright/);
  });
});
