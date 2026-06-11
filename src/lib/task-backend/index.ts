import { join } from 'node:path';
import { dirname } from 'node:path';
import { ensureContextRoot } from '../context-path.js';
import { readSetupConfig, type SetupConfig } from '../setup-config.js';
import { LocalTaskBackend } from './local.js';
import type { TaskBackend } from './types.js';

export * from './types.js';
export { LocalTaskBackend, isSafeTaskSlug, readTaskFile } from './local.js';

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
): TaskBackend {
  const root = contextRoot ?? ensureContextRoot();
  const cfg = config !== undefined ? config : readSetupConfig(dirname(root));
  const stateDir = join(root, 'state');

  const kind = cfg?.taskBackend ?? 'local';
  if (kind === 'clickup') {
    // Lazy import keeps the local path free of any remote-backend code.
    // (Wired in M3 — until then an unconfigured remote falls back to local.)
    const { createClickUpBackend } = requireClickUp();
    const backend = createClickUpBackend?.(root, cfg ?? null);
    if (backend) return backend;
  }
  return new LocalTaskBackend(stateDir);
}

/**
 * Indirection point for the ClickUp backend so M1 ships with zero remote code
 * on the local path. Replaced by a real factory import in M3.
 */
function requireClickUp(): {
  createClickUpBackend?: (contextRoot: string, config: SetupConfig | null) => TaskBackend | null;
} {
  return {};
}
