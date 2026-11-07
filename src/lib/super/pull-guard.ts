/**
 * Super Agent records never come in from the team (security review, 0.40.2). Main's record
 * (`state/.super-agent.json`) and every member Super's record, read marks and handoff
 * (`state/.super/`) are this Mac's alone and kept out of git by `.gitignore` only. A teammate who
 * force-adds one could hand a member Super a pending job that starts it with nobody pressing
 * anything, so a pull carrying any of them stops, the way incoming app data does.
 *
 * Names are enough, content is never read. The same names leave the index in every sync's staging
 * pass ({@link superStagePass}) and on `dreamcontext update` (migration 0.40.2).
 *
 * What this Mac's SESSIONS said goes the same way (2026-11-07: the owner's Super agenda on a
 * teammate's computer). `state/.sleep.json` keeps every session's last reply and the bookmarks
 * caught from it, and a Super turn ends on what waits on the owner ("the plan waits for your
 * yes"), so it carries the agenda's Waiting on you in the agent's own words. An install from
 * before its ignore line committed it, `.gitignore` never untracks a tracked file, and every sync
 * pushed it on. The same holds for the sleep history, session titles and digests, the handoff
 * log, the tool handoff's conversation text and peer mail (letters between THIS Mac's projects).
 * They are {@link SESSION_LOCAL_PATHSPECS}: dropped from every sync commit, untracked on update,
 * and a pull that carries one stops ({@link incomingSessionFiles}).
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

/** Incoming non-deletion entries of this Mac's session files ({@link SESSION_LOCAL_PATHSPECS}) in
 *  `HEAD...remoteRef`, or null when git cannot answer. Case-insensitive, like the record's guard:
 *  a case-only twin is the same file on a Mac's disk. */
export function incomingSessionFiles(gitCwd: string, contextRoot: string, remoteRef: string): string[] | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (prefix === null) return [];
  try {
    const top = git.topLevel(gitCwd);
    if (!top) return null;
    const specs = SESSION_LOCAL_PATHSPECS.map((p) => `:(icase)${prefix}${p}`);
    return git.rawEntries(top, `HEAD...${remoteRef}`, specs).filter((e) => e.newMode !== '000000').map((e) => e.path);
  } catch {
    return null;
  }
}

export const SESSION_FILES_PULL_NOTE = "Skipped the pull: the team's update carries another Mac's session files under _dream_context/state/ (sleep state, session history or peer mail). Those stay on each Mac and never sync; ask whoever pushed them to run dreamcontext update and sync once, which takes them out.";

export const SUPER_RECORD_PULL_NOTE = "Skipped the pull: the team's update carries a Super Agent record under _dream_context/state/ (.super-agent.json or .super/). Those stay on each Mac and never sync; ask whoever pushed it to remove it.";

/** The machine-local Super and session files, brain-relative (git pathspecs). */
export const SUPER_LOCAL_PATHSPECS = [
  'state/.super-agent.json',
  'state/.super-agent.json.*',
  'state/.super',
  'state/.agent-sessions.json',
  'state/.agent-sessions.*',
] as const;

/**
 * What this Mac's sessions said and did, brain-relative (git pathspecs; the 2026-11-07 leak, see
 * the header). Every one is in the brain `.gitignore` too (`BRAIN_LOCAL_GITIGNORE_ENTRIES`); this
 * list is what leaves the INDEX, for the brain that committed one before its line existed.
 */
export const SESSION_LOCAL_PATHSPECS = [
  'state/.sleep.json',
  'state/.sleep-history.json',
  'state/.sleep-runs.jsonl',
  'state/.handoff-log.jsonl',
  'state/.session-titles.json',
  'state/.session-digests',
  'state/.agent-session-map',
  'state/.active-task',
  'state/.tool-handoff',
  'state/.run-sessions',
  'state/.peer-mail',
  // The retired Sleepy chat's messages: nothing writes it now, an old brain still tracks it.
  'state/.sleepy-chat.json',
] as const;

/** Every machine-local file that never rides a sync commit: the Super's and the sessions'. */
export const MACHINE_LOCAL_PATHSPECS: readonly string[] = [...SUPER_LOCAL_PATHSPECS, ...SESSION_LOCAL_PATHSPECS];

/** {@link MACHINE_LOCAL_PATHSPECS} rooted at the repo's top folder, with the top; null outside a repo. */
export function superPathspecs(gitCwd: string, contextRoot: string): { top: string; specs: string[] } | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (prefix === null) return null;
  const top = git.topLevel(gitCwd);
  if (!top) return null;
  return { top, specs: MACHINE_LOCAL_PATHSPECS.map((p) => `${prefix}${p}`) };
}

/**
 * The sync's staging pass: whatever `.gitignore` says (a teammate's `!state/.super-agent.json`
 * pulled in beats every ignore line of ours, and a file an old install committed stays tracked
 * whatever it says), a Super or session file never stays in the index of a sync commit. Index only (`--cached -f`); the file stays on disk. Returns the paths dropped. Best
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
    // Could not list them: drop them unlisted, a planted record set aside first as above.
    setAsideForeignRecords(contextRoot);
    try { git.removeFromIndexForce(at.top, at.specs); } catch { /* git cannot answer at all */ }
    return [];
  }
}
