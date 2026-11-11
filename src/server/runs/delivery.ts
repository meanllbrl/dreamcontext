/**
 * Where a server-owned run's report goes (plan H5, I4, J1, K1).
 *
 *  - A run started from TELEGRAM in a Super chat (not a Mac "Run again"): through the hub, as an
 *    owner turn under a fresh Telegram ref whose pending entry is `{kind: 'run-report', cardRef}`,
 *    so the Super's answer to it goes back to Telegram and `writeOwnerTurn` reads the source from
 *    the honoured entry, never from the text.
 *  - Every other run: the chat's own window, `hub_command run_report`; the window posts it into
 *    the conversation exactly as the Mac card used to (its `[ran in chat]` line answers the wait).
 *  - No window mounted: the report is HELD, on disk (machine-local, per session, 0600), and
 *    delivered when the chat's window mounts again, a restart included. The record is already
 *    closed (J1), so nothing can run the card twice meanwhile.
 *
 * THE HELD FILE IS THE OUTBOX. A run's entry is written the moment it STARTS (a "cut off"
 * report) and replaced by the real report at its exit, both synchronously, before any await:
 * a server that is killed mid-run, or exits while a delivery is in flight, still owes the agent
 * its report after the restart. An entry leaves the file only once delivered. Sends for one chat
 * run one at a time and re-check the file first, so two window mounts never post one report twice.
 *
 * A CREW CHILD's card (sahip-karti-yerinde K6: a child of main or of a member Super, the card an
 * owner item stands for, `ownerCardLookup` non-null) never takes this file: its placeholder and
 * its report are held in the server's receipt store (`owner-receipts.ts`, keyed by the item's
 * `deliverTo` child, per-boot MAC), then handed to `deliverOwnerReceipt`. A first run, a Mac
 * rerun and a phone-started run alike. Every other host (a plain chat, the Super's own card, a
 * Telegram-started Super run) keeps the path above.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSessionUuid, type CardRecordEntry } from '../../lib/cards/records.js';
import { buildInterruptedReport } from '../../lib/run-report.js';
import { sendHubCommand, superTokenOfSession, tokenOfSession } from '../../lib/window-control.js';
import type { RunReport } from '../../lib/telegram/contract.js';
import { runOfSession, type Run, type RunDelivery } from './registry.js';
import { deliverOwnerReceipt, holdOwnerReceipt, ownerCardLookup } from '../owner-receipts.js';

export interface TelegramRunSink {
  /** True when the hub took the report (a Telegram-started run of a bound Super). */
  deliverRunReport(sessionId: string, cardRef: string, text: string): Promise<boolean>;
}

let telegramSink: TelegramRunSink | null = null;
export function setTelegramRunSink(s: TelegramRunSink | null): void { telegramSink = s; }

let heldHome: string | null = null;
export function setHeldHomeForTests(home: string | null): void { heldHome = home; }

const MAX_HELD = 8;
/**
 * One outbox entry is one RUN (`id` = its runId): a newer run of the same card never replaces an
 * older undelivered report, and a send removes only the entry it actually sent.
 */
interface Held {
  id: string;
  cardRef: string;
  text: string;
  at: number;
  /** The run is (or was, before a crash) still going: its "cut off" placeholder. */
  pending?: true;
}

function heldPath(sessionId: string): string | null {
  if (!isSessionUuid(sessionId)) return null;
  return join(heldHome ?? homedir(), '.dreamcontext', 'cards', `${sessionId.toLowerCase()}.held.json`);
}

export function readHeld(sessionId: string): Held[] {
  const p = heldPath(sessionId);
  if (!p || !existsSync(p)) return [];
  try {
    if (lstatSync(p).isSymbolicLink()) return [];
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((h): h is Held => !!h && typeof (h as Held).text === 'string' && typeof (h as Held).cardRef === 'string')
      .map((h) => ({ ...h, id: typeof h.id === 'string' && h.id ? h.id : h.cardRef }))
      .slice(-MAX_HELD);
  } catch { return []; }
}

function writeHeld(sessionId: string, list: Held[]): void {
  const p = heldPath(sessionId);
  if (!p) return;
  try {
    if (!list.length) { if (existsSync(p) && !lstatSync(p).isSymbolicLink()) rmSync(p); return; }
    const dir = join(p, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || (existsSync(p) && lstatSync(p).isSymbolicLink())) return;
    const tmp = `${p}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify(list.slice(-MAX_HELD))); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
  } catch { /* a held report that could not be written: the record is closed regardless */ }
}

function windowToken(sessionId: string): string | null {
  return superTokenOfSession(sessionId) ?? tokenOfSession(sessionId);
}

/** Hand one report to the chat's window. True = posted. */
async function toWindow(sessionId: string, cardRef: string, report: Pick<RunReport, 'text'>): Promise<boolean> {
  const token = windowToken(sessionId);
  if (!token) return false;
  const r = await sendHubCommand(token, 'run_report', { sessionId, cardRef, report: { text: report.text } });
  return r.ok === true;
}

/** Put (or replace) ONE RUN's entry in the outbox. Synchronous on purpose. */
export function holdReport(sessionId: string, runId: string, cardRef: string, text: string, pending?: true): void {
  writeHeld(sessionId, [...readHeld(sessionId).filter((h) => h.id !== runId), { id: runId, cardRef, text, at: Date.now(), ...(pending ? { pending } : {}) }]);
}

/** Remove the entry that was SENT: same run, same text (a placeholder replaced by the real report
 *  while it was in flight stays, and goes next). */
function dropSent(sessionId: string, sent: Held): void {
  const held = readHeld(sessionId);
  const next = held.filter((h) => !(h.id === sent.id && h.text === sent.text));
  if (next.length !== held.length) writeHeld(sessionId, next);
}

function heldEntry(sessionId: string, id: string): Held | null {
  return readHeld(sessionId).find((h) => h.id === id) ?? null;
}

// One send at a time per chat: the exit's delivery and a window mount's flush never race.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  chains.set(sessionId, tail);
  void tail.then(() => { if (chains.get(sessionId) === tail) chains.delete(sessionId); });
  return next;
}

export function deliverReport(run: Pick<Run, 'runId' | 'sessionId' | 'cardRef' | 'startedBy' | 'rerun'>, report: RunReport): Promise<'telegram' | 'window' | 'held' | 'sent'> {
  // In the outbox before the first await: the process may exit from here on.
  holdReport(run.sessionId, run.runId, run.cardRef, report.text);
  return serial(run.sessionId, async () => {
    // Read again: a window that mounted meanwhile may have posted it already.
    const h = heldEntry(run.sessionId, run.runId);
    if (!h) return 'sent' as const;
    if (run.startedBy === 'telegram' && !run.rerun && telegramSink) {
      try {
        if (await telegramSink.deliverRunReport(run.sessionId, run.cardRef, h.text)) { dropSent(run.sessionId, h); return 'telegram' as const; }
      } catch { /* fall back to the window */ }
    }
    if (await toWindow(run.sessionId, run.cardRef, h).catch(() => false)) { dropSent(run.sessionId, h); return 'window' as const; }
    return 'held' as const;
  });
}

/** A run still going in THIS process: its placeholder is not owed yet. */
function stillRunning(sessionId: string, id: string): boolean {
  const r = runOfSession(sessionId);
  return !!r && r.runId === id && !r.ended();
}

/** A chat's window mounted (agent-chat, once its window channel exists): post what was held.
 *  Each entry is read again right before its send (a run may have ended, and replaced its
 *  placeholder with the real report, while an earlier send was in flight). */
export function flushHeldReports(sessionId: string): Promise<number> {
  return serial(sessionId, async () => {
    let sent = 0;
    for (const id of readHeld(sessionId).map((h) => h.id)) {
      const h = heldEntry(sessionId, id);
      if (!h || (h.pending && stillRunning(sessionId, id))) continue;
      if (await toWindow(sessionId, h.cardRef, h).catch(() => false)) { sent++; dropSent(sessionId, h); }
    }
    return sent;
  });
}

/** Tests: the last crew delivery started, so a test can await it. */
let lastCrewDelivery: Promise<unknown> = Promise.resolve();
export function _lastCrewDeliveryForTests(): Promise<unknown> { return lastCrewDelivery; }

export const runDelivery: RunDelivery = {
  started(run: Run, record: CardRecordEntry) {
    const text = buildInterruptedReport((record.spec as { command: string }).command);
    const crew = ownerCardLookup(run.sessionId, run.cardRef);
    if (crew) {
      // K6: the run's own `pending` entry, held before `markCardStarted` (the registry calls this
      // first). Never delivered while the run lives in this boot; its report replaces it by runId.
      holdOwnerReceipt(crew.target, { id: run.runId, cardRef: run.cardRef, kind: 'run', text, pending: true });
      return;
    }
    holdReport(run.sessionId, run.runId, run.cardRef, text, true);
  },
  hold(run: Run, _record: CardRecordEntry, report: RunReport) {
    const crew = ownerCardLookup(run.sessionId, run.cardRef);
    // Same id: the placeholder goes. Before the record closes (the registry calls this first).
    if (crew) holdOwnerReceipt(crew.target, { id: run.runId, cardRef: run.cardRef, kind: 'run', text: report.text });
    else holdReport(run.sessionId, run.runId, run.cardRef, report.text);
  },
  report(run: Run, _record: CardRecordEntry, report: RunReport) {
    const crew = ownerCardLookup(run.sessionId, run.cardRef);
    if (crew) {
      // Held already (`hold`, before the record closed): delivered to the child that asked (its
      // successor after a hand-off), whichever surface started the run.
      lastCrewDelivery = deliverOwnerReceipt(crew.target).catch(() => 'held');
      return;
    }
    void deliverReport(run, report).catch(() => { /* held on disk; the next mount sends it */ });
  },
};
