import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isAgentRequest } from '../desktop.js';
import { isSameOriginStrict } from './agent-spawn-shared.js';
import { isPhoneSocket } from '../phone-origin.js';
import { superEntry } from '../../lib/super/store.js';
import { applyReadMarks, markSeen, parseReadPatch, readReadMarks } from '../../lib/super/read-marks.js';
import { querySuperId } from '../super-id-query.js';

/**
 * What the owner has read in the Super Agent's chat (lib/super/read-marks.ts). Under
 * `/api/agent/`, gated like `super-questions`, because the phone's mirror draws the same marks and
 * every `/api/super/*` route is laptop-only.
 *
 *   GET  /api/agent/super-read — the record; `{ since: null }` before its birth. No side effect.
 *   POST /api/agent/super-read — `{ read?: [{ key, ts }], seen?: true }`; answers the record.
 *        `seen` (a MEMBER's stage was read, plan r4 D7) raises its `seenAt` to now; 400 for main,
 *        whose marks are never touched by it.
 */
export async function handleSuperReadGet(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  if (!isAgentRequest(req)) { sendError(res, 403, 'forbidden', 'Available only in the desktop app or a signed-in phone.'); return; }
  const superId = querySuperId(req, res, contextRoot);
  if (!superId) return;
  try {
    sendJson(res, 200, (await readReadMarks(contextRoot, superId)) ?? { since: null, read: [] });
  } catch (err) {
    console.warn(`[super] read marks: ${(err as Error).message}`);
    sendError(res, 500, 'read_marks_failed', 'The read marks could not be read or written.');
  }
}

export async function handleSuperReadPost(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  if (!isAgentRequest(req)) { sendError(res, 403, 'forbidden', 'Available only in the desktop app or a signed-in phone.'); return; }
  if (!isPhoneSocket(req) && !isSameOriginStrict(req)) { sendError(res, 403, 'forbidden', 'Same origin only.'); return; }
  const superId = querySuperId(req, res, contextRoot);
  if (!superId) return;
  const patch = parseReadPatch(await parseJsonBody(req));
  if (!patch) { sendError(res, 400, 'bad_request', 'The body is { read?: [{ key, ts }], seen?: true }.'); return; }
  if (patch.seen && superId === 'main') { sendError(res, 400, 'bad_request', '`seen` is for a member\'s stage only.'); return; }
  // The record lives as long as the hand-over: a late write must not start a new one.
  if (!superEntry(contextRoot, superId).enabled) { sendError(res, 409, 'not_handed_over', 'The Super Agent is not handed over.'); return; }
  try {
    const now = Date.now();
    const merged = await applyReadMarks(contextRoot, { read: patch.read }, now, superId);
    sendJson(res, 200, patch.seen ? ((await markSeen(contextRoot, superId, now)) ?? merged) : merged);
  } catch (err) {
    console.warn(`[super] read marks: ${(err as Error).message}`);
    sendError(res, 500, 'read_marks_failed', 'The read marks could not be read or written.');
  }
}
