/**
 * The owner's card actions, wherever he is in the app (sahip-karti-yerinde K4, K6, K7): the
 * Super chat's slot, his bar row, the child's own chat. Every route here is Gate G1:
 *
 *  - `fromOwnerPage` on every POST (own Origin, `Sec-Fetch-Site: same-origin`, the shell's owner
 *    key). A no-Origin loopback request (an agent's `curl` or node `ws`, the Super's own Bash) is
 *    refused: 403 `{error:'owner_only', message:'Open dreamcontext to run it'}`, "on this Mac"
 *    added for a remote-access browser.
 *  - The one GET (`cards/state`) asks the same of a request a browser sends with no Origin (a
 *    same-origin GET): loopback, desktop, strict same origin, `Sec-Fetch-Site: same-origin`, and
 *    the owner key.
 *
 * Routes (JSON):
 *  - POST /api/agent/card-ticket          {session, card, action, shown, root} → {ticket, expiresAt}
 *    (409 `{error:'folder_changed', folder}` when `root` is not the card's folder now)
 *  - POST /api/agent/cards/checklist-submit {session, card, state, secrets} → {ok, outcome}
 *  - POST /api/agent/cards/not-needed     {session, card} → {ok}
 *  - GET  /api/agent/cards/state?session=&card= → {folder, views, cutOff, gone}
 *
 * No CLI verb, `super` verb, `window` verb or window command handler reaches any of these (the
 * key is the shell's; asserted by test). The Super's only lever stays `super queue done`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CARD_REF_RE, closeCard, isSessionUuid, type CardRecordEntry } from '../../lib/cards/records.js';
import type { ChecklistViewSpec, RunViewSpec } from '../../lib/chat-view-spec.js';
import { readChecklistSubmit } from '../../lib/checklist-markdown.js';
import { CARD_TICKET_ACTIONS, type CardTicketAction } from '../../lib/super/types.js';
import { isDesktop } from '../desktop.js';
import { parseJsonBody, sendJson } from '../middleware.js';
import { hasOwnerKey } from '../owner-key.js';
import { mintCardTicket } from '../card-ticket.js';
import {
  checklistReceipt, closeOwnerItemForCard, deliverOwnerReceipt, dropOwnerReceipts, holdOwnerReceipt, newSubmitId,
  ownerReceiptViews, type OwnerDeliverOutcome,
} from '../owner-receipts.js';
import { fromOwnerPage } from './assistant.js';
import { isLoopback, isSameOriginStrict } from './agent-spawn-shared.js';
import { cardFolderOf, folderRefusalBody, pressRoot, resolveCardRecord } from './run-terminal.js';
import { commandShowableAsIs } from '../telegram/runs.js';

type Params = Record<string, string>;

/** The one line every refused card action reads. */
export const CARD_OWNER_ONLY_MESSAGE = 'Open dreamcontext to run it';

/** 403 for a request with no owner proof; a request that did not come from this Mac (remote
 *  access) is told where to do it. */
export function sendCardOwnerOnly(req: IncomingMessage, res: ServerResponse): void {
  const here = isLoopback(req);
  sendJson(res, 403, { error: 'owner_only', message: here ? CARD_OWNER_ONLY_MESSAGE : `${CARD_OWNER_ONLY_MESSAGE} on this Mac` });
}

/** Owner proof for a POST: `fromOwnerPage` on this Mac's desktop app. */
export function cardOwnerProof(req: IncomingMessage): boolean {
  return isDesktop() && isLoopback(req) && fromOwnerPage(req);
}

/** Owner proof for a GET (a browser sends no Origin on a same-origin GET): every other part. */
export function cardOwnerReadProof(req: IncomingMessage): boolean {
  return isDesktop() && isLoopback(req) && isSameOriginStrict(req)
    && String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase() === 'same-origin'
    && hasOwnerKey(req);
}

function cardOf(b: Record<string, unknown>): { session: string; card: string } | null {
  const session = typeof b.session === 'string' ? b.session : '';
  const card = typeof b.card === 'string' ? b.card : '';
  return isSessionUuid(session) && CARD_REF_RE.test(card) ? { session, card } : null;
}

// ─── POST /api/agent/card-ticket ────────────────────────────────────────────

/**
 * One single-use ws ticket for one press (K4): bound to (project, posting session, cardRef,
 * action) and the command the surface DREW. `shown` must equal the record's command exactly, else
 * 409 `shown_mismatch` (a card rewritten between his look and his tap is never run unseen).
 */
export async function handleCardTicket(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!cardOwnerProof(req)) { sendCardOwnerOnly(req, res); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const c = cardOf(b);
  const action = b.action as CardTicketAction;
  if (!c || !(CARD_TICKET_ACTIONS as readonly string[]).includes(String(action)) || typeof b.shown !== 'string') {
    sendJson(res, 400, { error: 'bad_request', message: 'A card, an action and the command shown are required.' });
    return;
  }
  const { rec } = resolveCardRecord(c.session, c.card);
  if (!rec || rec.kind !== 'run') { sendJson(res, 404, { error: 'no_card', message: 'This card is no longer in the job\'s transcript.' }); return; }
  const command = (rec.spec as RunViewSpec).command;
  if (b.shown !== command) { sendJson(res, 409, { error: 'shown_mismatch', message: 'The card changed; look at it again.' }); return; }
  // What is shown is what runs (K4), held on the server for every surface: a command that can draw
  // as something else is never minted a ticket, whatever the client drew.
  if (!commandShowableAsIs(command)) { sendJson(res, 409, { error: 'not_showable', message: 'This command cannot be shown as it is, so it cannot be run from a card.' }); return; }
  // The folder the owner SAW (`root`, the `folder.path` of cards/state) is the folder now, or no
  // ticket; the ticket binds it, and the start compares it again (end review r2).
  const press = await pressRoot(rec, typeof b.root === 'string' ? b.root : null);
  if (!press.ok) { sendJson(res, 409, folderRefusalBody(press)); return; }
  sendJson(res, 200, mintCardTicket({ project: rec.vault, postingSession: rec.sessionId, cardRef: rec.cardRef, action, shown: b.shown, root: press.root }));
}

// ─── POST /api/agent/cards/checklist-submit ─────────────────────────────────

/**
 * A checklist's submit, relayed by the vault window (K4: only for an event that carried the
 * window's nonce; the window checks that). The body is the STRUCTURED state plus the typed
 * `wants:'secret'` values, never finished markdown: the server builds the receipt.
 *
 *  - A crew child's card: both forms are built, the receipt is HELD (kept form on disk, full form
 *    in memory) in the same synchronous block as, and before, the record closes, then delivered
 *    to the child (`outcome`). A closed record submits again, as at the base.
 *  - Any other host: the record closes and the window posts the server-built message itself
 *    (`outcome: 'window'`, `text`), as today.
 */
export async function handleChecklistSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!cardOwnerProof(req)) { sendCardOwnerOnly(req, res); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const c = cardOf(b);
  if (!c || 'markdown' in b || 'text' in b) {
    sendJson(res, 400, { error: 'bad_request', message: 'A card and the checklist\'s state are required (never a finished message).' });
    return;
  }
  const { rec, lookup } = resolveCardRecord(c.session, c.card);
  if (!rec || rec.kind !== 'checklist') { sendJson(res, 404, { error: 'no_card', message: 'This card is no longer in the job\'s transcript.' }); return; }
  const spec = rec.spec as ChecklistViewSpec;
  const state = b.state && typeof b.state === 'object' && !Array.isArray(b.state) ? b.state as Record<string, unknown> : null;
  const read = state ? readChecklistSubmit(spec, { ...state, secrets: b.secrets ?? {} }) : null;
  if (!read) { sendJson(res, 400, { error: 'bad_state', message: 'The checklist\'s state could not be read.' }); return; }
  const forms = checklistReceipt(spec, read.state, read.secrets);
  if (lookup) {
    const held = holdOwnerReceipt(lookup.target, { id: newSubmitId(), cardRef: rec.cardRef, kind: 'checklist', text: forms.kept, full: forms.full });
    if (!held) { sendJson(res, 500, { error: 'not_held', message: 'The result could not be kept; nothing was sent.' }); return; }
    closeCard(rec.sessionId, rec.cardRef, 'done');
    const outcome: OwnerDeliverOutcome = await deliverOwnerReceipt(lookup.target);
    sendJson(res, 200, { ok: true, outcome });
    return;
  }
  closeCard(rec.sessionId, rec.cardRef, 'done');
  sendJson(res, 200, { ok: true, outcome: 'window', text: forms.full });
}

// ─── POST /api/agent/cards/not-needed ───────────────────────────────────────

/** The owner says a crew child's card is not needed: its item closes (`answerOwnerItem` behind
 *  lane A's closer), anything held for it goes (its full forms first), its open record closes. */
export async function handleCardNotNeeded(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!cardOwnerProof(req)) { sendCardOwnerOnly(req, res); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const c = cardOf(b);
  if (!c) { sendJson(res, 400, { error: 'bad_request', message: 'A card is required.' }); return; }
  const { rec, lookup } = resolveCardRecord(c.session, c.card);
  if (!lookup) { sendJson(res, 404, { error: 'not_found', message: 'Nothing waits on this card.' }); return; }
  const closed = await closeOwnerItemForCard(lookup, 'not_needed');
  if (!closed) { sendJson(res, 409, { error: 'already_answered', message: 'This card was already dealt with.' }); return; }
  dropOwnerReceipts(lookup.target, { cardRef: lookup.handle.cardRef });
  if (rec && rec.state === 'open' && !rec.run) closeCard(rec.sessionId, rec.cardRef, 'dropped');
  sendJson(res, 200, { ok: true });
}

// ─── GET /api/agent/cards/state?session=&card= ──────────────────────────────

/** What the slot draws beside a card: the folder it runs in, what is held for it (never a MAC;
 *  `kept` / `cut_off` drawn read-only), and whether the card is past the rebuild window. */
export async function handleCardState(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!cardOwnerReadProof(req)) { sendCardOwnerOnly(req, res); return; }
  const url = new URL(req.url || '/', 'http://x');
  const c = cardOf({ session: url.searchParams.get('session') ?? '', card: url.searchParams.get('card') ?? '' });
  if (!c) { sendJson(res, 400, { error: 'bad_request', message: 'A card is required.' }); return; }
  const { rec, lookup } = resolveCardRecord(c.session, c.card);
  const folder = rec ? await folderFor(rec) : null;
  const views = lookup ? ownerReceiptViews(lookup.target).filter((v) => v.cardRef === c.card) : [];
  sendJson(res, 200, { folder, views, cutOff: views.some((v) => v.state === 'cut_off'), gone: !rec });
}

/** A secret naming an app keeps the app's root (drawn as the card's own); every other card: the
 *  card's working folder. */
async function folderFor(rec: CardRecordEntry): Promise<{ path: string; name: string } | null> {
  if (rec.kind === 'secret' && (rec.spec as { app?: string }).app) return null;
  return cardFolderOf(rec);
}

/** The router's table for these routes (index.ts registers them). */
export const CARD_ACTION_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: (req: IncomingMessage, res: ServerResponse, params: Params) => Promise<void> }> = [
  { method: 'post', path: '/api/agent/card-ticket', handler: handleCardTicket },
  { method: 'post', path: '/api/agent/cards/checklist-submit', handler: handleChecklistSubmit },
  { method: 'post', path: '/api/agent/cards/not-needed', handler: handleCardNotNeeded },
  { method: 'get', path: '/api/agent/cards/state', handler: handleCardState },
];
