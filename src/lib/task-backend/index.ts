import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureContextRoot } from '../context-path.js';
import { readSetupConfig, type SetupConfig } from '../setup-config.js';
import { LocalTaskBackend } from './local.js';
import { createClickUpBackend, type ClickUpBackendDeps } from './clickup.js';
import { SyncLedger } from './sync-state.js';
import type { TaskBackend, TaskSyncStatus } from './types.js';

export * from './types.js';
export { LocalTaskBackend, isSafeTaskSlug, readTaskFile } from './local.js';
export { ClickUpTaskBackend, createClickUpBackend } from './clickup.js';
export {
  installTaskSyncHooks,
  uninstallTaskSyncHooks,
  taskSyncHookScript,
  TASK_SYNC_HOOKS,
} from './git-hooks.js';
export { ensureRemoteBackendGitignore, REMOTE_BACKEND_GITIGNORE_ENTRIES } from './paths.js';

/**
 * Resolve the active task backend for a project.
 *
 * - `contextRoot` is the absolute `_dream_context/` directory; when omitted it
 *   is resolved by walking up from cwd (same as every CLI verb did before).
 * - `config` short-circuits the `.config.json` read (route handlers pass it
 *   when they already loaded it); `undefined` means "read it from disk".
 *
 * `taskBackend` absent or `"local"` → the file-based backend (the default and
 * the pre-#11 behavior). `"clickup"` → the ClickUp remote backend (M3).
 */
export function getTaskBackend(
  contextRoot?: string,
  config?: SetupConfig | null,
  deps?: ClickUpBackendDeps,
): TaskBackend {
  const root = contextRoot ?? ensureContextRoot();
  const cfg = config !== undefined ? config : readSetupConfig(dirname(root));

  if (cfg?.taskBackend === 'clickup') {
    // Mirror reads/writes work offline; only sync() needs token/list (and
    // reports rather than throws when they're missing).
    return createClickUpBackend(root, cfg ?? null, deps);
  }
  return new LocalTaskBackend(join(root, 'state'));
}

/**
 * Lightweight sync status (dashboard badge / doctor). Pure ledger read — no
 * network, safe on any backend (all zeros for local).
 */
export function getTaskSyncStatus(
  contextRoot: string,
  config?: SetupConfig | null,
): TaskSyncStatus {
  const cfg = config !== undefined ? config : readSetupConfig(dirname(contextRoot));
  const ledger = new SyncLedger(contextRoot);
  const state = ledger.readSyncState();
  const conflictsDir = ledger.conflictsDir();
  return {
    backend: cfg?.taskBackend ?? 'local',
    pendingPush: Object.values(state.tasks).filter((t) => t.pendingPush).length,
    queuedOps: ledger.readQueue().length,
    conflicts: existsSync(conflictsDir)
      ? readdirSync(conflictsDir).filter((f) => f.endsWith('.md')).length
      : 0,
    watermark: state.watermark,
  };
}
