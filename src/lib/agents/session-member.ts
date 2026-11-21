/**
 * Who a session is (plan global-uye-ogrenme D3): the ONE resolver every reader of "is this a
 * member's session, and whose" asks. A member's rules ride its own sessions only (rules-delivery),
 * and its process may write only its own rule store (learn's `own_member_only`).
 *
 * It reads the env in the SAME order as `memberActorFromEnv` (instruction-fields.ts): a member's run
 * (`DREAMCONTEXT_AGENT_SELF`), its Super's crew (`DREAMCONTEXT_MEMBER_CREW`), the member's own Super
 * chat, any conversation with it (`DREAMCONTEXT_AGENT_CHAT`), then a routine run of it
 * (`DREAMCONTEXT_RUN_MEMBER`, set by the runner). `''` is none; the ambiguous crew mark `*` and an
 * app's chat `app-<slug>` are nobody. The slug must be safe and a member of this project.
 *
 * Identity READS, it never authorises (SG2): the env picks what is read and narrows who may write;
 * every write still passes G1. {@link ownerProcess} is the one owner test every exemption reads.
 */
import { homedir } from 'node:os';
import { inAgentSession } from '../session-id.js';
import { memberSuperProcess } from '../automations/types.js';
import { memberActorFromEnv } from './instruction-fields.js';
import { memberScope, type MemberScope } from './scope.js';
import { isSafeAutomationSlug } from './slot.js';

export const RUN_MEMBER_ENV = 'DREAMCONTEXT_RUN_MEMBER';

export interface SessionMember { slug: string; scope: MemberScope }

/** The raw slug the env names, before it is checked against the project. '' when none. */
export function sessionMemberSlug(env: NodeJS.ProcessEnv = process.env): string {
  const pick = [
    env.DREAMCONTEXT_AGENT_SELF,
    env.DREAMCONTEXT_MEMBER_CREW,
    memberSuperProcess(env) ?? '',
    env.DREAMCONTEXT_AGENT_CHAT,
    env[RUN_MEMBER_ENV],
  ].map((v) => (v ?? '').trim()).find((v) => v !== '');
  return pick ?? '';
}

/** The member this session belongs to, or null. Pure, never throws. */
export function sessionMember(env: NodeJS.ProcessEnv, contextRoot: string | null, home: string = homedir()): SessionMember | null {
  try {
    const slug = sessionMemberSlug(env);
    if (!slug || slug === '*' || slug.startsWith('app-') || !isSafeAutomationSlug(slug)) return null;
    if (!contextRoot) return null;
    const scope = memberScope(contextRoot, slug, home);
    return scope ? { slug, scope } : null;
  } catch {
    return null;
  }
}

/**
 * True only for the owner himself at his own shell: no agent session (Claude, Codex, Antigravity),
 * no run, crew, Super or chat marker, and no member. The one predicate an owner-only exemption reads.
 */
export function ownerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  if (inAgentSession(env)) return false;
  if (memberActorFromEnv(env).actor !== 'owner') return false;
  return sessionMemberSlug(env) === '';
}
