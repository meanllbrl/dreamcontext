import { describe, it, expect } from 'vitest';
import { accessSync, chmodSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, delimiter } from 'node:path';
import { withGitCredentials, resolveAskpassPath, withNodeDirOnPath } from '../../src/lib/git-sync/credentials.js';

describe('git-sync/credentials — withGitCredentials', () => {
  it('resolves a real, existing askpass.cjs path', () => {
    const p = resolveAskpassPath();
    expect(existsSync(p)).toBe(true);
  });

  it('resolves an EXECUTABLE askpass.cjs — self-heals a 644 helper (git execs GIT_ASKPASS directly)', () => {
    const p = resolveAskpassPath();
    const originalMode = statSync(p).mode & 0o777;
    try {
      chmodSync(p, 0o644); // simulate a build/copy/extract that stripped the exec bit
      const resolved = resolveAskpassPath();
      expect(resolved).toBe(p);
      expect(() => accessSync(resolved, constants.X_OK)).not.toThrow();
    } finally {
      chmodSync(p, originalMode || 0o755);
    }
  });

  it('writes the token to a 0600 tmp file, sets the askpass env, puts no token in env/argv, and unlinks in finally', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let tokenFilePathDuringCall: string | undefined;

    await withGitCredentials('super-secret-token', (env) => {
      capturedEnv = env;
      tokenFilePathDuringCall = env.DREAMCONTEXT_ASKPASS_TOKEN_FILE;
      // File must exist, be 0600, and hold the token WHILE fn runs.
      expect(tokenFilePathDuringCall).toBeTruthy();
      const stat = statSync(tokenFilePathDuringCall!);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(readFileSync(tokenFilePathDuringCall!, 'utf-8')).toBe('super-secret-token');
    });

    expect(capturedEnv?.GIT_ASKPASS).toBeTruthy();
    expect(existsSync(capturedEnv!.GIT_ASKPASS!)).toBe(true);
    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0');
    // The token itself must never appear in the env object (only the path to the file does).
    expect(Object.values(capturedEnv ?? {})).not.toContain('super-secret-token');

    // Unlinked in finally.
    expect(existsSync(tokenFilePathDuringCall!)).toBe(false);
  });

  it('unlinks the tmp file even when fn throws', async () => {
    let tokenFilePath: string | undefined;
    await expect(
      withGitCredentials('another-token', (env) => {
        tokenFilePath = env.DREAMCONTEXT_ASKPASS_TOKEN_FILE;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(tokenFilePath).toBeTruthy();
    expect(existsSync(tokenFilePath!)).toBe(false);
  });

  it('puts node on PATH so the askpass helper (#!/usr/bin/env node) runs under a minimal GUI PATH', async () => {
    // Regression: the desktop app spawns the server with PATH=/usr/bin:/bin:/usr/sbin:/sbin
    // (no node), so git could not exec the helper and the failure was misread as an
    // expired GitHub sign-in. withGitCredentials must repair PATH.
    const nodeDir = dirname(process.execPath);
    const minimal = '/usr/bin:/bin:/usr/sbin:/sbin';
    const original = process.env.PATH;
    process.env.PATH = minimal;
    try {
      let capturedPath: string | undefined;
      await withGitCredentials('t', (env) => { capturedPath = env.PATH; });
      expect(capturedPath?.split(delimiter)).toContain(nodeDir);
      // Prepended (wins over anything ahead of it) and the original entries preserved.
      expect(capturedPath?.startsWith(nodeDir)).toBe(true);
      expect(capturedPath).toContain('/usr/bin');
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });

  it('withNodeDirOnPath is idempotent and tolerates an empty/undefined PATH', () => {
    const nodeDir = dirname(process.execPath);
    // Already present → returned unchanged (no duplicate prepend).
    const already = `${nodeDir}${delimiter}/usr/bin`;
    expect(withNodeDirOnPath(already)).toBe(already);
    // Empty / undefined → just the node dir, no dangling delimiter.
    expect(withNodeDirOnPath('')).toBe(nodeDir);
    expect(withNodeDirOnPath(undefined)).toBe(nodeDir);
  });

  it('askpass.cjs echoes x-access-token for a username prompt and the token file contents otherwise', async () => {
    const askpass = resolveAskpassPath();
    const usernameOut = execFileSync('node', [askpass, 'Username for https://github.com'], { encoding: 'utf-8' });
    expect(usernameOut).toBe('x-access-token');

    await withGitCredentials('the-real-token', (env) => {
      const passwordOut = execFileSync('node', [askpass, 'Password for https://x@github.com'], {
        encoding: 'utf-8',
        env,
      });
      expect(passwordOut).toBe('the-real-token');
    });
  });
});
