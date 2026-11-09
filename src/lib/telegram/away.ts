/**
 * Telegram while the app is quit (plan G5, A6, F1, F4, F5, F6; W2 lane B). Called once per
 * launchd tick (`tickAll`), so it works on a machine with no routines.
 *
 * The server is alive only if `handsfree-mac/server.json` names a live pid whose command is our
 * node/dreamcontext server (guards pid reuse). Then the hub serves and this does nothing.
 *
 * Server dead:
 *  - every bound bot (never the manager): take the token's poll lock, `getUpdates(timeout=0)`
 *    WITHOUT confirming the offset, and answer each authorized message ONCE (`notifiedIds`):
 *    "Mac'e şu an ulaşılamıyor …; bu mesaj işlenmeyecek". Nothing is queued: the hub's start
 *    drain later confirms them unprocessed.
 *  - hands-free left on by the dead server and not yet announced: write the marker
 *    `telegram-ended.json {startedAt}` FIRST, re-read `startedAt` (a new run? skip), restore
 *    power (`sudo -n`), stop OUR cloudflared, and send ONE message to the bot that started it.
 *    Never writes `state.json`; boot recovery still runs in full and skips only that message.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readMacState, readTelegramEnded, telegramEndedPathOf } from '../handsfree/mac/session.js';
import * as power from '../handsfree/mac/power.js';
import { isOurCloudflared } from '../handsfree/mac/tunnel.js';
import { POLL_RING_SIZE } from './contract.js';
import { bindingDir, listBindings, readBinding, readPollState, writePollState } from './config.js';
import { isAuthorized, type TgUpdateLike } from './auth.js';
import { escapeHtml } from './format.js';
import { TelegramPoller } from './poller.js';
import { TelegramTransport, type FetchLike } from './transport.js';

export const AWAY_LINE = "Mac'e şu an ulaşılamıyor (uygulama kapalı ya da Mac uyuyor). Bu mesaj işlenmeyecek; Mac açılınca yeniden yaz.";
export const AWAY_ENDED_LINE = 'Hands-free kapandı: uygulama kapandı. Mac uyuyabilir.';

export interface AwayDeps {
  home?: string;
  fetchImpl?: FetchLike;
  isAlive?: (pid: number) => boolean;
  commandOf?: (pid: number) => string;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  powerRun?: power.PowerRunner;
  log?: (line: string) => void;
}

const defaultAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const defaultCommandOf = (pid: number): string => {
  try { return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
};

/** Our desktop server: a live pid running node/dreamcontext (pid reuse guarded, A6). */
export function serverAlive(home: string, deps: Pick<AwayDeps, 'isAlive' | 'commandOf'> = {}): boolean {
  let pid: unknown;
  try { pid = (JSON.parse(readFileSync(join(home, '.dreamcontext', 'handsfree-mac', 'server.json'), 'utf8')) as { pid?: unknown }).pid; } catch { return false; }
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  if (!(deps.isAlive ?? defaultAlive)(pid as number)) return false;
  return /\b(node|dreamcontext)\b/.test((deps.commandOf ?? defaultCommandOf)(pid as number));
}

export async function telegramAwayTick(deps: AwayDeps = {}): Promise<void> {
  const home = deps.home ?? homedir();
  if (serverAlive(home, deps)) return;
  await recoverDeadHandsfree(home, deps);
  for (const row of listBindings(home)) {
    if (!row.read.ok) continue;
    await noticeAway(home, row.scope, row.target, row.read.binding, deps).catch((err) => deps.log?.(`[telegram] away notice failed: ${(err as Error)?.message ?? err}`));
  }
}

async function noticeAway(home: string, scope: string, target: string, b: { token: string; chatId: number; userId: number }, deps: AwayDeps): Promise<void> {
  const dir = bindingDir(scope, target, home);
  const transport = new TelegramTransport({ token: b.token, fetchImpl: deps.fetchImpl });
  const lock = new TelegramPoller({ transport, token: b.token, state: { read: () => readPollState(dir, home), write: () => {} }, allowedUpdates: [], onUpdate: async () => 'accepted', home });
  if (!lock.acquire()) return; // the server (or another tick) polls this token
  try {
    const state = readPollState(dir, home);
    const batch = (await transport.getUpdates({ offset: state.offset, timeout: 0, allowed_updates: ['message', 'callback_query'] })) as Record<string, unknown>[];
    const notified = [...state.notifiedIds];
    for (const u of batch) {
      const id = Number(u.update_id);
      if (!Number.isSafeInteger(id) || notified.includes(id) || state.seenIds.includes(id)) continue;
      // A reaction (still delivered after the server asked for it) is no message he expects an answer to.
      if (!u.message && !u.callback_query) continue;
      if (!isAuthorized(u as unknown as TgUpdateLike, b)) continue;
      notified.push(id);
      await transport.sendMessage(b.chatId, escapeHtml(AWAY_LINE)).catch(() => {});
    }
    if (notified.length !== state.notifiedIds.length) writePollState(dir, { ...readPollState(dir, home), notifiedIds: notified.slice(-POLL_RING_SIZE) }, home);
  } finally {
    lock.release();
  }
}

async function recoverDeadHandsfree(home: string, deps: AwayDeps): Promise<void> {
  const s = readMacState(home);
  if (!s || readTelegramEnded(home) === s.startedAt) return;
  // The marker FIRST (F6): a crash after it loses at most the message, never doubles it.
  writeTelegramJsonAt(telegramEndedPathOf(home), { startedAt: s.startedAt });
  const again = readMacState(home);
  if (!again || again.startedAt !== s.startedAt) return;
  try { await power.restorePower(s.priorLpm, deps.powerRun); } catch { deps.log?.('[telegram] power restore after a dead server failed; boot recovery retries it'); }
  const alive = deps.isAlive ?? defaultAlive;
  if (s.tunnelPid && alive(s.tunnelPid) && isOurCloudflared((deps.commandOf ?? defaultCommandOf)(s.tunnelPid), home)) {
    try { (deps.kill ?? ((p, sig) => process.kill(p, sig)))(s.tunnelPid, 'SIGTERM'); } catch { /* gone */ }
  }
  if (!s.startedVia) return;
  const b = readBinding(s.startedVia.scope, s.startedVia.target, home);
  if (!b.ok) return;
  const t = new TelegramTransport({ token: b.binding.token, fetchImpl: deps.fetchImpl });
  await t.sendMessage(b.binding.chatId, escapeHtml(AWAY_ENDED_LINE)).catch(() => {});
}

/** The marker sits in the hands-free folder, not under telegram/: written atomically at 0600. */
function writeTelegramJsonAt(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

