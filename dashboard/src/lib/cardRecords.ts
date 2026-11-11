import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { canonicalJson, type CardCloseReason, type PublicCard } from '../../../src/lib/cards/public.js';
import { RequestError } from '../api/client';
import type { ChecklistViewSpec, McpViewSpec, RunViewSpec, SecretViewSpec } from './chatViewSpec';
import type {
  CardTicketAction, CardTicketMintRequest, CardTicketMintResponse, OwnerCardHandle, OwnerReceiptView,
} from './superTypes';

/**
 * The server's card records of each chat (plan I1, J2, K1; sahip-karti-yerinde K1, K7), as the
 * window and the phone page see them. Every owner-only card is a record: run, secret, checklist and
 * mcp.
 *
 * A chat-host card never derives a cardRef: it finds the server's record by its `id` AND its
 * canonical spec (exactly what the agent wrote), the NEWEST record when a card was posted again,
 * and sends that record's cardRef back. The records arrive with the chat socket's `cards` frame
 * on every change, and once per chat from `GET /api/agent/cards` for a mount or a reload; until
 * that snapshot is in, a run card's ▶ stays disabled (no `cmd=` fallback race, J2).
 *
 * TWO HOSTS (K7). A card is drawn either in its own chat (`{session}`: found by id and spec) or
 * from an owner item's card handle (`{record}`: the Super-chat slot, the bar), where it is found by
 * `(posting session, cardRef)` with `byRecord`, and the spec drawn is the HANDLE's (the server's
 * own parse of the child's frame), never chat text. A record the posting session's list does not
 * hold (a parked or gone child whose chat is not loaded) is drawn from the handle; every action on
 * it is resolved by the server through `ensureCardsFor`.
 */

export type CardRecordView = PublicCard;
export type { CardCloseReason };

/** Every spec a record can be. */
export type RecordSpec = RunViewSpec | SecretViewSpec | ChecklistViewSpec | McpViewSpec;

/** Where a card is drawn: its own chat, or an owner item's record (`open`: the item is open). */
export type CardHost = { session: string } | { record: OwnerCardHandle; open?: boolean };

interface SessionCards { loaded: boolean; cards: PublicCard[] }

const store = new Map<string, SessionCards>();
const listeners = new Set<() => void>();
const inflight = new Set<string>();
let version = 0;

function emit(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

function isCards(v: unknown): v is PublicCard[] {
  return Array.isArray(v) && v.every((c) => !!c && typeof c === 'object' && typeof (c as PublicCard).cardRef === 'string' && typeof (c as PublicCard).id === 'string');
}

/** The chat socket's `cards` frame (chatSession.ts). */
export function applyCardsFrame(sessionId: unknown, cards: unknown): boolean {
  if (typeof sessionId !== 'string' || !isCards(cards)) return false;
  store.set(sessionId, { loaded: true, cards });
  emit();
  return true;
}

/** Load one chat's records once (mount, reload). `fetchJson` is the vault-scoped api's GET. */
export function loadCards(sessionId: string, fetchJson: (path: string) => Promise<unknown>): void {
  if (!sessionId || store.get(sessionId)?.loaded || inflight.has(sessionId)) return;
  inflight.add(sessionId);
  void fetchJson(`/agent/cards?session=${encodeURIComponent(sessionId)}`)
    .then((r) => {
      const cards = (r as { cards?: unknown } | null)?.cards;
      // A frame that arrived meanwhile is newer than this snapshot.
      if (!store.get(sessionId)?.loaded) store.set(sessionId, { loaded: true, cards: isCards(cards) ? cards : [] });
    })
    .catch(() => { if (!store.get(sessionId)?.loaded) store.set(sessionId, { loaded: true, cards: [] }); })
    .finally(() => { inflight.delete(sessionId); emit(); });
}

/** The record a drawn card is: same kind, same id, same canonical spec; the newest such. */
export function matchCard(cards: readonly PublicCard[], spec: RecordSpec): PublicCard | null {
  const want = canonicalJson(spec);
  let hit: PublicCard | null = null;
  for (const c of cards) if (c.kind === spec.type && c.id === spec.id && canonicalJson(c.spec) === want) hit = c;
  return hit;
}

/** The record an owner item's handle names (`(posting session, cardRef)`), when this window has
 *  that session's records. Null when it has not loaded them or the list does not hold it. */
export function byRecord(postingSession: string, cardRef: string): PublicCard | null {
  return store.get(postingSession)?.cards.find((c) => c.cardRef === cardRef) ?? null;
}

/** A record host's card when the posting session's list does not hold it: drawn from the handle
 *  (the server resolves it through `ensureCardsFor` on every action). */
export function recordFromHandle(h: OwnerCardHandle, open: boolean): PublicCard {
  return { id: h.spec.id, cardRef: h.cardRef, kind: h.spec.type, spec: h.spec, state: open ? 'open' : 'closed', run: null };
}

/** The posting session a host's records live under. */
export function hostSession(host: CardHost | undefined): string | undefined {
  if (!host) return undefined;
  return 'session' in host ? host.session : host.record.postingSession;
}

const readVersion = (): number => version;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The server record of a card drawn in chat `sessionId`. `loaded` false = not known yet. */
export function useCardRecord(
  sessionId: string | undefined,
  spec: RecordSpec,
  fetchJson: (path: string) => Promise<unknown>,
): { loaded: boolean; record: PublicCard | null } {
  useSyncExternalStore(subscribe, readVersion, readVersion);
  useEffect(() => { if (sessionId) loadCards(sessionId, fetchJson); }, [sessionId, fetchJson]);
  if (!sessionId) return { loaded: true, record: null };
  const s = store.get(sessionId);
  if (!s?.loaded) return { loaded: false, record: null };
  return { loaded: true, record: matchCard(s.cards, spec) };
}

/** The record of a card on either host (K7). The posting session is what every action names. */
export function useHostCard(
  host: CardHost | undefined,
  spec: RecordSpec,
  fetchJson: (path: string) => Promise<unknown>,
): { loaded: boolean; record: PublicCard | null; sessionId: string | undefined } {
  useSyncExternalStore(subscribe, readVersion, readVersion);
  const sessionId = hostSession(host);
  useEffect(() => { if (sessionId) loadCards(sessionId, fetchJson); }, [sessionId, fetchJson]);
  if (!host || !sessionId) return { loaded: true, record: null, sessionId };
  const s = store.get(sessionId);
  if ('record' in host) {
    // The handle names its record; until the list is in, the handle's own copy is drawn (its ▶
    // still mints a ticket the server checks against the record).
    const hit = s?.loaded ? byRecord(sessionId, host.record.cardRef) : null;
    return { loaded: true, record: hit ?? recordFromHandle(host.record, host.open !== false), sessionId };
  }
  if (!s?.loaded) return { loaded: false, record: null, sessionId };
  return { loaded: true, record: matchCard(s.cards, spec), sessionId };
}

/**
 * A chat's run card names its SERVER record instead of a command (plan H8, I1): the server
 * spawns the record's argv, or attaches this terminal to the run already going for it (one
 * started from the phone or Telegram included). `start` asks it to start when nothing runs;
 * `rerun` is the Mac's "Run again" of a closed card; `withheld` keeps the output from the agent.
 */
export interface CardTarget {
  sessionId: string;
  cardRef: string;
  start: boolean;
  withheld?: boolean;
  rerun?: boolean;
  /** The hands-free phone page: its own narrow path (`/api/agent/run-terminal`), owner proof by
   *  its device session; it carries no ticket. */
  phone?: boolean;
}

/** The ticket action a target's upgrade spends (K4): a rerun, a start, or an attach. */
export function ticketActionOf(t: Pick<CardTarget, 'start' | 'rerun'>): CardTicketAction {
  return t.rerun ? 'rerun' : t.start ? 'start' : 'attach';
}

/** The terminal URL for a card target: the Mac's chat-host mode (with its ticket), or the
 *  phone's own path. */
export function cardTerminalUrl(t: CardTarget, theme: string, ticket?: string): string {
  const p = new URLSearchParams({ session: t.sessionId, card: t.cardRef, theme });
  if (t.start) p.set('start', '1');
  if (t.withheld) p.set('withheld', '1');
  if (t.rerun) p.set('rerun', '1');
  if (ticket && !t.phone) p.set('ticket', ticket);
  return `${t.phone ? '/api/agent/run-terminal' : '/api/agent/terminal'}?${p.toString()}`;
}

// ─── The owner's card actions (K4): every one in the owner's name ───────────────────────────

/** What the server says to a request without owner proof (w2-shared). */
export const OWNER_ONLY_LINE = 'Open dreamcontext to run it';

export type OwnerPoster = { ownerPost<T>(path: string, body: unknown): Promise<T> };
export type CardActionResult<T> = { ok: true; value: T } | { ok: false; error: string; message: string };

function failure(e: unknown): { ok: false; error: string; message: string } {
  if (e instanceof RequestError) {
    const error = e.code || (e.status === 403 ? 'owner_only' : 'failed');
    // A refusal for want of owner proof always reads the one line, the server's own when it sent one.
    const message = error === 'owner_only' || error === 'owner_page_only' || e.status === 403
      ? (e.message && !/^Request failed/.test(e.message) ? e.message : OWNER_ONLY_LINE)
      : e.message;
    return { ok: false, error, message };
  }
  return { ok: false, error: 'failed', message: e instanceof Error ? e.message : '' };
}

/**
 * A press names what the owner SAW (end review r2, shown-is-not-what-runs): the command (`shown`)
 * and the folder it was drawn in (`root`, the `folder.path` of GET /api/agent/cards/state). The
 * server compares that folder with the one it resolves at the press and refuses on any difference
 * (409 `folder_changed`); it never re-resolves silently.
 */
export type CardTicketPress = CardTicketMintRequest & { root: string };

/** The refusal when the folder the owner saw is not the folder that would run. */
export const FOLDER_CHANGED = 'folder_changed';

/** Mint one single-use ticket for a run card's press, right before its terminal's socket opens.
 *  `shown` is the full command the surface drew, `root` the folder it drew. Never throws. */
export async function mintCardTicket(api: OwnerPoster, req: CardTicketPress): Promise<CardActionResult<string>> {
  try {
    const r = await api.ownerPost<CardTicketMintResponse>('/agent/card-ticket', req);
    if (r && typeof r.ticket === 'string' && r.ticket) return { ok: true, value: r.ticket };
    return { ok: false, error: 'failed', message: '' };
  } catch (e) { return failure(e); }
}

/** The owner's Not needed on a card (closes its owner item; its receipts are dropped). */
export async function cardNotNeeded(api: OwnerPoster, body: { session: string; card: string }): Promise<CardActionResult<true>> {
  try {
    await api.ownerPost<{ ok: true }>('/agent/cards/not-needed', body);
    return { ok: true, value: true };
  } catch (e) { return failure(e); }
}

/** What the slot reads about a card beside its record (`GET /api/agent/cards/state`). */
export interface CardStateView {
  folder: { path: string; name: string } | null;
  views: OwnerReceiptView[];
  cutOff: boolean;
  /** The card is past its transcript's rebuild window. */
  gone: boolean;
}

function cleanState(r: unknown): CardStateView | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const f = o.folder as { path?: unknown; name?: unknown } | null | undefined;
  const folder = f && typeof f.path === 'string' && typeof f.name === 'string' ? { path: f.path, name: f.name } : null;
  const views = Array.isArray(o.views) ? (o.views as OwnerReceiptView[]).filter((v) => !!v && typeof v.id === 'string' && typeof v.text === 'string' && typeof v.state === 'string') : [];
  return { folder, views, cutOff: o.cutOff === true, gone: o.gone === true };
}

/**
 * THE folder text of a card action (K5, K7), one helper for every surface that offers one (the
 * slot's run and secret cards, the bar row; the Telegram message draws the same shape): the card's
 * working root by name, then ` · <cwd>` when the spec runs in a sub-folder of it. What the owner
 * reads is where it runs. Null while the root is not known (loading, or its read failed): a
 * surface then offers no Run that would run somewhere unseen.
 */
export function cardFolderText(folder: { name: string } | null | undefined, spec: { cwd?: string } | RecordSpec): string | null {
  if (!folder?.name) return null;
  // The RAW cwd, exactly as the server resolves it: never a cleaned-up copy of it.
  const cwd = 'cwd' in spec && typeof spec.cwd === 'string' ? spec.cwd : '';
  return cwd ? `${folder.name} · ${cwd}` : folder.name;
}

/** Read a card's state with the owner key (the route asks for owner proof). Null on refusal. */
export async function fetchCardState(vault: string | null, session: string, card: string): Promise<CardStateView | null> {
  const headers: Record<string, string> = {};
  if (vault) headers['X-Dreamcontext-Vault'] = vault;
  try {
    const { ownerKey } = await import('./desktop');
    const key = await ownerKey();
    if (key) headers['X-Dreamcontext-Owner-Key'] = key;
  } catch { /* no shell: the route refuses, the slot draws without it */ }
  try {
    const res = await fetch(`/api/agent/cards/state?session=${encodeURIComponent(session)}&card=${encodeURIComponent(card)}`, { headers });
    if (!res.ok) return null;
    return cleanState(await res.json());
  } catch { return null; }
}

/** The last state read per card: the bar and the slot draw the same folder at once. */
const stateCache = new Map<string, CardStateView>();
const stateKey = (session: string, card: string): string => `${session}\u0000${card}`;
const STATE_CACHE_CAP = 64;

/** A card's state, read again whenever `refresh` changes (the item's delivery line moving, an
 *  action of the owner's). */
export function useCardState(vault: string | null, handle: Pick<OwnerCardHandle, 'postingSession' | 'cardRef'> | undefined, refresh: string): {
  state: CardStateView | null; reload: () => void;
} {
  const session = handle?.postingSession;
  const card = handle?.cardRef;
  const [state, setState] = useState<CardStateView | null>(() => (session && card ? stateCache.get(stateKey(session, card)) ?? null : null));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!session || !card) return undefined;
    let live = true;
    void fetchCardState(vault, session, card).then((s) => {
      if (s) {
        stateCache.set(stateKey(session, card), s);
        if (stateCache.size > STATE_CACHE_CAP) stateCache.delete(stateCache.keys().next().value as string);
      }
      if (live) setState(s);
    });
    return () => { live = false; };
  }, [vault, session, card, refresh, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, reload };
}

/** A card's folder as the server reports it (GET /api/agent/cards/state). */
export type CardFolder = { path: string; name: string };

/**
 * ONE press of a run card on the Mac (end review r2): the ticket is minted for the command AND the
 * folder the card drew. A `folder_changed` refusal calls `folderChanged` with the folder it named
 * (the card says so and reads the folder again) and returns: nothing here, nor the caller, presses
 * again by itself.
 */
export async function pressRun(api: OwnerPoster, req: CardTicketPress, on: { folderChanged: (root: string) => void }): Promise<CardActionResult<string>> {
  const r = await mintCardTicket(api, req);
  if (!r.ok && r.error === FOLDER_CHANGED) on.folderChanged(req.root);
  return r;
}

/** The body of a secret save: the record it is for, the folder it was drawn in (`root`), the
 *  file, title, app and the typed values. The values never leave in any other shape. */
export function secretSaveBody(a: {
  sessionId?: string; cardRef?: string; root: string | null;
  spec: Pick<SecretViewSpec, 'file' | 'title' | 'app' | 'fields'>; values: Record<string, string>;
}): Record<string, unknown> {
  return {
    ...(a.sessionId && a.cardRef ? { sessionId: a.sessionId, cardRef: a.cardRef } : {}),
    ...(a.root ? { root: a.root } : {}),
    file: a.spec.file,
    title: a.spec.title,
    ...(a.spec.app ? { app: a.spec.app } : {}),
    entries: a.spec.fields.map((f) => ({ key: f.key, value: (a.values[f.key] ?? '').trim() })),
  };
}

/** The server refused a press because the folder the owner saw is not the folder now. */
export function isFolderChanged(e: unknown): boolean {
  return e instanceof RequestError && e.code === FOLDER_CHANGED;
}

/**
 * The card's folder line (both cards): after a `folder_changed` refusal, what the folder is now
 * once read again (or that it is being read); otherwise, on the Mac, that no folder is known, so
 * nothing can be pressed. Null when there is nothing to say.
 */
export function folderLine(
  t: (key: string) => string,
  o: { changedFrom: string | null; folder: CardFolder | null; spec: { cwd?: string } | RecordSpec; unknown: boolean },
): string | null {
  if (o.changedFrom !== null) {
    return o.folder && o.folder.path !== o.changedFrom
      ? t('ownerCard.folderChanged').replace('{name}', cardFolderText(o.folder, o.spec) ?? o.folder.name)
      : t('ownerCard.folderChangedReading');
  }
  return o.unknown ? t('ownerCard.folderUnknown') : null;
}

/**
 * The folder a card DRAWS, and so the folder its press names (`root`). Given by the caller (the
 * slot reads the state once for the whole card), else read here for the card's own chat. `known`
 * false (loading, the read failed, a card past its transcript): the card offers no press, since
 * nothing would say where it runs. `reread` reads it again (after a `folder_changed` refusal),
 * never presses.
 */
export function useShownFolder(
  vault: string | null,
  target: { postingSession: string; cardRef: string } | undefined,
  given: CardFolder | null | undefined,
  onReread?: () => void,
): { folder: CardFolder | null; reread: () => void } {
  const own = useCardState(vault, given === undefined ? target : undefined, '');
  const folder = given !== undefined ? given : own.state?.folder ?? null;
  const ownReload = own.reload;
  const reread = useCallback(() => { if (given !== undefined) onReread?.(); else ownReload(); }, [given, onReread, ownReload]);
  return { folder, reread };
}

/** Tests only: a card's state as if it had been read. */
export function _seedCardStateForTests(session: string, card: string, state: CardStateView): void {
  stateCache.set(stateKey(session, card), state);
}

/** Tests only. */
export function _resetCardRecords(): void {
  store.clear();
  inflight.clear();
  stateCache.clear();
  emit();
}
