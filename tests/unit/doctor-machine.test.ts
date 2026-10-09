import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/cli/program.js';
import { machineToDoctorResults, runDoctorMachine } from '../../src/cli/commands/doctor.js';
import type { TtyDeps } from '../../src/cli/onboarding-tty.js';
import { listPendingGitInits, recordPendingGitInit, runPendingGitInits } from '../../src/lib/onboarding/pending-git.js';
import { CHECK_DEPS, CHECK_SCOPES, CHECK_TIERS, type CheckId, type CheckStatus, type ReadinessCheck, type ReadinessReport } from '../../src/lib/onboarding/types.js';
import { addVault } from '../../src/lib/vaults.js';

function check(id: CheckId, status: CheckStatus, manual?: string): ReadinessCheck {
  return {
    id, tier: CHECK_TIERS[id], scopes: [...CHECK_SCOPES[id]], status, dependsOn: [...CHECK_DEPS[id]],
    fix: manual ? { id: 'git-install', kind: 'manual', runnable: false, manual, editsShellProfile: false } : null,
  };
}

function report(checks: ReadinessCheck[]): ReadinessReport {
  return {
    version: 1, platform: 'linux', arch: 'x64', surface: 'cli', generatedAt: 0,
    ready: checks.every((c) => c.tier !== 'required' || c.status === 'ok' || c.status === 'unknown'),
    online: true, plan: [], next: null, activeFixes: [], checks,
  };
}

const ALL_OK: CheckId[] = ['network', 'node', 'npm', 'cli', 'claude', 'claude-auth', 'git', 'github', 'gh'];
const READY = report(ALL_OK.map((id) => check(id, 'ok')));
const MISSING_CLAUDE = report(ALL_OK.map((id) => check(id, id === 'claude' ? 'missing' : id === 'git' ? 'missing' : 'ok', id === 'git' ? 'sudo apt install git' : undefined)));

function deps(over: Partial<TtyDeps> = {}): TtyDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    home: '/nonexistent-home',
    platform: 'linux',
    probe: async () => READY,
    runFix: async () => ({ ok: true }),
    runInteractive: async () => 0,
    confirm: async () => true,
    waitForEnter: async () => {},
    print: (l) => { lines.push(l); },
    runPendingGitInits: () => [],
    recordPendingGitInit: () => true,
    ensureRegistered: () => true,
    gitUsable: () => true,
    initRepo: () => {},
    sleep: async () => {},
    now: () => 0,
    interactiveEnv: () => ({}),
    ...over,
  };
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'dc-doctor-machine-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('doctor --machine', () => {
  it('is a registered option of doctor', () => {
    const doctor = createProgram().commands.find((c) => c.name() === 'doctor');
    expect(doctor?.options.map((o) => o.long)).toContain('--machine');
  });

  it('--json prints exactly { version: 1, machine } and exits 0 when ready', async () => {
    const d = deps();
    expect(await runDoctorMachine({ json: true }, d)).toBe(0);
    const parsed = JSON.parse(d.lines.join('\n')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['machine', 'version']);
    expect(parsed.version).toBe(1);
    expect((parsed.machine as ReadinessReport).checks).toHaveLength(ALL_OK.length);
  });

  it('exits 1 when a required check is missing, and the text names the next step', async () => {
    const d = deps({ probe: async () => MISSING_CLAUDE });
    expect(await runDoctorMachine({}, d)).toBe(1);
    const text = d.lines.join('\n');
    expect(text).toContain('Next: dreamcontext setup');
    expect(text).toContain('Run: sudo apt install git');
    expect(text).not.toMatch(/—/);
  });

  it('runs pending git inits first: a project recorded while Git was installing gets .git once Git works', async () => {
    const home = join(tmp, 'home');
    const proj = join(tmp, 'proj');
    mkdirSync(join(proj, '_dream_context'), { recursive: true });
    mkdirSync(home, { recursive: true });
    addVault('proj', proj, home);
    expect(recordPendingGitInit(proj, home)).toBe(true);

    const order: string[] = [];
    const d = deps({
      runPendingGitInits: () => {
        order.push('pending');
        return runPendingGitInits({ home, gitAvailable: () => true, initRepo: (dir) => mkdirSync(join(dir, '.git')) });
      },
      probe: async () => { order.push('probe'); return READY; },
    });
    expect(await runDoctorMachine({}, d)).toBe(0);
    expect(order).toEqual(['pending', 'probe']);
    expect(existsSync(join(proj, '.git'))).toBe(true);
    expect(listPendingGitInits(home)).toEqual([]);
    expect(d.lines.join('\n')).toContain(`Set up Git in ${proj}`);
  });
});

describe('machineToDoctorResults', () => {
  it('maps a required gap to an error, a recommended gap to a warning, with stable codes and the manual fix', () => {
    const results = machineToDoctorResults(MISSING_CLAUDE);
    const claude = results.find((r) => r.code === 'doctor/machine-claude');
    const git = results.find((r) => r.code === 'doctor/machine-git');
    expect(claude?.status).toBe('error');
    expect(git?.status).toBe('warn');
    expect(git?.supportedFixes).toEqual(['sudo apt install git']);
    expect(results.find((r) => r.code === 'doctor/machine-node')?.status).toBe('ok');
  });

  it('leaves out agent-only checks', () => {
    const r = report([...READY.checks, check('terminal', 'missing')]);
    expect(machineToDoctorResults(r).some((x) => x.code === 'doctor/machine-terminal')).toBe(false);
  });
});
