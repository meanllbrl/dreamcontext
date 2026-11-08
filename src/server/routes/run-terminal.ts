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
 */
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { CARD_REF_RE, getCard, isRebuilt, isSessionUuid, listCards, rebuildCards, type CardRecordEntry } from '../../lib/cards/records.js';
import { PHONE_RUN_TERMINAL_PATH } from '../../lib/telegram/contract.js';
import { attachRun, startRun, type Run } from '../runs/registry.js';
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

/** Refusal as an HTTP status, or the run to serve. */
function runFor(c: CardRequest, by: 'mac' | 'phone', rec: CardRecordEntry): Run | number {
  const live = attachRun(c.sessionId, c.cardRef);
  if (live) return live;
  if (!c.start) return 409;
  if (by === 'phone' && rec.state === 'closed') return 409;
  const r = startRun(c.sessionId, c.cardRef, by, { withheld: c.withheld, rerun: by === 'mac' && c.rerun });
  if ('refused' in r) return r.refused === 'no_pty' ? 501 : r.refused === 'no_record' ? 404 : r.refused === 'bad_cwd' ? 400 : 409;
  return r;
}

/**
 * The Mac's chat-host mode of `/api/agent/terminal` (`attachAgentTerminal` delegates here when
 * the URL names a `card`, AFTER its desktop + loopback + strict-same-origin gate).
 */
export function handleMacCardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
  const c = readCardRequest(url);
  if (!c) { rejectUpgrade(socket, 400); return; }
  ensureCards(c.sessionId);
  const rec = getCard(c.sessionId, c.cardRef);
  if (!rec || rec.kind !== 'run') { rejectUpgrade(socket, 404); return; }
  const run = runFor(c, 'mac', rec);
  if (typeof run === 'number') { rejectUpgrade(socket, run); return; }
  void upgradeTo(req, socket, head, (ws) => serveRunSocket(ws, run));
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
  ensureCards(c.sessionId);
  const rec = getCard(c.sessionId, c.cardRef);
  // The project is the RECORD's, and it must be one the phone was given (I5).
  if (!rec || rec.kind !== 'run' || !isMacExposed(rec.vault)) { rejectUpgrade(socket, 404); return; }
  if (rec.state === 'closed') { rejectUpgrade(socket, 409); return; }
  const wouldStart = !attachRun(c.sessionId, c.cardRef);
  if (wouldStart && c.start && !rateOk(idHash)) { rejectUpgrade(socket, 409); return; }
  const run = runFor(c, 'phone', rec);
  if (typeof run === 'number') { rejectUpgrade(socket, run); return; }
  armRevoke();
  void upgradeTo(req, socket, head, (ws) => {
    const entry = { idHash, ws, spawned: wouldStart ? run : null };
    phoneSockets.add(entry);
    serveRunSocket(ws, run);
    ws.on('close', () => { phoneSockets.delete(entry); });
  });
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
  sendJson(res, 200, { session: sessionId, cards: listCards(sessionId) });
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
