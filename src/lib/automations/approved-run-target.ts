import { dirname } from 'node:path';
import { approvedTarget } from './registry.js';
import { getRunTarget } from './store.js';
import type { ApprovalUse, AutomationManifest, RunKind } from './types.js';

/**
 * The run target AS IT MAY RUN HERE: its last approved text when a newer version waits for the
 * owner's card (`approvedTarget`), else the file as it stands. Anything that reads a hashed field
 * to DECIDE how a member runs (its autonomy, tool, board, model) after a gate said it is ready
 * reads it from here, never from `getRunTarget`: a pending edit must never widen what runs
 * (security review 2026-11-08: a synced `autonomy: free` reached bypassPermissions through a task
 * step and a Super crew child). Null when there is no such target.
 */
export function approvedRunTarget(
  contextRoot: string,
  slug: string,
  kind: RunKind,
  home?: string,
  use: ApprovalUse = 'run',
): AutomationManifest | null {
  const raw = getRunTarget(contextRoot, slug, kind, home);
  if (!raw) return null;
  try {
    return approvedTarget(dirname(contextRoot), raw, home, use).manifest;
  } catch {
    // Fail closed: when the approval cannot be read, nothing pending may decide how it runs.
    return null;
  }
}
