/**
 * Super Agent records never come in from the team (security review, 0.40.2). Main's record
 * (`state/.super-agent.json`) and every member Super's record, read marks and handoff
 * (`state/.super/`) are this Mac's alone and kept out of git by `.gitignore` only. A teammate who
 * force-adds one could hand a member Super a pending job that starts it with nobody pressing
 * anything, so a pull carrying any of them stops, the way incoming app data does.
 *
 * Names are enough, content is never read.
 */

import { brainPrefix } from '../agents/agent-sync.js';
import * as git from '../git-sync/git.js';

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
