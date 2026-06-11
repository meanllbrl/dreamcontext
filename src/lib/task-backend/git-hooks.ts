import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Git trigger hooks for remote task backends — issue #11 M5.
 *
 * post-commit + pre-push run `tasks sync both --hook` in a BACKGROUNDED
 * subshell with all output swallowed and a hard `exit 0`. A sync error,
 * missing binary, or timeout can NEVER fail or block the git operation —
 * that guarantee lives in the script shape itself (and is under test with
 * the CLI forced to fail and to hang).
 */

const MARKER = '# dreamcontext-tasks-sync-hook v1';
export const TASK_SYNC_HOOKS = ['post-commit', 'pre-push'] as const;

export function taskSyncHookScript(cliInvocation: string): string {
  return `#!/bin/sh
${MARKER}
# Best-effort dreamcontext task sync. NEVER fails or blocks git:
#  - runs in a backgrounded subshell, output fully swallowed
#  - the CLI itself runs with --hook (bounded time, always exit 0)
#  - unconditional exit 0 below
(
  ${cliInvocation} tasks sync both --hook >/dev/null 2>&1 &
) >/dev/null 2>&1 || true
exit 0
`;
}

/** The default invocation: re-run the exact CLI entry that installed the hook. */
export function defaultCliInvocation(): string {
  const entry = process.argv[1];
  if (entry) return `"${process.execPath}" "${entry}"`;
  return 'dreamcontext';
}

export interface HookInstallResult {
  installed: string[];
  /** Hooks left alone because a non-dreamcontext hook already exists. */
  skipped: string[];
  /** No .git directory — nothing to install into. */
  noGit: boolean;
}

export function installTaskSyncHooks(
  projectRoot: string,
  opts: { cliInvocation?: string } = {},
): HookInstallResult {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  if (!existsSync(join(projectRoot, '.git'))) {
    return { installed: [], skipped: [], noGit: true };
  }

  const script = taskSyncHookScript(opts.cliInvocation ?? defaultCliInvocation());
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const hook of TASK_SYNC_HOOKS) {
    const path = join(hooksDir, hook);
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf-8');
      if (!existing.includes(MARKER)) {
        skipped.push(hook); // never clobber a user's own hook
        continue;
      }
    }
    writeFileSync(path, script, 'utf-8');
    try { chmodSync(path, 0o755); } catch { /* best-effort on exotic fs */ }
    installed.push(hook);
  }

  return { installed, skipped, noGit: false };
}

export function uninstallTaskSyncHooks(projectRoot: string): string[] {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  const removed: string[] = [];
  for (const hook of TASK_SYNC_HOOKS) {
    const path = join(hooksDir, hook);
    if (existsSync(path) && readFileSync(path, 'utf-8').includes(MARKER)) {
      rmSync(path);
      removed.push(hook);
    }
  }
  return removed;
}

/** True when `hook` is dreamcontext-managed. */
export function isManagedTaskSyncHook(projectRoot: string, hook: string): boolean {
  const path = join(projectRoot, '.git', 'hooks', hook);
  return existsSync(path) && readFileSync(path, 'utf-8').includes(MARKER);
}
