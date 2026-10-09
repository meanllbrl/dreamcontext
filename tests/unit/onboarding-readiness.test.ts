import { describe, it, expect, beforeEach } from 'vitest';
import {
  probeReadiness, getReadiness, invalidateReadiness, markFixActive, markFixDone, isFixActive,
  cliInstallDeferred, resetReadinessForTests, type ReadinessDeps,
} from '../../src/lib/onboarding/readiness.js';
import type { ProbeContext, ProbeRunner, ShellResult } from '../../src/lib/onboarding/types.js';

const ok = (stdout = ''): ShellResult => ({ ok: true, stdout, stderr: '', code: 0 });

function makeRunner(shellStdout: string, opts: { online?: boolean; ghOk?: boolean } = {}) {
  const calls = { loginShell: 0, exec: [] as string[][] };
  const runner: ProbeRunner = {
    loginShell: async () => { calls.loginShell++; await new Promise((r) => setTimeout(r, 5)); return ok(shellStdout); },
    exec: async (file, args) => { calls.exec.push([file, ...args]); return opts.ghOk === false ? { ok: false, stdout: '', stderr: 'not logged in', code: 1 } : ok(); },
    fetchOk: async () => opts.online ?? true,
  };
  return { runner, calls };
}

function makeDeps(over: Partial<ReadinessDeps> = {}) {
  const seen: string[] = [];
  let clock = 1_000_000;
  const deps: ReadinessDeps = {
    claudeAuth: async (dir) => { seen.push(dir); return { loggedIn: true, email: 'ada@example.com' }; },
    preferredConfigDir: () => '/home/u/.dreamcontext/claude-accounts/work',
    findClaudeBin: () => null,
    github: () => ({ connected: false, needsReconnect: false, login: null }),
    exists: () => false,
    linuxPm: () => null,
    now: () => clock,
    ...over,
  };
  return { deps, seen, tick: (ms: number) => { clock += ms; } };
}

const ctxFor = (runner: ProbeRunner): ProbeContext => ({
  surface: 'desktop', platform: 'darwin', arch: 'arm64', home: '/home/u', execPath: '/opt/homebrew/bin/node',
  runner, probeUrl: 'http://127.0.0.1:1/', ptyPresent: () => true,
});

const READY_SHELL = [
  '__DC__node=/opt/homebrew/bin/node', '__DC__nodeVersion=v22.3.0', '__DC__npm=/opt/homebrew/bin/npm',
  '__DC__dreamcontext=/opt/homebrew/bin/dreamcontext', '__DC__claude=/u/.local/bin/claude',
  '__DC__gh=/opt/homebrew/bin/gh', '__DC__git=/opt/homebrew/bin/git', '__DC__clt=1',
].join('\n');

beforeEach(() => resetReadinessForTests());

describe('probeReadiness', () => {
  it('asks Claude about the preferred account folder (a sandboxed account is not read as signed out)', async () => {
    const { runner } = makeRunner(READY_SHELL);
    const { deps, seen } = makeDeps();
    const r = await probeReadiness(ctxFor(runner), deps);
    expect(seen).toEqual(['/home/u/.dreamcontext/claude-accounts/work']);
    expect(r.checks.find((c) => c.id === 'claude-auth')).toMatchObject({ status: 'ok', account: 'ada@example.com' });
  });

  it('gh auth is probed with the resolved gh; offline turns a failure into unknown', async () => {
    const { runner, calls } = makeRunner(READY_SHELL, { online: false, ghOk: false });
    const r = await probeReadiness(ctxFor(runner), makeDeps().deps);
    expect(calls.exec).toContainEqual(['/opt/homebrew/bin/gh', 'auth', 'status', '--hostname', 'github.com']);
    expect(r.checks.find((c) => c.id === 'gh')?.status).toBe('unknown');
    expect(r.online).toBe(false);
    expect(r.ready).toBe(false); // network is required
  });

  it('a ready machine is ready, plans only the optional-free recommended fixes', async () => {
    const { runner } = makeRunner(READY_SHELL);
    const r = await probeReadiness(ctxFor(runner), makeDeps().deps);
    expect(r.ready).toBe(true);
    expect(r.plan).toEqual(['github-signin']);
    expect(r).toMatchObject({ version: 1, surface: 'desktop', platform: 'darwin' });
  });
});

describe('fix registry', () => {
  it('markFixActive / markFixDone drive isFixActive and report.activeFixes', async () => {
    const { runner } = makeRunner(READY_SHELL);
    const { deps } = makeDeps();
    markFixActive('git-install');
    expect(isFixActive('git-install')).toBe(true);
    expect((await getReadiness(ctxFor(runner), {}, deps)).activeFixes).toEqual(['git-install']);
    markFixDone('git-install');
    expect(isFixActive('git-install')).toBe(false);
    expect((await getReadiness(ctxFor(runner), {}, deps)).activeFixes).toEqual([]);
  });
});

describe('getReadiness memo + coalescing', () => {
  it('concurrent fresh requests share one probe; a second fresh within 2 s reuses it', async () => {
    const { runner, calls } = makeRunner(READY_SHELL);
    const { deps, tick } = makeDeps();
    await Promise.all([1, 2, 3].map(() => getReadiness(ctxFor(runner), { fresh: true }, deps)));
    expect(calls.loginShell).toBe(1);
    tick(1_000);
    await getReadiness(ctxFor(runner), { fresh: true }, deps);
    expect(calls.loginShell).toBe(1);
    tick(1_500);
    await getReadiness(ctxFor(runner), { fresh: true }, deps);
    expect(calls.loginShell).toBe(2);
  });

  it('reuses the report for 5 s, then probes again; invalidate forces a probe', async () => {
    const { runner, calls } = makeRunner(READY_SHELL);
    const { deps, tick } = makeDeps();
    await getReadiness(ctxFor(runner), {}, deps);
    tick(4_000);
    await getReadiness(ctxFor(runner), {}, deps);
    expect(calls.loginShell).toBe(1);
    tick(2_000);
    await getReadiness(ctxFor(runner), {}, deps);
    expect(calls.loginShell).toBe(2);
    invalidateReadiness();
    await getReadiness(ctxFor(runner), {}, deps);
    expect(calls.loginShell).toBe(3);
  });
});

describe('cliInstallDeferred', () => {
  it('true while cli-install runs, or when a recent report shows the CLI missing', async () => {
    expect(cliInstallDeferred()).toBe(false);
    markFixActive('cli-install');
    expect(cliInstallDeferred()).toBe(true);
    markFixDone('cli-install');
    const { runner } = makeRunner(READY_SHELL.replace('__DC__dreamcontext=/opt/homebrew/bin/dreamcontext', '__DC__dreamcontext='));
    const { deps } = makeDeps();
    await getReadiness(ctxFor(runner), {}, deps);
    expect(cliInstallDeferred(1_000_000 + 30_000)).toBe(true);
    expect(cliInstallDeferred(1_000_000 + 61_000)).toBe(false);
  });
});

describe('invalidateReadiness while a probe is in flight', () => {
  it('a fresh request gets a new probe, and the stale probe never overwrites the cache', async () => {
    // The first probe sees "no claude" and is held open; the machine then changes (Claude
    // installs), the fix ends and invalidates. Only the post-fix answer may be served or cached.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let probe = 0;
    const calls = { loginShell: 0 };
    const runner: ProbeRunner = {
      loginShell: async () => {
        calls.loginShell++;
        const n = ++probe;
        if (n === 1) {
          await gate;
          return ok(READY_SHELL.replace('__DC__claude=/u/.local/bin/claude', '__DC__claude='));
        }
        return ok(READY_SHELL);
      },
      exec: async () => ok(),
      fetchOk: async () => true,
    };
    const { deps, tick } = makeDeps();
    const claudeOf = (r: { checks: { id: string; status: string }[] }) => r.checks.find((c) => c.id === 'claude')?.status;

    const stale = getReadiness(ctxFor(runner), { fresh: true }, deps); // probe 1, in flight
    await Promise.resolve();
    invalidateReadiness(); // the fix finished
    tick(500); // well inside the 2 s fresh gap of the stale probe
    const after = await getReadiness(ctxFor(runner), { fresh: true }, deps); // must not join probe 1
    expect(calls.loginShell).toBe(2);
    expect(claudeOf(after)).toBe('ok');

    release();
    expect(claudeOf(await stale)).toBe('missing'); // its own caller asked before the fix
    tick(100);
    const cachedNow = await getReadiness(ctxFor(runner), {}, deps);
    expect(calls.loginShell).toBe(2); // served from the cache…
    expect(claudeOf(cachedNow)).toBe('ok'); // …which still holds the post-fix answer
  });
});
