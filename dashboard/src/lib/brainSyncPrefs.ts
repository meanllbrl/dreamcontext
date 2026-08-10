/**
 * Machine-local dashboard preferences for brain cloud-sync (github-cloud-collaboration-brain-repo-sync).
 * These are PER-MACHINE UI preferences (not team-shared config), so they live in
 * localStorage — the same place `aboutSeen` / agent settings live.
 *
 * PER MACHINE **and** PER VAULT: this preference decides whether opening a project
 * auto-COMMITS its uncommitted work. That is real git behaviour against one specific repo,
 * so it cannot be one value shared by every project in the window.
 */
import { readScopedRaw, writeScopedRaw } from './scopedStorage';

const AUTO_CHECKPOINT_KEY = 'dreamcontext.dashboard.autoCheckpointOnOpen';

/** Cross-window notify so an open sidebar reflects a Settings toggle immediately.
 *
 *  DEAD CODE, kept deliberately: nothing in `dashboard/src` listens for it (verified — zero
 *  `addEventListener` for this name). It stays on `window` exactly as it is; moving a no-op
 *  event onto the instance bus would be work with no behaviour attached. Wire a listener
 *  before relying on it. */
export const AUTO_CHECKPOINT_EVENT = 'dreamcontext-auto-checkpoint-pref';

/**
 * Whether opening the dashboard auto-CHECKPOINTS (commits) THIS vault's uncommitted local
 * edits before the on-open pull. Default ON — the safe behavior (nothing is ever lost to a
 * merge). When OFF, the on-open pull passes `noCheckpoint` and skips a dirty tree
 * entirely, leaving WIP untouched (the user syncs manually when ready).
 *
 * `keepLegacy` is MANDATORY here and the reason is the default-ON fallback above. Under
 * `scopedStorage`'s ordinary copy-once-then-delete policy, a user who deliberately turned
 * auto-checkpoint OFF would keep that intent for exactly ONE vault: every other vault would
 * find no scoped key, fall back to ON, and silently start auto-committing their work-in-
 * progress. Copy-once-then-delete is only safe when the unset fallback is the safe
 * direction, and here it is not — so the legacy key survives and every vault seeds from the
 * user's real choice.
 */
export function readAutoCheckpointOnOpen(vault: string | null): boolean {
  return readScopedRaw(vault, AUTO_CHECKPOINT_KEY, { keepLegacy: true }) !== '0';
}

export function writeAutoCheckpointOnOpen(vault: string | null, enabled: boolean): void {
  writeScopedRaw(vault, AUTO_CHECKPOINT_KEY, enabled ? '1' : '0');
  try {
    window.dispatchEvent(new CustomEvent(AUTO_CHECKPOINT_EVENT, { detail: enabled }));
  } catch {
    /* no window — ignore */
  }
}
