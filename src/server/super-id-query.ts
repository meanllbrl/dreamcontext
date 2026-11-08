import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './middleware.js';
import { memberCallState } from '../lib/agents/team-roster.js';
import { memberOfSuperId, parseSuperId } from '../lib/super/store.js';
import type { SuperId } from '../lib/super/types.js';

/**
 * Which super a Super route acts on, from its query (plan-r10 1; the window adds
 * `?superId=m%3A<slug>` for a member's Super, nothing for main's): absent = main, exactly as
 * before; malformed 400; a member this project has no manifest of 404. Sends the refusal; null =
 * refused. The route's own guard (owner window, phone) stays what it was.
 */
export function querySuperId(req: IncomingMessage, res: ServerResponse, contextRoot: string): SuperId | null {
  let raw: string | null = null;
  try { raw = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('superId'); } catch { raw = null; }
  const id = parseSuperId(raw ?? undefined);
  if (id === null) { sendError(res, 400, 'invalid_super', 'superId is `main` or `m:<member slug>`'); return null; }
  const slug = memberOfSuperId(id);
  if (slug) {
    let known = false;
    try { known = memberCallState(contextRoot, slug).state !== 'missing'; } catch { known = false; }
    if (!known) { sendError(res, 404, 'unknown_member', `no AI Team member "${slug}" in this project`); return null; }
  }
  return id;
}
