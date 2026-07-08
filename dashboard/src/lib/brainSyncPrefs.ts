/**
 * Machine-local dashboard preferences for brain cloud-sync (github-cloud-collaboration-brain-repo-sync).
 * These are PER-MACHINE UI preferences (not team-shared config), so they live in
 * localStorage — the same place `aboutSeen` / agent settings live.
 */

const AUTO_CHECKPOINT_KEY = 'dreamcontext.dashboard.autoCheckpointOnOpen';

/** Cross-window notify so an open sidebar reflects a Settings toggle immediately. */
export const AUTO_CHECKPOINT_EVENT = 'dreamcontext-auto-checkpoint-pref';

/**
 * Whether opening the dashboard auto-CHECKPOINTS (commits) uncommitted local edits
 * before the on-open pull. Default ON — the safe behavior (nothing is ever lost to a
 * merge). When OFF, the on-open pull passes `noCheckpoint` and skips a dirty tree
 * entirely, leaving WIP untouched (the user syncs manually when ready).
 */
export function readAutoCheckpointOnOpen(): boolean {
  try {
    return window.localStorage.getItem(AUTO_CHECKPOINT_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeAutoCheckpointOnOpen(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_CHECKPOINT_KEY, enabled ? '1' : '0');
  } catch {
    /* storage blocked — ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent(AUTO_CHECKPOINT_EVENT, { detail: enabled }));
  } catch {
    /* no window — ignore */
  }
}
