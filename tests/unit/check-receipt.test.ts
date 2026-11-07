import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  contentTree, dropReceipt, exitNotOwned, findReceipt, harmlessFor, normalizeCommand, planArgvReceipt, planShellReceipt, receiptState,
  receiptsDir, sameButVersion, writeReceipt, type ReceiptPlan,
} from '../../src/lib/check-receipt.js';
import { builderHeavy, type BuilderDeps } from '../../src/cli/commands/builder.js';
import { heavyLockPath, heavySlotPaths } from '../../src/lib/builder-tools.js';
import { releaseFileLock } from '../../src/lib/file-lock.js';

/**
 * Check receipts (task ayni-kod-iki-kez-test-edilmez…, 2026-11-07): a green check is recorded
 * against the content it ran on, and the same check on the same content does not run again.
 * Real git repos and real child processes; a receipt that lies is the risk, so most cases here
 * are the ones where it must NOT be used.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim();
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', msg); };

describe('check receipts', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-receipt-')));
    repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n.claude/\n.env*\n');
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { test: 'node count.mjs' } }, null, 2)}\n`);
    writeFileSync(join(repo, 'package-lock.json'), `${JSON.stringify({ name: 'demo-app', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'demo-app', version: '1.0.0' } } }, null, 2)}\n`);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    // The "suite": counts its runs OUTSIDE the repo (a write inside would move the tree) and exits
    // with whatever ../exit.txt says.
    writeFileSync(join(repo, 'count.mjs'), [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "appendFileSync('../runs.txt', 'run\\n');",
      "console.log('Tests 3 passed');",
      "let code = 0; try { code = Number(readFileSync('../exit.txt', 'utf-8')) || 0; } catch {}",
      'process.exit(code);',
    ].join('\n'));
    commit(repo, 'init');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const tests = (): ReceiptPlan => ({ kind: 'tests', toplevel: repo, cwdRel: '.', command: 'npx vitest run' });
  const tsc = (): ReceiptPlan => ({ kind: 'tsc', toplevel: repo, cwdRel: '.', command: 'npx tsc --noEmit' });
  const green = (plan: ReceiptPlan) => {
    const s = receiptState(plan)!;
    expect(writeReceipt(plan, s, { exit: 0, ms: 1000 })).not.toBeNull();
    return s;
  };
  const hitOf = (plan: ReceiptPlan) => { const s = receiptState(plan); return s ? findReceipt(plan, s) : null; };

  it('the same check on the same code finds its receipt; nothing recorded means nothing found', () => {
    expect(hitOf(tests())).toBeNull();
    green(tests());
    const hit = hitOf(tests());
    expect(hit?.via).toBe('same');
    expect(hit?.receipt.exit).toBe(0);
  });

  it('the tree includes uncommitted edits and untracked files, never ignored ones, and leaves the real index alone', () => {
    const t0 = contentTree(repo);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    const t1 = contentTree(repo);
    writeFileSync(join(repo, 'src/new.ts'), 'export {};\n');
    const t2 = contentTree(repo);
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/x.js'), '1');
    expect(new Set([t0, t1, t2]).size).toBe(3);
    expect(contentTree(repo)).toBe(t2);
    expect(git(repo, 'status', '--porcelain')).toContain('?? src/new.ts'); // still untracked: the real index was not used
  });

  it('a source change has no receipt, and a change back finds the old one', () => {
    green(tests());
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    expect(hitOf(tests())).toBeNull();
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    expect(hitOf(tests())?.via).toBe('same');
  });

  it('a merge of two green branches is a tree nobody tested: it runs', () => {
    git(repo, 'checkout', '-q', '-b', 'left');
    writeFileSync(join(repo, 'src/left.ts'), 'export const l = 1;\n');
    commit(repo, 'left');
    green(tests());
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'right');
    writeFileSync(join(repo, 'src/right.ts'), 'export const r = 1;\n');
    commit(repo, 'right');
    green(tests());
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'merge', '-q', '--no-edit', 'left');
    expect(hitOf(tests())).toBeNull();
  });

  it('a version-only bump reuses a type check but NOT a test run (tests can read the version)', () => {
    green(tests());
    green(tsc());
    const bump = (f: string) => writeFileSync(join(repo, f), readFileSync(join(repo, f), 'utf-8').split('1.0.0').join('1.0.1'));
    bump('package.json');
    bump('package-lock.json');
    const hit = hitOf(tsc());
    expect(hit?.via).toBe('harmless');
    expect(hit?.paths.sort()).toEqual(['package-lock.json', 'package.json']);
    expect(hitOf(tests())).toBeNull();
  });

  it('Markdown reuses a type check, never a test run; a package.json change past the version reuses nothing', () => {
    green(tests());
    green(tsc());
    writeFileSync(join(repo, 'README.md'), '# demo, now longer\n');
    expect(hitOf(tsc())?.via).toBe('harmless');
    expect(hitOf(tests())).toBeNull();
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8'));
    pkg.scripts.test = 'node other.mjs';
    writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg));
    expect(hitOf(tsc())).toBeNull();
  });

  it('brain files reuse every kind; a source file next to them does not', () => {
    green(tests());
    mkdirSync(join(repo, '_dream_context/state'), { recursive: true });
    writeFileSync(join(repo, '_dream_context/state/t.md'), 'x');
    expect(hitOf(tests())?.via).toBe('harmless');
    writeFileSync(join(repo, 'src/b.ts'), 'export {};\n');
    expect(hitOf(tests())).toBeNull();
  });

  // Review 2026-11-07: a nested `_dream_context/` is a test fixture vault, read by snapshot tests.
  it('only the root brain is harmless: a fixture vault under tests/ makes the run go again', () => {
    green(tests());
    mkdirSync(join(repo, 'tests/fixtures/golden/vault/_dream_context/core'), { recursive: true });
    writeFileSync(join(repo, 'tests/fixtures/golden/vault/_dream_context/core/0.soul.md'), 'changed');
    expect(hitOf(tests())).toBeNull();
    expect(harmlessFor('tests', 'tests/fixtures/golden/vault/_dream_context/core/0.soul.md', () => true)).toBe(false);
    expect(harmlessFor('tsc', 'eval/x/fixture/_dream_context/a.json', () => true)).toBe(false);
  });

  // Review 2026-11-07: the newest run is the truth, so a red --fresh cannot leave an old green behind.
  it('a red run drops the green receipt of that content and blocks a nearby one until it is green again', () => {
    const s1 = green(tsc());
    dropReceipt(tsc(), s1);
    expect(hitOf(tsc())).toBeNull();
    green(tsc());
    writeFileSync(join(repo, 'README.md'), 'docs only');
    expect(hitOf(tsc())?.via).toBe('harmless');
    const s2 = receiptState(tsc())!;
    dropReceipt(tsc(), s2); // went red here, docs-only difference or not
    expect(hitOf(tsc())).toBeNull();
    expect(writeReceipt(tsc(), s2, { exit: 0, ms: 1 })).not.toBeNull();
    expect(hitOf(tsc())?.via).toBe('same');
  });

  it('ignored inputs a test reads (.claude/, root .env*) are in a test run\'s key, not a type check\'s', () => {
    mkdirSync(join(repo, '.claude/skills/x'), { recursive: true });
    writeFileSync(join(repo, '.claude/skills/x/SKILL.md'), 'v1');
    green(tests());
    green(tsc());
    writeFileSync(join(repo, '.claude/skills/x/SKILL.md'), 'v2');
    expect(hitOf(tests())).toBeNull();
    expect(hitOf(tsc())?.via).toBe('same');
    green(tests());
    writeFileSync(join(repo, '.env.test'), 'A=1');
    expect(hitOf(tests())).toBeNull();
  });

  it('a node_modules with no record of what is installed gives no receipt; a pnpm record counts', () => {
    mkdirSync(join(repo, 'node_modules/left-pad'), { recursive: true });
    expect(receiptState(tests())).toBeNull();
    writeFileSync(join(repo, 'node_modules/.modules.yaml'), 'layoutVersion: 5');
    expect(receiptState(tests())).not.toBeNull();
  });

  it('a receipt pointing its log or report anywhere but beside itself is not believed', () => {
    const s = green(tests());
    const file = join(receiptsDir(repo)!, `${s.key}.json`);
    const good = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...good, log: '/etc/hosts' }));
    expect(hitOf(tests())).toBeNull();
    writeFileSync(file, JSON.stringify({ ...good, tree: '--output=/tmp/x' }));
    expect(hitOf(tests())).toBeNull();
  });

  it('a test run is keyed on the built dist too; a type check is not', () => {
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist/index.js'), 'v1');
    green(tests());
    green(tsc());
    writeFileSync(join(repo, 'dist/index.js'), 'v2');
    expect(hitOf(tests())).toBeNull();
    expect(hitOf(tsc())?.via).toBe('same');
  });

  it('installed dependencies and the env a test reads are in the key', () => {
    green(tests());
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/.package-lock.json'), '{"x":1}');
    expect(hitOf(tests())).toBeNull();
    green(tests());
    const s = receiptState(tests(), { ...process.env, DREAMCONTEXT_CHAT_TAB: 'tab-2' })!;
    expect(findReceipt(tests(), s)).toBeNull();
  });

  it('a red is never recorded, and a tree that moved while the check ran is not recorded either', () => {
    const s = receiptState(tests())!;
    expect(writeReceipt(tests(), s, { exit: 1, ms: 5 })).toBeNull();
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 9;\n'); // edited during the run
    expect(writeReceipt(tests(), s, { exit: 0, ms: 5 })).toBeNull();
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    expect(hitOf(tests())).toBeNull();
  });

  it('a corrupt, foreign or red receipt file is ignored, never trusted', () => {
    const s = green(tests());
    const file = join(receiptsDir(repo)!, `${s.key}.json`);
    const good = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, '{not json');
    expect(hitOf(tests())).toBeNull();
    writeFileSync(file, JSON.stringify({ ...good, exit: 1 }));
    expect(hitOf(tests())).toBeNull();
    writeFileSync(file, JSON.stringify({ ...good, key: 'f'.repeat(64) }));
    expect(hitOf(tests())).toBeNull();
    writeFileSync(file, JSON.stringify({ ...good, at: new Date(Date.now() - 30 * 86_400_000).toISOString() }));
    expect(hitOf(tests())).toBeNull();
    writeFileSync(join(receiptsDir(repo)!, `family-${s.family}.json`), '[[[');
    writeFileSync(join(repo, 'README.md'), 'changed');
    expect(hitOf(tsc())).toBeNull();
  });

  it('a build holds only while what it built is still there', () => {
    const build: ReceiptPlan = { kind: 'build', toplevel: repo, cwdRel: '.', command: 'npm run build' };
    const s = receiptState(build)!;
    expect(writeReceipt(build, s, { exit: 0, ms: 5 })).toBeNull(); // built nothing a later run could find
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist/index.js'), 'built');
    expect(writeReceipt(build, receiptState(build)!, { exit: 0, ms: 5 })).not.toBeNull();
    expect(hitOf(build)?.via).toBe('same');
    writeFileSync(join(repo, 'dist/index.js'), 'built by another tree');
    expect(hitOf(build)).toBeNull();
    rmSync(join(repo, 'dist'), { recursive: true });
    expect(hitOf(build)).toBeNull();
  });

  it('no git: no plan, so the check runs', () => {
    const bare = join(root, 'plain');
    mkdirSync(bare);
    expect(planShellReceipt(bare, 'npx vitest run')).toEqual({ skip: 'not a git repo' });
    expect('skip' in planArgvReceipt(bare, ['vitest', 'run'])).toBe(true);
  });

  it('only a command whose exit code is the check\'s own can hold a receipt', () => {
    expect(exitNotOwned('npx vitest run && npx tsc --noEmit')).toBeNull();
    expect(exitNotOwned('(cd dashboard && npx tsc -b) 2>&1')).toBeNull();
    expect(exitNotOwned("npx vitest run -t 'a | b; c'")).toBeNull();
    for (const bad of ['npx vitest run | tail -40', 'npx vitest run; echo done', 'npx vitest run || true', 'npx vitest run &', 'npx vitest run $(cat files)', 'npx vitest run `x`', "cat <<EOF\nx\nEOF"]) {
      expect(exitNotOwned(bad), bad).not.toBeNull();
    }
  });

  it('plans: the kind comes from every step; an unknown step, a browser run or a cd out of the repo gets none', () => {
    const scripts = { test: 'vitest', build: 'tsup', 'verify:look': 'node scripts/verify/look.mjs' };
    const kind = (c: string) => { const p = planShellReceipt(repo, c, scripts); return 'plan' in p ? p.plan.kind : `skip: ${p.skip}`; };
    expect(kind('npx tsc --noEmit')).toBe('tsc');
    expect(kind('npx vitest run tests/a.test.ts')).toBe('tests');
    expect(kind('npm test')).toBe('tests');
    expect(kind('npx tsc --noEmit && npx vitest run')).toBe('tests');
    expect(kind('npm run build && npx tsc --noEmit')).toBe('build');
    expect(kind('env -u DREAMCONTEXT_CHAT_TAB npx vitest run')).toBe('tests');
    expect(kind(`cd ${repo} && npx tsc --noEmit`)).toBe('tsc');
    expect(kind('(cd src && npx tsc --noEmit)')).toBe('tsc');
    expect(kind('npx tsc --noEmit && node scripts/check-docs.mjs')).toMatch(/^skip: .*not a known check/);
    expect(kind('npm run verify:look')).toMatch(/^skip: a browser run/);
    expect(kind(`cd ${root} && npx vitest run`)).toMatch(/^skip: a cd out of the repo/);
    expect(kind('npx vitest run /etc/other.test.ts')).toMatch(/^skip: a path out of the repo/);
    expect(kind('npx vitest run | tail -5')).toMatch(/^skip: a pipe/);
    // Review 2026-11-07: relative escapes, remembered directories and history-picked tests.
    expect(kind('npx tsc --noEmit -p ../other/tsconfig.json')).toMatch(/^skip: a path out of the repo/);
    expect(kind('npx vitest run --root ../other')).toMatch(/^skip: a path out of the repo/);
    expect(kind('npx vitest run ../../x/a.test.ts')).toMatch(/^skip: a path out of the repo/);
    expect(kind('npx vitest run src/../tests/a.test.ts')).toBe('tests');
    expect(kind('cd - && npx tsc --noEmit')).toMatch(/^skip: a cd to "-"/);
    expect(kind('pushd +1 && npx tsc --noEmit')).toMatch(/^skip: a cd to "\+1"/);
    expect(kind('popd && npx tsc --noEmit')).toMatch(/^skip: a popd/);
    expect(kind('npx vitest run --changed')).toMatch(/^skip: it picks tests from git history/);
    expect('skip' in planArgvReceipt(repo, ['vitest', 'related', '--run', '../x/a.ts'])).toBe(true);
    expect('skip' in planArgvReceipt(repo, ['jest', '--onlyChanged'])).toBe(true);
  });

  it('the command is keyed with the repo spelled <root> and report paths dropped, so worktrees and retries share it', () => {
    expect(normalizeCommand(`cd ${repo} && npx vitest run --outputFile=/x/y.json`, repo)).toBe('cd <root> && npx vitest run --outputFile=<report>');
  });

  it('harmless paths are explicit and small', () => {
    const yes = () => true;
    expect(harmlessFor('tsc', 'docs/guide.md', yes)).toBe(true);
    expect(harmlessFor('tsc', 'desktop/package.json', yes)).toBe(true);
    expect(harmlessFor('tsc', 'desktop/package.json', () => false)).toBe(false);
    expect(harmlessFor('tsc', 'src/a.ts', yes)).toBe(false);
    expect(harmlessFor('tsc', 'CHANGELOG.json', yes)).toBe(false);
    expect(harmlessFor('tests', 'README.md', yes)).toBe(false);
    expect(harmlessFor('tests', 'package.json', yes)).toBe(false);
    expect(harmlessFor('tests', '_dream_context/core/CHANGELOG.json', yes)).toBe(true);
    expect(harmlessFor('build', 'skills/x.md', yes)).toBe(false);
    expect(sameButVersion('{"version":"1","a":1}', '{"version":"2","a":1}')).toBe(true);
    expect(sameButVersion('{"version":"1","a":1}', '{"version":"2","a":2}')).toBe(false);
    expect(sameButVersion('{"packages":{"":{"version":"1"},"node_modules/x":{"version":"1"}}}', '{"packages":{"":{"version":"2"},"node_modules/x":{"version":"1"}}}')).toBe(true);
    expect(sameButVersion('{"packages":{"node_modules/x":{"version":"1"}}}', '{"packages":{"node_modules/x":{"version":"2"}}}')).toBe(false);
    expect(sameButVersion('not json', 'not json')).toBe(false);
  });

  describe('builder heavy', () => {
    let slots: string;
    let out: string[];
    let err: string[];
    const deps = (): BuilderDeps => ({
      cwd: () => repo, print: (l) => out.push(l), printErr: (l) => err.push(l), ps: () => '', kill: () => {},
      heavySlotDir: () => slots, heavyLimit: async () => 2, machineBusy: () => false,
    });
    const runs = () => (existsSync(join(root, 'runs.txt')) ? readFileSync(join(root, 'runs.txt'), 'utf-8').split('\n').filter(Boolean).length : 0);
    beforeEach(() => { slots = join(root, 'slots'); out = []; err = []; });
    afterEach(() => {
      for (const p of heavySlotPaths(slots)) releaseFileLock(p);
      releaseFileLock(heavyLockPath(repo));
    });

    it('runs once, then prints the receipt and the log tail instead of running; --fresh runs and records', async () => {
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
      expect(runs()).toBe(1);
      expect(err.join('\n')).toContain('receipt kept');
      err = []; out = [];
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
      expect(runs()).toBe(1);
      expect(err.join('\n')).toMatch(/RECEIPT, not re-run: "npm test" passed on this exact code/);
      expect(out.join('\n')).toContain('Tests 3 passed');
      expect(await builderHeavy(deps(), ['npm', 'test'], { fresh: true })).toBe(0);
      expect(runs()).toBe(2);
      expect(err.join('\n')).toContain('--fresh run recorded');
      const receipts = readdirSync(receiptsDir(repo)!).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
      expect(JSON.parse(readFileSync(join(receiptsDir(repo)!, receipts[0]), 'utf-8')).fresh).toBe(true);
    });

    it('a red run is not recorded and runs again; a source change runs again', async () => {
      writeFileSync(join(root, 'exit.txt'), '1');
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
      expect(runs()).toBe(2);
      writeFileSync(join(root, 'exit.txt'), '0');
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
      writeFileSync(join(repo, 'src/a.ts'), 'export const a = 3;\n');
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
      expect(runs()).toBe(4);
    });

    it('a red --fresh run leaves no green behind: the next plain run runs, and is red', async () => {
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
      writeFileSync(join(root, 'exit.txt'), '1'); // something outside the key broke it
      expect(await builderHeavy(deps(), ['npm', 'test'], { fresh: true })).toBe(1);
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
      expect(runs()).toBe(3);
    });

    it('a process the check left behind holding its output does not hold builder heavy', async () => {
      const t0 = Date.now();
      expect(await builderHeavy(deps(), ['sh', '-c', '(sleep 8 &); echo started'], {})).toBe(0);
      expect(Date.now() - t0).toBeLessThan(6000);
    }, 15_000);

    it('a corrupt receipt runs the check', async () => {
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
      const dir = receiptsDir(repo)!;
      for (const f of readdirSync(dir).filter((x) => /^[0-9a-f]{64}\.json$/.test(x))) writeFileSync(join(dir, f), 'garbage');
      expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
      expect(runs()).toBe(2);
    });

    it('--tail shows only the last lines; a pipe gets no receipt and says why', async () => {
      expect(await builderHeavy(deps(), ['npm', 'test'], { tail: '1' })).toBe(0);
      expect(out).toEqual(['Tests 3 passed']);
      err = [];
      expect(await builderHeavy(deps(), ['npm test | tail -3'], {})).toBe(0);
      expect(await builderHeavy(deps(), ['npm test | tail -3'], {})).toBe(0);
      expect(err.join('\n')).toContain('no receipt for this run (a pipe');
      expect(runs()).toBe(3);
      expect(await builderHeavy(deps(), ['npm', 'test'], { tail: 'x' })).toBe(2);
    });
  });
});
