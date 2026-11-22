/**
 * Live-link owner routes (plan C4, D8).
 *
 *  - `POST /api/shares` `{kind, vault, slug, password?, ai?}`: the owner's own page only (the
 *    shell's key, `fromOwnerPage`): a public link is outward-facing. Answers at once with
 *    `{id, state}`; the start runs in the background (D9 reserves synchronously).
 *  - `GET /api/shares`: this Mac's desktop app; never the link, token or password, for anyone.
 *  - `POST /api/shares/:id/reveal`: the owner's own page only: `{link, password?}` of an open share.
 *  - `POST /api/shares/:id/close`: this Mac (an agent's or the CLI's call too): closing only
 *    narrows exposure.
 *
 * Over any tunnel the main listener's `cf-*` backstop refuses all four; the phone's route policy
 * denies them; an app's gateway denies `/api/shares` for everyone (page-routes.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { requireLocalDesktop } from './agent-spawn-shared.js';
import { fromOwnerPage, ownerRefusalMessage } from './assistant.js';
import type { Router } from '../router.js';
import { closeAllShares, closeShare, getShare, listShares, openShare, publicShare, revealShare, ShareError } from '../shares/registry.js';
import '../shares/listener.js';
import { listVaults } from '../../lib/vaults.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';

function noStore(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
}

function ownerOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (fromOwnerPage(req)) return true;
  sendError(res, 403, 'owner_page_only', ownerRefusalMessage(req, 'Only the owner\'s own page can open a live link or read it back (a click in the dreamcontext app).'));
  return false;
}

/** The owner's first name for the guest's password page ("Mehmet bu app'i seninle paylaştı"). */
function ownerFirstName(vault: string): string | null {
  try {
    const v = listVaults().find((x) => x.name === vault);
    if (!v) return null;
    const name = resolveActivePerson(join(v.path, '_dream_context')).name;
    const first = typeof name === 'string' ? name.trim().split(/\s+/)[0] : '';
    return first ? first.slice(0, 40) : null;
  } catch { return null; }
}

export async function handleShareCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  noStore(res);
  if (!ownerOnly(req, res)) { req.resume(); return; }
  const b = await parseJsonBody(req);
  if (!b) { sendError(res, 400, 'bad_body', 'A JSON body is required.'); return; }
  try {
    const vault = typeof b.vault === 'string' ? b.vault : '';
    const { share, existing } = openShare({
      kind: String(b.kind ?? ''), vault, slug: typeof b.slug === 'string' ? b.slug : '',
      password: typeof b.password === 'string' ? b.password : null, ai: b.ai === true,
      ownerName: ownerFirstName(vault),
    });
    sendJson(res, existing ? 200 : 201, { ...publicShare(share), existing });
  } catch (e) {
    if (e instanceof ShareError) { sendError(res, e.status, e.code, e.message); return; }
    throw e;
  }
}

export async function handleShareList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  noStore(res);
  if (!requireLocalDesktop(req, res)) return;
  sendJson(res, 200, { shares: listShares() });
}

export async function handleShareReveal(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  noStore(res);
  if (!ownerOnly(req, res)) { req.resume(); return; }
  req.resume();
  const out = revealShare(params.id ?? '');
  if (!out) { sendError(res, 404, 'not_open', 'This live link is not open.'); return; }
  sendJson(res, 200, out);
}

export async function handleShareClose(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  noStore(res);
  if (!requireLocalDesktop(req, res)) { req.resume(); return; }
  const b = await parseJsonBody(req).catch(() => null);
  const reason = b?.via === 'cli' ? 'cli' : 'owner';
  const id = params.id ?? '';
  if (id === 'all') {
    await closeAllShares(reason);
    sendJson(res, 200, { ok: true, shares: listShares() });
    return;
  }
  if (!getShare(id)) { sendError(res, 404, 'not_found', 'No such live link.'); return; }
  await closeShare(id, reason);
  const s = getShare(id);
  sendJson(res, 200, { ok: true, ...(s ? { share: publicShare(s) } : {}) });
}

export function registerShareRoutes(router: Router): void {
  router.get('/api/shares', handleShareList);
  router.post('/api/shares', handleShareCreate);
  router.post('/api/shares/:id/reveal', handleShareReveal);
  router.post('/api/shares/:id/close', handleShareClose);
}
