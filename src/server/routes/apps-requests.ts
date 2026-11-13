/**
 * An agent's request for an app action (app-onay-karti plan r3, C3). Any local agent may ASK; only
 * the owner decides (the notch's owner-key decide route, or a paired Telegram tap). Every route
 * here is the desktop app's on this Mac (`requireLocalDesktop` first) and registered before the
 * `:slug` routes.
 *
 *   POST /api/apps/requests            build the action plan, open the card
 *   GET  /api/apps/requests/:id        its state; after Onayla the grant and the exact command
 *   GET  /api/apps/requests/:id/logo   a logo card's snapshotted bytes (by the card's proposal id)
 *
 * Headers: `x-dc-agent-session` names the requester's chat, for the "[app onayı]" line only
 * (delivery, never authority); `x-dc-run` can only narrow (an app's own assistant: its own app,
 * its own folder, no install).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { requireLocalDesktop } from './agent-spawn-shared.js';
import { holdOpen } from '../hold-open.js';
import { appsHomeDir, findAppFor, projectRootOf } from './apps.js';
import { listVaults } from '../../lib/vaults.js';
import { RUN_HEADER } from '../../lib/apps/call-claim.js';
import { LogoError } from '../../lib/apps/app-logo.js';
import { HostError, resolveAppHost } from '../../lib/apps/share/host.js';
import { PublishError } from '../../lib/apps/share/publish.js';
import { InstallError } from '../../lib/apps/share/install.js';
import { AppRequestError, appRequestByProposal, appRequestLogo, appRequestStatus, claimAppRequestReceipt, markAppRequestShown, openAppRequest, waitAppRequest, type CardSurface } from '../../lib/apps/share/app-request.js';
import { buildInstallPlan, buildInviteInstallPlan, buildLogoPlan, buildPublishPlan, buildUpdatePlan, type BuiltPlan } from '../../lib/apps/share/app-plan.js';
import { parseAppRepoRef } from '../../lib/apps/share/host.js';
import { listShared } from '../../lib/apps/share/shared.js';
import { realPath } from '../../lib/real-path.js';

type Params = Record<string, string>;

export const AGENT_SESSION_HEADER = 'x-dc-agent-session';
export const TAB_SESSION_HEADER = 'x-dc-tab-session';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{20,40}$/;
const PROPOSAL_ID = /^[0-9a-f-]{36}$/;

function realRoot(p: string): string {
  try { return realPath(p); } catch { return p; }
}

/** The app an app's own assistant may ask for, from its `x-dc-run` claim (narrowing only). */
export function claimedApp(req: IncomingMessage): string | null {
  const raw = req.headers[RUN_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  try {
    const app = (JSON.parse(v) as { app?: unknown }).app;
    return typeof app === 'string' && app ? app : null;
  } catch {
    return null;
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const v = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  return v && SAFE_ID.test(v) && v !== '.' && v !== '..' ? v : null;
}

const strings = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);

function fail(res: ServerResponse, e: unknown): void {
  if (e instanceof AppRequestError) { sendError(res, e.code === 'too_many' || e.code === 'cooldown' ? 429 : e.code === 'bad_logo' ? 400 : 409, e.code, e.message); return; }
  if (e instanceof LogoError) { sendError(res, 400, 'bad_logo', e.message); return; }
  if (e instanceof PublishError) { sendJson(res, 409, { error: e.code, message: e.message, ...(e.report ? { report: e.report } : {}) }); return; }
  if (e instanceof InstallError) { sendJson(res, 409, { error: e.code, message: e.message }); return; }
  if (e instanceof HostError) { sendError(res, e.code === 'not_signed_in' ? 401 : e.code === 'rate_limited' ? 429 : 409, e.code, e.message); return; }
  sendError(res, 500, 'request_failed', (e as Error)?.message ?? String(e));
}

/** POST /api/apps/requests {action, slug|ref, ...input, logoPath?} */
export async function handleAppRequestCreate(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const b = (await parseJsonBody(req)) ?? {};
  const action = b.action;
  if (action !== 'publish' && action !== 'update' && action !== 'install' && action !== 'logo') { sendError(res, 400, 'bad_action', 'action must be publish, update, install or logo.'); return; }
  const ownApp = claimedApp(req);
  if (ownApp && action === 'install') { sendError(res, 403, 'not_for_app_assistant', 'An app\'s own assistant cannot ask to install another app.'); return; }
  const home = appsHomeDir();
  const agentSessions = [header(req, TAB_SESSION_HEADER), header(req, AGENT_SESSION_HEADER)].filter((x): x is string => !!x);
  try {
    let built: BuiltPlan;
    if (action === 'install') {
      const projectRoot = realRoot(projectRootOf(contextRoot));
      const vault = listVaults(home).find((v) => realRoot(v.path) === projectRoot)?.name;
      if (!vault) { sendError(res, 409, 'no_vault', 'This project is not registered.'); return; }
      const config = b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? (b.config as Record<string, unknown>) : {};
      // K2: a repo with a pending invitation for this account installs from the invitation (the
      // one card both accepts and installs); every other repo is previewed and bound to its sha.
      const host = resolveAppHost(home);
      const fullName = parseAppRepoRef(String(b.ref ?? ''));
      const inv = fullName && host.signedIn
        ? (await listShared(host, { projectRoot, home }).catch(() => null))?.invitations.find((i) => i.fullName.toLowerCase() === fullName.toLowerCase()) ?? null
        : null;
      built = inv
        ? await buildInviteInstallPlan({ home, vault, contextRoot, projectRoot, host }, inv, { config })
        : await buildInstallPlan({ home, vault, contextRoot, projectRoot }, String(b.ref ?? ''), { config });
    } else {
      const slug = typeof b.slug === 'string' ? b.slug : '';
      if (ownApp && slug !== ownApp) { sendError(res, 403, 'not_your_app', 'An app\'s own assistant asks for its own app only.'); return; }
      const rec = findAppFor(contextRoot, slug, res);
      if (!rec) return;
      const ctx = { home, vault: rec.vault, contextRoot };
      if (action === 'publish') {
        built = await buildPublishPlan({ ...ctx, host: resolveAppHost(home) }, rec, {
          public: b.public === true, invite: strings(b.invite, 20), approve: strings(b.approve),
          note: typeof b.note === 'string' ? b.note : undefined,
          catalog: b.catalog === false ? false : b.catalog === true ? true : undefined,
        });
      } else if (action === 'update') {
        built = await buildUpdatePlan(ctx, rec, { how: b.how === 'merge' || b.how === 'set-aside' ? b.how : undefined });
      } else {
        built = buildLogoPlan(ctx, rec, typeof b.logoPath === 'string' ? b.logoPath : '', { ownAppOnly: !!ownApp });
      }
    }
    // Every install, publish, update and logo is his tap on its card (owner 2026-11-13: words he
    // typed in the chat do not count; the card sits in that chat, one tap). Any `ownerSaid` field
    // an older agent sends is ignored.
    const out = openAppRequest({ plan: built.plan, stillFresh: built.stillFresh, logo: built.logo ?? null, agentSessions });
    sendJson(res, 200, { request: out.id, state: out.state, renewal: out.renewal, proposal: out.proposalId });
  } catch (e) { fail(res, e); }
}

/** GET /api/apps/requests/:id?wait=<0..110> */
export async function handleAppRequestStatus(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const id = params.id ?? '';
  if (!REQUEST_ID.test(id)) { sendJson(res, 200, { state: 'unknown' }); return; }
  const wait = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('wait') ?? 0);
  if (wait > 0) await waitAppRequest(id, wait);
  if (res.writableEnded || res.destroyed) return;
  sendJson(res, 200, appRequestStatus(id));
}

/** GET /api/apps/requests/:id/logo?vault=<v> (`:id` = the card's proposal id). */
export async function handleAppRequestLogo(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const id = params.id ?? '';
  const hit = PROPOSAL_ID.test(id) ? appRequestLogo(id) : null;
  if (!hit) { sendError(res, 404, 'no_logo', 'No such logo card.'); return; }
  res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(hit.data);
}

const SURFACES: readonly CardSurface[] = ['chat', 'notch'];

/** GET /api/apps/requests/card/:proposal: the chat card's plan and state (the notch reads the same plan). */
export async function handleAppRequestCard(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const id = params.proposal ?? '';
  const hit = PROPOSAL_ID.test(id) ? appRequestByProposal(id) : null;
  if (!hit) { sendError(res, 404, 'no_card', 'No such app request card.'); return; }
  sendJson(res, 200, { state: hit.state, card: hit.view, ...(hit.failed ? { failed: hit.failed } : {}), ...(hit.stopped ? { stopped: hit.stopped } : {}), ...(hit.receiptOwed ? { receiptOwed: true } : {}) });
}

/**
 * POST /api/apps/requests/card/:proposal/receipt (K4): the owner said yes but the "[app onayı]"
 * line never reached the asking chat (no notch to relay it). The chat card drawing this request
 * claims the receipt ONCE and posts the line into its own chat; a second claim is 409. The line
 * carries no grant (S6), only `apps grant <request>`.
 */
export async function handleAppRequestReceipt(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const id = params.proposal ?? '';
  if (!PROPOSAL_ID.test(id)) { sendError(res, 400, 'bad_request', 'A card id.'); return; }
  const out = claimAppRequestReceipt(id);
  if ('line' in out) { sendJson(res, 200, { line: out.line }); return; }
  sendError(res, out.error === 'unknown' ? 404 : 409, out.error, out.error === 'claimed' ? 'Another card already posted this receipt.' : 'Nothing to post: the line already reached the chat, or the request is not approved.');
}

/**
 * POST /api/apps/requests/card/:proposal/shown {where: chat|notch}: a surface DREW the card
 * (ek-4). A display fact for the agent's "the card is on your screen", never authority.
 */
export async function handleAppRequestShown(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const id = params.proposal ?? '';
  const where = SURFACES.find((s) => s === b.where);
  if (!PROPOSAL_ID.test(id) || !where) { sendError(res, 400, 'bad_request', 'A card id and where it is drawn (chat or notch).'); return; }
  sendJson(res, 200, { ok: markAppRequestShown({ proposalId: id }, where) });
}
