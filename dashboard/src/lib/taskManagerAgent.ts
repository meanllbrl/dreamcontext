import type { Task } from '../hooks/useTasks';
import type { SessionStatusKind } from '../components/sleepy/agentStatus';
import { preparePrompt } from './agentPrompt';
import { taskSourcePath } from './delegateAgent';
import { getActiveVault } from '../api/client';

/**
 * The "Curate this task" bridge — the task-detail pane's half of the agent×task family.
 *
 * Task Manager is NOT a second agent runtime, and NOT a second AgentSurface. `AgentSurface` is
 * mounted exactly once above the router and globally owns the things a Claude session needs to
 * be unique: the session-id counter, the per-vault roster file (`.agent-sessions.json`), and
 * the live-conversation set that stops two PTYs attaching to one transcript. A second instance
 * inside the task page would race the roster and could double-attach a conversation.
 *
 * So the task page owns no session at all. It renders an empty SLOT, and the one global surface
 * moves the session's DOM into it — the same raw-DOM hoist that already keeps sessions alive
 * across navigation (`.agent-pane-slot[data-pane]`). The terminal is never remounted; it is
 * re-parented. The page asks for a session by dispatching an event, exactly like Delegate.
 *
 * Task Manager ≠ Delegate:
 *  - Task Manager (here) maintains the task DOCUMENT — revise / summarize / split / status. It
 *    runs in view, interactively, and the doc refreshes under it.
 *  - Delegate (`delegateAgent.ts`) implements the task. It runs minimized, in the background.
 */

/** Ask the surface for this task's session and hoist it into the page's slot. */
export const TASK_MANAGER_EVENT = 'dreamcontext-task-manager';
/** The slot is going away (task closed / detail unmounted) — park the session, don't kill it. */
export const TASK_MANAGER_DETACH_EVENT = 'dreamcontext-task-manager-detach';
/** The pane's quick actions (Revise / Summarize / Split / Status) type into the live session. */
export const TASK_MANAGER_SEND_EVENT = 'dreamcontext-task-manager-send';
/** The surface reports the session's live status back to the pane (it owns no session state). */
export const TASK_MANAGER_STATUS_EVENT = 'dreamcontext-task-manager-status';

export interface TaskManagerDetail {
  /** Task slug — also the slot key (`.agent-task-manager-slot[data-task="<slug>"]`). */
  slug: string;
  /** Tab/session title, for the surface's own bookkeeping. */
  title: string;
  /** First message, INLINE. Empty when `promptToken` is set — see {@link DelegateAgentDetail}
   *  for why the transport must be chosen before dispatch rather than inside the listener. */
  prompt: string;
  /** Token redeeming a first message too large to inline. */
  promptToken: string;
  bypass: boolean;
  /** Set true by the surface once a session actually exists and is bound to the slot. */
  accepted?: boolean;
}

export interface TaskManagerSendDetail {
  slug: string;
  /** Text to type into the live session. Submitted unless `submit` is false. */
  text: string;
  submit?: boolean;
}

export interface TaskManagerStatusDetail {
  slug: string;
  /** The shared session-status vocabulary (`agentStatus.ts`) — notably `asking`, which is the
   *  whole reason the pane needs this: an agent blocked on a permission prompt or a plan
   *  approval is invisible to someone reading the task document next to it. */
  kind: SessionStatusKind;
  label: string;
}

/**
 * The conversation UUID pinned to a task's Task Manager session, per vault.
 *
 * Persisted so reopening a task RESUMES the conversation you were in the middle of instead of
 * starting a blank one — you asked it to split AC-3 an hour ago, come back, and it still knows.
 * Safe to always resume against: when no transcript exists yet the server falls back to
 * `--session-id <same id>` (start fresh, stay pinned) rather than erroring, so a never-used
 * task and a half-curated one take the same path.
 *
 * localStorage, not the roster: the session is scoped to a task you have open, so it is
 * deliberately absent from `.agent-sessions.json` (no corner chip, no restore-on-launch).
 * Only the id needs to survive, and only per browser/vault.
 */
const TM_ID_PREFIX = 'dreamcontext:task-manager-id:';

function tmIdKey(slug: string): string {
  return `${TM_ID_PREFIX}${getActiveVault() ?? ''}:${slug}`;
}

export function taskManagerConversationId(slug: string): string {
  const key = tmIdKey(slug);
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    // Private mode / storage disabled: a fresh id every open still works, it just won't resume.
    return crypto.randomUUID();
  }
}

/** Forget a task's conversation, so the next open starts clean (the pane's Reset). */
export function forgetTaskManagerConversation(slug: string): void {
  try { localStorage.removeItem(tmIdKey(slug)); } catch { /* nothing to forget */ }
}

/**
 * The FIRST message: pin the agent to this task and load the skill that tells it how to manage one.
 *
 * Deliberately short. It does NOT inline the task's body the way the delegate prompt does,
 * because the agent is about to read the file itself and the user is watching that same file —
 * an inlined copy would just be a second, staler version of what's on screen. The delegate
 * agent runs unattended and benefits from having the brief in-message; this one has the
 * document one Read away and a human next to it.
 *
 * `task-manager` is a core skill installed into every project (see skill-task-manager/SKILL.md), so
 * naming it here is enough for the session to load it.
 */
export function buildTaskManagerPrompt(task: Task, title: string): string {
  return [
    `Load the \`task-manager\` skill and manage this dreamcontext task with it. Do NOT implement the task — maintain its document.`,
    `\nTask: ${title}`,
    `Slug: \`${task.slug}\``,
    `Document: \`${taskSourcePath(task.slug)}\``,
    `\nRead the document first, then give me a SHORT read on its current state: is it clear, are the acceptance criteria testable, does anything look stale or already done? Then wait — I'll tell you what to change.`,
  ].join('\n');
}

/** Quick-action prompts. Each is a full instruction on its own — the session already knows
 *  which task it is pinned to, so these never need to re-name it. */
export const TASK_MANAGER_ACTIONS = [
  {
    id: 'revise',
    label: 'Revise',
    prompt: 'Revise this task: tighten the prose without changing its meaning, cut hedging, fuse duplicate bullets, and make every acceptance criterion independently testable. Tell me what you changed and why.',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    prompt: "Summarize this task: set its one-line description to say what the task IS (not a restatement of the title), and tighten the Why to the shortest version that still carries the reasoning.",
  },
  {
    id: 'split',
    label: 'Split',
    prompt: 'Does this task hold more than one independent job? If it does, propose a split — name the children and which acceptance criteria go to each — and ask me before you create anything. If it does not, say so and stop.',
  },
  {
    id: 'status',
    label: 'Status',
    prompt: 'Reconcile this task with reality: read the code and check each unticked acceptance criterion — is it actually still open? Tick only what you can demonstrate, cite the evidence, and tell me whether the status should move.',
  },
] as const;

/** Sync ACK, for the same reason as {@link requestDelegateAgent}: `dispatchEvent` runs listeners
 *  inline, so the surface's guards have already answered by the time this returns. Prepare the
 *  prompt's transport BEFORE calling — an await inside the listener would make the ack a lie. */
export function requestTaskManager(detail: TaskManagerDetail): boolean {
  const payload: TaskManagerDetail = { ...detail, accepted: false };
  window.dispatchEvent(new CustomEvent<TaskManagerDetail>(TASK_MANAGER_EVENT, { detail: payload }));
  return payload.accepted === true;
}

/** Prepare + dispatch: route the first message to a transport that can carry it, then ask the
 *  surface to bind a session to this task's slot. Throws if the hand-off fails. */
export async function openTaskManager(
  args: { slug: string; title: string; prompt: string; bypass: boolean },
): Promise<boolean> {
  const { inline, token } = await preparePrompt(args.prompt.trim());
  return requestTaskManager({
    slug: args.slug, title: args.title, prompt: inline, promptToken: token, bypass: args.bypass,
  });
}

/** Release the slot without killing the session (the task detail is closing). */
export function detachTaskManager(slug: string): void {
  window.dispatchEvent(new CustomEvent<{ slug: string }>(TASK_MANAGER_DETACH_EVENT, { detail: { slug } }));
}

/** Type into a task's live session (the quick actions). */
export function sendToTaskManager(detail: TaskManagerSendDetail): void {
  window.dispatchEvent(new CustomEvent<TaskManagerSendDetail>(TASK_MANAGER_SEND_EVENT, { detail }));
}
