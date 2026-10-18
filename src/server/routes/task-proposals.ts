import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadStatuses } from '../../lib/overrides.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { isSafeTaskSlug } from '../../lib/task-backend/local.js';
import {
  FEEDBACK_REASONS,
  isFeedbackReason,
  readFeedback,
  reasonLabel,
  weeklyAcceptance,
} from '../../lib/task-feedback.js';
import { loadTaskBriefs } from '../../lib/task-parent.js';
import {
  acceptProposal,
  filingBrake,
  keepFiled,
  pendingProposals,
  ProposalError,
  readProposals,
  rejectFiled,
  rejectProposal,
  taskOnBoard,
  waitingCount,
  waitingFiled,
} from '../../lib/task-proposals.js';
import { recentRuleChanges, readRules, revertRule, RuleError } from '../../lib/task-filing-rules.js';
import { applySuggestion, BacklogError, keepAsIs, waitingSuggestions } from '../../lib/backlog-migration.js';
import { recordDashboardChange } from '../change-tracker.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';

/**
 * The Proposals section of the Tasks screen (owner decision 8).
 *
 * Proposals live HERE, not in a chat or the snapshot: sleep often runs in the
 * background with nobody in a session. This is the owner's path, so accept does
 * not run `refuseSelfApproval` (E9: the server may itself run inside a Claude
 * session; every accept and reject is a journal / feedback entry instead).
 */

const PROPOSAL_ID = /^tp_[A-Za-z0-9_-]{1,40}$/;

const ERROR_STATUS: Record<ProposalError['code'], number> = {
  not_found: 404,
  resolved: 409,
  exists: 409,
  invalid: 400,
  no_cancel_status: 409,
  corrupt: 500,
};

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof ProposalError) {
    sendError(res, ERROR_STATUS[err.code], err.code, err.message);
    return;
  }
  console.error('[task-proposals]', err);
  sendError(res, 500, 'write_failed', 'Could not record the decision.');
}

/** GET /api/task-proposals — everything the section draws, in one read. */
export async function handleTaskProposalsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const store = readProposals(contextRoot);
  const briefs = new Map(loadTaskBriefs(join(contextRoot, 'state')).map((b) => [b.slug, b]));
  const nameOf = (slug: string | null): string | null => (slug ? briefs.get(slug)?.name ?? null : null);
  // A task that left the board some other way (deleted, renamed away) is neither
  // shown nor counted: the badge and the list use the same predicate.
  const onBoard = taskOnBoard(contextRoot);
  // The task migration's uncertain changes wait in the same section (they are
  // not sleep's filings, so they never touch the brake or the feedback store).
  const changes = waitingSuggestions(contextRoot);
  sendJson(res, 200, {
    waiting: waitingCount(store, onBoard) + changes.length,
    changes,
    proposals: pendingProposals(store).map((p) => ({ ...p, parentName: nameOf(p.parent) })),
    filed: waitingFiled(store, onBoard)
      .map((f) => ({ ...f, status: briefs.get(f.slug)?.status ?? null, parentName: nameOf(f.parent) })),
    brake: filingBrake(store),
    trend: weeklyAcceptance(readFeedback(contextRoot)),
    reasons: FEEDBACK_REASONS.map((key) => ({ key, label: reasonLabel(key) })),
    ruleCount: readRules(contextRoot).length,
    rules: recentRuleChanges(contextRoot).map((c) => ({
      id: c.id,
      title: c.title,
      action: c.action,
      by: c.by,
      at: c.at,
      restsOn: (c.after ?? c.before)?.restsOn.length ?? 0,
      removed: c.after === null,
    })),
  });
}

const RULE_ID = /^R\d{1,4}$/;

/**
 * POST /api/task-filing-rules/:id/revert — { at } — the owner undoes the latest
 * change to one rule. `at` is the change the owner saw; a newer one refuses (409),
 * so a double tap never undoes its own revert.
 */
export async function handleTaskFilingRuleRevert(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { id } = params;
  if (!RULE_ID.test(id)) { sendError(res, 400, 'invalid', `Invalid rule id: ${id}`); return; }
  const at = str(((await parseJsonBody(req)) ?? {}).at);
  if (!at || at.length > 40) { sendError(res, 400, 'invalid', 'at (the change being reverted) is required.'); return; }
  try {
    const restored = revertRule(contextRoot, id, 'owner', at);
    recordDashboardChange(contextRoot, {
      entity: 'knowledge',
      action: 'update',
      target: 'knowledge/patterns/task-filing-rules.md',
      summary: `Reverted task-filing rule ${id}`,
    });
    sendJson(res, 200, { id, restored: restored ? { title: restored.title } : null });
  } catch (err) {
    if (err instanceof RuleError) { sendError(res, 409, 'invalid', err.message); return; }
    fail(res, err);
  }
}

/** GET /api/task-proposals/count — the sidebar badge (no bodies). */
export async function handleTaskProposalsCount(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { waiting: waitingCount(readProposals(contextRoot), taskOnBoard(contextRoot)) + waitingSuggestions(contextRoot).length });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** POST /api/task-proposals/:id/accept — { name?, why?, parent?: string | null } */
export async function handleTaskProposalAccept(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { id } = params;
  if (!PROPOSAL_ID.test(id)) { sendError(res, 400, 'invalid', `Invalid proposal id: ${id}`); return; }
  const body = (await parseJsonBody(req)) ?? {};
  const parent = body.parent === null ? null : str(body.parent);
  if (typeof parent === 'string' && !isSafeTaskSlug(parent)) { sendError(res, 400, 'invalid', 'Invalid parent slug.'); return; }
  try {
    const r = await acceptProposal(
      contextRoot,
      getTaskBackend(contextRoot),
      loadStatuses(contextRoot),
      id,
      { name: str(body.name), why: str(body.why), parent },
      'dashboard',
    );
    recordDashboardChange(contextRoot, {
      entity: 'task',
      action: 'create',
      target: r.slug,
      summary: `Accepted sleep's proposal ${id} into the Next queue`,
    });
    sendJson(res, 200, r);
  } catch (err) {
    fail(res, err);
  }
}

function rejectInput(body: Record<string, unknown>): { reason: (typeof FEEDBACK_REASONS)[number]; note?: string } | null {
  if (!isFeedbackReason(body.reason)) return null;
  const note = str(body.note)?.slice(0, 2000);
  return { reason: body.reason, ...(note ? { note } : {}) };
}

/** POST /api/task-proposals/:id/reject — { reason, note? } */
export async function handleTaskProposalReject(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { id } = params;
  if (!PROPOSAL_ID.test(id)) { sendError(res, 400, 'invalid', `Invalid proposal id: ${id}`); return; }
  const input = rejectInput((await parseJsonBody(req)) ?? {});
  if (!input) { sendError(res, 400, 'invalid', `reason must be one of: ${FEEDBACK_REASONS.join(', ')}`); return; }
  try {
    const p = rejectProposal(contextRoot, id, input);
    sendJson(res, 200, { id: p.id, status: p.status });
  } catch (err) {
    fail(res, err);
  }
}

/** POST /api/task-proposals/filed/:slug/reject — { reason, note? } */
export async function handleFiledTaskReject(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid', `Invalid task slug: ${slug}`); return; }
  const input = rejectInput((await parseJsonBody(req)) ?? {});
  if (!input) { sendError(res, 400, 'invalid', `reason must be one of: ${FEEDBACK_REASONS.join(', ')}`); return; }
  try {
    const f = await rejectFiled(contextRoot, getTaskBackend(contextRoot), loadStatuses(contextRoot), slug, input);
    recordDashboardChange(contextRoot, {
      entity: 'task',
      action: 'update',
      target: slug,
      field: 'status',
      summary: `Rejected a task sleep opened (${reasonLabel(input.reason)})`,
    });
    sendJson(res, 200, { slug: f.slug, outcome: f.outcome });
  } catch (err) {
    fail(res, err);
  }
}

/** POST /api/task-proposals/filed/:slug/keep */
export async function handleFiledTaskKeep(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid', `Invalid task slug: ${slug}`); return; }
  try {
    const f = keepFiled(contextRoot, slug);
    sendJson(res, 200, { slug: f.slug, outcome: f.outcome });
  } catch (err) {
    fail(res, err);
  }
}

// ─── The task migration's suggestions ────────────────────────────────────────

const SUGGESTION_ID = /^bs_[A-Za-z0-9_-]{1,40}$/;

const BACKLOG_STATUS: Record<BacklogError['code'], number> = {
  no_store: 404,
  not_found: 404,
  corrupt: 500,
  not_open: 409,
  invalid: 400,
  decided: 409,
  no_cancel_status: 409,
  has_children: 409,
  stale: 409,
};

function suggestionTarget(params: Record<string, string>, body: Record<string, unknown>, res: ServerResponse): { slug: string; id: string } | null {
  const { slug } = params;
  const id = str(body.id);
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid', 'Invalid task slug.'); return null; }
  if (!id || !SUGGESTION_ID.test(id)) { sendError(res, 400, 'invalid', 'id (the suggestion being answered) is required.'); return null; }
  return { slug, id };
}

function failBacklog(res: ServerResponse, err: unknown): void {
  if (err instanceof BacklogError) {
    sendError(res, BACKLOG_STATUS[err.code], err.code, err.message);
    return;
  }
  console.error('[task-proposals:changes]', err);
  sendError(res, 500, 'write_failed', 'Could not record the decision.');
}

/** The owner applies a reorganisation the task migration was not sure about. */
export async function handleTaskChangeApply(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const target = suggestionTarget(params, (await parseJsonBody(req)) ?? {}, res);
  if (!target) return;
  try {
    const rec = await applySuggestion(contextRoot, getTaskBackend(contextRoot), target.slug, target.id);
    recordDashboardChange(contextRoot, {
      entity: 'task',
      action: 'update',
      target: target.slug,
      summary: `Applied the task migration's suggestion (${rec.suggestion?.change ?? rec.outcome})`,
    });
    sendJson(res, 200, { slug: target.slug, outcome: rec.outcome, into: rec.into ?? null });
  } catch (err) {
    failBacklog(res, err);
  }
}

/** The owner keeps the task as it is: the suggestion is answered, the card is untouched. */
export async function handleTaskChangeKeep(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const target = suggestionTarget(params, (await parseJsonBody(req)) ?? {}, res);
  if (!target) return;
  try {
    keepAsIs(contextRoot, target.slug, target.id);
    sendJson(res, 200, { slug: target.slug, outcome: 'keep' });
  } catch (err) {
    failBacklog(res, err);
  }
}
