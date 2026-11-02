import { activityOf, getChat } from '../assistant/chat-registry.js';
import { getAgent, listAgentTargets } from '../agents/store.js';
import { memberCallState } from '../agents/team-roster.js';
import { listMemberSupers, readSuperState, superIdOfMember, type SanitizeOpts } from './store.js';
import type { SuperMemberSummary, SuperState } from './types.js';

/**
 * The Ekip row's facts (plan-r10 1 "Who sees a member's work", 1f; `summary=1` `members`): one
 * entry per AI Team member of the project, derived on the SERVER from that member's own Super
 * record, counting the OWNER's and routine work only. A member working only for main Super is
 * `superOnly` (listed, no count); a global member says `global`; `approval` = its one card waits.
 */

const isMain = (o: string | undefined): boolean => typeof o === 'string' && o.startsWith('main:');

function runsNow(sid: string): boolean {
  const e = getChat(sid);
  if (!e) return false;
  const a = activityOf(e);
  return a === 'working' || a === 'starting' || a === 'asking' || a === 'stale';
}

/** One member's entry from its record (pure but for the registry's live status). */
export function summarizeMember(
  slug: string, s: SuperState | null, facts: { global: boolean; enabled: boolean; approval: boolean },
  live: (sid: string) => boolean = runsNow,
): SuperMemberSummary {
  const base: SuperMemberSummary = { slug, global: facts.global, enabled: facts.enabled, ownerWorking: 0, asking: false, approval: facts.approval, unread: 0, superOnly: false, lastAt: 0, pending: 0 };
  if (!s) return base;
  // What waits for the member's Super to be attached (plan-r10 1): main's requests and replies
  // the pump has not carried yet. A spawn signal for the window, never part of the owner's count.
  const pending = s.queue.filter((q) => (q.kind === 'request' || q.kind === 'reply') && q.state === 'pending').length;
  const kids = Object.entries(s.children);
  const ownerKids = kids.filter(([, c]) => !isMain(c.workOrigin));
  const ownerWorking = ownerKids.filter(([sid, c]) => c.endedAt === undefined && (c.row === 'working' || c.row === 'asking') && live(sid)).length;
  const childOrigin = (sid: string) => (Object.prototype.hasOwnProperty.call(s.children, sid) ? s.children[sid].workOrigin : undefined);
  const asking = s.queue.some((q) => q.state !== 'done' && !isMain(q.workOrigin) && !isMain(childOrigin(q.sessionId))
    && (q.kind === 'permission' || q.kind === 'owner' || q.state === 'escalated' || (q.kind === 'question' && q.direct === true)));
  const unread = ownerKids.filter(([, c]) => c.finishedAt !== undefined && !(c.seenAt !== undefined && c.seenAt >= c.finishedAt)).length;
  const mainOpen = s.queue.some((q) => q.kind === 'request' && q.state !== 'done')
    || kids.some(([sid, c]) => isMain(c.workOrigin) && c.endedAt === undefined && live(sid));
  const times = [
    ...kids.flatMap(([, c]) => [c.startedAt, c.rowAt ?? 0, c.finishedAt ?? 0]),
    ...s.queue.map((q) => q.createdAt),
  ];
  return {
    ...base,
    ownerWorking,
    asking,
    unread,
    superOnly: mainOpen && ownerWorking === 0 && !asking,
    lastAt: times.length ? Math.max(0, ...times) : 0,
    pending,
  };
}

/** A member's row for the phone (`live-chats`): the owner-facing facts only. `pending` is the
 *  window's spawn signal, and the phone never opens a Super chat. */
export function phoneMemberRow(m: SuperMemberSummary): Omit<SuperMemberSummary, 'pending'> {
  const { pending: _pending, ...row } = m;
  return row;
}

/** Every member of the project (project and global agents), its record read when it has one. */
export async function memberSummaries(contextRoot: string, opts: SanitizeOpts & { home?: string } = {}): Promise<SuperMemberSummary[]> {
  let targets: Array<{ slug: string; enabled: boolean }> = [];
  try { targets = listAgentTargets(contextRoot, opts.home); } catch { targets = []; }
  const withRecord = new Set(await listMemberSupers(contextRoot));
  const out: SuperMemberSummary[] = [];
  for (const t of targets) {
    let approval = false;
    let enabled = t.enabled;
    try {
      const call = memberCallState(contextRoot, t.slug, opts.home);
      if (call.state === 'missing' || call.state === 'not_owner') continue;
      approval = call.state === 'needs-approval';
      enabled = call.state !== 'off';
    } catch { /* one unreadable member costs its line */ continue; }
    let global = false;
    try { global = getAgent(contextRoot, t.slug, opts.home)?.scope === 'global'; } catch { global = false; }
    let s: SuperState | null = null;
    if (withRecord.has(t.slug)) {
      try { s = await readSuperState(contextRoot, superIdOfMember(t.slug), opts); } catch { s = null; }
    }
    out.push(summarizeMember(t.slug, s, { global, enabled, approval }));
  }
  return out;
}

/** The sessions a vault's member Supers hold (their own and their children's): never an owner's
 *  chat in a count or a list. */
export async function memberSuperSessions(contextRoot: string, opts: SanitizeOpts = {}): Promise<Set<string>> {
  const out = new Set<string>();
  for (const slug of await listMemberSupers(contextRoot)) {
    try {
      const s = await readSuperState(contextRoot, superIdOfMember(slug), opts);
      if (s.session) out.add(s.session);
      for (const sid of Object.keys(s.children)) out.add(sid);
      for (const sid of s.formerChildren ?? []) out.add(sid);
    } catch { /* a refused record lists nothing */ }
  }
  return out;
}
