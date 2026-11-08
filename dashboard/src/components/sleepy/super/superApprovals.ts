import type { AgentSummary } from '../../../hooks/useAgents';
import type { AutomationSummary } from '../../../hooks/useAutomations';

/**
 * What waits for the owner's approval on THIS Mac, for the Super Agent's screen (owner 2026-11-06:
 * "AI Team üyelerinde approve gerektiğinde Super Agent surface'de istesin"). Derived from the two
 * lists the AI Team page reads, never stored: an item leaves the moment the server says it is
 * approved or off, whoever decided it and wherever.
 *
 * - a member (new, or its instructions changed) that is ON and not approved to run here;
 * - an automation (a member's routine, or one set up on its own) that is ON and not approved.
 *
 * Never a teammate's (read-only here: `not_owner`, nothing this Mac can approve), never one that
 * is off (a NO already given, or a member he switched off: nothing will run, nothing waits). An
 * agent's own call target is the member's row, never a second one.
 */
export interface SuperApproval {
  /** `agent:<slug>` or `routine:<slug>`: the row's key, its DOM anchor and its agenda key. */
  key: string;
  kind: 'agent' | 'routine';
  slug: string;
  /** The member's or the routine's name. */
  title: string;
  /** The member it belongs to (a routine's agent), for the sentence. */
  memberTitle: string;
  /** That member's slug: where AI Team opens when the card row is not on screen. */
  member: string;
  /** Changed since it was approved (instructions, a synced change), vs new. */
  changed: boolean;
  /** It keeps working on the version the owner approved; only the newer one waits (owner 2026-11-08). */
  keepsWorking?: boolean;
}

type AgentFields = Pick<AgentSummary, 'slug' | 'title' | 'approvedForChat' | 'approvedToRun' | 'approvalReason'> & { readOnly?: boolean; enabled?: boolean; pendingChange?: AgentSummary['pendingChange'] };
type AutomationFields = Pick<AutomationSummary, 'slug' | 'title' | 'agent' | 'agentTitle' | 'approved' | 'approvalReason' | 'enabled' | 'runKind'> & { changeWaits?: boolean };

const changedReason = (r: string | null | undefined) => r === 'manifest-changed' || r === 'payload-format-changed';

export function superApprovals(agents: readonly AgentFields[] | undefined, automations: readonly AutomationFields[] | undefined): SuperApproval[] {
  const out: SuperApproval[] = [];
  const nameOf = new Map((agents ?? []).map((a) => [a.slug, a.title || a.slug]));
  for (const a of agents ?? []) {
    if (a.readOnly || a.enabled === false) continue;
    const keepsWorking = a.approvedForChat && a.approvedToRun && !!a.pendingChange;
    if (a.approvedForChat && a.approvedToRun && !keepsWorking) continue;
    if (a.approvalReason === 'not_owner') continue;
    const title = a.title || a.slug;
    out.push({ key: `agent:${a.slug}`, kind: 'agent', slug: a.slug, title, memberTitle: title, member: a.slug, changed: keepsWorking || changedReason(a.approvalReason), ...(keepsWorking ? { keepsWorking } : {}) });
  }
  for (const m of automations ?? []) {
    if (m.runKind === 'agent' || (m.approved && !m.changeWaits) || !m.enabled || m.approvalReason === 'not_owner') continue;
    // A legacy file that is its own agent (no `agent:`) is already the member's row. A split
    // member's scheduled job keeps the member's slug but is a grant of its own: it gets a row.
    if (!m.agent && out.some((o) => o.kind === 'agent' && o.slug === m.slug)) continue;
    const owner = m.agent ?? m.slug;
    out.push({
      key: `routine:${m.slug}`, kind: 'routine', slug: m.slug, title: m.title || m.slug,
      memberTitle: nameOf.get(owner) ?? m.agentTitle ?? owner, member: owner, changed: m.approved || changedReason(m.approvalReason),
      ...(m.approved ? { keepsWorking: true } : {}),
    });
  }
  return out;
}

/**
 * The rows Waiting on you lists. A member `super team ask` was refused for already has its own
 * Waiting row (the queue's approval item), so its card rows are not listed twice: neither the
 * member's nor a same-slug routine's (a split member's job is what `say` runs when there is one).
 */
export function agendaApprovals(
  approvals: readonly SuperApproval[],
  queue: readonly { kind: string; state?: string; member?: string | null }[],
): SuperApproval[] {
  const asked = new Set(queue.filter((q) => q.kind === 'approval' && q.state !== 'done' && q.member).map((q) => q.member as string));
  return approvals.filter((a) => !asked.has(a.slug));
}

/** Bring the card row for a member's approval into view: its own row, else its same-slug job's. */
export function showMemberApproval(member: string, root?: ParentNode): boolean {
  return showApprovalRow(`agent:${member}`, root) || showApprovalRow(`routine:${member}`, root);
}

/** The one sentence a row is said in (the AI Team page's own words). */
export function superApprovalSentence(it: SuperApproval, t: (k: string) => string): string {
  if (it.keepsWorking) {
    return t(it.kind === 'routine' ? 'aiteam.approval.routineKeepsWorking' : 'aiteam.approval.keepsWorking').replace('{routine}', it.title).replace('{name}', it.memberTitle);
  }
  if (it.kind === 'routine') {
    return t(it.changed ? 'aiteam.approval.routineChanged' : 'aiteam.approval.routineNew').replace('{routine}', it.title).replace('{name}', it.memberTitle);
  }
  return t(it.changed ? 'aiteam.approval.talkChanged' : 'aiteam.approval.talkNew').replace('{name}', it.title);
}

/**
 * Bring a row of the Super's approval card into view and flash it. False when no such row is on
 * screen: not drawn, or drawn on a stage that is folded away or behind another tab, so the caller
 * falls back (AI Team) instead of a button that does nothing.
 */
export function showApprovalRow(key: string, root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLElement>(`[data-super-approval="${CSS.escape(key)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'nearest' });
  if (!onScreen(el)) return false;
  el.dataset.flash = 'true';
  window.setTimeout(() => { delete el.dataset.flash; }, 1600);
  el.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  return true;
}

/** Whether the owner can see the row: it has a box and its middle is not covered or clipped away. */
function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + Math.min(r.height, 40) / 2, 0), window.innerHeight - 1);
  const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : el;
  return hit !== null && el.contains(hit);
}
