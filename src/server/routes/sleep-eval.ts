import type { IncomingMessage, ServerResponse } from 'node:http';
import { readEvalSet } from '../../lib/sleep-eval/fixtures.js';
import { LabelError, labelCards, labelQueue, recordLabel } from '../../lib/sleep-eval/labels.js';
import { FEEDBACK_REASONS } from '../../lib/sleep-eval/types.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';

/**
 * The labelling deck behind the Tasks screen: the sleep-eval items still waiting for the
 * owner's verdict, and the verdict itself. Local-only data (tmp/sleep-eval/), read and
 * written through the same functions the CLI uses.
 */

/** GET /api/sleep-eval/labels — `{ active, total, labelled, pending[], reasons[] }`. */
export async function handleSleepEvalLabelsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!readEvalSet(contextRoot)) {
    sendJson(res, 200, { active: false, total: 0, labelled: 0, required: { total: 0, labelled: 0 }, pending: [], reasons: FEEDBACK_REASONS });
    return;
  }
  const q = labelQueue(contextRoot);
  sendJson(res, 200, { active: true, total: q.total, labelled: q.labelled, required: q.required, pending: labelCards(contextRoot, q.pending), reasons: FEEDBACK_REASONS });
}

/** POST /api/sleep-eval/labels — `{ id, verdict: keep|reject, reason?, note?, name?, why? }`. */
export async function handleSleepEvalLabelsPost(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Invalid JSON body');
    return;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  try {
    const entry = recordLabel(contextRoot, {
      id: str(body.id) ?? '',
      verdict: body.verdict === 'keep' || body.verdict === 'reject' ? body.verdict : undefined,
      outcome: str(body.outcome) ?? null,
      reason: str(body.reason) ?? null,
      note: str(body.note),
      name: str(body.name),
      why: str(body.why),
    });
    const q = labelQueue(contextRoot);
    sendJson(res, 200, { entry, total: q.total, labelled: q.labelled, required: q.required });
  } catch (e) {
    sendError(res, e instanceof LabelError ? 400 : 500, e instanceof LabelError ? 'invalid_label' : 'label_failed', (e as Error).message);
  }
}
