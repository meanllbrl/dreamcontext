import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAST_BROWSER_TARGET, browserAny, ciWaitAny, ciWatchIn, directHeavy, fastBrowserScope, heavyStep, readBudget, recordRed, recordStart, refusal,
} from '../../src/lib/run-budget.js';
import { acquireBrowserSlot } from '../../src/lib/builder-tools.js';
import type { LanePick } from '../../src/lib/run-lane.js';

const fast = (visible = true): LanePick => ({ lane: 'fast', reason: '3 lines, look and copy only', lines: 3, visible, customScripts: [] });

describe('a fast change takes one browser run per run (D4c, AC2)', () => {
  let dir: string;
  let budget: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fast-budget-')); budget = join(dir, 'b.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const scope = fastBrowserScope('/w/kitup-super-x', 'a'.repeat(40));

  it('the first run passes, the second is refused whatever it aims at', () => {
    const now = Date.now();
    expect(refusal(readBudget(budget), scope, 'browser', FAST_BROWSER_TARGET, now, fast())).toBeNull();
    recordStart(budget, scope, 'browser', FAST_BROWSER_TARGET, now);
    expect(refusal(readBudget(budget), scope, 'browser', FAST_BROWSER_TARGET, now, fast())).toMatch(/fast change and it already took/);
  });
  it('a red earns one more, and no more', () => {
    const now = Date.now();
    recordStart(budget, scope, 'browser', FAST_BROWSER_TARGET, now);
    recordRed(budget, scope, FAST_BROWSER_TARGET, now);
    expect(refusal(readBudget(budget), scope, 'browser', FAST_BROWSER_TARGET, now, fast())).toBeNull();
    recordStart(budget, scope, 'browser', FAST_BROWSER_TARGET, now);
    expect(refusal(readBudget(budget), scope, 'browser', FAST_BROWSER_TARGET, now, fast())).not.toBeNull();
  });
  it('nothing visible changed (a .md only): no browser at all', () => {
    expect(refusal(readBudget(budget), scope, 'browser', FAST_BROWSER_TARGET, Date.now(), fast(false))).toMatch(/nothing visible changed/);
  });
});

describe('a browser run however it is written (D7, C7, AC4)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'browser-kind-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a /tmp node script that imports playwright', () => {
    const f = join(dir, 'x.mjs');
    writeFileSync(f, "import { chromium } from 'playwright';\n");
    expect(heavyStep(`node ${f}`)?.kind).toBe('browser');
    expect(directHeavy(`node ${f}`)).toBe('browser');
    expect(directHeavy(`dreamcontext builder heavy -- node ${f}`)).toBeNull();
  });
  it('npx playwright screenshot', () => {
    expect(directHeavy('npx playwright screenshot https://x.test a.png')).toBe('browser');
  });
  it('inline code in a heredoc', () => {
    expect(directHeavy("node --input-type=module <<'EOF'\nimport { chromium } from 'playwright';\nEOF")).toBe('browser');
  });
  it('a symlinked script is not read and not a browser', () => {
    const real = join(dir, 'real.mjs');
    writeFileSync(real, "import 'playwright';\n");
    symlinkSync(real, join(dir, 'link.mjs'));
    expect(directHeavy(`node ${join(dir, 'link.mjs')}`)).toBeNull();
  });
  it('a plain node script is no browser', () => {
    const f = join(dir, 'plain.mjs');
    writeFileSync(f, 'console.log(1)\n');
    expect(directHeavy(`node ${f}`)).toBeNull();
  });
  it('dreamcontext shots is a browser run for the Super gate', () => {
    expect(browserAny('dreamcontext shots http://localhost:5173')).toBe(true);
  });
});

describe('CI watches (D6, AC4)', () => {
  it.each([
    'gh run watch 123',
    'gh pr checks 7 --watch',
    'while true; do gh run view 123 --json status; sleep 30; done',
    'until gh run view 1 | grep -q completed; do sleep 20; done',
  ])('%s is refused', (cmd) => {
    expect(ciWatchIn(cmd)).not.toBeNull();
  });
  it('a commit message that names it runs nothing', () => {
    expect(ciWatchIn('git commit -m "no more gh run watch"')).toBeNull();
  });
  it('one gh run view is fine; ci wait is not a watch but is a wait', () => {
    expect(ciWatchIn('gh run view 123 --json status')).toBeNull();
    expect(ciWatchIn('dreamcontext ci wait 123')).toBeNull();
    expect(ciWaitAny('dreamcontext ci wait 123')).toBe('dreamcontext ci wait');
  });
});

describe('the machine\'s browser slots (D7)', () => {
  it('two at once; the third waits and gives up with null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bslot-'));
    try {
      const a = await acquireBrowserSlot({ slotDir: dir, waitMs: 0 });
      const b = await acquireBrowserSlot({ slotDir: dir, waitMs: 0 });
      expect(a && b).toBeTruthy();
      expect(await acquireBrowserSlot({ slotDir: dir, waitMs: 50, pollMs: 10 })).toBeNull();
      a!();
      const c = await acquireBrowserSlot({ slotDir: dir, waitMs: 0 });
      expect(c).toBeTruthy();
      b!(); c!();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
