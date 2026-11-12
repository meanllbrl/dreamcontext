import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { VERIFY_DIST_INPUTS, VERIFY_HARNESS_EXIT, VERIFY_OLD_BUILD_ON_PURPOSE, VERIFY_PREFLIGHT_FILE, staleDistFor } from '../../src/lib/run-budget.js';
// @ts-expect-error: a plain .mjs of the verify scripts, no types.
import { DIST_INPUTS, HARNESS_EXIT, HarnessError, OLD_BUILD_ON_PURPOSE, reportHarness, staleDist } from '../../scripts/verify/lib/preflight.mjs';

/**
 * scripts/verify/lib/preflight.mjs (the script's own preflight) and run-budget.ts (builder heavy,
 * before the queue) must say the same thing about the same build: one exit code, one input set,
 * one verdict (audit OR-5). The CLI cannot import the script, so the two are mirrored and held here.
 */
describe('verify preflight mirror', () => {
  it('one exit code and one input set', () => {
    expect(HARNESS_EXIT).toBe(VERIFY_HARNESS_EXIT);
    expect(DIST_INPUTS).toEqual(VERIFY_DIST_INPUTS);
    expect(OLD_BUILD_ON_PURPOSE).toBe(VERIFY_OLD_BUILD_ON_PURPOSE);
    expect(VERIFY_PREFLIGHT_FILE).toBe('scripts/verify/lib/preflight.mjs');
  });

  describe('the same verdict on the same repo', () => {
    let repo: string;
    const put = (rel: string, text = '') => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
    const age = (rel: string, s: number) => { const t = new Date(Date.now() - s * 1000); utimesSync(join(repo, rel), t, t); };
    const both = () => [staleDist(repo)?.why ?? null, staleDistFor(repo)?.why ?? null];
    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'dc-preflight-'));
      execFileSync('git', ['init', '-q'], { cwd: repo });
      put(VERIFY_PREFLIGHT_FILE, '// stand-in\n');
      put('.gitignore', 'dist/\nnode_modules/\n');
      put('src/a.ts'); put('dashboard/src/b.tsx'); put('scripts/verify/x.mjs');
      put('src/lib/shared.ts'); put('src/cli/cmd.ts');
      put('dashboard/dist/index.html'); put('dist/index.js'); put('dist/dashboard/index.html');
      for (const f of ['src/a.ts', 'src/lib/shared.ts', 'src/cli/cmd.ts', 'dashboard/src/b.tsx', 'scripts/verify/x.mjs']) age(f, 600);
      for (const f of ['dashboard/dist/index.html', 'dist/index.js', 'dist/dashboard/index.html']) age(f, 300);
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it('current build: both null', () => expect(both()).toEqual([null, null]));

    it('a newer source, tracked or untracked: both name it and the build that fixes it', () => {
      put('src/new.ts');
      const [a, b] = both();
      expect(a).toBe(b);
      expect(a).toBe('dist/index.js is older than src/new.ts');
      expect(staleDist(repo).build).toBe('npm run build:cli');
    });

    it("the dashboard is measured on Vite's own output, not on the copy a CLI build refreshes", () => {
      put('dashboard/src/b.tsx', 'x');
      put('dist/index.js', 'rebuilt'); put('dist/dashboard/index.html', 'old copy, fresh mtime');
      expect(both()).toEqual(['dashboard/dist/index.html is older than dashboard/src/b.tsx', 'dashboard/dist/index.html is older than dashboard/src/b.tsx']);
      expect(staleDist(repo).build).toBe('npm run build');
    });

    it('a shared src/lib file the dashboard bundles needs the whole build; a CLI-only file the CLI build', () => {
      put('src/lib/shared.ts', 'x');
      expect(both()[0]).toBe('dashboard/dist/index.html is older than src/lib/shared.ts');
      expect(both()[1]).toBe(both()[0]);
      expect(staleDist(repo).build).toBe('npm run build');
      put('dashboard/dist/index.html', 'vite again');
      put('src/cli/cmd.ts', 'y');
      expect(both()[0]).toMatch(/^dist\/index\.js is older than (src\/lib\/shared\.ts, src\/cli\/cmd\.ts|src\/cli\/cmd\.ts, src\/lib\/shared\.ts)$/);
      expect(staleDist(repo).build).toBe('npm run build:cli');
    });

    it('a dashboard built after the copy asks for the copy (build:cli)', () => {
      put('dashboard/dist/index.html', 'new vite output');
      expect(both()).toEqual(['dist/dashboard/index.html is older than dashboard/dist/index.html', 'dist/dashboard/index.html is older than dashboard/dist/index.html']);
    });

    it('a fixed verify script, an ignored file or a test asks for no build', () => {
      put('scripts/verify/x.mjs', 'fixed'); put('tests/a.test.ts'); put('node_modules/z/index.js');
      expect(both()).toEqual([null, null]);
    });

    it('no build at all', () => {
      rmSync(join(repo, 'dist'), { recursive: true });
      expect(both()).toEqual(['there is no dist/index.js', 'there is no dist/index.js']);
      rmSync(join(repo, 'dashboard/dist'), { recursive: true });
      expect(both()).toEqual(['there is no dashboard/dist/index.html', 'there is no dashboard/dist/index.html']);
    });
  });

  it('a HARNESS report names the stage and says it tested nothing', () => {
    let out = '';
    const code = reportHarness(new HarnessError('shell', 'the app shell did not draw in 60s at /?vault=proj'), { write: (s: string) => { out += s; } });
    expect(code).toBe(78);
    expect(out).toMatch(/^HARNESS \(shell\): the app shell did not draw/);
    expect(out).toMatch(/tested nothing of the product/);
  });
});
