/**
 * App data never enters git (plan-veri r3, K2). Two ignore layers keep `_dream_context/apps/` out
 * of a normal `git add`; this module covers what gets past them:
 *
 *  - {@link appDataStagePass}: after every sync stage, any index entry under the brain's `apps/`
 *    (any letter case, a `git add -f` included, a nested brain included) is dropped from the
 *    index. The file stays on disk. The owner hears it once, in the inbox.
 *  - {@link appDataInPushRange}: before a push, every commit the push would send is checked; a
 *    tree holding anything under `apps/` (a merge commit, or a commit whose path a later one
 *    deleted, included) holds the push (`app_data_held`).
 *  - {@link incomingAppData}: before a pull, any incoming entry under `apps/` other than a
 *    deletion stops it, so a teammate's push can never overwrite or delete this Mac's data.
 *
 * Names are enough, content is never read: nothing may be there.
 */

import { dirname } from 'node:path';
import { brainPrefix } from '../agents/agent-sync.js';
import * as git from '../git-sync/git.js';
import { raiseInboxRow } from '../owner-inbox.js';
import { APPS_DATA_FOLDER, foldName } from './data-dir.js';

/** `:(icase)<prefix>apps`, or null when the brain is not in a git repo. */
export function appsPathspec(gitCwd: string, contextRoot: string): string | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  return prefix === null ? null : `:(icase)${prefix}${APPS_DATA_FOLDER}`;
}

/** Drop every index entry under `apps/`. Never throws; returns the paths dropped. */
export function appDataStagePass(gitCwd: string, contextRoot: string, opts: { home?: string } = {}): string[] {
  const spec = appsPathspec(gitCwd, contextRoot);
  if (!spec) return [];
  let dropped: string[] = [];
  try {
    dropped = git.indexPaths(gitCwd, [spec]);
    if (!dropped.length) return [];
    git.removeFromIndex(gitCwd, [spec]);
  } catch {
    // Could not list or drop one by one: drop the whole folder from the index.
    try { git.removeFromIndex(gitCwd, [spec]); } catch { /* the push gate still holds it */ }
  }
  if (dropped.length) {
    try {
      raiseInboxRow(dirname(contextRoot), {
        kind: 'app-data-held',
        ref: dropped[0],
        agent: null,
        title: `App data was about to be committed (${dropped.slice(0, 2).join(', ')}${dropped.length > 2 ? ` +${dropped.length - 2}` : ''}). App data stays on this Mac and never syncs; it was left out.`,
        actions: ['dismiss'],
        dedupeKey: 'app-data-held:stage',
      }, opts.home);
    } catch { /* the row is a courtesy */ }
  }
  return dropped;
}

/**
 * The first commit of the push range whose tree holds anything under `apps/`, or null. THROWS
 * when git cannot answer: the caller holds the push then (fail closed).
 */
export function appDataInPushRange(gitCwd: string, contextRoot: string, remoteRef: string | null): string | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (prefix === null) return null;
  const top = git.topLevel(gitCwd);
  if (!top) throw new Error('no git top folder');
  // `ls-tree` takes no `:(icase)`: the brain folder's children are listed and folded instead.
  const dir = prefix.replace(/\/$/, '');
  const ref = remoteRef && git.revParse(gitCwd, remoteRef) ? remoteRef : null;
  for (const c of git.commitsToPush(gitCwd, ref)) {
    if (git.treeChildren(top, c, dir).some((e) => foldName(e.name) === APPS_DATA_FOLDER)) return c;
  }
  return null;
}

/** Incoming non-deletion entries under `apps/` of `HEAD...remoteRef`, or null when git cannot answer. */
export function incomingAppData(gitCwd: string, contextRoot: string, remoteRef: string): string[] | null {
  const spec = appsPathspec(gitCwd, contextRoot);
  if (!spec) return [];
  try {
    const top = git.topLevel(gitCwd);
    if (!top) return null;
    return git.rawEntries(top, `HEAD...${remoteRef}`, [spec]).filter((e) => e.newMode !== '000000').map((e) => e.path);
  } catch {
    return null;
  }
}

export const APP_DATA_HELD_NOTE = 'Held the push (app_data_held): a commit holds app data under _dream_context/apps/, which never syncs. Remove it from that commit (git rm -r --cached _dream_context/apps, then amend or rewrite the unpushed commits) and sync again.';
export const APP_DATA_PULL_NOTE = "Skipped the pull: the team's update carries app data under _dream_context/apps/. App data never goes to the team; ask whoever pushed it to remove it.";
