import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HEAVY_BUILD_FIRST_EXIT, builderHeavy, builderLane, type BuilderDeps } from '../../src/cli/commands/builder.js';
import {
  BUDGET_BUCKET_MAX_AGE_MS, BUDGET_LIMITS, HEAVY_OVER_BUDGET_EXIT, budgetPath, classifyHeavy, directHeavy, readBudget,
  HARNESS_FREE_RUNS, VERIFY_HARNESS_EXIT, currentScope, drivesDist, heavyStep, markPhase, recordRed, staleDistFor, recordStart, refusal, shellQuote, shellSegments, type BudgetScope,
} from '../../src/lib/run-budget.js';

describe('classifyHeavy', () => {
  it.each([
    ['npm run build', 'build'],
    ['npm run build:dashboard', 'build'],
    ['cd dashboard && npx vite build', 'build'],
    ['npx tsup', 'build'],
    ['node scripts/verify/chat-html.mjs', 'browser'],
    ['DC_VERIFY_PHASE=x node scripts/verify/chat-html.mjs', 'browser'],
    ['npm run verify:chat-html', 'browser'],
    ['npx playwright test e2e/a.spec.ts', 'browser'],
    ['npm test', 'suite'],
    ['npx vitest run', 'suite'],
    ['npx vitest run --config eval/x.ts', 'suite'],
    ['npx vitest run tests/unit/a.test.ts', 'check'],
    ['npx tsc --noEmit', 'check'],
    ['npm run build && node scripts/verify/a.mjs', 'browser'],
    ['npm test 2>&1 | tail -20', 'suite'],
    ['npm test > out.txt', 'suite'],
    ['npm test -- --run', 'suite'],
    ['npx vitest run 2>&1 | tail', 'suite'],
    ['npx vitest run --bail 1', 'suite'],
    ['npm test -- tests/unit/a.test.ts', 'check'],
    ['npx vitest run run-lane', 'check'],
    ['npm test -- run-budget', 'check'],
    ['npx vitest run --reporter json --outputFile out.json', 'suite'],
    ['npx vitest run --shard 1/4', 'suite'],
    ['npm test &> out.txt', 'suite'],
    ['npx vitest run -t foo', 'check'],
    ['npx vitest run --testNamePattern foo', 'check'],
    ['npx vitest run --environment jsdom', 'suite'],
    ['npx vitest run --hookTimeout 1000', 'suite'],
    ['npx vitest run &', 'suite'],
    ['npx vitest run --runInBand tests/a.test.ts', 'check'],
  ])('%s is %s', (cmd, kind) => expect(classifyHeavy(cmd)).toBe(kind));

  // Measured 2026-11-08: the direct verify runs the strict shape missed after the gate landed.
  it.each([
    ['npx tsx scripts/verify/super-owed-replay.mjs ~/x.jsonl', 'scripts/verify/super-owed-replay.mjs'],
    ['node ../../scripts/verify/_tmp-agy-e2e.mjs ok 2>&1', 'scripts/verify/_tmp-agy-e2e.mjs'],
    ['timeout 120 node scripts/verify/a.mjs', 'scripts/verify/a.mjs'],
    ['timeout -s KILL 90s node scripts/verify/a.mjs', 'scripts/verify/a.mjs'],
    ['node --import tsx scripts/verify/a.mjs', 'scripts/verify/a.mjs'],
    ['node /Users/x/repo/scripts/verify/a.mjs', 'scripts/verify/a.mjs'],
    ['(cd dashboard && node ../scripts/verify/a.mjs)', 'scripts/verify/a.mjs'],
    ['bun scripts/verify/a.ts', 'scripts/verify/a.ts'],
    ['node "scripts/verify/a.mjs"', 'scripts/verify/a.mjs'],
    // End review 2026-11-08: a valued timeout flag and the other package runners.
    ['timeout -k 5 120 node scripts/verify/a.mjs', 'scripts/verify/a.mjs'],
    ['pnpm exec tsx scripts/verify/a.ts', 'scripts/verify/a.ts'],
    ['bunx tsx scripts/verify/a.ts', 'scripts/verify/a.ts'],
    ['yarn tsx scripts/verify/a.ts', 'scripts/verify/a.ts'],
  ])('a verify run spelled otherwise is still one: %s', (cmd, target) => {
    expect(directHeavy(cmd)).toBe('browser');
    expect(heavyStep(cmd)?.target).toBe(target);
  });

  it.each(['node --check scripts/verify/a.mjs', 'sed -n 1,80p scripts/verify/a.mjs', 'node -c scripts/verify/a.mjs'])(
    'reading or parsing a verify script runs nothing: %s', (cmd) => expect(directHeavy(cmd)).toBeNull());

  it('a look.mjs glance stays scoped however it is spelled', () => {
    expect(heavyStep('timeout 60 node ./scripts/verify/look.mjs /x')).toEqual({ kind: 'browser', target: 'scripts/verify/look.mjs', scoped: 1 });
  });

  it.each(['git status', 'grep "npm run build" README.md', 'git commit -m "npm run build; node scripts/verify/a.mjs"', 'npm run dev', 'ls scripts/verify'])(
    '%s is no heavy step', (cmd) => expect(classifyHeavy(cmd)).toBeNull());

  it.each([
    "cat > notes.md <<'EOF'\nnpm run build\nEOF",
    "git commit -F - <<'EOF'\nnpm test\nEOF",
    '# first; npm run build',
    `git commit -m "$(cat <<'EOF'\na; npm run build twice\nEOF\n)"`,
  ])('text that never runs is no step: %s', (cmd) => expect(directHeavy(cmd)).toBeNull());

  it('a here-string is no heredoc', () => {
    expect(directHeavy('grep x <<< foo\nnpm run build')).toBe('build');
  });

  it('still sees the step after a heredoc', () => {
    expect(directHeavy("cat > a <<'EOF'\nx\nEOF\nnpm run build")).toBe('build');
  });

  it('a script is what it runs, and two builds are two targets', () => {
    expect(heavyStep('npm run verify:sleep-debt', { 'verify:sleep-debt': 'vitest run --config eval/x.ts' })).toEqual({ kind: 'suite', target: 'suite eval/x.ts' });
    expect(heavyStep('npm run verify:ui', { 'verify:ui': 'node scripts/verify/ui.mjs' })).toEqual({ kind: 'browser', target: 'scripts/verify/ui.mjs' });
    expect(heavyStep('npm test', { test: 'vitest run' })?.target).toBe(heavyStep('npx vitest run')?.target);
    expect(heavyStep('npm run build:cli')?.target).not.toBe(heavyStep('npm run build:dashboard')?.target);
  });

  it('quotes a command so its text stays text when pasted back', () => {
    expect(execFileSync('sh', ['-c', `printf %s ${shellQuote("a 'b' $(touch x) \`y\`")}`], { encoding: 'utf-8' })).toBe("a 'b' $(touch x) \`y\`");
  });

  it('keeps a quoted separator inside its segment', () => {
    expect(shellSegments(`echo "a && b"; ls`)).toEqual(['echo "a && b"', 'ls']);
  });
});

describe('directHeavy (the hook)', () => {
  it('sends a direct heavy step to builder', () => expect(directHeavy('cd dashboard && npm run build')).toBe('build'));
  it('lets a step already inside builder through', () => {
    expect(directHeavy('dreamcontext builder heavy -- npm run build')).toBeNull();
    expect(directHeavy('npx dreamcontext builder test s --wave 1 --related a.ts')).toBeNull();
  });
  it('still catches the heavy step chained after a builder call', () => {
    expect(directHeavy('dreamcontext builder heavy -- npx tsc --noEmit && npm run build')).toBe('build');
  });
});

describe('refusal', () => {
  const scope: BudgetScope = { branch: 'b', run: 'r', phase: 'codereview' };
  let dir: string; let path: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-budget-')); path = join(dir, 'b.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const NOW = Date.parse('2026-10-31T10:00:00Z');

  it('allows the limit, then refuses, and a red earns exactly one more', () => {
    expect(BUDGET_LIMITS.build).toBe(1);
    expect(refusal(readBudget(path), scope, 'build', 'build', NOW)).toBeNull();
    recordStart(path, scope, 'build', 'build', NOW);
    expect(refusal(readBudget(path), scope, 'build', 'build', NOW)).toMatch(/1 run\(s\) of build/);
    recordRed(path, scope, 'build', NOW);
    expect(refusal(readBudget(path), scope, 'build', 'build', NOW)).toBeNull();
    recordStart(path, scope, 'build', 'build', NOW);
    recordRed(path, scope, 'build', NOW);
    expect(refusal(readBudget(path), scope, 'build', 'build', NOW)).toMatch(/extra run after a red/);
  });

  it('counts each phase and each branch apart', () => {
    recordStart(path, scope, 'build', 'build', NOW);
    expect(refusal(readBudget(path), { ...scope, phase: 'w1' }, 'build', 'build', NOW)).toBeNull();
    expect(refusal(readBudget(path), { ...scope, branch: 'other' }, 'build', 'build', NOW)).toBeNull();
    expect(refusal(readBudget(path), scope, 'build', 'build:cli', NOW)).toBeNull();
  });

  it('with a code tree, counts per tree: a phase move is no reset, changed code is free', () => {
    const t1 = { ...scope, tree: 'a'.repeat(40) };
    recordStart(path, t1, 'build', 'build', NOW);
    expect(refusal(readBudget(path), t1, 'build', 'build', NOW)).toMatch(/on this exact code \(tree:aaaaaaaaaaaa\)/);
    // The review's fix moved the phase, not the code: still the same answer.
    expect(refusal(readBudget(path), { ...t1, phase: 'end' }, 'build', 'build', NOW)).toMatch(/1 run\(s\) of build/);
    // The fix changed the code: new proof, no flag needed.
    expect(refusal(readBudget(path), { ...t1, tree: 'b'.repeat(40) }, 'build', 'build', NOW)).toBeNull();
  });

  it('a red keeps its log on the bucket, and the refusal names it', () => {
    const t1 = { ...scope, tree: 'c'.repeat(40) };
    recordStart(path, t1, 'browser', 'scripts/verify/look.mjs', NOW);
    recordStart(path, t1, 'browser', 'scripts/verify/look.mjs', NOW);
    recordRed(path, t1, 'scripts/verify/look.mjs', NOW, '/x/run-1.log');
    recordStart(path, t1, 'browser', 'scripts/verify/look.mjs', NOW);
    expect(refusal(readBudget(path), t1, 'browser', 'scripts/verify/look.mjs', NOW)).toMatch(/its last red log: \/x\/run-1\.log/);
  });

  it('forgets a bucket once it is old', () => {
    recordStart(path, scope, 'build', 'build', NOW);
    expect(refusal(readBudget(path), scope, 'build', 'build', NOW + BUDGET_BUCKET_MAX_AGE_MS + 1)).toBeNull();
  });

  it('a light change with nothing visible takes no browser run, a visible one takes it, no script of its own', () => {
    const lane = { lane: 'light' as const, reason: '20 lines', lines: 20, visible: false, customScripts: [] };
    const look = 'scripts/verify/look.mjs';
    const own = 'scripts/verify/x.mjs';
    expect(refusal(readBudget(path), scope, 'browser', look, NOW, lane)).toMatch(/nothing visible/);
    expect(refusal(readBudget(path), scope, 'browser', look, NOW, { ...lane, visible: true })).toBeNull();
    expect(refusal(readBudget(path), scope, 'browser', own, NOW, { ...lane, visible: true, customScripts: [own] })).toMatch(/look\.mjs/);
    expect(refusal(readBudget(path), scope, 'browser', look, NOW, { ...lane, visible: true, customScripts: [own] })).toBeNull();
    expect(refusal(readBudget(path), scope, 'browser', look, NOW, { ...lane, lane: 'full' })).toBeNull();
  });

  it('a broken budget file reads as empty, never as a blocked check', () => {
    writeFileSync(path, '{ not json');
    expect(refusal(readBudget(path), scope, 'build', 'build', NOW)).toBeNull();
  });
});

/** The exit criterion: the COMMAND stops the run, in a real repo on a real branch. */
describe('builder heavy stops a run past the limit', () => {
  let repo: string; let err: string[]; let deps: BuilderDeps;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dc-heavy-budget-'));
    git('init', '-q', '-b', 'work'); git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i');
    err = [];
    deps = { cwd: () => repo, print: () => {}, printErr: (l) => err.push(l), ps: () => '', kill: () => {}, heavySlotDir: () => join(repo, 'slots'), heavyLimit: async () => 2 };
    // A Node script, not `sh`: npm runs scripts through cmd.exe on Windows.
    writeFileSync(join(repo, 'build.cjs'), "require('fs').appendFileSync('ran.txt', 'ran\\n'); process.exit(Number(process.env.FAKE_EXIT || 0));\n");
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs' } }));
    // What a build writes is ignored, as dist/ is: the code tree is what the build reads.
    writeFileSync(join(repo, '.gitignore'), 'ran.txt\nslots/\n');
  });
  afterEach(() => { delete process.env.FAKE_EXIT; rmSync(repo, { recursive: true, force: true }); });
  const runs = () => { try { return String(readFileSync(join(repo, 'ran.txt'), 'utf-8').split('\n').filter(Boolean).length); } catch { return '0'; } };
  const heavy = (o: { because?: string } = {}) => {
    const cwd = process.cwd(); process.chdir(repo);
    return builderHeavy(deps, ['npm', 'run', 'build', '--silent'], { maxWait: '5', ...o }).finally(() => process.chdir(cwd));
  };

  it('runs once, refuses the second WITHOUT running it, and the way out leaves a trail', async () => {
    markPhase(repo, 'build', 'task', Date.now());
    expect(await heavy()).toBe(0);
    expect(runs()).toBe('1');
    expect(await heavy()).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(runs()).toBe('1');
    expect(err.join('\n')).toMatch(/REFUSED/);
    expect(err.join('\n')).toMatch(/--because/);

    expect(await heavy({ because: 'short' })).toBe(2);
    expect(runs()).toBe('1');

    expect(await heavy({ because: 'the owner asked for a clean rebuild' })).toBe(0);
    // The way out works once per run and command: a second one really stops, in any phase.
    err.length = 0;
    expect(await heavy({ because: 'the owner asked for a clean rebuild again' })).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(err.join('\n')).toMatch(/already spent its one --because/);
    expect(runs()).toBe('2');
    const { overruns } = readBudget(budgetPath(repo));
    expect(overruns).toHaveLength(1);
    expect(overruns[0].reason).toBe('the owner asked for a clean rebuild');
  });

  it('counts per code tree (audit OR-8): a phase move is no reset, a code change runs free', async () => {
    markPhase(repo, 'build', 'task', Date.now());
    expect(await heavy()).toBe(0);
    expect(await heavy()).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(err.join('\n')).toMatch(/on this exact code/);
    expect(err.join('\n')).toMatch(/Change the code and it runs again, no flag needed/);
    // The end phase on the same code is the same answer.
    builderLane(deps, { from: 'HEAD' });
    expect(await heavy()).toBe(HEAVY_OVER_BUDGET_EXIT);
    // The review's fix changed the code: the build runs, no --because.
    writeFileSync(join(repo, 'fix.ts'), 'export const x = 1;\n');
    expect(await heavy()).toBe(0);
    expect(await heavy()).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(runs()).toBe('2');
    const keys = Object.keys(readBudget(budgetPath(repo)).buckets);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^work task tree:[0-9a-f]{12} build$/);
    expect(readBudget(budgetPath(repo)).overruns).toHaveLength(0);
  });

  it('a red keeps its whole log, prints where and the first failures, and says read it, never re-run (audit OR-3)', async () => {
    writeFileSync(join(repo, 'build.cjs'), "require('fs').appendFileSync('ran.txt', 'ran\\n'); console.log('compiling'); console.log(' FAIL  tests/a.test.ts > adds'); console.log('error TS2322: Type string is not number'); process.exit(Number(process.env.FAKE_EXIT || 0));\n");
    process.env.FAKE_EXIT = '1';
    expect(await heavy()).toBe(1);
    const text = err.join('\n');
    const log = /its whole output is kept: (\S+)/.exec(text)?.[1];
    expect(log).toBeTruthy();
    expect(readFileSync(log!, 'utf-8')).toContain('compiling');
    expect(text).toMatch(/first failures:\n\s+FAIL {2}tests\/a\.test\.ts > adds\n\s+error TS2322/);
    expect(text).toMatch(/never re-run the check to see more/);
    // A green run leaves no stray log behind.
    delete process.env.FAKE_EXIT;
    err.length = 0;
    expect(await heavy()).toBe(0);
    expect(err.join('\n')).not.toMatch(/whole output is kept/);
  });

  it('no open run limits nothing: a plain chat builds as often as it needs', async () => {
    expect(currentScope(repo)).toBeNull();
    expect(await heavy()).toBe(0);
    expect(await heavy()).toBe(0);
    expect(runs()).toBe('2');
  });

  it('a red earns one more run', async () => {
    markPhase(repo, 'build', 'task', Date.now());
    process.env.FAKE_EXIT = '1';
    expect(await heavy()).toBe(1);
    delete process.env.FAKE_EXIT;
    expect(await heavy()).toBe(0);
    expect(await heavy()).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(runs()).toBe('2');
  });
});

/** Audit OR-5: a verify script's own setup failure costs no run, and an old build is refused before the queue. */
describe('builder heavy and the browser preflight', () => {
  let repo: string; let err: string[]; let deps: BuilderDeps;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  const age = (rel: string, secondsAgo: number) => { const t = new Date(Date.now() - secondsAgo * 1000); utimesSync(join(repo, rel), t, t); };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dc-heavy-preflight-'));
    git('init', '-q', '-b', 'work');
    err = [];
    deps = { cwd: () => repo, print: () => {}, printErr: (l) => err.push(l), ps: () => '', kill: () => {}, heavySlotDir: () => join(repo, 'slots'), heavyLimit: async () => 2 };
    put('.gitignore', 'ran.txt\nslots/\ndist/\n');
    put('scripts/verify/lib/preflight.mjs', 'export const HARNESS_EXIT = 78;\n');
    // Stands in for a verify script: counts its runs, exits as told.
    put('scripts/verify/dev.mjs', "import { appendFileSync } from 'node:fs';\nappendFileSync('ran.txt', 'ran\\n'); process.exit(Number(process.env.FAKE_EXIT || 0));\n");
    put('scripts/verify/built.mjs', "// openApp({ build: true })\nimport { appendFileSync } from 'node:fs';\nappendFileSync('ran.txt', 'ran\\n');\n");
    put('src/a.ts', 'export const a = 1;\n');
    put('dashboard/src/b.tsx', 'export const b = 1;\n');
    put('dist/index.js', '');
    put('dist/dashboard/index.html', '');
    put('dashboard/dist/index.html', '');
    put('scripts/verify/own-vite.mjs', "// fromDash('@vitejs/plugin-react/dist/index.js'): its own Vite on the source\nimport { appendFileSync } from 'node:fs';\nappendFileSync('ran.txt', 'ran\\n');\n");
    git('add', '-A'); git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'i');
    for (const f of ['src/a.ts', 'dashboard/src/b.tsx', 'scripts/verify/dev.mjs', 'scripts/verify/built.mjs']) age(f, 600);
    for (const f of ['dashboard/dist/index.html', 'dist/index.js', 'dist/dashboard/index.html']) age(f, 300);
  });
  afterEach(() => { delete process.env.FAKE_EXIT; rmSync(repo, { recursive: true, force: true }); });
  const runs = () => { try { return readFileSync(join(repo, 'ran.txt'), 'utf-8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const heavy = (script: string, o: { because?: string; env?: string } = {}) => {
    const cwd = process.cwd(); process.chdir(repo);
    const { env, ...rest } = o;
    // As the refusal prints it: one quoted line, run through a shell.
    return builderHeavy(deps, env ? [`${env} node scripts/verify/${script}`] : ['node', `scripts/verify/${script}`], { maxWait: '5', ...rest }).finally(() => process.chdir(cwd));
  };

  it('a HARNESS exit is given back twice on the same code, then counts like any red', async () => {
    markPhase(repo, 'look', 'task', Date.now());
    process.env.FAKE_EXIT = String(VERIFY_HARNESS_EXIT);
    expect(await heavy('dev.mjs')).toBe(VERIFY_HARNESS_EXIT);
    expect(err.join('\n')).toMatch(/HARNESS: the check stopped in its own setup and tested nothing of the product; this run is not counted \(1 of 2 on this code\)/);
    expect(await heavy('dev.mjs')).toBe(VERIFY_HARNESS_EXIT);
    let [bucket] = Object.values(readBudget(budgetPath(repo)).buckets);
    expect(bucket).toMatchObject({ runs: 0, reds: 0, harness: HARNESS_FREE_RUNS });
    err.length = 0;
    expect(await heavy('dev.mjs')).toBe(VERIFY_HARNESS_EXIT);
    expect(err.join('\n')).toMatch(/uncounted HARNESS runs on this code are spent: this one counts/);
    [bucket] = Object.values(readBudget(budgetPath(repo)).buckets);
    expect(bucket).toMatchObject({ runs: 1, reds: 1, harness: HARNESS_FREE_RUNS });
    // The product was never reached, so the browser limit is still whole: 2 more runs, plus the red's one.
    delete process.env.FAKE_EXIT;
    expect(await heavy('dev.mjs')).toBe(0);
    expect(await heavy('dev.mjs')).toBe(0);
    expect(await heavy('dev.mjs')).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(runs()).toBe(5);
  });

  it('an ordinary red is still counted', async () => {
    markPhase(repo, 'look', 'task', Date.now());
    process.env.FAKE_EXIT = '1';
    expect(await heavy('dev.mjs')).toBe(1);
    const [bucket] = Object.values(readBudget(budgetPath(repo)).buckets);
    expect(bucket).toMatchObject({ runs: 1, reds: 1 });
    expect(bucket.harness).toBeUndefined();
  });

  it('a script on the built app is refused before the queue while dist/ is older than the code, and names the build', async () => {
    // No run open: the build check stands on its own, outside the repeat limit.
    expect(await heavy('built.mjs')).toBe(0);
    put('src/a.ts', 'export const a = 2;\n');
    err.length = 0;
    expect(await heavy('built.mjs')).toBe(HEAVY_BUILD_FIRST_EXIT);
    const text = err.join('\n');
    expect(text).toMatch(/dist\/index\.js is older than src\/a\.ts/);
    expect(text).toMatch(/NOTHING ran, nothing was counted/);
    expect(text).toMatch(/builder heavy -- npm run build:cli/);
    expect(text).toMatch(/older build on purpose\? builder heavy -- 'DC_VERIFY_DIST=dist\/index\.js '\\''node'\\'' '\\''scripts\/verify\/built\.mjs'\\'''/);
    expect(runs()).toBe(1);
    // --because passes no stale build: the script would stop on it as HARNESS.
    expect(await heavy('built.mjs', { because: 'before shots on the old build' })).toBe(HEAVY_BUILD_FIRST_EXIT);
    // A dev-server script never reads dist/, nor one whose only dist path is a dependency's: they run.
    expect(await heavy('dev.mjs')).toBe(0);
    expect(await heavy('own-vite.mjs')).toBe(0);
    // Built again: it runs.
    put('dist/index.js', '// rebuilt\n');
    expect(await heavy('built.mjs')).toBe(0);
    // The dashboard is measured on Vite's own output: a CLI build re-copies it, fresh mtime and all.
    put('dashboard/src/b.tsx', 'export const b = 2;\n');
    put('dist/index.js', '// build:cli again\n'); put('dist/dashboard/index.html', '<!-- the old copy -->');
    err.length = 0;
    expect(await heavy('built.mjs')).toBe(HEAVY_BUILD_FIRST_EXIT);
    expect(err.join('\n')).toMatch(/dashboard\/dist\/index\.html is older than dashboard\/src\/b\.tsx.*\n.*npm run build$/m);
    // An older build on purpose: the env prefix both sides honor.
    expect(await heavy('built.mjs', { env: 'DC_VERIFY_DIST=dist/index.js' })).toBe(0);
    expect(runs()).toBe(5);
  });

  it('applies only where the preflight file is, and DC_VERIFY_DIST on the line opts out', () => {
    expect(drivesDist('node scripts/verify/built.mjs', 'scripts/verify/built.mjs', repo)).toBe(true);
    expect(drivesDist('node scripts/verify/look.mjs --build', 'scripts/verify/look.mjs', repo)).toBe(true);
    expect(drivesDist('DC_VERIFY_DIST=tmp/old/index.js node scripts/verify/built.mjs', 'scripts/verify/built.mjs', repo)).toBe(false);
    expect(drivesDist('node scripts/verify/dev.mjs', 'scripts/verify/dev.mjs', repo)).toBe(false);
    expect(drivesDist('node scripts/verify/own-vite.mjs', 'scripts/verify/own-vite.mjs', repo)).toBe(false);
    expect(drivesDist('node scripts/verify/look.mjs --build-only-x', 'scripts/verify/look.mjs', repo)).toBe(false);
    put('src/a.ts', 'export const a = 3;\n');
    expect(staleDistFor(repo)?.why).toMatch(/src\/a\.ts/);
    rmSync(join(repo, 'scripts/verify/lib/preflight.mjs'));
    expect(staleDistFor(repo)).toBeNull();
  });
});
