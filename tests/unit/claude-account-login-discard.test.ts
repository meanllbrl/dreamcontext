/**
 * `executeClaudeDetached`'s `discardOutput` — the guard on the in-app SIGN-IN leg.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────────────
 * `POST /api/agent/accounts/login` spawns `claude auth login`. An interactive OAuth flow's
 * stdout can carry a callback URL bearing an AUTHORIZATION CODE, and `executeClaudeDetached`
 * normally BUFFERS the child's full stdout (`attachOutputCollectors`) — a buffer that other
 * callers in the same file write straight to disk (runner.ts's run-log paths). So the login
 * leg passes `discardOutput`, and the property that has to hold is not "we chose not to log
 * it" but "there is no buffer to log": with `stdio: ['ignore','ignore','ignore']` the child's
 * pipes do not exist, so nothing is ever collected.
 *
 * Proven by RUNNING a child that prints a secret, rather than by reading the code and
 * reasoning about it. The spawn is injected, so this costs no `claude` and no tokens.
 */
import { describe, it, expect } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import { executeClaudeDetached } from '../../src/lib/automations/runner.js';

const SECRET = 'SECRET-AUTH-CODE-DO-NOT-LEAK';

/** A stand-in `claude` that prints a callback URL on stdout and a token on stderr. */
function leakySpawn(): typeof nodeSpawn {
  return ((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) => nodeSpawn(
    process.execPath,
    ['-e', `process.stdout.write('Visit https://claude.ai/oauth/callback?code=${SECRET}\\n'); process.stderr.write('token=${SECRET}\\n');`],
    opts as never,
  )) as unknown as typeof nodeSpawn;
}

describe('discardOutput leaves NO buffer for anything to leak', () => {
  it('a child that prints a secret yields an EMPTY stdout and stderrTail', async () => {
    const logged: string[] = [];
    const execution = await executeClaudeDetached(['auth', 'login'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      discardOutput: true,
      spawnImpl: leakySpawn(),
      log: (line) => logged.push(line),
    });

    expect(execution.spawned).toBe(true);
    expect(execution.timedOut).toBe(false);
    // The whole point: not "we didn't write it down" but "there was nothing written down".
    expect(execution.stdout).toBe('');
    expect(execution.stderrTail).toBe('');
    // And nothing reached the logger either — the third place a run's output can end up.
    expect(logged.join('\n')).not.toContain(SECRET);
    // Belt and braces: the secret is nowhere in the serialized result the route could return.
    expect(JSON.stringify(execution)).not.toContain(SECRET);
  });

  it('WITHOUT the flag the same child DOES buffer it — so the guard is load-bearing, not decorative', async () => {
    const execution = await executeClaudeDetached(['auth', 'login'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      spawnImpl: leakySpawn(),
    });
    // This is the negative control. If this ever stops containing the secret, the test above
    // has quietly stopped proving anything and this file needs rewriting.
    expect(execution.stdout).toContain(SECRET);
  });

  it('the env is merged over the base, so a per-account CLAUDE_CONFIG_DIR wins', async () => {
    let seenEnv: Record<string, string> = {};
    const capture = ((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) => {
      seenEnv = (opts.env ?? {}) as Record<string, string>;
      return nodeSpawn(process.execPath, ['-e', ''], opts as never);
    }) as unknown as typeof nodeSpawn;

    await executeClaudeDetached(['auth', 'login'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      discardOutput: true,
      env: { CLAUDE_CONFIG_DIR: '/tmp/some-account-sandbox' },
      spawnImpl: capture,
    });

    expect(seenEnv.CLAUDE_CONFIG_DIR).toBe('/tmp/some-account-sandbox');
    // The base env survives around it — the merge adds, it does not replace.
    expect(seenEnv.PATH).toBeTruthy();
  });
});
