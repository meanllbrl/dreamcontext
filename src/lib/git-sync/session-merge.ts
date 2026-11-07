/**
 * A pull whose update touches a session file (edge-case review, 2026-11-07).
 *
 * Session files (`SESSION_LOCAL_PATHSPECS`: sleep state, digests, peer mail…) never sync. A team
 * that still has an old install keeps changing its tracked copy on every ordinary sync, so a pull
 * that STOPPED for them would lock every updated teammate out for good. Instead the merge is
 * defused around them:
 *
 *   1. before the merge, this Mac's copy of every session path the update touches (a change, an
 *      add or a removal) goes to a park folder outside the repo (copied when git still tracks it,
 *      so the merge does not read it as a local change; moved when not, so git can write there;
 *      `~/.dreamcontext/…/session-park`), recorded first, so a crash leaves a record the next sync puts back;
 *   2. after the merge, every session path leaves the index (any case; a modify/delete conflict
 *      included, which settles it), and what the merge wrote there (the other Mac's sleep state,
 *      its letters) is taken off the disk: it was never this Mac's, and kept it would be read as
 *      this Mac's own;
 *   3. this Mac's parked copies go back where they were.
 *
 * The merge commit then carries the removal, so the remote converges in one push. Never follows
 * or moves a symlink: one at a session path is left where it is.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { localDir, readLocalJson, updateLocalJson } from '../local-store.js';
import { sessionPathspecs, type SessionChange } from '../super/pull-guard.js';
import { brainPrefix, moveFileAcross } from '../agents/agent-sync.js';
import * as git from './git.js';

const PARK_FILE = 'session-park.json';

export interface SessionPark {
  /** Absolute path the file came from (its on-disk case). */
  from: string;
  /** Absolute path of the parked copy. */
  backup: string;
  at: string;
}

interface ParkFile { pending: SessionPark[] }

const pendingOf = (cur: ParkFile): SessionPark[] => (Array.isArray(cur.pending) ? cur.pending : []);

/** The file at `abs` as it is named on disk (a case-insensitive Mac answers for any case), or null. */
function onDiskName(abs: string): string | null {
  const dir = dirname(abs);
  const want = basename(abs).toLowerCase();
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  const hit = names.find((n) => n === basename(abs)) ?? names.find((n) => n.toLowerCase() === want);
  return hit ? join(dir, hit) : null;
}

function forget(projectRoot: string, backup: string, home?: string): void {
  updateLocalJson<ParkFile>(projectRoot, PARK_FILE, { pending: [] }, (cur) => ({ pending: pendingOf(cur).filter((p) => p.backup !== backup) }), home);
}

/** Put one parked copy back (over whatever is there now: the parked one is this Mac's state). */
function putBack(projectRoot: string, p: SessionPark, home?: string): boolean {
  try {
    if (!existsSync(p.backup)) { forget(projectRoot, p.backup, home); return true; }
    mkdirSync(dirname(p.from), { recursive: true });
    try { if (lstatSync(p.from).isFile()) unlinkSync(p.from); } catch { /* nothing there */ }
    moveFileAcross(p.backup, p.from);
    forget(projectRoot, p.backup, home);
    return true;
  } catch {
    return false;
  }
}

/** A park a crashed sync left behind goes back first. Never throws. */
export function restoreLeftoverSessionPark(contextRoot: string, home?: string): void {
  const projectRoot = dirname(contextRoot);
  try {
    for (const p of pendingOf(readLocalJson<ParkFile>(projectRoot, PARK_FILE, { pending: [] }, home))) putBack(projectRoot, p, home);
  } catch { /* the next sync tries again */ }
}

/**
 * Step 1: park this Mac's copy of every session path in `changes`. Returns the parks, or null when
 * one could not be parked (everything parked so far is put back; the caller skips the pull).
 */
export function parkSessionFiles(gitCwd: string, contextRoot: string, changes: SessionChange[], home?: string, now: Date = new Date()): SessionPark[] | null {
  const top = git.topLevel(gitCwd);
  if (!top) return null;
  const projectRoot = dirname(contextRoot);
  const dir = join(localDir(projectRoot, home), 'session-park');
  const parks: SessionPark[] = [];
  const seen = new Set<string>();
  // A copy git still tracks is COPIED (moved away, it would read as a local change and git would
  // refuse the merge); an untracked one is MOVED (left, git would refuse to overwrite it).
  const prefix = brainPrefix(gitCwd, contextRoot);
  let tracked: Set<string>;
  try { tracked = new Set(git.indexPaths(top, sessionPathspecs(prefix ?? '')).map((p) => join(top, p).toLowerCase())); } catch { return null; }
  for (const c of changes) {
    const from = onDiskName(join(top, c.path));
    if (!from || seen.has(from.toLowerCase())) continue;
    seen.add(from.toLowerCase());
    try { if (!lstatSync(from).isFile()) continue; } catch { continue; } // never a link or a folder
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const rec: SessionPark = { from, backup: join(dir, `${now.getTime()}-${randomBytes(4).toString('hex')}-${basename(from)}`), at: now.toISOString() };
      updateLocalJson<ParkFile>(projectRoot, PARK_FILE, { pending: [] }, (cur) => ({ pending: [...pendingOf(cur), rec] }), home);
      try {
        if (tracked.has(from.toLowerCase())) copyFileSync(from, rec.backup);
        else moveFileAcross(from, rec.backup);
      } catch { forget(projectRoot, rec.backup, home); throw new Error('park'); }
      parks.push(rec);
    } catch {
      for (const p of parks) putBack(projectRoot, p, home);
      return null;
    }
  }
  return parks;
}

/**
 * Step 2, right after the merge: every session path leaves the index, and what the merge wrote at
 * the paths it changed comes off the disk. Returns the conflicted paths this settled (lower case),
 * so the caller hands only the rest to the conflict resolver. Never throws.
 */
export function settleSessionMerge(gitCwd: string, contextRoot: string, changes: SessionChange[]): Set<string> {
  const settled = new Set<string>();
  const prefix = brainPrefix(gitCwd, contextRoot);
  const top = git.topLevel(gitCwd);
  if (prefix === null || !top) return settled;
  try { git.removeFromIndexForce(top, sessionPathspecs(prefix)); } catch { /* the stage pass and the push gate still stand */ }
  for (const c of changes) {
    settled.add(c.path.toLowerCase());
    if (c.deleted) continue;
    const abs = onDiskName(join(top, c.path));
    if (!abs) continue;
    try {
      const st = lstatSync(abs);
      if (st.isFile() || st.isSymbolicLink()) unlinkSync(abs);
    } catch { /* already gone */ }
  }
  return settled;
}

/** Step 3: put every parked copy back. Never throws; a copy that cannot go back stays recorded. */
export function restoreSessionPark(contextRoot: string, parks: SessionPark[] | null, home?: string): void {
  if (!parks?.length) return;
  const projectRoot = dirname(contextRoot);
  for (const p of parks) putBack(projectRoot, p, home);
}
