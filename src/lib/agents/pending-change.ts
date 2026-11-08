import { dirname, join } from 'node:path';
import { approvedTarget, changedApprovalFields, getApproval, type PendingApprovalChange } from '../automations/registry.js';
import { listAutomations } from '../automations/store.js';
import { listAgentTargets } from './store.js';
import type { AutomationManifest } from '../automations/types.js';
import { readLocalJson, updateLocalJson } from '../local-store.js';
import { configuredEmail, lastAuthorEmail } from '../git-sync/git.js';
import { GLOBAL_REGISTRY_KEY } from './scope.js';
import { listAmendments } from './amendments.js';
import { loginFromEmail } from './agent-sync.js';

/**
 * WHICH CHANGE WAITS, said by name (owner 2026-11-08): a member that keeps running on its last
 * approved text tells the owner who changed it, when, which fields, and what the risk filter saw.
 * Read from facts that already exist, never stored by habit: the machine-local trace of a member
 * write (`agent-amendments.json`, a background run's `waits` row), the git author of the member's
 * file (a teammate's synced change), and the approval's per-field hashes.
 */
export interface PendingChangeInfo {
  /** The member the change belongs to (a routine's agent, else the target itself). */
  member: string;
  /** `background`: text a process that never talks to the owner wrote (a member's run, a
   *  routine, a Super child) and the risk filter held; `teammate`: a change that came by sync. */
  by: 'background' | 'teammate' | 'unknown';
  /** The teammate's login (or commit email) for a synced change. */
  who: string | null;
  /** When the waiting text was written, when known. */
  at: string | null;
  /** The reviewed fields that moved, when this Mac knows them. */
  fields: string[] | null;
  /** What the risk filter flagged in a background run's text. */
  risks: string[];
  /** It keeps running on the last approved text meanwhile. */
  runsOnApproved: boolean;
}

/** Describe the change `m` (the CURRENT file, never the overlaid text) waits with. */
export function describePendingChange(
  contextRoot: string,
  m: AutomationManifest,
  runsOnApproved: boolean,
  home?: string,
): PendingChangeInfo {
  const projectRoot = dirname(contextRoot);
  const member = m.agent || m.slug;
  const global = m.agentScope === 'global';
  const entry = getApproval(global ? GLOBAL_REGISTRY_KEY : projectRoot, m.slug, home, m.runKind === 'agent' ? 'agent' : 'automation');
  const since = entry ? Date.parse(entry.approvedAt) : NaN;
  const fields = changedApprovalFields(projectRoot, m, home);
  let held = null as null | { at: string; risks?: string[] };
  try {
    held = listAmendments(projectRoot, member, home).find((a) => a.waits === true && !a.revertedAt
      && (Number.isNaN(since) || Date.parse(a.at) >= since)) ?? null;
  } catch { held = null; }
  if (held) return { member, by: 'background', who: null, at: held.at, fields, risks: [...(held.risks ?? [])], runsOnApproved };
  if (!global) {
    // A synced change: the newest commit that touched the file is someone else's (not this Mac's
    // git user). A member's own file, or the routine's when the change is in the routine.
    const rel = m.runKind === 'agent' ? join('_dream_context', 'agents', `${member}.md`) : join('_dream_context', 'automations', `${m.slug}.md`);
    const email = lastAuthorEmail(projectRoot, rel);
    const mine = configuredEmail(projectRoot);
    if (email && (!mine || email.trim().toLowerCase() !== mine.trim().toLowerCase())) {
      return { member, by: 'teammate', who: loginFromEmail(contextRoot, email) ?? email, at: null, fields, risks: [], runsOnApproved };
    }
  }
  return { member, by: 'unknown', who: null, at: null, fields, risks: [], runsOnApproved };
}

const NOTICES = 'pending-change-notices.json';
type Notices = Record<string, string>;

/**
 * The owner's one notice for a waiting change: its title and body, or null when this very version
 * was already announced (keyed by target and the waiting hash, so a second edit is a new notice and
 * a re-read of the same one never is). Claiming records it; the caller posts it.
 */
export function claimPendingNotice(
  contextRoot: string,
  m: AutomationManifest,
  pending: PendingApprovalChange,
  home?: string,
): { title: string; body: string } | null {
  const key = `${m.runKind === 'agent' ? 'agent' : 'automation'}:${m.slug}`;
  const projectRoot = dirname(contextRoot);
  try {
    if (readLocalJson<Notices>(projectRoot, NOTICES, {}, home)[key] === pending.actual) return null;
    let first = false;
    updateLocalJson<Notices>(projectRoot, NOTICES, {}, (cur) => {
      if (cur[key] === pending.actual) return cur;
      first = true;
      return { ...cur, [key]: pending.actual };
    }, home);
    if (!first) return null;
  } catch {
    return null;
  }
  const info = describePendingChange(contextRoot, m, true, home);
  const name = m.agentTitle || m.title || m.slug;
  return { title: `${name}: a change waits for you`, body: pendingChangeSentence(info) };
}

/** The one plain sentence a waiting change is said in (CLI, notice). The app words its own. */
export function pendingChangeSentence(info: PendingChangeInfo): string {
  const who = info.by === 'teammate' ? `${info.who} changed it` : info.by === 'background' ? 'a background run rewrote it' : 'someone changed it';
  const what = info.fields && info.fields.length ? ` (${info.fields.join(', ')})` : '';
  const risk = info.risks.length ? `; flagged: ${info.risks.join('; ')}` : '';
  const goes = info.runsOnApproved ? ' It keeps working on the version you approved; the new one waits for your approval.' : ' It waits for your approval.';
  return `${who}${what}${risk}.${goes}`.replace(/^./, (c) => c.toUpperCase());
}

/**
 * The dispatcher's sweep (every tick): each own member and routine that keeps working on its last
 * approved text while a newer version waits is announced once, even when nothing runs it. Never
 * throws: a failure here never stops a project's fires.
 */
export function announcePendingChanges(
  contextRoot: string,
  notify: (title: string, body: string) => void,
  home?: string,
): number {
  const projectRoot = dirname(contextRoot);
  let told = 0;
  let targets: AutomationManifest[] = [];
  try {
    targets = [...listAgentTargets(contextRoot, home), ...listAutomations(contextRoot, home).filter((m) => m.runKind !== 'agent')];
  } catch { return 0; }
  for (const m of targets) {
    try {
      if (!m.enabled) continue;
      const view = approvedTarget(projectRoot, m, home, 'run');
      if (!view.pending) continue;
      const notice = claimPendingNotice(contextRoot, m, view.pending, home);
      if (notice) { notify(notice.title, notice.body); told += 1; }
    } catch { /* the next tick tries again */ }
  }
  return told;
}
