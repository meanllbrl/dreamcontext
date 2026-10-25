import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import { refuseNotOwner } from './owner-guard.js';
import { runBrainSync } from '../../lib/git-sync/sync-engine.js';
import {
  agentSyncPreview,
  agentSyncState,
  confirmAgentSyncHere,
  readAgentSyncLocal,
  readPendingRestores,
} from '../../lib/agents/agent-sync.js';
import { writeActiveHere } from '../../lib/agents/active.js';
import { getAgent, listAgents } from '../../lib/agents/store.js';
import { isSafeAutomationSlug } from '../../lib/agents/slot.js';
import { currentLogin, UNOWNED } from '../../lib/agents/owner.js';
import { readMachineIdentity } from '../../lib/machine-id.js';
import { listInboxRows, resolveInboxRow, type InboxRow } from '../../lib/owner-inbox.js';
import { scanOutsideAssignments } from '../../lib/agents/outside-assignments.js';
import { ignoreOutsideKey, recordAssignment } from '../../lib/agents/assignment-ledger.js';
import { adoptPattern } from '../../lib/agents/agent-sync.js';
import { commitAssignment, prepareAssignment } from '../../lib/agents/task-assignment.js';
import { patchMeta } from '../../lib/agents/task-jobs.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import {
  approvePlanAction, cancelTaskAction, changePlanAction, continueTaskAction, letFinishAction, oneMoreRoundAction,
  reconcileTaskRows, rescheduleAction, sendBackAction, startNowAction, stopTaskAction, takeOverAction, type ActionResult,
} from '../../lib/agents/task-starter.js';
import { endTaskJobIfClosed, startDueTaskJobs, taskIdOfRow } from '../../lib/agents/task-starter.js';
import { findTaskHead } from '../../lib/agents/task-jobs.js';
import { foreignOwner, NotOwnerError } from '../../lib/agents/owner.js';
import { loadStatuses } from '../../lib/overrides.js';
import { checkCloseGate } from '../../lib/sleep-eval/report.js';
import { isMappedWaveChild, openChildren } from '../../lib/task-parent.js';

/**
 * Agents ride the brain sync (AI Team v2, wave B1): the migration notice, this machine's
 * confirmation, "Bring it here", and the owner-inbox rows the B1 checks raise.
 *
 *  GET  /api/agents/sync          — the switch, this machine's confirmation, what would start to
 *                                   sync from here and the secret-scan hits in it, unowned members
 *  POST /api/agents/sync/confirm  — turn the switch on (if off) and confirm the notice HERE, then push
 *  GET  /api/agents/inbox         — the owner-inbox rows (after a fresh scan of hand-edited assignments)
 *  POST /api/agents/inbox/:id     — answer one row: start | ignore | adopt | dismiss | start-all | review
 *  POST /api/agents/:slug/bring-here — run this agent on this machine from now on, then push
 */

/** Push the brain in the background: the confirm and "Bring it here" are only half done until the
 *  other machines can pull them. A failed push is retried by the next sync. */
function pushSoon(contextRoot: string): void {
  void runBrainSync({ cwd: contextRoot, mode: 'auto', foreground: true }).catch(() => {});
}

export async function handleAgentSyncState(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const state = agentSyncState(contextRoot);
    const preview = state.active ? { files: [], hits: [] } : agentSyncPreview(contextRoot);
    const unowned = listAgents(contextRoot).filter((a) => a.owner === UNOWNED).map((a) => a.slug);
    const local = readAgentSyncLocal(dirname(contextRoot));
    sendJson(res, 200, {
      ...state,
      confirmedAt: local.confirmedAt ?? null,
      login: currentLogin(),
      machine: readMachineIdentity(),
      filesToSync: preview.files.length,
      hits: preview.hits.map((h) => ({ file: h.file, line: h.line, rule: h.rule, severity: h.severity })),
      unowned,
      parked: readPendingRestores(dirname(contextRoot)).map((p) => p.slug),
    });
  } catch {
    sendError(res, 500, 'agent_sync_failed', 'Failed to read the agent sync state.');
  }
}

export async function handleAgentSyncConfirm(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const result = confirmAgentSyncHere(contextRoot);
    pushSoon(contextRoot);
    sendJson(res, 200, { ...agentSyncState(contextRoot), renamed: result.renamed });
  } catch (err) {
    console.error('[agents] sync confirm failed', err);
    sendError(res, 500, 'agent_sync_confirm_failed', 'Failed to turn on agent sync here.');
  }
}

export async function handleAgentsInbox(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    scanOutsideAssignments(contextRoot);
    reconcileTaskRows(contextRoot);
    sendJson(res, 200, { rows: listInboxRows(dirname(contextRoot)) });
  } catch {
    sendError(res, 500, 'inbox_failed', 'Failed to read the owner inbox.');
  }
}

/** Start one task assigned outside the app: the same steps as "Assign to agent". */
function startOutsideTask(contextRoot: string, taskSlug: string, agent: string): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const prep = prepareAssignment(contextRoot, taskSlug, agent, { source: 'dashboard' });
  if (!prep.ok) return { ok: false, status: prep.code === 'not_owner' ? 403 : 409, code: prep.code, message: prep.message };
  commitAssignment(contextRoot, prep, new Date());
  startDueTaskJobs(contextRoot);
  return { ok: true };
}

/**
 * A task job's row answered (C1): the same lib actions the CLI's `tasks agent-action` takes.
 * `complete` is the owner signing off a delivery (status by owner); `open-task` only closes the
 * row (the drawer is where the task opens).
 */
export async function answerTaskAction(contextRoot: string, task: string, action: string, text: string): Promise<ActionResult> {
  // Only the agent's owner answers its job (B1-4): a teammate's agent is read-only here.
  const head = findTaskHead(contextRoot, task);
  for (const slug of head ? [head.data.agent, head.data.reviewer] : []) {
    const agent = typeof slug === 'string' && isSafeAutomationSlug(slug) ? getAgent(contextRoot, slug) : null;
    const owner = agent ? foreignOwner({ owner: agent.owner }) : null;
    if (agent && owner) return { ok: false, code: 'not_owner', message: new NotOwnerError(owner, agent.title || agent.slug).message };
  }
  switch (action) {
    case 'start-now': return startNowAction(contextRoot, task);
    case 'reschedule': return rescheduleAction(contextRoot, task, text);
    case 'stop': return stopTaskAction(contextRoot, task);
    case 'let-finish': return letFinishAction(contextRoot, task);
    case 'continue': return continueTaskAction(contextRoot, task);
    case 'take-over': return takeOverAction(contextRoot, task);
    case 'approve-plan': return approvePlanAction(contextRoot, task);
    case 'change-plan': return changePlanAction(contextRoot, task, text);
    case 'one-more-round': return oneMoreRoundAction(contextRoot, task);
    case 'cancel': return cancelTaskAction(contextRoot, task);
    case 'send-back': return sendBackAction(contextRoot, task, text);
    case 'complete': return completeDeliveryAction(contextRoot, head?.slug ?? task);
    case 'open-task':
    case 'dismiss':
      return { ok: true };
    default:
      return { ok: false, code: 'bad_action', message: `Unknown action "${action}".` };
  }
}

/**
 * The owner signs off a delivery: only one that is delivered, behind the same close gates as the
 * board and `tasks complete` (open sub-tasks, the sleep-eval gate), and the job ends with it.
 */
async function completeDeliveryAction(contextRoot: string, slug: string): Promise<ActionResult> {
  const backend = getTaskBackend(contextRoot);
  const task = await backend.get(slug);
  if (!task) return { ok: false, code: 'unknown_task', message: 'There is no such task.' };
  if ((task.raw?.agent_state ?? null) !== 'delivered') {
    return { ok: false, code: 'not_delivered', message: 'That task has no delivery waiting for your approval.' };
  }
  const statuses = loadStatuses(contextRoot);
  const all = (await backend.list()).map((s) => ({ slug: s.name, parent_task: s.parent_task, status: s.status }));
  const open = openChildren(all, slug, statuses);
  if (open.length > 0) {
    return { ok: false, code: 'parent_has_open_children', message: `This task has ${open.length} open sub-task(s): ${open.map((t) => t.slug).join(', ')}. Close or cancel them first.` };
  }
  const parent = task.parent_task ? await backend.get(task.parent_task) : null;
  const gate = checkCloseGate(contextRoot, slug, task.parent_task ?? null, { exempt: !!(parent && isMappedWaveChild(parent, task)) });
  if (gate.applies && !gate.ok) return { ok: false, code: 'sleep_eval_gate', message: gate.message };
  await backend.complete(slug, 'The owner approved the delivery.', { by: 'owner' });
  endTaskJobIfClosed(contextRoot, slug);
  return { ok: true };
}

export async function handleAgentsInboxAction(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const action = typeof body?.action === 'string' ? body.action : '';
  const projectRoot = dirname(contextRoot);
  const row: InboxRow | undefined = listInboxRows(projectRoot).find((r) => r.id === params.id);
  if (!row) {
    sendError(res, 404, 'not_found', 'That row is no longer open.');
    return;
  }
  if (!(row.actions as string[]).includes(action)) {
    sendError(res, 400, 'bad_action', `That row takes ${row.actions.join(', ')}.`);
    return;
  }
  try {
    if (row.kind.startsWith('task-')) {
      // By the task's id: a row keeps the slug it was raised with, and a rename moves the task.
      const result = await answerTaskAction(contextRoot, taskIdOfRow(row) || row.ref, action, typeof body?.text === 'string' ? body.text : '');
      if (!result.ok) {
        sendError(res, 409, result.code, result.message);
        return;
      }
      resolveInboxRow(projectRoot, row.id);
      sendJson(res, 200, { ok: true, rows: listInboxRows(projectRoot) });
      return;
    }
    if (action === 'ignore') {
      ignoreOutsideKey(projectRoot, row.dedupeKey);
    } else if (action === 'adopt' && row.agent) {
      const agent = getAgent(contextRoot, row.agent);
      if (agent && refuseNotOwner(res, { slug: agent.slug, owner: agent.owner, title: agent.title })) return;
      adoptPattern(contextRoot, row.agent, agent?.pattern ?? '');
    } else if (action === 'start' && row.kind === 'assigned-outside' && row.agent) {
      if (row.dedupeKey.includes(':reviewer:')) {
        // A reviewer set outside the app: recorded here, and the task's job meta follows it.
        const taskId = row.dedupeKey.split(':')[1];
        recordAssignment(projectRoot, { taskId, taskSlug: row.ref, role: 'reviewer', agent: row.agent });
        patchMeta(projectRoot, taskId, { reviewer: row.agent });
      } else {
        const started = startOutsideTask(contextRoot, row.ref, row.agent);
        if (!started.ok) {
          sendError(res, started.status, started.code, started.message);
          return;
        }
      }
    } else if (action === 'start-all' && row.agent) {
      for (const slug of (row.detail ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        startOutsideTask(contextRoot, slug, row.agent);
      }
    }
    resolveInboxRow(projectRoot, row.id);
    sendJson(res, 200, { ok: true, rows: listInboxRows(projectRoot) });
  } catch (err) {
    console.error('[agents] inbox action failed', err);
    sendError(res, 500, 'inbox_action_failed', 'Failed to answer that row.');
  }
}

export async function handleAgentsBringHere(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const agent = isSafeAutomationSlug(params.slug) ? getAgent(contextRoot, params.slug) : null;
  if (!agent) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  if (refuseNotOwner(res, { slug: agent.slug, owner: agent.owner, title: agent.title })) return;
  try {
    // Its routines follow it: a run is placed by its agent's record (`placement(m.agent)`).
    const rec = writeActiveHere(contextRoot, agent.slug, agent.owner);
    pushSoon(contextRoot);
    sendJson(res, 200, { active: rec });
  } catch (err) {
    console.error('[agents] bring-here failed', err);
    sendError(res, 500, 'bring_here_failed', 'Failed to bring the agent here.');
  }
}
