// The bot's own lines (a voice echo, a job status row) are quieter than the agent's real reply:
// one shared formatter for every bot, Super and member. Telegram HTML; `telegramHtmlToPlain`
// turns each into the same words in the same order when Telegram refuses the entities.

import { STATUS_GLYPH, STATUS_LABEL, type StatusState } from './contract.js';
import { escapeHtml, redactSecrets } from './format.js';

/** A job name longer than this is cut with an ellipsis: a status row stays one line. */
export const STATUS_NAME_MAX = 50;
/** A transcript this long is cut (the message limit is 4096 with the markup). */
export const VOICE_ECHO_MAX = 3000;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : one;
}

/** The transcript echo (owner 2026-11-21: "sesli yankı kalabilir… collapsible; tıklamazsam küçük
 *  kalır"): ONE folded quote whose first line is the "🎙 Duyduğum" label, the words after it on a
 *  single line, so the closed bubble stays small and a tap opens the whole transcript. */
export function voiceEchoHtml(spoken: string): string {
  const body = Array.from(spoken.replace(/\s+/g, ' ').trim()).slice(0, VOICE_ECHO_MAX).join('');
  return `<blockquote expandable>🎙 <i>Duyduğum:</i> ${escapeHtml(body)}</blockquote>`;
}

/** A job row: icon first, the name in italic, the status word after a dot. No bold. */
export function statusLineHtml(state: StatusState, name: string, note?: string): string {
  const extra = note ? ` · ${escapeHtml(note)}` : '';
  return `${STATUS_GLYPH[state]} <i>${escapeHtml(clip(name, STATUS_NAME_MAX))}</i> · ${STATUS_LABEL[state]}${extra}`;
}

/** A closed card shows at most this many visible characters. */
export const CLOSED_CARD_MAX = 60;

/** What a card is about, from its own text: its first line, the "❓" and bold gone. */
export function cardAbout(textOrHtml: string): string {
  const plain = textOrHtml.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return (plain.split('\n').find((l) => l.trim()) ?? '').replace(/^[\s❓🔐✋⏰]+/u, '').trim();
}

/**
 * A card once it is closed (Doc 2026-11-21, C3: 155 closed cards stayed in the chat in full): ONE
 * line, at most 60 visible characters, what happened in bold and what it was about after it
 * ("✓ Cevaplandı: Yeşil · Hangi renk?"). The question itself is gone; the answer stays.
 */
export function closedCardHtml(head: string, about = ''): string {
  const h = clip(redactSecrets(head), CLOSED_CARD_MAX);
  const room = CLOSED_CARD_MAX - Array.from(h).length - 3;
  const a = about && room >= 8 ? clip(redactSecrets(about), room) : '';
  return `<b>${escapeHtml(h)}</b>${a ? ` · <i>${escapeHtml(a)}</i>` : ''}`;
}

/** A job status message holds at most this many visible characters (its oldest steps go first). */
export const JOB_STATUS_MAX = 1200;

/**
 * One job's status message (owner 2026-11-21: "bir mesaj at, o işe çalışılıyor; gelişme oldu mu
 * o mesajı güncelliyor"), drawn from the Super's `dream-status` block: the job's name in bold,
 * what is being done now, then one ✓ line per finished step; done = the name and its result
 * line. The hub sends it once and edits that same message in place (silently) on every update.
 */
export function jobStatusHtml(lines: readonly string[], done: boolean): string {
  const clean = lines.map((l) => redactSecrets(l).replace(/^\s*(?:[-*•]|✓|✔|✅|⏳|\d{1,2}[.)])\s*/u, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const name = clip(clean[0] ?? 'İş', STATUS_NAME_MAX);
  const now = clean[1] ? clip(clean[1], 160) : '';
  if (done) return `✅ <b>${escapeHtml(name)}</b>${now ? `\n${escapeHtml(now)}` : ''}`;
  const steps = clean.slice(2).map((s) => `✓ ${escapeHtml(clip(s, 120))}`);
  const head = `⏳ <b>${escapeHtml(name)}</b>${now ? `\n<i>${escapeHtml(now)}</i>` : ''}`;
  // The newest steps stay when it grows long: a status says where the job is now.
  let shown = steps;
  let cut = false;
  const size = (rows: readonly string[]): number => Array.from([head, ...rows].join('\n').replace(/<[^>]+>/g, '')).length;
  while (shown.length && size(shown) > JOB_STATUS_MAX) { shown = shown.slice(1); cut = true; }
  return [head, ...(cut ? ['✓ …'] : []), ...shown].join('\n');
}

/** A permission prompt (the Super's own and a child's, one shape): the ask in bold on its own
 *  line, the job it is for under it, then the exact command. `text` is already redacted. */
export function permissionHtml(toolName: string, text: string, job?: string): string {
  const jobLine = job?.trim() ? `\n<i>${escapeHtml(clip(redactSecrets(job), 60))}</i>` : '';
  return `🔐 <b>İzin istiyor: ${escapeHtml(toolName)}</b>${jobLine}\n<pre>${escapeHtml(text.slice(0, 1500))}</pre>`;
}

/** Status rows go out silently: only the real reply buzzes. */
export const SILENT = { disable_notification: true } as const;

/** A system notice: a meaning emoji, then one plain sentence in italic (what happened and, if any,
 *  what he can do). The one shape every fixed warning/info line of every bot goes through. */
export type NoticeKind = 'info' | 'warn' | 'file' | 'phone' | 'access' | 'wait';
export const NOTICE_EMOJI: Record<NoticeKind, string> = { info: 'ℹ️', warn: '⚠️', file: '📎', phone: '📱', access: '🔒', wait: '⏳' };

export function noticeHtml(kind: NoticeKind, sentence: string): string {
  return `${NOTICE_EMOJI[kind]} <i>${escapeHtml(sentence.replace(/\s+/g, ' ').trim())}</i>`;
}

/** A spoken summary that could not be made (voice-reply.ts): the summary follows as text. */
export const VOICE_SUMMARY_LINES = {
  no_key: "Sesli özet için ses anahtarı yok: Mac'te Ayarlar › Ses › OpenRouter anahtarı. Yazıyla:",
  no_ffmpeg: 'Sesli özet için ffmpeg gerekli (Mac\'te brew install ffmpeg). Yazıyla:',
  failed: 'Sesli özet şu an hazırlanamadı. Yazıyla:',
  too_long: 'Sesli özet çok uzun oldu. Yazıyla:',
} as const;

/** The caption under a voice bubble: one line, the title escaped. */
export function voiceCaptionHtml(title: string): string {
  const t = clip(redactSecrets(title || ''), 64);
  return `🔊 ${escapeHtml(t || 'Sesli özet')}`;
}
