import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * `dreamcontext update` — exit-code contract (integration).
 *
 * The bug this pins: with no installed platform, `update` printed "No installed
 * platforms found" and exited 0. Every batch caller reads the exit code and
 * nothing else — `upgrade`'s per-project fan-out, the launcher's "Update all",
 * a user's propagate loop — so a vault that was never touched was counted as
 * refreshed. A no-op reported as success is how automation is trained to ignore
 * real failures, which is why this is asserted against the REAL built CLI in a
 * subprocess rather than against the action function: the exit code only exists
 * at the process boundary.
 *
 * The second test is the other half of the contract and matters just as much —
 * a fix that made `update` exit non-zero more often than it should would pass
 * the first test alone.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

interface RunResult { output: string; exitCode: number }

/**
 * Spawn the real built CLI with an ISOLATED $HOME so `init`'s vault registration
 * lands in the temp home, never the developer's real ~/.dreamcontext/. `stdin`
 * is ignored so no run can be a TTY — `update`'s stale-file confirm must never
 * be reachable here, and the whole point of the assertion is the non-interactive
 * path a script takes.
 */
function run(args: string[], cwd: string, home: string): RunResult {
  try {
    const output = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { output, exitCode: 0 };
  } catch (e: any) {
    const output = (e.stdout ?? '') + (e.stderr ?? '');
    return { output, exitCode: typeof e.status === 'number' ? e.status : 1 };
  }
}

function makeTmpDir(name: string): string {
  const raw = join(tmpdir(), `ac-update-exit-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

describe('update exit code — no-op must not read as success (integration)', () => {
  let tmp: string;
  let home: string;

  beforeEach(() => {
    tmp = makeTmpDir('proj');
    home = makeTmpDir('home');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('exits 1 with the actionable message when no platform is installed', () => {
    // A real vault, scaffolded but never wired to an agent platform — the
    // orbit-demo shape this was found on.
    run(['init', '--yes', '--name', 'Test', '--description', 'd', '--stack', 'Node', '--priority', 'p'], tmp, home);
    expect(existsSync(join(tmp, '_dream_context'))).toBe(true);
    expect(existsSync(join(tmp, '.claude', 'skills', 'dreamcontext', 'SKILL.md'))).toBe(false);

    const result = run(['update'], tmp, home);

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(1);
    // The message stays clear and actionable — it names the cause AND the fix.
    expect(result.output).toContain('No installed platforms found');
    expect(result.output).toContain('install-skill');
  });

  it('still exits 0 when a platform IS installed and the refresh runs', () => {
    run(['init', '--yes', '--name', 'Test', '--description', 'd', '--stack', 'Node', '--priority', 'p'], tmp, home);
    run(['install-skill', '--platforms', 'claude'], tmp, home);
    expect(existsSync(join(tmp, '.claude', 'skills', 'dreamcontext', 'SKILL.md'))).toBe(true);

    const result = run(['update', '--yes'], tmp, home);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('No installed platforms found');
  });
});
