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
import { isValidTarget, readManagerBinding, scopeOfContextRoot } from '../../lib/telegram/config.js';
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
  const m = readManagerBinding();
  const manager: TelegramStatusRow | null = m.ok
    ? { scope: 'global', target: MANAGER_PAIRING_TARGET, state: 'active', botUsername: m.binding.botUsername }
    : m.reason === 'tamper' ? { scope: 'global', target: MANAGER_PAIRING_TARGET, state: 'disabled', botUsername: '', disabledReason: 'tamper' } : null;
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
  await h.removeManager?.();
  sendJson(res, 200, { ok: true });
};

/** Every Telegram route. Order: the specific id routes before `:target`. */
export function registerTelegramRoutes(router: Router): void {
  router.get('/api/telegram-pairing/:id', pairingPreview);
  router.post('/api/telegram-pairing/:id/confirm', pairingConfirm);
  router.get('/api/telegram-manager/status', managerStatus);
  router.post('/api/telegram-manager/bind', managerBind);
  router.delete('/api/telegram-manager', managerUnbind);
  router.get('/api/telegram', status);
  router.post('/api/telegram/:target/bind', bind);
  router.delete('/api/telegram/:target', unbind);
}
