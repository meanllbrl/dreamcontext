/**
 * Telegram binding routes (plan "Binding routes", A1, B4, C4, Z1, AA1, AB; W3 route proposal).
 *
 * Page-called, vault-scoped (`/api/telegram…`): the desktop page's own headers (loopback, the
 * server's own Origin, `Sec-Fetch-Site: same-origin`), NO owner key: a bind started here only
 * ever creates a PENDING pairing that never serves.
 *
 * Rust-called, vault-agnostic (`/api/telegram-pairing/…`, `/api/telegram-manager/…`): the
 * confirm requires the owner key the shell holds (`fromOwnerPage`), and acts on the vault the
 * pairing was minted in, never on a header. A pairing whose vault is gone answers 410.
 *
 * Every row is `deny(SECRET)` on the hands-free phone (route-policy.ts). No CLI verb binds.
 * GET never returns a token or a payload.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isLoopback } from './agent-spawn-shared.js';
import { carriesOwnOrigin } from '../owner-page.js';
import { fromOwnerPage } from './assistant.js';
import { hasOwnerKey } from '../owner-key.js';
import { HubError, MANAGER_PAIRING_TARGET, telegramHub, type TelegramHub } from '../telegram/hub.js';
import { isValidTarget, scopeOfContextRoot } from '../../lib/telegram/config.js';
import { PAIRING_ID_RE, TELEGRAM_TARGET_RE, type TelegramStatusRow } from '../../lib/telegram/contract.js';
import { memberScope } from '../../lib/agents/scope.js';
import type { Router } from '../router.js';

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;

/** The desktop page's own request: loopback, own Origin, a browser's same-origin word. No key. */
export function fromPageHeaders(req: IncomingMessage): boolean {
  return isDesktop() && isLoopback(req) && carriesOwnOrigin(req)
    && String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase() === 'same-origin';
}

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  sendError(res, status, code, message);
}

function hubOr(res: ServerResponse): TelegramHub | null {
  const h = telegramHub();
  if (!h) refuse(res, 503, 'telegram_unavailable', 'Telegram works only in the Mac app.');
  return h;
}

function sendHubError(res: ServerResponse, err: unknown): void {
  if (err instanceof HubError) { refuse(res, err.status, err.code, err.message); return; }
  refuse(res, 500, 'telegram_failed', 'Telegram request failed.');
}

/** `super` → this project's scope; a member slug → its project scope, or `global` for a global member. */
export function scopeOfTarget(contextRoot: string, target: string): string | null {
  if (!TELEGRAM_TARGET_RE.test(target) || !isValidTarget(target)) return null;
  if (target === 'super') return scopeOfContextRoot(contextRoot);
  const where = memberScope(contextRoot, target);
  if (where === 'project') return scopeOfContextRoot(contextRoot);
  if (where === 'global') return 'global';
  return null;
}

const projectNameOf = (contextRoot: string) => basename(dirname(contextRoot));

// ── Page-called ──

const status: Handler = async (req, res, _p, contextRoot) => {
  if (!fromPageHeaders(req) && !(isDesktop() && isLoopback(req))) { refuse(res, 403, 'owner_page_only', 'Telegram status is shown in the Mac app only.'); return; }
  const h = telegramHub();
  const scope = scopeOfContextRoot(contextRoot);
  const rows: TelegramStatusRow[] = (h?.status() ?? []).filter((r) => r.scope === scope || (r.scope === 'global' && scopeOfTarget(contextRoot, r.target) === 'global'));
  const manager: TelegramStatusRow | null = h?.manager ? h.manager.row() : null;
  sendJson(res, 200, { rows, manager });
};

const bind: Handler = async (req, res, params, contextRoot) => {
  if (!fromPageHeaders(req)) { refuse(res, 403, 'owner_page_only', 'Only the owner, in the app, connects a bot.'); return; }
  const h = hubOr(res);
  if (!h) return;
  const scope = scopeOfTarget(contextRoot, params.target);
  if (!scope) { refuse(res, 404, 'not_found', 'No such Super or member here.'); return; }
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  try {
    const out = await h.beginPairing({ scope, target: params.target, token: String(body.token ?? ''), projectName: projectNameOf(contextRoot), contextRoot });
    sendJson(res, 200, out);
  } catch (err) { sendHubError(res, err); }
};

const unbind: Handler = async (req, res, params, contextRoot) => {
  if (!fromPageHeaders(req)) { refuse(res, 403, 'owner_page_only', 'Only the owner, in the app, removes a bot.'); return; }
  const h = hubOr(res);
  if (!h) return;
  const scope = scopeOfTarget(contextRoot, params.target);
  if (!scope) { refuse(res, 404, 'not_found', 'No such Super or member here.'); return; }
  try {
    await h.unbind(scope, params.target, { keyed: hasOwnerKey(req), replaceManagedToken: h.replaceManagedToken });
    sendJson(res, 200, { ok: true });
  } catch (err) { sendHubError(res, err); }
};

// ── Rust-called, vault-agnostic ──

const pairingPreview = async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
  if (!isDesktop() || !isLoopback(req)) { refuse(res, 403, 'desktop_only', 'Desktop only.'); return; }
  const h = hubOr(res);
  if (!h) return;
  if (!PAIRING_ID_RE.test(params.id ?? '')) { refuse(res, 400, 'bad_id', 'Malformed pairing id.'); return; }
  const ctx = h.pairingContext(params.id);
  if (ctx?.contextRoot && !existsSync(ctx.contextRoot)) { refuse(res, 410, 'vault_gone', 'That project is gone.'); return; }
  const p = h.pairingPreview(params.id);
  if (!p) { refuse(res, 404, 'not_found', 'No such pairing.'); return; }
  sendJson(res, 200, p);
};

const pairingConfirm = async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
  if (!isDesktop() || !isLoopback(req) || !fromOwnerPage(req)) { refuse(res, 403, 'owner_key_required', 'Only the Mac app\'s own confirm can connect a bot.'); return; }
  const h = hubOr(res);
  if (!h) return;
  if (!PAIRING_ID_RE.test(params.id ?? '')) { refuse(res, 400, 'bad_id', 'Malformed pairing id.'); return; }
  const ctx = h.pairingContext(params.id);
  if (!ctx) { refuse(res, 409, 'gone', 'This pairing is no longer valid.'); return; }
  if (ctx.contextRoot && !existsSync(ctx.contextRoot)) { refuse(res, 410, 'vault_gone', 'That project is gone.'); return; }
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  const botId = Number(body.botId);
  const userId = Number(body.userId);
  if (!Number.isSafeInteger(botId) || !Number.isSafeInteger(userId)) { refuse(res, 400, 'bad_body', 'Body must be { botId, userId }.'); return; }
  const out = await h.confirmPairing(params.id, { botId, userId });
  if (out === 'ok') sendJson(res, 200, { ok: true });
  else refuse(res, 409, out, out === 'mismatch' ? 'The pairing changed since it was shown.' : 'This pairing is no longer valid.');
};

const managerStatus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!isDesktop() || !isLoopback(req)) { refuse(res, 403, 'desktop_only', 'Desktop only.'); return; }
  const h = telegramHub();
  sendJson(res, 200, h?.managerStatus?.() ?? { manager: null, bots: [] });
};

const managerBind = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!fromPageHeaders(req)) { refuse(res, 403, 'owner_page_only', 'Only the owner, in the app, sets up Telegram.'); return; }
  const h = hubOr(res);
  if (!h) return;
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  try {
    sendJson(res, 200, await h.beginPairing({ scope: 'manager', target: MANAGER_PAIRING_TARGET, token: String(body.token ?? ''), projectName: 'Bu Mac', contextRoot: null }));
  } catch (err) { sendHubError(res, err); }
};

const managerUnbind = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!fromPageHeaders(req)) { refuse(res, 403, 'owner_page_only', 'Only the owner, in the app, removes the manager.'); return; }
  const h = hubOr(res);
  if (!h) return;
  await h.removeManager?.(hasOwnerKey(req));
  sendJson(res, 200, { ok: true });
};

// ── Id-record routes (Z1, AA1, AB): page mints, Rust confirms ──

function mgrOr(res: ServerResponse) {
  const h = hubOr(res);
  if (!h) return null;
  if (!h.manager) { refuse(res, 503, 'telegram_unavailable', 'Telegram works only in the Mac app.'); return null; }
  return h.manager;
}

const pageOnly = (handler: Handler): Handler => async (req, res, params, contextRoot) => {
  if (!fromPageHeaders(req)) { refuse(res, 403, 'owner_page_only', 'Only the owner, in the app, changes Telegram.'); return; }
  if (!scopeOfTarget(contextRoot, params.target)) { refuse(res, 404, 'not_found', 'No such Super or member here.'); return; }
  try { await handler(req, res, params, contextRoot); } catch (err) { sendHubError(res, err); }
};

const forwardList: Handler = pageOnly(async (_req, res, params, contextRoot) => {
  const m = mgrOr(res);
  if (m) sendJson(res, 200, m.forwardList(contextRoot, params.target));
});
const forwardRequest: Handler = pageOnly(async (req, res, params, contextRoot) => {
  const m = mgrOr(res);
  if (!m) return;
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  sendJson(res, 200, m.forwardRequest(contextRoot, params.target, String(body.routine ?? '')));
});
/** OFF is keyless (less leaves the Mac, W3); ON only through the request + native confirm. */
const forwardSet: Handler = pageOnly(async (req, res, params, contextRoot) => {
  const m = mgrOr(res);
  if (!m) return;
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  if (body.on !== false) { refuse(res, 403, 'confirm_required', 'Turning results on needs the Mac\'s own confirm.'); return; }
  m.forwardOff(contextRoot, params.target, String(body.routine ?? ''));
  sendJson(res, 200, { ok: true });
});
const creationRequest: Handler = pageOnly(async (_req, res, params, contextRoot) => {
  const m = mgrOr(res);
  if (m) sendJson(res, 200, m.creationRequest(contextRoot, params.target, scopeOfTarget(contextRoot, params.target)!));
});
const readoptRequest: Handler = pageOnly(async (_req, res, params, contextRoot) => {
  const m = mgrOr(res);
  if (m) sendJson(res, 200, m.readoptRequest(contextRoot, params.target, scopeOfTarget(contextRoot, params.target)!));
});
const readoptAvailable: Handler = pageOnly(async (_req, res, params, contextRoot) => {
  const m = mgrOr(res);
  if (m) sendJson(res, 200, m.readoptAvailable(contextRoot, params.target));
});

type Kind = 'forward' | 'creation' | 'readopt';
/** A Rust call on an id record: desktop + loopback; POSTs also need the owner key. */
function rustRecord(kind: Kind, keyed: boolean) {
  return (run: (m: NonNullable<ReturnType<typeof mgrOr>>, rec: Exclude<ReturnType<NonNullable<ReturnType<typeof mgrOr>>['take']>, string>, req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
      if (!isDesktop() || !isLoopback(req) || (keyed && !fromOwnerPage(req))) { refuse(res, 403, keyed ? 'owner_key_required' : 'desktop_only', 'Only the Mac app\'s own confirm can do this.'); return; }
      const m = mgrOr(res);
      if (!m) return;
      if (!PAIRING_ID_RE.test(params.id ?? '')) { refuse(res, 400, 'bad_id', 'Malformed id.'); return; }
      const rec = m.take(kind, params.id);
      if (rec === 'vault_gone') { refuse(res, 410, 'vault_gone', 'That project is gone.'); return; }
      if (rec === 'gone') { refuse(res, keyed ? 409 : 404, 'gone', 'This request is no longer valid.'); return; }
      try { await run(m, rec, req, res); } catch (err) { sendHubError(res, err); }
    };
}

const forwardPreview = rustRecord('forward', false)(async (m, rec, _req, res) => { sendJson(res, 200, m.forwardPreview(rec)); });
const forwardConfirm = rustRecord('forward', true)(async (m, rec, req, res) => {
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  const out = m.forwardConfirm(rec, { projectKey: body.projectKey, approvalHash: body.approvalHash });
  if (out === 'ok') sendJson(res, 200, { ok: true }); else refuse(res, 409, 'mismatch', 'The routine or the bot changed since it was shown.');
});
const creationStart = rustRecord('creation', true)(async (m, rec, _req, res) => { sendJson(res, 200, m.creationStart(rec)); });
const readoptPreview = rustRecord('readopt', false)(async (m, rec, _req, res) => { sendJson(res, 200, m.readoptPreview(rec)); });
const readoptStart = rustRecord('readopt', true)(async (m, rec, req, res) => {
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  const out = await m.readoptStart(rec, body.approvalHash);
  if (out === 'ok') sendJson(res, 200, { ok: true }); else refuse(res, 409, 'mismatch', 'What was shown changed.');
});

/** Every Telegram route. Order: the specific id routes before `:target`. */
export function registerTelegramRoutes(router: Router): void {
  router.get('/api/telegram-pairing/:id', pairingPreview);
  router.post('/api/telegram-pairing/:id/confirm', pairingConfirm);
  router.get('/api/telegram-manager/status', managerStatus);
  router.post('/api/telegram-manager/bind', managerBind);
  router.delete('/api/telegram-manager', managerUnbind);
  router.get('/api/telegram-forward/:id/preview', forwardPreview);
  router.post('/api/telegram-forward/:id/confirm', forwardConfirm);
  router.post('/api/telegram-creation/:id/start', creationStart);
  router.get('/api/telegram-readopt/:id/preview', readoptPreview);
  router.post('/api/telegram-readopt/:id/start', readoptStart);
  router.get('/api/telegram/:target/forward', forwardList);
  router.post('/api/telegram/:target/forward/request', forwardRequest);
  router.post('/api/telegram/:target/forward', forwardSet);
  router.post('/api/telegram/:target/creation/request', creationRequest);
  router.post('/api/telegram/:target/readopt/request', readoptRequest);
  router.get('/api/telegram/:target/readopt', readoptAvailable);
  router.get('/api/telegram', status);
  router.post('/api/telegram/:target/bind', bind);
  router.delete('/api/telegram/:target', unbind);
}
