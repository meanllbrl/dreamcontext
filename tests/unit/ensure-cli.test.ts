/**
 * Unit tests for ensureCliInstalled — the best-effort global `dreamcontext`
 * install that lets a scaffolded project's `npx dreamcontext hook …` calls work.
 * Uses an injected shell runner (no real shell / npm spawned).
 */
import { describe, it, expect } from 'vitest';
import { ensureCliInstalled, type ShellResult, type ShellRunner } from '../../src/lib/ensure-cli.js';

const ok = (stdout = ''): ShellResult => ({ ok: true, stdout, stderr: '' });
const fail = (stderr = 'err'): ShellResult => ({ ok: false, stdout: '', stderr });

/** Build a runner that answers by script substring and records the scripts seen. */
function runnerFrom(map: (script: string) => ShellResult): { runner: ShellRunner; scripts: string[] } {
  const scripts: string[] = [];
  const runner: ShellRunner = async (script) => {
    scripts.push(script);
    return map(script);
  };
  return { runner, scripts };
}

describe('ensureCliInstalled', () => {
  it("returns 'present' and never installs when dreamcontext is already on PATH", async () => {
    const { runner, scripts } = runnerFrom((s) =>
      s.includes('command -v dreamcontext') ? ok('/usr/local/bin/dreamcontext') : ok(),
    );
    const res = await ensureCliInstalled(runner);
    expect(res.status).toBe('present');
    expect(scripts.some((s) => s.includes('npm install'))).toBe(false);
  });

  it("installs from npm and returns 'installed' when missing but npm exists", async () => {
    const { runner, scripts } = runnerFrom((s) => {
      if (s.includes('command -v dreamcontext')) return fail(); // not on PATH
      if (s.includes('command -v npm')) return ok('/usr/local/bin/npm');
      if (s.includes('npm install -g dreamcontext')) return ok('added 1 package');
      return ok();
    });
    const res = await ensureCliInstalled(runner);
    expect(res.status).toBe('installed');
    expect(scripts.some((s) => s.includes('npm install -g dreamcontext@latest'))).toBe(true);
  });

  it("returns 'failed' with guidance when npm is not found", async () => {
    const { runner } = runnerFrom((s) =>
      s.includes('command -v') ? fail() : ok(),
    );
    const res = await ensureCliInstalled(runner);
    expect(res.status).toBe('failed');
    expect(res.message).toMatch(/npm/i);
  });

  it("returns 'failed' when the npm install itself fails", async () => {
    const { runner } = runnerFrom((s) => {
      if (s.includes('command -v dreamcontext')) return fail();
      if (s.includes('command -v npm')) return ok('/usr/local/bin/npm');
      if (s.includes('npm install')) return fail('EACCES');
      return ok();
    });
    const res = await ensureCliInstalled(runner);
    expect(res.status).toBe('failed');
    expect(res.message).toMatch(/npm install -g dreamcontext/);
  });

  it('probes with a single script: a fast -lc lookup that falls back to an interactive shell only when it resolves nothing', async () => {
    // `||` is the fallback mechanism, not a second JS-level call — the fast
    // `command -v dreamcontext` runs first, and the `-ic` sub-shell on the right
    // only executes (per POSIX `||` semantics) when the left side finds nothing.
    const { runner, scripts } = runnerFrom((s) =>
      s.includes('command -v dreamcontext') ? ok('/usr/local/bin/dreamcontext') : ok(),
    );
    const res = await ensureCliInstalled(runner);
    expect(res.status).toBe('present');
    expect(scripts[0]).toBe(
      'command -v dreamcontext || "${SHELL:-/bin/zsh}" -ic "command -v dreamcontext" 2>/dev/null',
    );
    // Exactly one probe call — the fallback is embedded in the script text, so
    // fixing the misreport case never costs a second runner invocation.
    expect(scripts.filter((s) => s.includes('command -v dreamcontext')).length).toBe(1);
  });

  it('invokes the npm install command exactly once when the CLI is missing on both the fast and fallback paths', async () => {
    const { runner, scripts } = runnerFrom((s) => {
      if (s.includes('command -v dreamcontext')) return fail(); // fast path AND its embedded -ic fallback both resolve nothing
      if (s.includes('command -v npm')) return ok('/usr/local/bin/npm');
      if (s.includes('npm install -g dreamcontext')) return ok('added 1 package');
      return ok();
    });
    const res = await ensureCliInstalled(runner);
    expect(res.status).toBe('installed');
    const installCalls = scripts.filter((s) => s.includes('npm install -g dreamcontext'));
    expect(installCalls.length).toBe(1);
  });
});
