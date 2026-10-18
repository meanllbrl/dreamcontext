import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadStatuses } from '../../lib/overrides.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';
import { AuditError, listAudit, markAuditSeen, type AuditEntry } from '../../lib/task-audit.js';
import { listTaskCards } from '../../lib/task-list.js';
import { isReview } from '../../lib/task-status.js';
import { LearnError, listLearnedItems, revertItem } from '../../lib/learned-patterns.js';
import { RuleError } from '../../lib/task-filing-rules.js';
import type { TaskListItem } from '../../lib/task-backend/types.js';
import { recordDashboardChange } from '../change-tracker.js';
import { parseJsonBody, requireBrowserOrigin, sendError, sendJson, writeVia } from '../middleware.js';
import { buildProposalsPayload, proposalsWaiting } from './task-proposals.js';

/**
 * The Inbox (C5; plan r3 § W4): everything that waits for the owner or that the owner
 * should see, in one read.
 *
 *   proposals  sleep's proposals and the task migration's change cards (C4/C6)
 *   reviews    tasks in a review-kind status (the verdict is the owner's)
 *   records    approvals, send-backs, accepts, applies, forces and exemptions of the
 *              last 30 days, with who and through what (`via`): the detective control
 *              E9 rests on
 *   flags      parents a sync held open because their sub-tasks are open (unseen)
 *   learned    what sleep learned in the last 14 days, revertable
 *
 * The badge counts what needs the owner: the C4 count, reviews that are FULLY
 * evidenced (an unfinished one is listed but would make a permanent badge), and
 * unseen flags.
 */

const RECORD_KINDS = ['approval', 'send_back', 'accept', 'apply', 'force', 'exempt'] as const;
const RECORD_DAYS = 30;
const LEARNED_DAYS = 14;

function reviews(contextRoot: string): TaskListItem[] {
  const defs = loadStatuses(contextRoot);
  return listTaskCards(join(contextRoot, 'state'), defs).filter((t) => isReview(defs, t.status));
}

/** A review the owner can decide right now: every criterion ticked (with evidence, by the gate). */
export function fullyEvidenced(t: TaskListItem): boolean {
  return t.criteria.total > 0 && t.criteria.done === t.criteria.total;
}

function flags(contextRoot: string): AuditEntry[] {
  return listAudit(contextRoot, { kinds: ['held_open'], unseenOnly: true });
}

/** The Inbox badge: C4's count + fully evidenced reviews + unseen held-open flags. */
export function inboxWaiting(contextRoot: string): number {
  return proposalsWaiting(contextRoot) + reviews(contextRoot).filter(fullyEvidenced).length + flags(contextRoot).length;
}

/** GET /api/inbox */
export async function handleInbox(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const since = new Date(Date.now() - LEARNED_DAYS * 86_400_000).toISOString();
  sendJson(res, 200, {
    proposals: buildProposalsPayload(contextRoot),
    reviews: reviews(contextRoot),
    records: listAudit(contextRoot, { kinds: RECORD_KINDS, sinceDays: RECORD_DAYS }),
    flags: flags(contextRoot),
    learned: listLearnedItems(contextRoot, { since }),
  });
}

/** GET /api/inbox/count — the sidebar badge. */
export async function handleInboxCount(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { waiting: inboxWaiting(contextRoot) });
}

function actorOf(contextRoot: string): string {
  try {
    return resolveActivePerson(contextRoot).slug ?? 'owner';
  } catch {
    return 'owner';
  }
}

const AUDIT_ID = /^ta_[A-Za-z0-9_-]{1,40}$/;

/** POST /api/inbox/seen — { id }: mark one record seen (who and through what are kept on it). */
export async function handleInboxSeen(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!requireBrowserOrigin(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const id = typeof body.id === 'string' ? body.id : '';
  if (!AUDIT_ID.test(id)) { sendError(res, 400, 'invalid', 'id (an audit record, ta_…) is required.'); return; }
  try {
    const entry = markAuditSeen(contextRoot, id, actorOf(contextRoot), writeVia(req));
    sendJson(res, 200, { entry });
  } catch (err) {
    if (err instanceof AuditError) { sendError(res, 404, 'not_found', err.message); return; }
    throw err;
  }
}

const LEARNED_ID = /^(lp_[A-Za-z0-9_-]{1,40}|R\d{1,4}@[0-9T:.Z-]{10,40})$/;

/** POST /api/learned/:id/revert — { expectAt? }: the owner undoes something sleep learned. */
export async function handleLearnedRevert(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!requireBrowserOrigin(req, res)) return;
  const { id } = params;
  if (!LEARNED_ID.test(id)) { sendError(res, 400, 'invalid', `Invalid learned item id: ${id}`); return; }
  const body = (await parseJsonBody(req)) ?? {};
  const expectAt = typeof body.expectAt === 'string' && body.expectAt.length <= 40 ? body.expectAt : undefined;
  try {
    const item = revertItem(contextRoot, id, 'owner', expectAt);
    recordDashboardChange(contextRoot, {
      entity: 'knowledge',
      action: 'update',
      target: `knowledge/patterns/${item.pattern}.md`,
      summary: `Reverted a learned change (${id})`,
    });
    sendJson(res, 200, { item });
  } catch (err) {
    if (err instanceof LearnError || err instanceof RuleError) { sendError(res, 409, 'not_reverted', err.message); return; }
    throw err;
  }
}
