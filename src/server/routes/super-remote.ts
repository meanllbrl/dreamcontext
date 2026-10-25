import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isAgentRequest } from '../desktop.js';
import { isPhoneSocket, macPublicOrigin } from '../phone-origin.js';
import { readSuperState } from '../../lib/super/store.js';
import { superSanitizeOpts, superVaultName, writeSuper } from '../../lib/super/inbox.js';
import { isRotating } from '../../lib/super/fresh-session.js';
import { superRemoteView } from '../../lib/super/remote-view.js';
import { CONTAINER_SIZES, MAX_CONTAINERS, MAX_PRESENT, PRESENT_LAYOUTS, type SuperState } from '../../lib/super/types.js';
import type { SuperRemoteView } from '../../lib/handsfree/mac/contract.js';
import { applyOwnerLayout, applyOwnerSeen, ownerSeenMarks } from './super.js';

/**
 * The Super Agent's stage for a REMOTE screen (hands-free sekmeler W1, D5): the computer or
 * landscape tablet on the tunnel reads the stage and arranges it, and nothing more. The Mac
 * window stays the Super's bridge (it holds the super chat's socket and every child's), so
 * hand-over, take-back, a fresh session, ending a child, closing, grouping or parking a card stay
 * on the Mac; `/api/super/*` stays laptop-only and `requireSuperOwner` is not loosened.
 *
 *   GET  /api/agent/super-stage         — the allowlisted view (lib/super/remote-view.ts).
 *   POST /api/agent/super-stage/layout  — the owner's arranging gestures, through a STRICT key
 *        allowlist: `cards` (id, pos, size, order, and `place` only as 'float'), `presentLayout`,
 *        `chat`, `exit` (with an empty `closing`), `agenda`, and `view` only in the shapes the
 *        stage sends, rebuilt here. Any other key is 400 and changes nothing.
 *   POST /api/agent/super-stage/seen    — the agenda's "seen", as the owner's own door applies it.
 *
 * Phone sockets only (the phone listener's gate already checked the device session, the
 * tunnel's Origin and the chosen project). Every answer is the allowlisted view; a refusal is a
 * fixed `{ error, message }`, never the store's details. Refused unless handed over.
 */

class RemoteRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const strList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const TOP_KEYS = ['cards', 'presentLayout', 'chat', 'exit', 'agenda', 'view'] as const;
const CARD_KEYS = ['id', 'pos', 'size', 'order', 'place'] as const;

function bad(message: string): never { throw new RemoteRefused(400, 'invalid_body', message); }

/** The checked view shape, or undefined when the body names none. Existence is checked later,
 *  against the record being written. */
type RemoteViewAsk = { mode: 'float' } | { mode: 'half'; card: string } | { mode: 'present'; cards: string[] };

/**
 * The body a remote screen may send, checked key by key. Throws {@link RemoteRefused} (400) on
 * anything outside the allowlist; returns the cleaned body for `applyOwnerLayout` and the view
 * asked for (rebuilt, never the request object).
 */
export function checkRemoteLayout(body: Record<string, unknown>): { patch: Record<string, unknown>; view: RemoteViewAsk | undefined } {
  for (const k of Object.keys(body)) if (!(TOP_KEYS as readonly string[]).includes(k)) bad(`"${k}" is not something a remote screen changes`);
  const patch: Record<string, unknown> = {};
  if (body.cards !== undefined) {
    if (!Array.isArray(body.cards) || body.cards.length > MAX_CONTAINERS) bad(`cards must be a list of at most ${MAX_CONTAINERS}`);
    patch.cards = (body.cards as unknown[]).map((raw) => {
      const p = rec(raw);
      if (!p || !onlyKeys(p, CARD_KEYS) || typeof p.id !== 'string') bad('each card is { id, pos?, size?, order?, place? }');
      const out: Record<string, unknown> = { id: p.id };
      if (p.place !== undefined) {
        if (p.place !== 'float') bad('a remote screen brings a card onto the stage; Others, closing and groups stay on the Mac');
        out.place = 'float';
      }
      if (p.pos !== undefined) {
        const pos = rec(p.pos);
        if (p.pos !== null && !(pos && onlyKeys(pos, ['x', 'y']) && finite(pos.x) && finite(pos.y))) bad('pos is { x, y } or null');
        out.pos = p.pos === null ? null : { x: (pos as { x: number }).x, y: (pos as { y: number }).y };
      }
      if (p.size !== undefined) {
        if (p.size !== null && !(typeof p.size === 'string' && (CONTAINER_SIZES as readonly string[]).includes(p.size))) bad(`size is one of ${CONTAINER_SIZES.join(', ')} or null`);
        out.size = p.size;
      }
      if (p.order !== undefined) {
        if (p.order !== 'last') bad('order is "last"');
        out.order = 'last';
      }
      return out;
    });
  }
  if (body.presentLayout !== undefined) {
    const pl = rec(body.presentLayout);
    if (!pl || !onlyKeys(pl, ['layout', 'cards']) || typeof pl.layout !== 'string' || !(PRESENT_LAYOUTS as readonly string[]).includes(pl.layout) || !strList(pl.cards, MAX_CONTAINERS)) bad('presentLayout is { layout, cards }');
    patch.presentLayout = { layout: pl.layout, cards: [...(pl.cards as string[])] };
  }
  if (body.chat !== undefined) {
    const ch = rec(body.chat);
    if (!ch || !onlyKeys(ch, ['value', 'cards']) || !(ch.value === 'bar' || ch.value === null) || !strList(ch.cards, MAX_CONTAINERS)) bad('chat is { value: "bar" | null, cards }');
    patch.chat = { value: ch.value, cards: [...(ch.cards as string[])] };
  }
  if (body.exit !== undefined) {
    const ex = rec(body.exit);
    if (!ex || !onlyKeys(ex, ['cards', 'closing']) || !strList(ex.cards, MAX_CONTAINERS)) bad('exit is { cards, closing: [] }');
    if (ex.closing !== undefined && !(Array.isArray(ex.closing) && ex.closing.length === 0)) bad('a remote screen closes no card, so exit.closing is []');
    patch.exit = { cards: [...(ex.cards as string[])], closing: [] };
  }
  if (body.agenda !== undefined) {
    if (body.agenda !== 'open' && body.agenda !== 'min') bad('agenda is "open" or "min"');
    patch.agenda = body.agenda;
  }
  let view: RemoteViewAsk | undefined;
  if (body.view !== undefined) {
    const v = rec(body.view);
    if (v && v.mode === 'float' && onlyKeys(v, ['mode'])) view = { mode: 'float' };
    else if (v && v.mode === 'half' && onlyKeys(v, ['mode', 'card']) && typeof v.card === 'string') view = { mode: 'half', card: v.card };
    else if (v && v.mode === 'present' && onlyKeys(v, ['mode', 'cards']) && strList(v.cards, MAX_PRESENT) && v.cards.length > 0) view = { mode: 'present', cards: [...(v.cards as string[])] };
    else bad('view is { mode: "float" }, { mode: "half", card } or { mode: "present", cards }');
  }
  return { patch, view };
}

/** The checked view against the record being written: every card it names must exist. */
function viewFor(s: SuperState, ask: RemoteViewAsk): SuperState['view'] {
  const has = (id: string) => s.containers.some((c) => c.id === id);
  if (ask.mode === 'half') {
    if (!has(ask.card)) throw new RemoteRefused(400, 'unknown_card', 'that card is not on the stage');
    return { mode: 'half', card: ask.card };
  }
  if (ask.mode === 'present') {
    if (!ask.cards.every(has)) throw new RemoteRefused(400, 'unknown_card', 'a card it names is not on the stage');
    return { mode: 'present', cards: [...ask.cards] };
  }
  return { mode: 'float' };
}

/** A remote screen's request on a phone socket, or the 403 sent. */
function remoteOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (isPhoneSocket(req) && isAgentRequest(req)) return true;
  sendError(res, 403, 'forbidden', 'The remote stage is served to a signed-in remote screen only.');
  return false;
}

function tunnelHost(): string | null {
  const origin = macPublicOrigin();
  if (!origin) return null;
  try { return new URL(origin).hostname; } catch { return null; }
}

/** The allowlisted view of `state` for this project. */
export function remoteViewOf(contextRoot: string, state: SuperState): SuperRemoteView {
  return superRemoteView(state, superVaultName(contextRoot), tunnelHost(), isRotating(state.session));
}

const NOT_HANDED_OVER = { status: 409, code: 'not_handed_over', message: 'This project\'s Super Agent is not handed over right now.' };

function refusal(res: ServerResponse, err: unknown): void {
  if (err instanceof RemoteRefused) { sendError(res, err.status, err.code, err.message); return; }
  // Never the store's message or details through the tunnel.
  console.warn(`[super-remote] a remote stage request failed: ${(err as Error)?.message ?? err}`);
  sendError(res, 503, 'unavailable', 'The Super Agent stage could not be read; try again.');
}

/** GET /api/agent/super-stage */
export async function handleSuperStageGet(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  if (!remoteOnly(req, res)) return;
  try {
    const state = await readSuperState(contextRoot, superSanitizeOpts());
    if (!state.enabled || !state.session) { sendError(res, NOT_HANDED_OVER.status, NOT_HANDED_OVER.code, NOT_HANDED_OVER.message); return; }
    sendJson(res, 200, remoteViewOf(contextRoot, state));
  } catch (err) { refusal(res, err); }
}

/** A remote write: refused unless handed over, applied inside the locked write (the record it
 *  checks is the one it writes), answered with the allowlisted view. */
async function remoteWrite(res: ServerResponse, contextRoot: string, fn: (s: SuperState) => void): Promise<void> {
  try {
    const state = await writeSuper(contextRoot, (s) => {
      if (!s.enabled || !s.session) throw new RemoteRefused(NOT_HANDED_OVER.status, NOT_HANDED_OVER.code, NOT_HANDED_OVER.message);
      fn(s);
    });
    sendJson(res, 200, { state: remoteViewOf(contextRoot, state) });
  } catch (err) { refusal(res, err); }
}

/** POST /api/agent/super-stage/layout */
export async function handleSuperStageLayout(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  if (!remoteOnly(req, res)) return;
  const body = rec(await parseJsonBody(req));
  if (!body) { sendError(res, 400, 'invalid_body', 'a JSON object is expected'); return; }
  let checked: ReturnType<typeof checkRemoteLayout>;
  try { checked = checkRemoteLayout(body); } catch (err) { refusal(res, err); return; }
  await remoteWrite(res, contextRoot, (s) => {
    // The view is rebuilt from its checked fields against THIS record, before the gestures run
    // (the owner's door applies a view after them, from the same body).
    const patch = checked.view ? { ...checked.patch, view: viewFor(s, checked.view) } : checked.patch;
    applyOwnerLayout(s, patch);
  });
}

/** POST /api/agent/super-stage/seen */
export async function handleSuperStageSeen(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  if (!remoteOnly(req, res)) return;
  const body = rec(await parseJsonBody(req));
  const marks = ownerSeenMarks(body ?? {});
  if ('error' in marks) { sendError(res, 400, 'invalid_body', marks.error); return; }
  await remoteWrite(res, contextRoot, (s) => { applyOwnerSeen(s, marks.marks); });
}
