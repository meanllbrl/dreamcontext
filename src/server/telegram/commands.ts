/**
 * Native Telegram gestures mapped to the Super's own paths (plan M4, M6, N5, N6, P4).
 *
 *  - A reply to a bot message → `[Reply to message ref=<msgRef of that transcript item> from=super]`
 *    + its quote, built by the hub (never from Telegram's `reply_to_message` text); a reply to
 *    the owner's own earlier Telegram message → `from=owner` with that turn's ref.
 *  - `/dur`: the window's `hub_command interrupt` (what Esc does: interrupt + pause the queue);
 *    the injector's `interrupt()` only when no window is mounted (P4: one interrupt).
 *  - `/durum`: job rows (children + team jobs, every state), what waits on the owner, the pool.
 *  - `/gundem`: ONE message; each line waiting on the owner is one button. A tap turns the same
 *    message into that line in full with **Bitti** (the same `padMove` the Mac's Done calls, no
 *    turn), **Yaz** (the owner's next text carries the Mac's `[About agenda line note=…]` block;
 *    5 minutes) and **Gündeme dön**. Running and finished lines are one quiet line.
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
import { type ButtonRecord, type StatusState } from '../../lib/telegram/contract.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { statusLineHtml } from '../../lib/telegram/system-lines.js';
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
  noWindow: "Super Mac'te açık değil; durduracak bir şey yok.",
  emptyAgenda: 'Gündem boş.',
  nothingWaiting: 'Seni bekleyen iş yok.',
  waitingCount: (n: number) => `Seni bekleyen ${n} iş`,
  running: (n: number) => `${n} iş sürüyor`,
  finishedToday: (n: number) => `bugün ${n} iş bitti`,
  justDone: (line: string) => `✓ ${line} bitti`,
  doneBtn: '✓ Bitti',
  writeBtn: '✎ Yaz',
  backBtn: '‹ Gündeme dön',
  writeNext: (line: string) => `Yaz: sonraki mesajın bu satır hakkında olacak (5 dk): «${line}»`,
  superOpened: "Super açıldı; Mac'te açık olan sekmeler buraya devredilmedi.",
  tabCap: "Mac'te sekme sınırı dolu.",
  reversing: "Mac'te geçiş sürüyor; birazdan tekrar dene.",
  cannotOpen: "Super Mac'te açılamadı; uygulamaya bakıp tekrar dene.",
} as const;


/** One waiting line as the button record keeps it (callback data never carries it). */
interface AgendaLine { id: string; section: string; text: string; at?: number }
/** One message holds this many lines (Telegram: 100 buttons, 2-digit button index). */
const AGENDA_MAX = 30;
const AGENDA_LABEL = 40;
/** Month + the ablative suffix Turkish needs after it (Ocak'tan, Eylül'den). */
const MONTHS = ["Ocak'tan", "Şubat'tan", "Mart'tan", "Nisan'dan", "Mayıs'tan", "Haziran'dan", "Temmuz'dan", "Ağustos'tan", "Eylül'den", "Ekim'den", "Kasım'dan", "Aralık'tan"];

/** The tapped line in full: its first words bold when it reads "title: rest"; its age only when it is old. */
function itemHtml(row: AgendaLine, nowMs: number): string {
  const full = cleanTitle(row.text, 600);
  const cut = full.indexOf(': ');
  const text = cut > 0 && cut <= 60 ? `<b>${escapeHtml(full.slice(0, cut))}</b>\n${escapeHtml(full.slice(cut + 2))}` : `<b>${escapeHtml(full)}</b>`;
  if (!row.at || nowMs - row.at < 24 * 3600_000) return text;
  const d = new Date(row.at);
  return `${text}\n<i>${d.getDate()} ${MONTHS[d.getMonth()]} beri seni bekliyor</i>`;
}

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
    return parts.join('\n\n');
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
    if (!s?.enabled || !s.session) { await hub.notice(ab, 'info', LINES.superOff); return; }
    const chat = getChat(s.session);
    if (!chat || chat.status === 'idle' || chat.status === 'gone') { await hub.notice(ab, 'info', CMD_LINES.nothingRunning); return; }
    const token = superTokenOfSession(s.session);
    if (token) {
      const r = await sendHubCommand(token, 'interrupt', {}).catch(() => ({ ok: false as const, error: 'failed' }));
      if (r.ok) { await hub.notice(ab, 'info', CMD_LINES.stopped); return; }
    }
    const inj = chatInjector(s.session);
    if (!inj) { await hub.notice(ab, 'info', CMD_LINES.noWindow); return; }
    inj.interrupt();
    await hub.notice(ab, 'info', CMD_LINES.stopped);
  }

  async function status(ab: ActiveBinding): Promise<void> {
    const s = await superState(ab);
    if (!s?.enabled || !s.session) { await hub.notice(ab, 'info', LINES.superOff); return; }
    await hub.send(ab, statusText(s, ab.contextRoot!));
  }

  /** The agenda as the owner reads it: only what waits on HIM is a button (one per line, cut);
   *  the Super's own Now lines and the finished ones are one quiet line. `justDone` = the line
   *  that was just finished (it replaces the quiet line once). */
  function agendaView(s: SuperState, justDone?: string): { html: string; labels: string[][]; lines: AgendaLine[] } {
    const pad = (s.pad ?? []).filter((p) => p.text.trim());
    const waiting = pad.filter((p) => p.section === 'waiting');
    const shown = waiting.slice(0, AGENDA_MAX);
    const running = pad.filter((p) => p.section === 'now').length;
    const finished = pad.filter((p) => p.section === 'done').length;
    const quiet = [running ? CMD_LINES.running(running) : '', finished ? CMD_LINES.finishedToday(finished) : ''].filter(Boolean).join(' · ');
    const head = waiting.length ? CMD_LINES.waitingCount(waiting.length) : CMD_LINES.nothingWaiting;
    const html = [`<b>${escapeHtml(head)}</b>`, justDone ? `<i>${escapeHtml(CMD_LINES.justDone(cleanTitle(justDone, 40)))}</i>` : quiet ? `<i>${escapeHtml(quiet)}</i>` : '']
      .filter(Boolean).join('\n');
    return {
      html,
      labels: shown.map((p) => [cleanTitle(p.text, AGENDA_LABEL)]),
      lines: shown.map((p) => ({ id: p.id, section: p.section, text: p.text, at: p.at })),
    };
  }

  async function agenda(ab: ActiveBinding): Promise<void> {
    const s = await superState(ab);
    if (!s?.enabled || !s.session) { await hub.notice(ab, 'info', LINES.superOff); return; }
    const v = agendaView(s);
    if (!v.labels.length) { await hub.send(ab, v.html); return; }
    await hub.sendButtons(ab, v.html, v.labels, { kind: 'agenda', singleUse: false }, { view: 'list', lines: v.lines });
  }

  /** The list drawn again on the SAME message (back, after Bitti); no waiting line left → the empty state, no buttons. */
  async function showList(ab: ActiveBinding, messageId: number, justDone?: string): Promise<boolean> {
    const s = await superState(ab);
    if (!s) return false;
    const v = agendaView(s, justDone);
    if (!v.labels.length) return hub.closeAnswered(ab, messageId, v.html);
    return hub.editButtons(ab, messageId, v.html, v.labels, { kind: 'agenda', singleUse: false }, { view: 'list', lines: v.lines });
  }

  async function agendaButton(ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string | null> {
    if (!ab.contextRoot) return LINES.stale;
    if (rec.data?.view === 'item') {
      const row = obj(rec.data?.row) as unknown as AgendaLine | null;
      if (!row) return LINES.stale;
      if (idx === 2) return (await showList(ab, rec.messageId)) ? null : LINES.stale;
      if (idx === 0) {
        // The Telegram owner (owner-checked by the hub): his Done rides his next message (owner-marks.ts).
        const r = await padMove(ab.contextRoot, row.id, 'done', 'main', { mark: true });
        if (!r.found) return LINES.stale;
        return (await showList(ab, rec.messageId, row.text)) ? CMD_LINES.doneBtn : `${CMD_LINES.doneBtn} (Mac'te de görünür)`;
      }
      if (idx !== 1) return LINES.stale;
      const block = agendaNoteBlock(row.id, row.section, row.text);
      if (!block) return LINES.stale;
      capture.set(ab.key, { kind: 'about', block, at: now() });
      await hub.notice(ab, 'wait', CMD_LINES.writeNext(cleanTitle(row.text, 120)));
      return CMD_LINES.writeBtn;
    }
    const rows = Array.isArray(rec.data?.lines) ? (rec.data!.lines as AgendaLine[]) : [];
    const row = rows[idx];
    if (!row) return LINES.stale;
    const ok = await hub.editButtons(ab, rec.messageId, itemHtml(row, now()), [[CMD_LINES.doneBtn, CMD_LINES.writeBtn], [CMD_LINES.backBtn]], { kind: 'agenda', singleUse: false }, { view: 'item', row });
    return ok ? null : LINES.stale;
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
    if (!token) { await hub.notice(ab, 'warn', CMD_LINES.cannotOpen, true); return '✗'; }
    const r = await sendHubCommand(token, 'super_handover', { adopt: [] }, { timeoutMs: 30_000 }).catch(() => ({ ok: false as const, error: 'failed' }));
    if (!r.ok) {
      const why = String((r as { reason?: unknown }).reason ?? r.error);
      await hub.notice(ab, 'warn', why === 'tab_cap' ? CMD_LINES.tabCap : why === 'reversing' ? CMD_LINES.reversing : CMD_LINES.cannotOpen, true);
      return '✗';
    }
    await hub.notice(ab, 'info', CMD_LINES.superOpened);
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
    rows.push(statusLineHtml(state, cleanTitle(c.brief || 'iş', 60)));
  }
  for (const j of s.team.slice(0, 10)) {
    let st = 'running';
    try { st = teamJobStatus(contextRoot, j, null).status; } catch { /* running */ }
    if (st === 'done') continue;
    const state: StatusState = st === 'failed' ? 'stuck' : st === 'asking' ? 'asking' : 'running';
    rows.push(statusLineHtml(state, cleanTitle(`${j.member}: ${j.brief || ''}`, 60)));
  }
  const waiting = s.queue.filter((q) => q.state !== 'done' && ['ask', 'question', 'permission', 'approval', 'owner'].includes(q.kind)).slice(0, 8)
    .map((q) => `✋ ${escapeHtml(cleanTitle(redactSecrets(q.ownerText ?? q.brief ?? q.kind), 80))}`);
  const out = [`<b>İşler</b>`, ...(rows.length ? rows : ['Çalışan iş yok.'])];
  if (waiting.length) out.push('', '<b>Seni bekleyenler</b>', ...waiting);
  if (s.pool.length) out.push('', `<b>Sırada</b> (${s.pool.length})`, ...s.pool.slice(0, 5).map((p) => `• ${escapeHtml(cleanTitle(p.title, 80))}`));
  return out.join('\n');
}
