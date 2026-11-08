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
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSessionUuid, type CardRecordEntry } from '../../lib/cards/records.js';
import { sendHubCommand, superTokenOfSession, tokenOfSession } from '../../lib/window-control.js';
import type { RunReport } from '../../lib/telegram/contract.js';
import type { Run, RunDelivery } from './registry.js';

export interface TelegramRunSink {
  /** True when the hub took the report (a Telegram-started run of a bound Super). */
  deliverRunReport(sessionId: string, cardRef: string, text: string): Promise<boolean>;
}

let telegramSink: TelegramRunSink | null = null;
export function setTelegramRunSink(s: TelegramRunSink | null): void { telegramSink = s; }

let heldHome: string | null = null;
export function setHeldHomeForTests(home: string | null): void { heldHome = home; }

const MAX_HELD = 8;
interface Held { cardRef: string; text: string; at: number }

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
    return Array.isArray(raw) ? raw.filter((h): h is Held => !!h && typeof (h as Held).text === 'string' && typeof (h as Held).cardRef === 'string').slice(-MAX_HELD) : [];
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

export async function deliverReport(run: Pick<Run, 'sessionId' | 'cardRef' | 'startedBy' | 'rerun'>, report: RunReport): Promise<'telegram' | 'window' | 'held'> {
  if (run.startedBy === 'telegram' && !run.rerun && telegramSink) {
    try { if (await telegramSink.deliverRunReport(run.sessionId, run.cardRef, report.text)) return 'telegram'; } catch { /* fall back to the window */ }
  }
  if (await toWindow(run.sessionId, run.cardRef, report).catch(() => false)) return 'window';
  writeHeld(run.sessionId, [...readHeld(run.sessionId).filter((h) => h.cardRef !== run.cardRef), { cardRef: run.cardRef, text: report.text, at: Date.now() }]);
  return 'held';
}

/** A chat's window mounted (agent-chat, once its window channel exists): post what was held. */
export async function flushHeldReports(sessionId: string): Promise<number> {
  const held = readHeld(sessionId);
  if (!held.length) return 0;
  let sent = 0;
  const left: Held[] = [];
  for (const h of held) {
    if (await toWindow(sessionId, h.cardRef, h).catch(() => false)) sent++;
    else left.push(h);
  }
  writeHeld(sessionId, left);
  return sent;
}

export const runDelivery: RunDelivery = {
  report(run: Run, _record: CardRecordEntry, report: RunReport) {
    void deliverReport(run, report);
  },
};
