import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './middleware.js';
import { isSameOriginStrict } from './routes/agent-spawn-shared.js';

/**
 * Did this request come from the app's own page? A browser page always sends `Origin` on a
 * write, and `isSameOriginStrict` holds it to this server's host and port (a page on another
 * port, a rebinding name, a cross-site fetch all fail). A bare client, an agent's `curl`, a
 * Claude session's script, sends none and is refused.
 *
 * What it is, said plainly: the guard that makes an agent's ATTEMPT to approve its own work fail,
 * the way `refuseSelfApproval` does for the CLI. Not a boundary against a process that forges
 * the header on purpose (the same OS user can also write the registry file); the shell's owner
 * key (owner-key.ts) is the stronger proof, held by the owner's own windows (notch, Launcher,
 * project windows; desktop/src-tauri/src/owner_key.rs).
 */
export function carriesOwnOrigin(req: IncomingMessage): boolean {
  return typeof req.headers.origin === 'string' && isSameOriginStrict(req);
}

/** The refusal every owner-only decision route sends. Returns true when it refused. */
export function refuseUnlessOwnerPage(req: IncomingMessage, res: ServerResponse, what: string): boolean {
  if (carriesOwnOrigin(req)) return false;
  sendError(res, 403, 'owner_page_only', `Only the owner, in the app, ${what}. An agent or a script cannot.`);
  return true;
}
