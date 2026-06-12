import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  installTaskSyncHooks,
  uninstallTaskSyncHooks,
  taskSyncHookScript,
} from '../../src/lib/task-backend/git-hooks.js';

/**
 * Issue #11 M5 — git commit/push triggers are best-effort: a sync error or
 * timeout must NEVER fail or block the git operation. Tested at the git level
 * with the CLI forced to fail and forced to hang.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

let tmpDir: string;

function git(cmd: string, cwd = tmpDir): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 20000 });
}

function setupGitRepo(): void {
  git('init -q');
  git('config user.email t@t.test');
  git('config user.name t');
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  tmpDir = realpathSync(raw);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('git sync hooks (M5 — never fail, never block)', () => {
  it('install writes executable post-commit + pre-push hooks that end in exit 0', () => {
    setupGitRepo();
    const res = installTaskSyncHooks(tmpDir, { cliInvocation: 'dreamcontext' });
    expect(res.noGit).toBe(false);
    expect(res.installed.sort()).toEqual(['post-commit', 'pre-push']);

    for (const hook of ['post-commit', 'pre-push']) {
      const path = join(tmpDir, '.git', 'hooks', hook);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('dreamcontext-tasks-sync-hook');
      expect(content.trimEnd().endsWith('exit 0')).toBe(true);
      expect(content).toContain('tasks sync both --hook');
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o111).toBeTruthy();
      }
    }
  });

  it('git commit succeeds even when the sync CLI exits non-zero (adapter forced to error)', () => {
    setupGitRepo();
    const failing = join(tmpDir, 'failing-cli.sh');
    writeFileSync(failing, '#!/bin/sh\necho "sync exploded" >&2\nexit 1\n');
    chmodSync(failing, 0o755);
    installTaskSyncHooks(tmpDir, { cliInvocation: `"${failing}"` });

    writeFileSync(join(tmpDir, 'a.txt'), 'hello');
    git('add a.txt');
    // Throws on non-zero exit — the assertion is that it does NOT throw.
    git('commit -q -m "commit with broken sync"');
    expect(git('log --oneline').trim()).toContain('commit with broken sync');
  });

  it('git commit is not blocked by a hanging sync CLI (adapter forced to timeout)', () => {
    setupGitRepo();
    const hanging = join(tmpDir, 'hanging-cli.sh');
    writeFileSync(hanging, '#!/bin/sh\nsleep 30\n');
    chmodSync(hanging, 0o755);
    installTaskSyncHooks(tmpDir, { cliInvocation: `"${hanging}"` });

    writeFileSync(join(tmpDir, 'b.txt'), 'hello');
    git('add b.txt');
    const started = Date.now();
    git('commit -q -m "commit with hanging sync"'); // execSync timeout 20s would throw if blocked
    expect(Date.now() - started).toBeLessThan(10_000); // backgrounded — returns immediately
    expect(git('log --oneline').trim()).toContain('commit with hanging sync');
  });

  it('never clobbers a non-dreamcontext hook', () => {
    setupGitRepo();
    const custom = '#!/bin/sh\necho my-own-hook\n';
    writeFileSync(join(tmpDir, '.git', 'hooks', 'pre-push'), custom);
    const res = installTaskSyncHooks(tmpDir, { cliInvocation: 'dreamcontext' });
    expect(res.skipped).toEqual(['pre-push']);
    expect(res.installed).toEqual(['post-commit']);
    expect(readFileSync(join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')).toBe(custom);
  });

  it('uninstall removes only managed hooks', () => {
    setupGitRepo();
    installTaskSyncHooks(tmpDir, { cliInvocation: 'dreamcontext' });
    const removed = uninstallTaskSyncHooks(tmpDir);
    expect(removed.sort()).toEqual(['post-commit', 'pre-push']);
    expect(existsSync(join(tmpDir, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('no .git directory → install is a clean no-op', () => {
    const res = installTaskSyncHooks(tmpDir);
    expect(res.noGit).toBe(true);
    expect(res.installed).toEqual([]);
  });

  it('the hook script is exit-0 by construction even if the invocation is garbage', () => {
    const script = taskSyncHookScript('/definitely/not/a/binary');
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
    expect(script).toContain('|| true');
    expect(script).toContain('&'); // backgrounded subshell
  });

  it('`tasks sync both --hook` exits 0 in a clickup project with no token (real CLI)', () => {
    execSync(`node ${CLI} init --yes --name "T" --description "d" --stack "n" --priority "p"`, {
      cwd: tmpDir, encoding: 'utf-8', timeout: 20000,
    });
    execSync(`node ${CLI} config task-backend clickup`, { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });
    // Must not throw (exit 0) despite the missing token/list.
    const out = execSync(`node ${CLI} tasks sync both --hook 2>&1`, {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, CLICKUP_TOKEN: '', CLICKUP_API_KEY: '' },
    });
    expect(out.toLowerCase()).not.toContain('unhandled');
  });

  it('post-sleep: `sleep done` succeeds (best-effort sync) in a broken clickup project', () => {
    execSync(`node ${CLI} init --yes --name "T" --description "d" --stack "n" --priority "p"`, {
      cwd: tmpDir, encoding: 'utf-8', timeout: 20000,
    });
    execSync(`node ${CLI} config task-backend clickup`, { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });
    execSync(`node ${CLI} sleep start`, { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });
    const out = execSync(`node ${CLI} sleep done "test consolidation" 2>&1`, {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, CLICKUP_TOKEN: '', CLICKUP_API_KEY: '' },
    });
    expect(out).toContain('Consolidation complete');
  });
});
