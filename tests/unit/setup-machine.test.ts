import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awaitGitForInit, renderReadiness, runMachinePhase, type BackgroundFix, type TtyDeps,
} from '../../src/cli/onboarding-tty.js';
import { machineMode } from '../../src/cli/commands/setup.js';
import { CLI_COPY } from '../../src/lib/onboarding/copy.js';
import { CLI_INTERACTIVE, type FixOutcome } from '../../src/lib/onboarding/fixes.js';
import { listPendingGitInits, recordPendingGitInit, runPendingGitInits } from '../../src/lib/onboarding/pending-git.js';
import { isFixActive, resetReadinessForTests } from '../../src/lib/onboarding/readiness.js';
import { CHECK_DEPS, CHECK_SCOPES, CHECK_TIERS, type CheckId, type CheckStatus, type FixId, type FixKind, type ReadinessCheck, type ReadinessReport } from '../../src/lib/onboarding/types.js';
import { addVault, listVaults } from '../../src/lib/vaults.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function check(id: CheckId, status: CheckStatus, fix?: { id: FixId; kind: FixKind }, reason?: ReadinessCheck['reason']): ReadinessCheck {
  return {
    id,
    tier: CHECK_TIERS[id],
    scopes: [...CHECK_SCOPES[id]],
    status,
    dependsOn: [...CHECK_DEPS[id]],
    ...(reason ? { reason } : {}),
    fix: fix ? { id: fix.id, kind: fix.kind, runnable: fix.kind !== 'manual', editsShellProfile: false } : null,
  };
}

function report(checks: ReadinessCheck[], plan: FixId[]): ReadinessReport {
  return {
    version: 1, platform: 'darwin', arch: 'arm64', surface: 'cli', generatedAt: 0,
    ready: checks.every((c) => c.tier !== 'required' || c.status === 'ok' || c.status === 'unknown'),
    online: true, plan, next: null, activeFixes: [], checks,
  };
}

const READY = report([
  check('network', 'ok'), check('node', 'ok'), check('npm', 'ok'), check('cli', 'ok'),
  check('claude', 'ok'), check('claude-auth', 'ok'), check('git', 'ok'), check('github', 'ok'), check('gh', 'ok'),
], []);

const FRESH = report([
  check('network', 'ok'), check('node', 'ok'), check('npm', 'ok'),
  check('cli', 'missing', { id: 'cli-install', kind: 'auto' }, 'not-installed'),
  check('claude', 'ok'),
  check('claude-auth', 'missing', { id: 'claude-signin', kind: 'browser' }, 'signed-out'),
  check('git', 'missing', { id: 'git-install', kind: 'system-dialog' }, 'not-installed'),
  check('github', 'ok'), check('gh', 'ok'),
], ['git-install', 'cli-install', 'claude-signin']);

interface Fake extends TtyDeps {
  lines: string[];
  fixes: FixId[];
  interactive: string[][];
  confirms: string[];
  inits: string[];
}

function fakeDeps(over: Partial<TtyDeps> & { reports?: ReadinessReport[]; home?: string } = {}): Fake {
  const reports = [...(over.reports ?? [READY])];
  const lines: string[] = [];
  const fixes: FixId[] = [];
  const interactive: string[][] = [];
  const confirms: string[] = [];
  const inits: string[] = [];
  let clock = 0;
  const base: Fake = {
    lines, fixes, interactive, confirms, inits,
    home: over.home ?? '/nonexistent-home',
    platform: 'darwin',
    probe: async () => (reports.length > 1 ? reports.shift()! : reports[0]),
    runFix: async (id) => { fixes.push(id); return { ok: true }; },
    runInteractive: async (argv) => { interactive.push(argv); return 0; },
    confirm: async (m) => { confirms.push(m); return true; },
    waitForEnter: (signal) => new Promise((r) => signal.addEventListener('abort', () => r(), { once: true })),
    print: (l) => { lines.push(l); },
    runPendingGitInits: () => [],
    recordPendingGitInit: () => true,
    ensureRegistered: () => true,
    gitUsable: () => false,
    initRepo: (dir) => { inits.push(dir); mkdirSync(join(dir, '.git'), { recursive: true }); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    interactiveEnv: () => ({}),
  };
  const { reports: _r, ...rest } = over;
  return Object.assign(base, rest);
}

let tmp: string;
beforeEach(() => {
  resetReadinessForTests();
  tmp = mkdtempSync(join(tmpdir(), 'dc-setup-machine-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeProject(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, '_dream_context'), { recursive: true });
  return dir;
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

describe('renderReadiness', () => {
  it('uses only ✓ ✗ ℹ and a dim –, never emoji or em dashes', () => {
    const r = report([
      check('network', 'ok'), check('node', 'ok'), check('npm', 'ok'),
      check('cli', 'missing', { id: 'cli-install', kind: 'auto' }, 'not-installed'),
      check('claude', 'ok'), { ...check('claude-auth', 'blocked'), blockedBy: ['claude'] },
      check('git', 'missing', { id: 'git-install', kind: 'manual' }, 'not-installed'),
      check('github', 'unknown', undefined, 'unverifiable'), check('gh', 'ok'),
    ], []);
    r.checks[6].fix!.manual = 'sudo apt install git';
    const text = renderReadiness(r).join('\n');
    expect(text).toContain('✓');
    expect(text).toContain('✗');
    expect(text).toContain('ℹ');
    expect(text).toContain('–');
    expect(text).toContain('Run: sudo apt install git');
    expect(text).not.toMatch(/—/);
    // ✓ ✗ ℹ are the CLI's convention symbols (ℹ is itself pictographic in Unicode); nothing else may be.
    expect(text.replace(/[✓✗ℹ]/g, '')).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('hides the network and package-manager rows when they are fine, and agent-only rows', () => {
    const text = renderReadiness({ ...READY, checks: [...READY.checks, check('terminal', 'missing', { id: 'pty-install', kind: 'auto' })] }).join('\n');
    expect(text).not.toContain('Internet connection');
    expect(text).not.toContain('Node package manager');
    expect(text).not.toContain('Built-in terminal');
  });
});

describe('machineMode', () => {
  it('--yes runs automatic fixes; a terminal without --defaults asks; anything else reports', () => {
    expect(machineMode({ yes: true }, false)).toBe('yes');
    expect(machineMode({}, true)).toBe('interactive');
    expect(machineMode({ defaults: true }, true)).toBe('report');
    expect(machineMode({}, false)).toBe('report');
  });
});

// ─── Machine phase ─────────────────────────────────────────────────────────────

describe('runMachinePhase', () => {
  it('report mode runs pending inits first, then only reports: no fixes, no questions', async () => {
    const calls: string[] = [];
    const deps = fakeDeps({
      reports: [FRESH],
      runPendingGitInits: () => { calls.push('pending'); return ['/p/one']; },
      probe: async () => { calls.push('probe'); return FRESH; },
    });
    const r = await runMachinePhase({ mode: 'report' }, deps);
    expect(calls).toEqual(['pending', 'probe']);
    expect(r.pendingInitialized).toEqual(['/p/one']);
    expect(deps.fixes).toEqual([]);
    expect(deps.confirms).toEqual([]);
    expect(deps.interactive).toEqual([]);
    expect(deps.lines.join('\n')).toContain('Next: run dreamcontext setup');
  });

  it('--yes runs automatic fixes only, never a sign-in or the macOS dialog', async () => {
    const deps = fakeDeps({ reports: [FRESH, { ...FRESH, plan: ['git-install', 'claude-signin'] }] });
    const r = await runMachinePhase({ mode: 'yes' }, deps);
    expect(deps.fixes).toEqual(['cli-install']);
    expect(deps.interactive).toEqual([]);
    expect(deps.confirms).toEqual([]);
    expect(r.gitInstall).toBeNull();
    expect(r.ran).toEqual(['cli-install']);
  });

  it('interactive: Git install starts first in the background, then each fix asks once; sign-ins use this terminal', async () => {
    let releaseGit: (o: FixOutcome) => void = () => {};
    const deps = fakeDeps({
      reports: [FRESH, { ...FRESH, plan: ['git-install', 'claude-signin'] }, { ...FRESH, plan: ['git-install'] }],
      runFix: async (id) => {
        deps.fixes.push(id);
        if (id === 'git-install') return new Promise<FixOutcome>((r) => { releaseGit = r; });
        return { ok: true };
      },
    });
    const r = await runMachinePhase({ mode: 'interactive' }, deps);
    expect(deps.fixes).toEqual(['git-install', 'cli-install']);
    expect(deps.interactive).toEqual([CLI_INTERACTIVE['claude-signin']]);
    expect(deps.confirms).toHaveLength(3);
    expect(deps.confirms[0]).toMatch(/background/);
    // Still installing: registered active for this process, so the git offer can wait on it.
    expect(r.gitInstall).not.toBeNull();
    expect(isFixActive('git-install')).toBe(true);
    releaseGit({ ok: true });
    await r.gitInstall!.done;
    expect(isFixActive('git-install')).toBe(false);
  });

  it('a declined fix is not run', async () => {
    const deps = fakeDeps({ reports: [{ ...FRESH, plan: ['cli-install'] }], confirm: async () => false });
    await runMachinePhase({ mode: 'interactive' }, deps);
    expect(deps.fixes).toEqual([]);
  });
});

// ─── Git init while Git is still installing ────────────────────────────────────

function runningGit(): BackgroundFix & { finish(o: FixOutcome): void } {
  let finish: (o: FixOutcome) => void = () => {};
  let settled = false;
  const done = new Promise<FixOutcome>((r) => { finish = (o) => { settled = true; r(o); }; });
  return { id: 'git-install', done, settled: () => settled, abort: () => {}, finish: (o) => finish(o) };
}

describe('awaitGitForInit', () => {
  it('Git usable already: git init right away', async () => {
    const proj = makeProject('ready');
    const deps = fakeDeps({ gitUsable: () => true });
    expect(await awaitGitForInit(proj, null, deps)).toBe('initialized');
    expect(existsSync(join(proj, '.git'))).toBe(true);
  });

  it('same run: waits with the macOS line, and runs git init when the install lands', async () => {
    const proj = makeProject('same-run');
    let polls = 0;
    const deps = fakeDeps({ gitUsable: () => ++polls > 3 });
    const out = await awaitGitForInit(proj, runningGit(), deps, { pollMs: 5_000 });
    expect(out).toBe('initialized');
    expect(existsSync(join(proj, '.git'))).toBe(true);
    expect(deps.lines.join('\n')).toContain(CLI_COPY.gitWaiting);
  });

  it('off macOS the waiting line names no macOS tool', async () => {
    const proj = makeProject('linux');
    let polls = 0;
    const deps = fakeDeps({ platform: 'linux', gitUsable: () => ++polls > 2 });
    await awaitGitForInit(proj, runningGit(), deps);
    const text = deps.lines.join('\n');
    expect(text).toContain('Waiting for Git to finish installing');
    expect(text).not.toMatch(/macOS/);
  });

  it('Enter skips: the folder is registered and recorded, and the next setup sets Git up', async () => {
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const proj = makeProject('Öğretmen Notları');
    let gitReady = false;
    const deps = fakeDeps({
      home,
      waitForEnter: async () => {},
      gitUsable: () => gitReady,
      ensureRegistered: (p) => { addVault('ogretmen', p, home); return true; },
      recordPendingGitInit: (p) => recordPendingGitInit(p, home),
    });
    expect(await awaitGitForInit(proj, runningGit(), deps)).toBe('pending');
    expect(existsSync(join(proj, '.git'))).toBe(false);
    expect(deps.lines.join('\n')).toContain(CLI_COPY.gitLater);
    expect(listPendingGitInits(home)).toEqual([proj.normalize('NFC')]);
    expect(listVaults(home).map((v) => v.name)).toEqual(['ogretmen']);

    // The stub flips: Git is usable now. The next `setup` picks the pending entry up first.
    gitReady = true;
    const next = fakeDeps({
      home,
      runPendingGitInits: () => runPendingGitInits({ home, gitAvailable: () => gitReady, initRepo: (d) => mkdirSync(join(d, '.git')) }),
    });
    const r = await runMachinePhase({ mode: 'report' }, next);
    expect(r.pendingInitialized).toHaveLength(1);
    expect(existsSync(join(proj, '.git'))).toBe(true);
    expect(listPendingGitInits(home)).toEqual([]);
  });

  it('times out after the bound and records the folder, never waiting forever', async () => {
    const proj = makeProject('timeout');
    const recorded: string[] = [];
    const deps = fakeDeps({ recordPendingGitInit: (p) => { recorded.push(p); return true; } });
    expect(await awaitGitForInit(proj, runningGit(), deps, { timeoutMs: 20_000, pollMs: 5_000 })).toBe('pending');
    expect(recorded).toEqual([proj]);
  });

  it('a Git install that failed stops the wait', async () => {
    const proj = makeProject('failed');
    const git = runningGit();
    git.finish({ ok: false, reason: 'failed' });
    await git.done;
    const deps = fakeDeps({ sleep: async () => { throw new Error('should not sleep'); } });
    expect(await awaitGitForInit(proj, git, deps)).toBe('pending');
  });

  it('no Git install from this run and no Git: says how to finish later, records nothing it cannot honour', async () => {
    const proj = makeProject('nogit');
    const deps = fakeDeps({ ensureRegistered: () => false });
    expect(await awaitGitForInit(proj, null, deps)).toBe('pending');
    expect(deps.lines.join('\n')).toContain('Run git init in this folder once Git is installed.');
  });
});
