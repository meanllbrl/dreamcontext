/**
 * Native Telegram gestures mapped to the Super's own paths (plan M4, M6, N5, N6, P4).
 *
 *  - A reply to a bot message → `[Reply to message ref=<msgRef of that transcript item> from=super]`
 *    + its quote, built by the hub (never from Telegram's `reply_to_message` text); a reply to
 *    the owner's own earlier Telegram message → `from=owner` with that turn's ref.
 *  - `/dur`: the window's `hub_command interrupt` (what Esc does: interrupt + pause the queue);
 *    the injector's `interrupt()` only when no window is mounted (P4: one interrupt).
 *  - `/durum`: job rows (children + team jobs, every state), what waits on the owner, the pool.
 *  - `/gundem`: the agenda (Now / Waiting / Done) with **Bitti** (the same `padMove` the Mac's
 *    Done calls, no turn) and **Yaz** (the owner's next text carries the Mac's
 *    `[About agenda line note=…]` block; 5 minutes) per open line.
 *  - Super off → "Bu projede Super kapalı" + **Super'i aç**: the window's own hand-over adopting
 *    nothing (`hub_command super_handover`); no window → the project is opened and the command
 *    sent once a chat of it mounts.
 * Every button goes through the hub's live button record (single use, message-bound).
 */
import { chatInjector, getChat, listChats } from '../../lib/assistant/chat-registry.js';
import { appLinkForContextRoot } from '../../lib/app-link.js';
import { padMove } from '../../lib/super/pad-move.js';
import { readSuperState } from '../../lib/super/store.js';
import { teamJobStatus } from '../../lib/super/team.js';
import type { SuperState } from '../../lib/super/types.js';
import { STATUS_GLYPH, STATUS_LABEL, type ButtonRecord, type StatusState } from '../../lib/telegram/contract.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { agendaNoteBlock, replyAboutBlock } from '../../lib/telegram/headers.js';
import { cleanTitle } from '../../lib/telegram/urls.js';
import { sendHubCommand, superTokenOfSession, tokenOfSession } from '../../lib/window-control.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';
import { NextTextCapture } from './capture.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

export const CMD_LINES = {
  stopped: 'Durduruldu.',
  nothingRunning: 'Şu an çalışan bir iş yok.',
  noWindow: "Super Mac'te açık değil.",
  emptyAgenda: 'Gündem boş.',
  writeNext: (line: string) => `Yaz: sonraki mesajın bu satır hakkında olacak (5 dk).\n«${line}»`,
  superOpened: "Super açıldı. Açık sekmeler devredilmedi.",
  tabCap: "Mac'te sekme sınırı dolu.",
  reversing: "Mac'te geçiş sürüyor, birazdan tekrar dene.",
  cannotOpen: "Super'i Mac'te açamadım. Mac'te uygulamaya bak.",
} as const;


export interface CommandsDeps {
  /** The bot's one next-text capture (shared with rich asks' Not ekle, capture.ts). */
  capture?: NextTextCapture;
  now?: () => number;
  openLink?: (url: string) => void;
  /** How long to wait for a window of the project to mount (Super'i aç). */
  windowWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function wireCommands(hub: TelegramHub, deps: CommandsDeps = {}): () => void {
  const now = deps.now ?? hub.now;
  /** The agenda line the owner's next text is about (Yaz): the bot's one capture slot. */
  const capture = deps.capture ?? new NextTextCapture(now);

  const prevCommand = hub.commandHook;
  hub.commandHook = async (ab, u) => {
    if (prevCommand && await prevCommand(ab, u)) return true;
    const text = String(obj(u.message)?.text ?? '').trim();
    const m = /^\/(dur|durum|gundem)(?:@\w+)?(?:\s|$)/i.exec(text);
    if (!m || ab.target !== 'super') return false;
    const cmd = m[1].toLowerCase();
    if (cmd === 'dur') await stop(ab);
    else if (cmd === 'durum') await status(ab);
    else await agenda(ab);
    return true;
  };

  const prevPrefix = hub.turnPrefix;
  hub.turnPrefix = (ab, msg) => {
    const parts: string[] = [];
    const pre = prevPrefix ? prevPrefix(ab, msg) : '';
    if (pre) parts.push(pre);
    if (capture.peek(ab.key)?.kind === 'about') {
      const c = capture.take(ab.key);
      if (c?.kind === 'about') parts.push(c.block);
    }
    const replyTo = Number(obj(msg.reply_to_message)?.message_id);
    const r = Number.isSafeInteger(replyTo) ? hub.replyOf(ab, replyTo) : null;
    if (r) parts.push(replyAboutBlock(r.quote, r.from, r.quote, r.ref));
    return parts.join('\n');
  };

  const prevButton = hub.extraButton;
  hub.extraButton = async (ab, rec, idx) => {
    const d = rec.data ?? {};
    if (rec.kind === 'agenda') return agendaButton(ab, rec, idx);
    if (rec.kind === 'confirm' && d.action === 'super-on') return turnOn(ab);
    return prevButton ? prevButton(ab, rec, idx) : LINES.stale;
  };

  const prevOff = hub.superOff;
  hub.superOff = async (ab) => {
    if (prevOff) { await prevOff(ab); return; }
    await hub.sendButtons(ab, escapeHtml(LINES.superOff), [["Super'i aç"]], { kind: 'confirm', singleUse: true }, { action: 'super-on' });
  };

  async function superState(ab: ActiveBinding): Promise<SuperState | null> {
    if (!ab.contextRoot) return null;
    try { return await readSuperState(ab.contextRoot); } catch { return null; }
  }

  async function stop(ab: ActiveBinding): Promise<void> {
    const s = await superState(ab);
    if (!s?.enabled || !s.session) { await hub.reply(ab, LINES.superOff); return; }
    const chat = getChat(s.session);
    if (!chat || chat.status === 'idle' || chat.status === 'gone') { await hub.reply(ab, CMD_LINES.nothingRunning); return; }
    const token = superTokenOfSession(s.session);
    if (token) {
      const r = await sendHubCommand(token, 'interrupt', {}).catch(() => ({ ok: false as const, error: 'failed' }));
      if (r.ok) { await hub.reply(ab, CMD_LINES.stopped); return; }
    }
    const inj = chatInjector(s.session);
    if (!inj) { await hub.reply(ab, CMD_LINES.noWindow); return; }
    inj.interrupt();
    await hub.reply(ab, CMD_LINES.stopped);
  }

  async function status(ab: ActiveBinding): Promise<void> {
    const s = await superState(ab);
    if (!s?.enabled || !s.session) { await hub.reply(ab, LINES.superOff); return; }
    await hub.send(ab, statusText(s, ab.contextRoot!));
  }

  async function agenda(ab: ActiveBinding): Promise<void> {
    const s = await superState(ab);
    if (!s?.enabled || !s.session) { await hub.reply(ab, LINES.superOff); return; }
    const pad = (s.pad ?? []).filter((p) => p.text.trim());
    if (!pad.length) { await hub.reply(ab, CMD_LINES.emptyAgenda); return; }
    const sections: [string, string][] = [['now', 'Şimdi'], ['waiting', 'Seni bekliyor'], ['done', 'Bitti']];
    const lines: string[] = [];
    const open = pad.filter((p) => p.section !== 'done').slice(0, 10);
    for (const [key, word] of sections) {
      const rows = pad.filter((p) => p.section === key).slice(-10);
      if (!rows.length) continue;
      lines.push(`<b>${escapeHtml(word)}</b>`);
      for (const p of rows) lines.push(`${open.includes(p) ? `${open.indexOf(p) + 1}. ` : '• '}${escapeHtml(cleanTitle(p.text, 120))}`);
    }
    const labels = open.map((p, i) => [`${i + 1} Bitti`, `${i + 1} Yaz`]);
    if (!labels.length) { await hub.send(ab, lines.join('\n')); return; }
    await hub.sendButtons(ab, lines.join('\n'), labels, { kind: 'agenda', singleUse: false },
      { lines: open.map((p) => ({ id: p.id, section: p.section, text: p.text })) });
  }

  async function agendaButton(ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string | null> {
    const rows = Array.isArray(rec.data?.lines) ? (rec.data!.lines as { id: string; section: string; text: string }[]) : [];
    const row = rows[Math.floor(idx / 2)];
    if (!row || !ab.contextRoot) return LINES.stale;
    if (idx % 2 === 0) {
      const r = await padMove(ab.contextRoot, row.id, 'done');
      return r.found ? `✓ Bitti: ${cleanTitle(row.text, 60)}` : LINES.stale;
    }
    const block = agendaNoteBlock(row.id, row.section, row.text);
    if (!block) return LINES.stale;
    capture.set(ab.key, { kind: 'about', block, at: now() });
    await hub.reply(ab, CMD_LINES.writeNext(cleanTitle(row.text, 120)));
    return '✎ Yaz';
  }

  /** Super'i aç: the window's own hand-over, adopting nothing (N5). */
  async function turnOn(ab: ActiveBinding): Promise<string | null> {
    if (!ab.contextRoot) return LINES.stale;
    const before = await superState(ab);
    if (before?.enabled && before.session) return 'Super zaten açık.';
    let token = vaultToken(ab.projectName);
    if (!token) {
      const link = appLinkForContextRoot(ab.contextRoot, { kind: 'project' });
      if (link) { try { (deps.openLink ?? hub.deps.openLink ?? (() => {}))(link); } catch { /* the wait times out */ } }
      const until = now() + (deps.windowWaitMs ?? 45_000);
      const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      while (!token && now() < until) { await sleep(500); token = vaultToken(ab.projectName); }
    }
    if (!token) { await hub.reply(ab, CMD_LINES.cannotOpen); return '✗'; }
    const r = await sendHubCommand(token, 'super_handover', { adopt: [] }, { timeoutMs: 30_000 }).catch(() => ({ ok: false as const, error: 'failed' }));
    if (!r.ok) {
      const why = String((r as { reason?: unknown }).reason ?? r.error);
      await hub.reply(ab, why === 'tab_cap' ? CMD_LINES.tabCap : why === 'reversing' ? CMD_LINES.reversing : CMD_LINES.cannotOpen);
      return '✗';
    }
    await hub.reply(ab, CMD_LINES.superOpened);
    return "✓ Super'i aç";
  }

  return () => {
    hub.commandHook = prevCommand;
    hub.turnPrefix = prevPrefix;
    hub.extraButton = prevButton;
    hub.superOff = prevOff;
    capture.clear();
  };
}

/** A live window socket of the project (any chat of it): the hand-over runs in that window. */
function vaultToken(vault: string): string | null {
  for (const c of listChats({ vault })) {
    const t = tokenOfSession(c.sessionId);
    if (t) return t;
  }
  return null;
}

/** /durum: every job row, what waits on the owner, the pool. */
export function statusText(s: SuperState, contextRoot: string): string {
  const rows: string[] = [];
  for (const c of Object.values(s.children)) {
    if (c.endedAt) continue;
    const live = getChat(c.sessionId);
    const state: StatusState = live?.pendingQuestion?.isPermission ? 'waiting' : c.row === 'working' ? 'running' : c.row === 'asking' ? 'asking'
      : c.row === 'done' ? 'done' : c.row === 'stuck' ? 'stuck' : c.row === 'gone' ? 'gone' : c.row === 'waiting' ? 'waiting' : 'running';
    rows.push(`${STATUS_GLYPH[state]} ${escapeHtml(cleanTitle(c.brief || 'iş', 60))} · ${STATUS_LABEL[state]}`);
  }
  for (const j of s.team.slice(0, 10)) {
    let st = 'running';
    try { st = teamJobStatus(contextRoot, j, null).status; } catch { /* running */ }
    if (st === 'done') continue;
    const state: StatusState = st === 'failed' ? 'stuck' : st === 'asking' ? 'asking' : 'running';
    rows.push(`${STATUS_GLYPH[state]} ${escapeHtml(cleanTitle(`${j.member}: ${j.brief || ''}`, 60))} · ${STATUS_LABEL[state]}`);
  }
  const waiting = s.queue.filter((q) => q.state !== 'done' && ['ask', 'question', 'permission', 'approval', 'owner'].includes(q.kind)).slice(0, 8)
    .map((q) => `✋ ${escapeHtml(cleanTitle(redactSecrets(q.ownerText ?? q.brief ?? q.kind), 80))}`);
  const out = [`<b>İşler</b>`, ...(rows.length ? rows : ['Çalışan iş yok.'])];
  if (waiting.length) out.push('', '<b>Seni bekleyenler</b>', ...waiting);
  if (s.pool.length) out.push('', `<b>Sırada</b> (${s.pool.length})`, ...s.pool.slice(0, 5).map((p) => `• ${escapeHtml(cleanTitle(p.title, 80))}`));
  return out.join('\n');
}
