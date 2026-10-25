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
import { commitAssignment, consumeAssignmentStart, prepareAssignment } from '../../lib/agents/task-assignment.js';
import { startAutomationJob } from '../automation-job.js';

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
    sendJson(res, 200, { rows: listInboxRows(dirname(contextRoot)) });
  } catch {
    sendError(res, 500, 'inbox_failed', 'Failed to read the owner inbox.');
  }
}

/** Start one task assigned outside the app: the same steps as "Assign to agent". */
function startOutsideTask(contextRoot: string, taskSlug: string, agent: string): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const prep = prepareAssignment(contextRoot, taskSlug, agent, { source: 'dashboard' });
  if (!prep.ok) return { ok: false, status: prep.code === 'not_owner' ? 403 : 409, code: prep.code, message: prep.message };
  const fireAt = new Date();
  commitAssignment(contextRoot, prep, fireAt);
  if (!consumeAssignmentStart(contextRoot, prep)) return { ok: false, status: 409, code: 'not_armed', message: 'That start was not armed on this machine.' };
  startAutomationJob(contextRoot, prep.target.slug, { text: '', fireAt, task: { slug: prep.task.slug, name: prep.task.name }, target: 'agent' });
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
    if (action === 'ignore') {
      ignoreOutsideKey(projectRoot, row.dedupeKey);
    } else if (action === 'adopt' && row.agent) {
      const agent = getAgent(contextRoot, row.agent);
      if (agent && refuseNotOwner(res, { slug: agent.slug, owner: agent.owner, title: agent.title })) return;
      adoptPattern(contextRoot, row.agent, agent?.pattern ?? '');
    } else if (action === 'start' && row.kind === 'assigned-outside' && row.agent) {
      if (row.dedupeKey.includes(':reviewer:')) {
        // The reviewer step itself arrives with wave C1: today "Start" records the assignment here.
        const taskId = row.dedupeKey.split(':')[1];
        recordAssignment(projectRoot, { taskId, taskSlug: row.ref, role: 'reviewer', agent: row.agent });
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
