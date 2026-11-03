/**
 * Super Agent records never come in from the team (security review, 0.40.2). Main's record
 * (`state/.super-agent.json`) and every member Super's record, read marks and handoff
 * (`state/.super/`) are this Mac's alone and kept out of git by `.gitignore` only. A teammate who
 * force-adds one could hand a member Super a pending job that starts it with nobody pressing
 * anything, so a pull carrying any of them stops, the way incoming app data does.
 *
 * Names are enough, content is never read. The same names leave the index in every sync's staging
 * pass ({@link superStagePass}) and on `dreamcontext update` (migration 0.40.2).
 */

import { brainPrefix } from '../agents/agent-sync.js';
import * as git from '../git-sync/git.js';
import { setAsideForeignRecords } from './record-binding.js';

/** Incoming non-deletion entries of Super records in `HEAD...remoteRef`, or null when git cannot answer. */
export function incomingSuperRecords(gitCwd: string, contextRoot: string, remoteRef: string): string[] | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (prefix === null) return [];
  try {
    const top = git.topLevel(gitCwd);
    if (!top) return null;
    const specs = [`:(icase)${prefix}state/.super-agent.json`, `:(icase)${prefix}state/.super`];
    return git.rawEntries(top, `HEAD...${remoteRef}`, specs).filter((e) => e.newMode !== '000000').map((e) => e.path);
  } catch {
    return null;
  }
}

export const SUPER_RECORD_PULL_NOTE = "Skipped the pull: the team's update carries a Super Agent record under _dream_context/state/ (.super-agent.json or .super/). Those stay on each Mac and never sync; ask whoever pushed it to remove it.";

/** The machine-local Super and session files, brain-relative (git pathspecs). */
export const SUPER_LOCAL_PATHSPECS = [
  'state/.super-agent.json',
  'state/.super-agent.json.*',
  'state/.super',
  'state/.agent-sessions.json',
  'state/.agent-sessions.*',
] as const;

/** {@link SUPER_LOCAL_PATHSPECS} rooted at the repo's top folder, with the top; null outside a repo. */
export function superPathspecs(gitCwd: string, contextRoot: string): { top: string; specs: string[] } | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (prefix === null) return null;
  const top = git.topLevel(gitCwd);
  if (!top) return null;
  return { top, specs: SUPER_LOCAL_PATHSPECS.map((p) => `${prefix}${p}`) };
}

/**
 * The sync's staging pass: whatever `.gitignore` says (a teammate's `!state/.super-agent.json`
 * pulled in beats every ignore line of ours), a Super file never stays in the index of a sync
 * commit. Index only (`--cached -f`); the file stays on disk. Returns the paths dropped. Best
 * effort: the push still carries nothing new for a path git refused to list.
 */
export function superStagePass(gitCwd: string, contextRoot: string): string[] {
  const at = superPathspecs(gitCwd, contextRoot);
  if (!at) return [];
  try {
    const staged = git.indexPaths(at.top, at.specs);
    if (!staged.length) return [];
    // While HEAD still holds a pulled record's bytes: once this commit drops it, nothing would
    // tell a planted copy from this Mac's own (record-binding.ts).
    setAsideForeignRecords(contextRoot);
    git.removeFromIndexForce(at.top, at.specs);
    return staged;
  } catch {
    // Could not list them: drop them unlisted.
    try { git.removeFromIndexForce(at.top, at.specs); } catch { /* git cannot answer at all */ }
    return [];
  }
}
