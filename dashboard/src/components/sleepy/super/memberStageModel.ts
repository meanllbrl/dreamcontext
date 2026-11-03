/**
 * A member's stage (plan-r10 1, 1c, 1e, 1f): the window's pure half. AgentSurface shows ONE stage
 * at a time, bound to `activeSuperId` (`'main'` or `m:<member slug>`); everything here decides
 * from plain data, so the unit tests drive it without a browser.
 *
 *  - which super a drawer intent shows (`superIdOfIntent`);
 *  - which members to start cold (`coldMembers`: main gave them work, no window holds them);
 *  - the spawn settings of a member's Super (`memberSuperSpawn`: its manifest model and effort,
 *    the project's Super default for a member on another tool);
 *  - the server's answer when the owner opens a member (`memberOpenRefusal`);
 *  - the member's tasks for its agenda (`memberTasks`) and the strip's buttons (`stripActions`,
 *    `stripWait`).
 */
import type { ApiClient } from '../../../api/client';
import { RequestError } from '../../../api/client';
import type { DrawerIntent } from '../../../lib/drawerIntents';
import { MEMBER_SUPER_PREFIX, SUPER_STATE_VERSION, parseSuperId, readSuperStateView, type SuperId, type SuperMemberSummary, type SuperStateView } from '../../../lib/superTypes';
import type { AgentJob, Task, TaskAgentAction } from '../../../hooks/useTasks';
import { jobWaitKey, type JobWaitKey } from '../../../lib/taskAgentJob';
import { fetchRemoteStage } from './remoteStage';

/** `m:<slug>` for a member slug (unchecked here: `parseSuperId` checks). */
export function memberSuperId(slug: string): SuperId {
  return `${MEMBER_SUPER_PREFIX}${slug}` as SuperId;
}

/** The member a superId names, or null for main (or anything malformed). */
export function memberOf(superId: SuperId | null | undefined): string | null {
  if (!superId || superId === 'main') return null;
  const id = parseSuperId(superId);
  return id && id !== 'main' ? id.slice(MEMBER_SUPER_PREFIX.length) : null;
}

/** Which super a drawer intent shows: a member intent its member, the Super row main, anything
 *  else nothing (the active super stays). */
export function superIdOfIntent(intent: DrawerIntent): SuperId | null {
  if (intent.kind === 'super') return 'main';
  if (intent.kind === 'member') {
    const id = parseSuperId(memberSuperId(intent.slug));
    return id && id !== 'main' ? id : null;
  }
  return null;
}

// ─── Every super of the project at once ───────────────────────────────────────────

/**
 * Every super's children as ONE record view (plan-r10 1): which chats of this window are SOME
 * super's children, whichever stage shows. An enabled super lends all its children; a super that
 * is off lends only its ended ones (a dormant tab of an ended child still closes, as main's always
 * did). `session` is main's (only main is ever a tab's pin); `enabled` = any super is on.
 */
export function unionSuperView(list: ReadonlyArray<{ superId: SuperId; record: SuperStateView }>): Pick<SuperStateView, 'session' | 'enabled' | 'children'> {
  const children: SuperStateView['children'] = {};
  let enabled = false;
  let session: string | null = null;
  for (const { superId, record } of list) {
    if (superId === 'main') session = record.session;
    if (record.enabled) enabled = true;
    for (const [sid, c] of Object.entries(record.children)) {
      if (record.enabled || c?.endedAt !== undefined) children[sid] = c;
    }
  }
  return { session, enabled, children };
}

// ─── Opening a member: the owner verb `member` (POST /api/super/member) ──────────────────

export type MemberOpen =
  | { ok: true; superId: SuperId; session: string; born: boolean; state: SuperStateView | null }
  | { ok: false; status: number; error: string };

/**
 * Ask the server for the member's Super (born on this open when it has none). A refusal is an
 * answer the stage shows, never thrown: 409 `member_unapproved` (its one approval card), 409
 * `member_off`, 404 `unknown_member`, 403 `not_owner`. Status 0 = unreachable.
 */
export async function openMemberSuper(api: ApiClient, slug: string): Promise<MemberOpen> {
  try {
    const r = await api.post<{ superId?: unknown; session?: unknown; born?: unknown; state?: unknown }>('/super/member', { slug });
    const superId = parseSuperId(r?.superId);
    if (!superId || superId === 'main' || typeof r?.session !== 'string' || !r.session) return { ok: false, status: 0, error: 'bad_answer' };
    return { ok: true, superId, session: r.session, born: r.born === true, state: readSuperStateView(r.state) };
  } catch (err) {
    if (err instanceof RequestError) return { ok: false, status: err.status, error: err.code || 'refused' };
    return { ok: false, status: 0, error: 'unreachable' };
  }
}

/** What the stage says for a refused open: the approval card's line, off, gone, or a teammate's. */
export type MemberRefusal = 'unapproved' | 'off' | 'missing' | 'not_owner' | 'unreachable';
export function memberOpenRefusal(r: MemberOpen): MemberRefusal | null {
  if (r.ok) return null;
  if (r.error === 'member_unapproved') return 'unapproved';
  if (r.error === 'member_off') return 'off';
  if (r.error === 'not_owner' || r.status === 403) return 'not_owner';
  if (r.status === 404) return 'missing';
  return 'unreachable';
}

// ─── Spawning a member's Super ─────────────────────────────────────────────────────

/** The project's Super default for a member on Codex or Antigravity (plan-r10 1: explicit, never
 *  an inherited xhigh). */
export const MEMBER_SUPER_FALLBACK = { model: 'opus', effort: 'medium' } as const;

/**
 * The model and effort a member's Super chat spawns on: its manifest's (Super is Claude-only, so a
 * member whose tool is not Claude runs its Super on the project's Super default, Opus at medium,
 * explicit). A Claude member with no model of its own takes the same default.
 */
export function memberSuperSpawn(agent: { model?: string | null; effort?: string | null; tool?: string } | null | undefined): { model: string; effort: string } {
  const claude = !agent?.tool || agent.tool === 'claude';
  if (!claude) return { ...MEMBER_SUPER_FALLBACK };
  return {
    model: agent?.model || MEMBER_SUPER_FALLBACK.model,
    effort: agent?.effort || MEMBER_SUPER_FALLBACK.effort,
  };
}

/**
 * Members to start cold (plan-r10 1 "Spawning a cold member"): main gave them work still waiting
 * for delivery (`pending > 0`, on, not the owner's to approve) and no live chat in THIS window
 * holds their Super. The server delivers on attach, so two windows starting the same member never
 * deliver twice. `tried`: members this window already started once (never twice in a row).
 */
export function coldMembers(
  members: ReadonlyArray<{ slug: string; enabled: boolean; approval: boolean; pending?: number }>,
  live: ReadonlySet<string>,
  tried: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const m of members) {
    const pending = typeof m.pending === 'number' ? m.pending : 0;
    if (pending <= 0 || !m.enabled || m.approval) continue;
    if (live.has(m.slug) || tried.has(m.slug)) continue;
    out.push(m.slug);
  }
  return out;
}

/** A cold start's retry wait (end review M5): 30 s after the first try, then 2 min, capped. */
export const COLD_RETRY_MS = [30_000, 120_000] as const;
export interface ColdTry { at: number; tries: number }
/** When this member may be started cold again (a failed open, or its chat gone before it took
 *  the work). */
export function coldRetryAt(t: ColdTry): number {
  return t.at + COLD_RETRY_MS[Math.min(t.tries, COLD_RETRY_MS.length) - 1];
}
/** The members still waiting out their retry at `now` (what `coldMembers` must skip), and when the
 *  next one is due (null: none waits). */
export function coldWaiting(tried: ReadonlyMap<string, ColdTry>, now: number): { waiting: Set<string>; nextAt: number | null } {
  const waiting = new Set<string>();
  let nextAt: number | null = null;
  for (const [slug, t] of tried) {
    const at = coldRetryAt(t);
    if (at > now) { waiting.add(slug); nextAt = nextAt === null ? at : Math.min(nextAt, at); }
  }
  return { waiting, nextAt };
}

/** `members` of `GET /agent/sessions?summary=1`, read defensively (an older server sends none). */
export function readMemberSummaries(raw: unknown): Array<SuperMemberSummary & { pending: number }> {
  const list = raw && typeof raw === 'object' ? (raw as { members?: unknown }).members : undefined;
  if (!Array.isArray(list)) return [];
  const out: Array<SuperMemberSummary & { pending: number }> = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    if (typeof o.slug !== 'string' || !parseSuperId(memberSuperId(o.slug))) continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    out.push({
      slug: o.slug,
      global: o.global === true,
      enabled: o.enabled !== false,
      ownerWorking: num(o.ownerWorking),
      asking: o.asking === true,
      approval: o.approval === true,
      unread: num(o.unread),
      superOnly: o.superOnly === true,
      lastAt: num(o.lastAt),
      pending: num(o.pending),
    });
  }
  return out;
}

// ─── The member's tasks (plan-r10 1c) ──────────────────────────────────────────────

export type TaskRole = 'doer' | 'reviewer';

/** The member's part in a task: the doer (`agent`), else the reviewer (its job's `reviewer`). */
export function roleIn(task: Pick<Task, 'agent' | 'agent_job'>, slug: string): TaskRole | null {
  if (task.agent === slug) return 'doer';
  if (task.agent_job?.reviewer === slug) return 'reviewer';
  return null;
}

/**
 * The tasks whose doer or reviewer is this member, open first (then the newest first): the
 * agenda's "Görevleri". `closed` says which statuses are terminal (the project's own set).
 */
export function memberTasks<T extends Pick<Task, 'slug' | 'agent' | 'agent_job' | 'status' | 'updated_at'>>(
  tasks: readonly T[], slug: string, closed: (status: string) => boolean,
): Array<{ task: T; role: TaskRole; open: boolean }> {
  const rows: Array<{ task: T; role: TaskRole; open: boolean }> = [];
  for (const task of tasks) {
    const role = roleIn(task, slug);
    if (role) rows.push({ task, role, open: !closed(task.status) });
  }
  return rows.sort((a, b) => (a.open === b.open ? (b.task.updated_at ?? '').localeCompare(a.task.updated_at ?? '') : a.open ? -1 : 1));
}

/**
 * The owner's buttons on the strip, when they apply (mockup r8-08b): Onayla ve kapat and Geri
 * gönder once delivered, Bir tur daha and İptal when stuck at the cap, Ben alırım whenever it waits
 * on him. The same actions the task's own job row sends (`POST /api/tasks/:slug/agent-action`).
 * A closed task or a teammate's member offers none.
 */
export type StripAction = Extract<TaskAgentAction, 'complete' | 'send-back' | 'one-more-round' | 'take-over' | 'cancel'>;
export function stripActions(job: Pick<AgentJob, 'state'> | null | undefined, opts: { closed: boolean; readOnly: boolean }): StripAction[] {
  if (!job?.state || opts.closed || opts.readOnly) return [];
  switch (job.state) {
    case 'delivered': return ['complete', 'send-back'];
    case 'stuck': return ['one-more-round', 'take-over', 'cancel'];
    case 'waiting_owner':
    case 'blocked':
    case 'stopped':
    case 'stalled': return ['take-over'];
    default: return [];
  }
}

/** Who the task waits on, as the strip says it (`superStage.task.waitsOn.*`): derived the way the
 *  task's job row derives it (`jobWaitKey`). Null on a closed task or with no job. */
export function stripWait(job: Pick<AgentJob, 'state' | 'step'> | null | undefined, closed: boolean): JobWaitKey | null {
  return closed ? null : jobWaitKey(job);
}

/**
 * What a strip button sends: exactly the body the task's own job row sends to
 * `POST /api/tasks/:slug/agent-action` (`useTaskAgentAction`). Send back needs his words (null
 * until he wrote some: the strip asks first); every other button goes as is.
 */
export function stripRequest(slug: string, action: StripAction, text?: string): { slug: string; action: StripAction; text?: string } | null {
  if (action === 'send-back') {
    const words = (text ?? '').trim();
    return words ? { slug, action, text: words } : null;
  }
  return { slug, action };
}

/** "tur N/cap" for the strip: the round in play (a rework's next one), or null before any. */
export function stripRound(job: Pick<AgentJob, 'round' | 'cap' | 'step'> | null | undefined): { n: number; cap: number } | null {
  if (!job) return null;
  const n = job.step === 'rework' ? job.round + 1 : job.round;
  return n > 0 && job.cap > 0 ? { n, cap: job.cap } : null;
}

/**
 * The stage of a member that has no record here (plan-r10 1e, 1f): its birth was refused (its
 * approval card, off) or is still on its way. The stage still draws, from the member's manifest and
 * summary: its head, its approval band, its project chip, the refusal line, its own three cards.
 * Nothing else on it is the server's: no chat, no other card, no queue. View only, never written to the record store.
 */
export function memberPlaceholderState(vault: string): SuperStateView | null {
  // Its own three cards at their defaults (plan r4 G3): an off or unapproved member can still be
  // turned on, or deleted, from its stage. Drawn only; a layout change to them waits for the record.
  const cards = [
    { id: 'member-routines', kind: 'member', ref: 'routines', shape: 'square', size: 'large', place: 'float' },
    { id: 'member-instructions', kind: 'member', ref: 'instructions', shape: 'square', place: 'float' },
    { id: 'member-settings', kind: 'member', ref: 'settings', shape: 'square', place: 'others' },
  ];
  return readSuperStateView({
    v: SUPER_STATE_VERSION, vault, session: null, enabled: true,
    containers: cards, groups: [], queue: [], children: {}, notes: {}, away: { since: null, events: 0 },
    dismissed: [], pool: [], ownerBatches: [], team: [],
  });
}

/**
 * The phone's way onto a member's stage (plan-r10 AC9): the phone holds no record and births no
 * Super, so it reads the member's stage through the tunnel's own door and opens its Super's
 * conversation as a mirror, the way main's Super row opens main's. A member with no Super running
 * ('off': never born, turned off, waiting for its card) or an unreachable Mac is said instead.
 */
export type PhoneMemberPlan = { kind: 'open'; session: string } | { kind: 'refused'; refusal: MemberRefusal };
export async function phoneMemberOpen(api: ApiClient, slug: string, read: typeof fetchRemoteStage = fetchRemoteStage): Promise<PhoneMemberPlan> {
  const st = await read(api, memberSuperId(slug));
  if (st === null) return { kind: 'refused', refusal: 'unreachable' };
  if (st === 'off' || !st.enabled || !st.session) return { kind: 'refused', refusal: 'off' };
  return { kind: 'open', session: st.session };
}

/**
 * The member's open routine questions (a `flow-hitl` its own routine, or a routine it runs, asked
 * the owner): what the member stage answers (end review M4). Pure.
 */
export function memberRoutineQuestions<Q extends { kind: string; state: string; slug: string }>(
  questions: readonly Q[], automations: ReadonlyArray<{ slug: string; agent?: string | null }>, member: string,
): Q[] {
  return questions.filter((q) => {
    if (q.kind !== 'flow-hitl' || q.state !== 'pending') return false;
    if (q.slug === member) return true;
    return automations.some((a) => a.slug === q.slug && a.agent === member);
  });
}

/** How long the phone waits for a member's mirror to open before it shows the read-only view. */
export const PHONE_MIRROR_WAIT_MS = 8_000;

/**
 * A member's mirror tab on the phone, at its first attach: `keep` once its socket is open (the Mac
 * took it: the member's Super is live), `fall-back` when the Mac refused it (closed) or it has not
 * opened in time (the read-only view takes over), else `wait`. Pure.
 */
export function memberMirrorVerdict(status: 'connecting' | 'open' | 'closed' | string | undefined, waitedMs: number): 'keep' | 'fall-back' | 'wait' {
  if (status === 'open') return 'keep';
  if (status === 'closed') return 'fall-back';
  return waitedMs >= PHONE_MIRROR_WAIT_MS ? 'fall-back' : 'wait';
}
