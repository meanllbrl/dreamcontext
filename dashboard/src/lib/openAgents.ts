/**
 * "Open a member": the one request every surface uses to land on an AI Team member, or on the
 * create flow, from wherever it is (the Automations empty state, a task's face, a chat or
 * whiteboard picker's "Manage agents", the member stage's Profile button).
 *
 * WHERE IT LANDS (plan-r10 1c, 1d). There is no AI Team page any more:
 *  - `{ slug }` or `{ slug, task }`: that member's stage, its one conversation (the drawer's
 *    `{ kind: 'member', slug, task? }` intent), with the task strip when `task` is given;
 *  - `{ create }` / `{ whiteboard }`, and `requestManageMembers(...)`: the "Üyeleri yönet" modal,
 *    on that member's profile when a slug is given.
 *
 * WHY A WINDOW EVENT AND NOT THE INSTANCE BUS. The callers are deep components and plain
 * helpers that hold no bus, and the contract (`requestOpenAgents(focus)`) takes none. The window
 * hears it in every mounted project, so the LISTENER does the scoping: `ProjectInstance` acts on
 * it only in the ACTIVE instance. That is exact, not a guess: a hidden instance is `inert`, so a
 * click can only ever come from the project the user is looking at.
 *
 * `nonce` is stamped by the listener, never by the caller, so two requests for the same agent
 * still read as two.
 */
export const OPEN_AGENTS_EVENT = 'dreamcontext-open-agents';
/** "Üyeleri yönet": the modal, in the active project. Detail: {@link ManageMembersDetail}. */
export const MANAGE_MEMBERS_EVENT = 'dreamcontext-manage-members';

/** What is asked for: one member (its stage, with a task), the create flow, or the roster. */
export interface AgentsFocus {
  slug?: string;
  create?: boolean;
  /** With `create`: the board the new agent calls home, preset in the create dialog, so "New
   *  agent" on a board makes that board's agent in one step. Ignored without `create`. */
  whiteboard?: string;
  /** With `slug`: the task the member's stage opens on (its task strip). */
  task?: string;
  nonce: number;
}

/** The request as it travels on the window: the focus minus the listener's nonce. */
export type OpenAgentsDetail = Omit<AgentsFocus, 'nonce'>;

/** What "Üyeleri yönet" is asked to show. */
export interface ManageMembersDetail {
  slug?: string;
  create?: boolean;
  whiteboard?: string;
}

/** The agent slug shape the server accepts (`isSafeAutomationSlug`): lowercase words joined
 *  by single dashes. Anything else is dropped rather than handed to the page. */
const AGENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The board slug shape the server accepts (`isValidWhiteboardSlug` in `src/lib/whiteboards/validate.ts`). */
const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The task slug shape (`ABOUT_TASK_RE`'s charset): no 64 cap, task slugs reach ~100 characters. */
export const OPEN_TASK_SLUG = /^[a-z0-9][a-z0-9-]{0,251}$/;

/**
 * Normalise one incoming request. Total: a malformed detail becomes the plain roster (`{}`), never
 * a throw, because an event payload is whatever the dispatcher put there. A bad `task` is dropped
 * on its own (the member still opens); a task without a member is nothing to open.
 */
export function readOpenAgentsDetail(detail: unknown): OpenAgentsDetail {
  if (!detail || typeof detail !== 'object') return {};
  const { slug, create, whiteboard, task } = detail as { slug?: unknown; create?: unknown; whiteboard?: unknown; task?: unknown };
  const out: OpenAgentsDetail = {};
  if (typeof slug === 'string' && slug.length <= 100 && AGENT_SLUG_RE.test(slug)) {
    out.slug = slug;
    if (typeof task === 'string' && OPEN_TASK_SLUG.test(task)) out.task = task;
  }
  if (create === true) {
    out.create = true;
    if (typeof whiteboard === 'string' && BOARD_SLUG_RE.test(whiteboard)) out.whiteboard = whiteboard;
  }
  return out;
}

/** The same rules for "Üyeleri yönet" (no task: the modal has no strip). */
export function readManageMembersDetail(detail: unknown): ManageMembersDetail {
  const { task: _task, ...rest } = readOpenAgentsDetail(detail);
  return rest;
}

/**
 * Where one request goes (pure; the listener in `ProjectInstance` acts on it):
 * a member (with or without a task) opens its stage; the create flow, a board's new agent or a
 * bare request opens "Üyeleri yönet".
 */
export type OpenAgentsRoute =
  | { to: 'member'; slug: string; task?: string }
  | { to: 'manage'; detail: ManageMembersDetail };

export function routeOpenAgents(detail: OpenAgentsDetail): OpenAgentsRoute {
  if (detail.slug && !detail.create) return { to: 'member', slug: detail.slug, ...(detail.task ? { task: detail.task } : {}) };
  const manage: ManageMembersDetail = {};
  if (detail.slug) manage.slug = detail.slug;
  if (detail.create) manage.create = true;
  if (detail.create && detail.whiteboard) manage.whiteboard = detail.whiteboard;
  return { to: 'manage', detail: manage };
}

/** Ask the visible project to open a member's stage (`{slug, task?}`) or "Üyeleri yönet". */
export function requestOpenAgents(focus: Omit<AgentsFocus, 'nonce'>): void {
  if (typeof window === 'undefined') return;
  const detail: OpenAgentsDetail = readOpenAgentsDetail(focus);
  window.dispatchEvent(new CustomEvent<OpenAgentsDetail>(OPEN_AGENTS_EVENT, { detail }));
}

/** Open "Üyeleri yönet" in the active project, on that member's profile when `slug` is given. */
export function requestManageMembers(detail?: { slug?: string; create?: boolean; whiteboard?: string }): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ManageMembersDetail>(MANAGE_MEMBERS_EVENT, { detail: readManageMembersDetail(detail ?? {}) }));
}

/**
 * Where an `automation/<slug>` link lands (pure): the member the routine runs as (its `agent`, or
 * the automation itself when it is a member's own call target) opens that member's stage; a
 * routine of no member, or one this project does not list, keeps "Üyeleri yönet" on that slug.
 */
export function automationLinkRoute(
  slug: string,
  automations: ReadonlyArray<{ slug: string; agent?: string | null; runKind?: string }>,
  agents: ReadonlyArray<{ slug: string }>,
): { to: 'member'; slug: string } | { to: 'manage'; slug: string } {
  const a = automations.find((x) => x.slug === slug);
  const member = a?.agent ?? (a?.runKind === 'agent' ? a.slug : null);
  if (member && agents.some((x) => x.slug === member)) return { to: 'member', slug: member };
  return { to: 'manage', slug: a?.agent ?? slug };
}
