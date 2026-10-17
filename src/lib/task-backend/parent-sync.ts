import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFamily, resolveRemoteParent, rollupOf } from '../task-parent.js';
import { isDone, isTerminal, type StatusDef } from '../task-status.js';
import { hashContent, type SyncLedger, type TaskSyncEntry } from './sync-state.js';
import type { SyncReport } from './types.js';

/**
 * The parent link on the wire (C2, AC7), shared by the GitHub (sub-issues) and
 * ClickUp (subtasks) backends. `remote_parent` in the sync ledger is what the
 * remote last carried: a pull applies a remote link only when the local link
 * is still that value (an unpushed local move wins, the next push sends it),
 * and nothing is ever cleared because a remote is silent about a parent.
 */
export async function applyRemoteParentLink(opts: {
  stateDir: string;
  ledger: SyncLedger;
  childSlug: string;
  remoteParentSlug: string;
  /** Write `parent_task` as a remote-applied change (no push enqueued). */
  write: (fields: Record<string, unknown>) => Promise<void>;
  report: SyncReport;
}): Promise<void> {
  const { stateDir, ledger, childSlug, remoteParentSlug, report } = opts;
  const path = join(stateDir, `${childSlug}.md`);
  if (!existsSync(path)) return;
  const family = loadFamily(stateDir);
  const res = resolveRemoteParent(family, childSlug, remoteParentSlug);
  if (res.warning) report.warnings.push(`pull ${childSlug}: ${res.warning}`);
  if (!res.parent) return;
  const entry = ledger.taskSync(childSlug);
  const current = family.parentOf.get(childSlug) ?? null;
  if (current === res.parent) {
    if (entry?.remote_parent !== res.parent || entry?.parent_link_stuck) {
      ledger.updateTaskSync(childSlug, { remote_parent: res.parent, parent_link_stuck: undefined });
    }
    return;
  }
  // A local link (or detach) the remote has not taken yet wins; the next push
  // sends it. The one exception: a local change the remote could not take
  // (given up on, e.g. ClickUp cannot un-subtask) yields to a NEW remote parent.
  const recorded = entry?.remote_parent ?? null;
  if (current !== recorded) {
    const stuck = entry?.parent_link_stuck;
    const gaveUp = !!stuck && stuck.target === current && stuck.tries >= PARENT_LINK_MAX_TRIES;
    if (!gaveUp || res.parent === recorded) return;
  }
  const before = readFileSync(path, 'utf-8');
  const wasClean = entry?.localHash === hashContent(before);
  await opts.write({ parent_task: res.parent });
  const after = readFileSync(path, 'utf-8');
  ledger.updateTaskSync(childSlug, {
    remote_parent: res.parent,
    parent_link_stuck: undefined,
    ...(wasClean ? { localHash: hashContent(after), base_snapshot: { hash: hashContent(after), body: after } } : {}),
  });
}

/**
 * A remote close of a parent whose sub-tasks are still open: the local parent
 * stays open (its children are the truth) and the hold is reported. Returns
 * the status to keep, or null when the remote status may stand.
 */
export function holdOpenParent(
  stateDir: string,
  defs: readonly StatusDef[],
  slug: string,
  localStatus: string,
  mergedStatus: string,
): { keep: string; open: number } | null {
  if (!isDone(defs, mergedStatus) || isTerminal(defs, localStatus)) return null;
  const open = rollupOf(loadFamily(stateDir).children.get(slug) ?? [], defs).open.length;
  return open > 0 ? { keep: localStatus, open } : null;
}

/** Syncs a failing parent link is retried before the push stops trying. */
export const PARENT_LINK_MAX_TRIES = 3;

/**
 * Whether the remote's parent link needs no push for `desired`: it already
 * carries it, or linking it failed {@link PARENT_LINK_MAX_TRIES} times for this
 * same local parent (a sub-issues API the host lacks, a full parent, a detach
 * the API cannot do). A changed local parent tries again.
 */
export function parentLinkSettled(entry: TaskSyncEntry | null | undefined, desired: string | null): boolean {
  if ((entry?.remote_parent ?? null) === desired) return true;
  const stuck = entry?.parent_link_stuck;
  return !!stuck && stuck.target === desired && stuck.tries >= PARENT_LINK_MAX_TRIES;
}

/**
 * Count one failed link attempt for `desired`; `permanent` (a 404/422, or a
 * detach the API cannot make) gives up at once. Warns once, when it gives up.
 */
export function noteParentLinkFailure(
  entry: TaskSyncEntry | null | undefined,
  desired: string | null,
  permanent: boolean,
  report: SyncReport,
  slug: string,
  remoteName: string,
): { target: string | null; tries: number } {
  const prev = entry?.parent_link_stuck;
  const before = prev && prev.target === desired ? prev.tries : 0;
  const tries = permanent ? PARENT_LINK_MAX_TRIES : Math.min(before + 1, PARENT_LINK_MAX_TRIES);
  if (tries >= PARENT_LINK_MAX_TRIES && before < PARENT_LINK_MAX_TRIES) {
    report.warnings.push(
      `push ${slug}: ${remoteName} would not take its parent link (${desired ?? 'detach'}); no more retries until its parent changes — set it in ${remoteName}.`,
    );
  }
  return { target: desired, tries };
}
