/**
 * THE one module through which app data touches git (app-veri-ortak plan r6, K5): outbound
 * (`stageOutbound`), before a merge (`parkBeforeMerge`), the settle decision (`planSettle`), and
 * after the merge ended (`finishAppPull`), plus crash recovery (`recoverAppPulls`).
 *
 * STUB (wave 1, lane A): the names and signatures are pinned here so wave 2 lane B (surface) can
 * import them. Wave 2 lane A OWNS this file and replaces every body; keep the names. Each stub
 * does nothing and changes nothing.
 */

import type { AppPullCtx, FinishAppPullFn, RecoverAppPullsFn } from './data-conflicts.js';

export type { AppPullCtx } from './data-conflicts.js';

/** Recover this machine's crashed pulls; only while the brain lock is held (wave 2 lane A). */
export const recoverAppPulls: RecoverAppPullsFn = (_ctx) => ({ recovered: [], skipped: null, notes: [] });

/** Finish one app's pull once no MERGE_HEAD is open (wave 2 lane A). */
export const finishAppPull: FinishAppPullFn = (_ctx, _hash) => ({ done: false, note: 'not implemented (wave 2)' });

/**
 * Apply the K5 settle rule to an app installed onto a team folder under the same slug: team
 * files on paths the installed manifest does not call `shared` go to the conflict store
 * (wave 2 lane A; called by share/install.ts in wave 2 lane B).
 */
export function applyPullRuleForInstall(_ctx: AppPullCtx, _slug: string, _hash: string): { stored: string[] } {
  return { stored: [] };
}

/** The `apps/` paths `stageOutbound` would add or remove now (its dry run; feeds `dirtyPaths`). */
export function pendingSharedAppFiles(_ctx: AppPullCtx): string[] {
  return [];
}
