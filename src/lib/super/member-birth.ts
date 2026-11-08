import { randomUUID } from 'node:crypto';
import { memberCallState } from '../agents/team-roster.js';
import { writeSuper } from './inbox.js';
import { settleMemberIdentity } from './member-identity.js';
import { okMember, superIdOfMember } from './store.js';
import type { SuperId, SuperState } from './types.js';

/**
 * THE BIRTH OF A MEMBER'S SUPER (plan-r10 1). An AI Team member is a Super of its own in a project:
 * its record is `state/.super/members/<slug>.json`, born here on the FIRST request to it (the owner
 * opens the member and sends, or main Super's `team ask`): `enabled: true`, a fresh session id, the
 * member's slug. Only then does the window spawn the chat with that id, so the upgrade gate
 * (agent-chat.ts `superUpgradeRefusal`, per super) accepts it. No hand-over and no adopting the
 * owner's chats: `handover.ts` stays main's.
 *
 * The member is judged on every call the way `super team ask` judges it (`memberCallState`, the
 * order of `sayToAgent`): missing 404, a colleague's 403, turned off 409 `member_off`, waiting for
 * its one approval card 409 `member_unapproved`. A refused member gets NO record.
 *
 * A global member (`~/.dreamcontext/agents/<slug>.md`) is born the same way: its record lives in
 * THIS project, its identity comes from the global manifest (`prepareAgentChat` at spawn).
 */

export type MemberBirth =
  | { ok: true; superId: SuperId; session: string; state: SuperState; born: boolean }
  | { ok: false; status: 403 | 404 | 409; error: string; message: string };

export async function ensureMemberSuper(
  contextRoot: string,
  slug: string,
  home?: string,
  deps: { stopSuper?: (root: string, slug: string) => Promise<unknown> } = {},
): Promise<MemberBirth> {
  if (!okMember(slug)) return { ok: false, status: 404, error: 'unknown_member', message: 'name an AI Team member by its slug' };
  // A new member that took an earlier member's name starts clean: the earlier one's record moves
  // to the trash before anything reads it (`member-identity.ts`).
  try { await settleMemberIdentity(contextRoot, slug, { stopSuper: deps.stopSuper, home }); } catch { /* judged below as before */ }
  let call: ReturnType<typeof memberCallState>;
  try { call = memberCallState(contextRoot, slug, home); } catch {
    return { ok: false, status: 404, error: 'unknown_member', message: `the member "${slug}" cannot be read` };
  }
  if (call.state === 'missing') return { ok: false, status: 404, error: 'unknown_member', message: `no AI Team member "${slug}" in this project` };
  if (call.state === 'not_owner') return { ok: false, status: 403, error: 'not_owner', message: 'this member belongs to a teammate and is read-only here' };
  if (call.state === 'off') return { ok: false, status: 409, error: 'member_off', message: 'this member is turned off; turn it on first' };
  if (call.state === 'needs-approval') return { ok: false, status: 409, error: 'member_unapproved', message: 'this member waits for its one approval card' };
  const superId = superIdOfMember(slug);
  let born = false;
  const state = await writeSuper(contextRoot, superId, (s) => {
    if (!s.session) { s.session = randomUUID(); born = true; }
    s.enabled = true;
  });
  if (!state.session) return { ok: false, status: 409, error: 'member_unborn', message: 'the member\'s record could not be written' };
  return { ok: true, superId, session: state.session, state, born };
}
