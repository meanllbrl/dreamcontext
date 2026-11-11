/**
 * The terminals of server-owned runs (plan H4, H8, I1, J2, J4, K1) and the card records' read
 * route.
 *
 * Two ways in, both reading ONLY `session` and `card` (plus the owner's two switches: start, and
 * "do not hand the output to the agent"); never a command, a cwd or a vault:
 *
 *  - The Mac, chat-host mode of `/api/agent/terminal` (`?session=&card=`): reached through
 *    `attachAgentTerminal`'s existing gate (desktop, loopback, strict same origin). Project and
 *    cwd come from the RECORD. It may start an open card, attach to a run going for it (one
 *    started from the phone or Telegram included), and start a CLOSED card again ("Run again",
 *    Mac only, K1).
 *  - The phone, `/api/agent/run-terminal` on the Mac phone listener only: a valid device session
 *    on every upgrade, the tunnel's own Origin, the record's project exposed. It may start an OPEN
 *    card or attach to its run; a closed card is 409. At most 6 starts a minute per device. A
 *    logout or revoke closes its sockets (4401), kills the runs that device started and detaches
 *    from the rest (a Telegram-started run keeps going).
 *
 * A free terminal (`kind=shell`, `kind=agent`, `open-terminal`) never reaches the phone: its path
 * is not in the phone listener's WebSocket list and this handler spawns only a record's argv.
 *
 * Gate G1 (sahip-karti-yerinde K4): every Mac card-mode upgrade (start, attach, rerun) carries a
 * single-use ticket minted by `POST /api/agent/card-ticket` (owner page only), SPENT here before
 * anything starts, attaches or replays. A no-Origin loopback client (an agent's node `ws`) has
 * no owner key, so it can mint none and gets no replay byte. K5: a run starts in the card's
 * working folder (`cardWorkingRoot`, resolved here before `startRun`), never the bare project
 * root. A crew child's card resolves its record through the owner item's card handle
 * (`ensureCardsFor`), with no live chat needed.
 */
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { basename, join } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { CARD_REF_RE, ensureCardsFor, getCard, isRebuilt, isSessionUuid, listCards, rebuildCards, type CardRecordEntry } from '../../lib/cards/records.js';
import type { RunViewSpec } from '../../lib/chat-view-spec.js';
import { consumeCardTicket, type CardTicketAction } from '../card-ticket.js';
import { ownerCardLookup, type OwnerCardLookup } from '../owner-receipts.js';
import { cardWorkingRoot } from '../session-worktree.js';
import { commandShowableAsIs } from '../telegram/runs.js';
import { PHONE_RUN_TERMINAL_PATH } from '../../lib/telegram/contract.js';
import { attachRun, runProjectRootOf, startRun, type Run } from '../runs/registry.js';
import { sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isMacExposed, isMacOriginAllowed, isPhoneSocket } from '../phone-origin.js';
import { authFor, deviceIdHash, macHandsfreeAuth, onDeviceSessionsChanged } from '../handsfree-auth.js';
import { isLoopback, isSameOriginStrict, rejectUpgrade, resolveVaultProjectRoot } from './agent-spawn-shared.js';
import { getChat } from '../../lib/assistant/chat-registry.js';
import { liveTranscriptPath } from '../../lib/transcript-locate.js';

type WS = import('ws').WebSocket;

export const RUN_SOCKET_CLOSED = 4409;
const PHONE_STARTS_PER_MIN = 6;
const DEVICE_REVOKED_CLOSE = 4401;

/** Pipe a run to one socket: replay first, then live output, the exit as a binary control frame
 *  (the frame InlineTerminal already reads). Closing the socket DETACHES; the run goes on. */
export function serveRunSocket(ws: WS, run: Run): () => void {
  const replay = run.replay();
  if (replay) { try { ws.send(replay); } catch { /* closing */ } }
  const offOut = run.onOutput((chunk) => { if (ws.readyState === ws.OPEN) { try { ws.send(chunk); } catch { /* closing */ } } });
  const offExit = run.onExit((_report, code) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(Buffer.from(JSON.stringify({ type: 'exit', code }))); } catch { /* closing */ }
    try { ws.close(1000); } catch { /* closing */ }
  });
  ws.on('message', (raw: Buffer | string, isBinary?: boolean) => {
    if (isBinary) return;
    const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str) as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
        if (msg.type === 'input' && typeof msg.data === 'string') { run.input(msg.data); return; }
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') { run.resize(msg.cols, msg.rows); return; }
        if (msg.type === 'interrupt') { run.interrupt(); return; }
        return; // ack, focus: nothing to do for a run
      } catch { /* raw input */ }
    }
    run.input(str);
  });
  const detach = () => { offOut(); offExit(); };
  ws.on('close', detach);
  ws.on('error', detach);
  return detach;
}

interface CardRequest { sessionId: string; cardRef: string; start: boolean; withheld: boolean; rerun: boolean }

function readCardRequest(url: URL): CardRequest | null {
  const sessionId = url.searchParams.get('session') ?? '';
  const cardRef = url.searchParams.get('card') ?? '';
  if (!isSessionUuid(sessionId) || !CARD_REF_RE.test(cardRef)) return null;
  return {
    sessionId,
    cardRef,
    start: url.searchParams.get('start') === '1',
    withheld: url.searchParams.get('withheld') === '1',
    rerun: url.searchParams.get('rerun') === '1',
  };
}

async function upgradeTo(req: IncomingMessage, socket: Duplex, head: Buffer, then: (ws: WS) => void): Promise<void> {
  let WebSocketServer: typeof import('ws').WebSocketServer;
  try { ({ WebSocketServer } = await import('ws')); } catch { rejectUpgrade(socket, 501); return; }
  new WebSocketServer({ noServer: true }).handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => { /* the close that follows is what counts */ });
    then(ws);
  });
}

/**
 * Read a session's older cards back from its transcript (after a restart) before a lookup or a
 * snapshot, once per process. Gated on "read back yet", never on "has records": a resumed chat
 * that posts a new card first must still get its older ones (the rebuild merges). Every reader
 * of the records goes through here: the phone and Mac terminals, the secret route, the cards
 * GET and the chat socket's `cards` frame.
 */
export function ensureCards(sessionId: string): void {
  if (isRebuilt(sessionId)) return;
  const entry = getChat(sessionId);
  const vault = entry?.vault;
  if (!vault) return;
  const root = resolveVaultProjectRoot(vault);
  if (!root) return;
  const path = liveTranscriptPath(join(root, '_dream_context'), entry?.conversationId || sessionId);
  if (!path) return;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024 * 1024) return;
    rebuildCards(sessionId, vault, readFileSync(path, 'utf-8'));
  } catch { /* unreadable transcript: no records */ }
}

/**
 * The record a card action names, `(posting session, cardRef)` (sahip-karti-yerinde K1): a crew
 * child's owner card resolves through its item's card handle (`ensureCardsFor`: the handle's own
 * transcript, no live chat, after a restart, a park, a succession or a `/clear`); any other card
 * through the chat's own rebuild. `lookup` is the crew card's owner item, or null (today's path).
 */
export function resolveCardRecord(sessionId: string, cardRef: string): { rec: CardRecordEntry | null; lookup: OwnerCardLookup | null } {
  const lookup = ownerCardLookup(sessionId, cardRef);
  if (lookup) {
    const rec = ensureCardsFor(lookup.handle, resolveVaultProjectRoot(lookup.handle.vault));
    if (rec) return { rec, lookup };
  }
  ensureCards(sessionId);
  return { rec: getCard(sessionId, cardRef), lookup };
}

type CardRootResolver = (rec: Pick<CardRecordEntry, 'sessionId' | 'vault'>) => Promise<string | null>;

/**
 * The folder a card runs in and writes its secret under (K5, D5): `cardWorkingRoot` for the
 * POSTING session, read from the server's state at action time, never from a request or a card.
 * It is proven by the governed repository (the project's or a linked repo's own `git worktree
 * list` names it), wherever it lives on disk. Null when it is refused (a symlink, a folder that is
 * not a worktree root, an ungoverned repository's checkout, a folder that is gone) or the project
 * is unknown: the action does not happen.
 */
const realCardRoot: CardRootResolver = async (rec) => {
  const projectRoot = runProjectRootOf(rec.vault);
  if (!projectRoot) return null;
  try { return await cardWorkingRoot(join(projectRoot, '_dream_context'), projectRoot, rec.sessionId); } catch { return null; }
};
let cardRootResolver: CardRootResolver = realCardRoot;
export function cardRootOf(rec: Pick<CardRecordEntry, 'sessionId' | 'vault'>): Promise<string | null> {
  return cardRootResolver(rec);
}
/** Tests: where cards run (null restores the real `cardWorkingRoot`). */
export function setCardRootResolverForTests(fn: CardRootResolver | null): void { cardRootResolver = fn ?? realCardRoot; }

/** The folder a press is refused for, as the refusal names it (the folder it would be now). */
export type PressFolder = { path: string; name: string } | null;
export type PressRootResult = { ok: true; root: string } | { ok: false; why: 'folder_changed' | 'no_folder'; current: PressFolder };

const realOrSame = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };

/**
 * THE one layer for "the folder the owner SAW is the folder that runs or is written to" (end
 * review r2). Every press resolves the card's folder NOW (`cardRootOf`) and compares it, by real
 * path, with the folder that surface drew (`shownRoot`): the ticket mint, a run start at the ws
 * upgrade (the root the ticket bound), the phone's start, the secret submit and the Telegram Run
 * press. A difference refuses (`folder_changed`, with the folder it is now); a missing drawn
 * folder refuses; nothing is ever re-resolved silently. Only this function picks a press's root.
 */
export async function pressRoot(rec: Pick<CardRecordEntry, 'sessionId' | 'vault'>, shownRoot: string | null | undefined): Promise<PressRootResult> {
  const root = await cardRootOf(rec);
  if (!root) return { ok: false, why: 'no_folder', current: null };
  const current = { path: root, name: basename(root) };
  if (typeof shownRoot !== 'string' || !shownRoot) return { ok: false, why: 'folder_changed', current };
  if (realOrSame(shownRoot) !== realOrSame(root)) return { ok: false, why: 'folder_changed', current };
  return { ok: true, root };
}

/** The HTTP body of a refused press (409). */
export function folderRefusalBody(r: Extract<PressRootResult, { ok: false }>): { error: 'folder_changed'; folder: PressFolder; message: string } {
  return {
    error: 'folder_changed',
    folder: r.current,
    message: r.current ? `This card's folder changed: it is now ${r.current.name}. Look again, then press.` : 'This card\'s folder could not be checked, so nothing ran.',
  };
}

/** What the surface may show of a card's folder (the bar, the slot): its path and its name. */
export async function cardFolderOf(rec: Pick<CardRecordEntry, 'sessionId' | 'vault'>): Promise<{ path: string; name: string } | null> {
  const root = await cardRootOf(rec);
  return root ? { path: root, name: basename(root) } : null;
}

/** A ws start refused because the folder the owner saw is not the folder now: the socket opens and
 *  closes with this code and the reason `folder_changed` (the client re-reads the card's state). */
export const FOLDER_CHANGED_CLOSE = 4412;

/** Refusal as an HTTP status (or `folder_changed`), or the run to serve and whether THIS request
 *  started it (an attach, the raced one included, never counts as started). A start runs only in
 *  the folder the press drew (`pressRoot`). */
async function runFor(c: CardRequest, by: 'mac' | 'phone', rec: CardRecordEntry, shownRoot: string | null | undefined): Promise<{ run: Run; started: boolean } | number | 'folder_changed'> {
  const live = attachRun(c.sessionId, c.cardRef);
  if (live) return { run: live, started: false };
  if (!c.start) return 409;
  if (by === 'phone' && rec.state === 'closed') return 409;
  // What is shown is what runs (K4): no start, from any surface, of a command that can draw as
  // something else. Attaching to a run already going is unaffected.
  if (!commandShowableAsIs((rec.spec as RunViewSpec).command)) return 409;
  const press = await pressRoot(rec, shownRoot);
  if (!press.ok) return 'folder_changed';
  const root = press.root;
  // Another start may have raced the await: attach to it rather than refuse.
  const raced = attachRun(c.sessionId, c.cardRef);
  if (raced) return { run: raced, started: false };
  const r = startRun(c.sessionId, c.cardRef, by, { withheld: c.withheld, rerun: by === 'mac' && c.rerun, root });
  if ('refused' in r) return r.refused === 'no_pty' ? 501 : r.refused === 'no_record' ? 404 : r.refused === 'bad_cwd' ? 400 : 409;
  // No await since the raced check: a run returned here is the one this request spawned.
  return { run: r, started: r.startedBy === by };
}

/** Which ticket actions an upgrade of this card accepts now: attaching to the card's own live
 *  run takes any of its tickets; otherwise a closed record takes a `rerun`, an open one a `start`. */
export function ticketActionsFor(rec: CardRecordEntry, live: boolean): CardTicketAction | readonly CardTicketAction[] {
  if (live) return ['attach', 'start', 'rerun'];
  return rec.state === 'closed' ? 'rerun' : 'start';
}

/**
 * The Mac's chat-host mode of `/api/agent/terminal` (`attachAgentTerminal` delegates here when
 * the URL names a `card`, AFTER its desktop + loopback + strict-same-origin gate). Gate G1: the
 * `ticket` is spent first, before anything starts, attaches or replays; no ticket, a reused or
 * expired one, one for another card or action, or one whose drawn command is not the record's:
 * 403, no byte of the run reaches the socket.
 */
export function handleMacCardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
  const c = readCardRequest(url);
  if (!c) { rejectUpgrade(socket, 400); return; }
  const ticket = url.searchParams.get('ticket');
  const { rec } = resolveCardRecord(c.sessionId, c.cardRef);
  if (!rec || rec.kind !== 'run') {
    // Spent anyway: a ticket never outlives a refused upgrade.
    consumeCardTicket(ticket, { project: '', postingSession: c.sessionId, cardRef: c.cardRef, action: 'start', command: '' });
    rejectUpgrade(socket, 404);
    return;
  }
  const t = consumeCardTicket(ticket, {
    project: rec.vault,
    postingSession: rec.sessionId,
    cardRef: rec.cardRef,
    action: ticketActionsFor(rec, !!attachRun(c.sessionId, c.cardRef)),
    command: (rec.spec as RunViewSpec).command,
  });
  if (!t.ok) { rejectUpgrade(socket, 403); return; }
  void (async () => {
    // The start runs only in the folder the ticket bound at mint (the folder the owner saw).
    const got = await runFor(c, 'mac', rec, t.binding.root).catch(() => 500);
    if (got === 'folder_changed') { void upgradeTo(req, socket, head, closeFolderChanged); return; }
    if (typeof got === 'number') { rejectUpgrade(socket, got); return; }
    void upgradeTo(req, socket, head, (ws) => serveRunSocket(ws, got.run));
  })();
}

/** Open, then close with `folder_changed`: nothing ran, no byte of any run was sent. */
function closeFolderChanged(ws: WS): void {
  try { ws.close(FOLDER_CHANGED_CLOSE, 'folder_changed'); } catch { /* closing */ }
}

// ─── The phone ──────────────────────────────────────────────────────────────

const phoneStarts = new Map<string, number[]>();
/** Phone sockets, by device: cut on logout/revoke. */
const phoneSockets = new Set<{ idHash: string; ws: WS; spawned: Run | null }>();
let revokeArmed = false;

function armRevoke(): void {
  if (revokeArmed) return;
  revokeArmed = true;
  onDeviceSessionsChanged(() => { cutRevokedPhoneRuns(); });
}

/** Close every phone run socket whose device is no longer valid; kill what it started. */
export function cutRevokedPhoneRuns(isValid?: (idHash: string) => boolean): number {
  const valid = isValid ?? ((h: string) => {
    try { return macHandsfreeAuth().store.isValidDeviceHash(h); } catch { return false; }
  });
  let n = 0;
  for (const s of [...phoneSockets]) {
    if (valid(s.idHash)) continue;
    phoneSockets.delete(s);
    // Detach first (unbind the handler), then close, then kill what it started (H8).
    s.ws.removeAllListeners('message');
    try { s.ws.close(DEVICE_REVOKED_CLOSE, 'signed out'); } catch { /* closing */ }
    if (s.spawned && s.spawned.startedBy === 'phone') s.spawned.kill();
    n++;
  }
  return n;
}

function rateOk(idHash: string, now = Date.now()): boolean {
  const list = (phoneStarts.get(idHash) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= PHONE_STARTS_PER_MIN) { phoneStarts.set(idHash, list); return false; }
  list.push(now);
  phoneStarts.set(idHash, list);
  return true;
}

/** The phone listener's run-terminal upgrade (H8). The listener's gate ran first; again here. */
export function handlePhoneRunUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  let url: URL;
  try { url = new URL(req.url || '/', `http://${req.headers.host}`); } catch { socket.destroy(); return; }
  if (url.pathname !== PHONE_RUN_TERMINAL_PATH) return;
  if (!isPhoneSocket(req) || !isMacOriginAllowed(req)) { rejectUpgrade(socket, 403); return; }
  const auth = authFor(req);
  const idHash = deviceIdHash(req);
  if (!auth || !idHash || !auth.store.isValidDeviceHash(idHash)) { rejectUpgrade(socket, 401); return; }
  const c = readCardRequest(url);
  if (!c) { rejectUpgrade(socket, 400); return; }
  const { rec } = resolveCardRecord(c.sessionId, c.cardRef);
  // The project is the RECORD's, and it must be one the phone was given (I5).
  if (!rec || rec.kind !== 'run' || !isMacExposed(rec.vault)) { rejectUpgrade(socket, 404); return; }
  if (rec.state === 'closed') { rejectUpgrade(socket, 409); return; }
  const wouldStart = !attachRun(c.sessionId, c.cardRef);
  if (wouldStart && c.start && !rateOk(idHash)) { rejectUpgrade(socket, 409); return; }
  void (async () => {
    // The phone's own scope (its device session is owner proof); the run now starts in the
    // card's working folder (K5), and a crew card's result is held like any other (K6).
    // The phone is an owner surface like the Mac (end review r3): it is SHOWN the card's folder
    // (`folders` in GET /api/agent/cards) and presses with it (`root`). No root, no start.
    const got = await runFor(c, 'phone', rec, url.searchParams.get('root')).catch(() => 500);
    if (got === 'folder_changed') { void upgradeTo(req, socket, head, closeFolderChanged); return; }
    if (typeof got === 'number') { rejectUpgrade(socket, got); return; }
    armRevoke();
    void upgradeTo(req, socket, head, (ws) => {
      // Only a run THIS phone request spawned is the device's to kill on a revoke: one the Mac
      // started during the folder await is attached, never recorded as phone-spawned.
      const entry = { idHash, ws, spawned: got.started ? got.run : null };
      phoneSockets.add(entry);
      serveRunSocket(ws, got.run);
      ws.on('close', () => { phoneSockets.delete(entry); });
    });
  })();
}

/** Attach the phone run-terminal handler to the phone listener's server. */
export function attachPhoneRunTerminal(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => handlePhoneRunUpgrade(req, socket, head));
}

// ─── GET /api/agent/cards?session= ─────────────────────────────────────────

/**
 * The open and closed run/secret records of one chat, for a mount or reload (I1, J4). The
 * desktop owner page (desktop, loopback, strict same origin) or a phone with a device session,
 * for a chat of an exposed project only (else 404). Never a path, never more than the agent wrote.
 */
export async function handleAgentCards(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const phone = isPhoneSocket(req);
  if (phone) {
    const idHash = deviceIdHash(req);
    if (!idHash || !authFor(req)?.store.isValidDeviceHash(idHash)) { sendError(res, 401, 'unauthorized', 'Sign in again.'); return; }
  } else if (!isDesktop() || !isLoopback(req) || !isSameOriginStrict(req)) {
    sendError(res, 403, 'forbidden', 'Available only in the desktop app.');
    return;
  }
  const url = new URL(req.url || '/', 'http://x');
  const sessionId = url.searchParams.get('session') ?? '';
  if (!isSessionUuid(sessionId)) { sendError(res, 400, 'bad_session', 'A chat session id is required.'); return; }
  ensureCards(sessionId);
  const first = listCards(sessionId)[0];
  const vault = getChat(sessionId)?.vault ?? (first ? getCard(sessionId, first.cardRef)?.vault : null) ?? null;
  if (phone && (!vault || !isMacExposed(vault))) { sendError(res, 404, 'not_found', 'No such chat.'); return; }
  const cards = listCards(sessionId);
  if (!phone) { sendJson(res, 200, { session: sessionId, cards }); return; }
  // The phone (passphrase-proven, end review r3) is SHOWN each run and secret card's folder, as
  // the Mac is through GET /api/agent/cards/state (which stays Mac-only): `folders[cardRef]` is
  // `{ path, name }`, or null when it cannot be proven (or the secret belongs to an app). The phone
  // presses with that `path` as `root`; `pressRoot` checks it like any press.
  const folders: Record<string, { path: string; name: string } | null> = {};
  await Promise.all(cards.map(async (c) => {
    const rec = getCard(sessionId, c.cardRef);
    if (!rec || (rec.kind !== 'run' && rec.kind !== 'secret')) return;
    folders[c.cardRef] = rec.kind === 'secret' && (rec.spec as { app?: string }).app ? null : await cardFolderOf(rec).catch(() => null);
  }));
  sendJson(res, 200, { session: sessionId, cards, folders });
}

/** Wire the registry to the real machine (server start). */
export async function wireRunRegistry(): Promise<void> {
  const [{ configureRuns, nodePtySpawner }, { loadNodePty, execShellArgs, resolveContainedDir }, { trackChild }, { claudeAwarePath }, { runDelivery }] = await Promise.all([
    import('../runs/registry.js'),
    import('./agent-terminal.js'),
    import('../lifecycle.js'),
    import('../../lib/claude-path.js'),
    import('../runs/delivery.js'),
  ]);
  configureRuns({
    spawner: nodePtySpawner(loadNodePty, execShellArgs, claudeAwarePath),
    projectRootOf: (vault) => resolveVaultProjectRoot(vault),
    resolveCwd: resolveContainedDir,
    delivery: runDelivery,
    trackChild,
  });
}

/** Tests only. */
export function _resetPhoneRunsForTests(): void { phoneSockets.clear(); phoneStarts.clear(); }
