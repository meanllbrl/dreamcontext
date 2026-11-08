import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builderHeavy, builderLane, type BuilderDeps } from '../../src/cli/commands/builder.js';
import {
  BUDGET_BUCKET_MAX_AGE_MS, BUDGET_LIMITS, HEAVY_OVER_BUDGET_EXIT, budgetPath, classifyHeavy, directHeavy, readBudget,
  currentScope, heavyStep, markPhase, recordRed, recordStart, refusal, shellQuote, shellSegments, type BudgetScope,
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

  it('a new phase, moved by the commands a run already makes, starts a new count', async () => {
    markPhase(repo, 'build', 'task', Date.now());
    expect(await heavy()).toBe(0);
    expect(await heavy()).toBe(HEAVY_OVER_BUDGET_EXIT);
    markPhase(repo, 'w1', 'task', Date.now());
    expect(await heavy()).toBe(0);
    builderLane(deps, { from: 'HEAD' });
    expect(await heavy()).toBe(0);
    expect(await heavy()).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(Object.keys(readBudget(budgetPath(repo)).buckets).sort()).toEqual(['work task build build', 'work task end build', 'work task w1 build']);
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
