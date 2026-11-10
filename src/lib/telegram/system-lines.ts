// The bot's own lines (a voice echo, a job status row) are quieter than the agent's real reply:
// one shared formatter for every bot, Super and member. Telegram HTML; `telegramHtmlToPlain`
// turns each into the same words in the same order when Telegram refuses the entities.

import { STATUS_GLYPH, STATUS_LABEL, type StatusState } from './contract.js';
import { escapeHtml } from './format.js';

/** A job name longer than this is cut with an ellipsis: a status row stays one line. */
export const STATUS_NAME_MAX = 50;
/** A transcript this long is cut (the message limit is 4096 with the markup). */
export const VOICE_ECHO_MAX = 3000;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : one;
}

/** The transcript echo: a small label, then the words in one expandable italic quote, so the
 *  bubble shows two lines and opens on tap. */
export function voiceEchoHtml(spoken: string): string {
  const body = Array.from(spoken.trim()).slice(0, VOICE_ECHO_MAX).join('');
  return `🎙 <i>Duyduğum</i>\n<blockquote expandable><i>${escapeHtml(body)}</i></blockquote>`;
}

/** A job row: icon first, the name in italic, the status word after a dot. No bold. */
export function statusLineHtml(state: StatusState, name: string, note?: string): string {
  const extra = note ? ` · ${escapeHtml(note)}` : '';
  return `${STATUS_GLYPH[state]} <i>${escapeHtml(clip(name, STATUS_NAME_MAX))}</i> · ${STATUS_LABEL[state]}${extra}`;
}

/** A permission prompt (the Super's own and a child's, one shape): the ask in bold on its own
 *  line, the job it is for under it, then the exact command. `text` is already redacted. */
export function permissionHtml(toolName: string, text: string, job?: string): string {
  const jobLine = job?.trim() ? `\n<i>${escapeHtml(clip(job, 60))}</i>` : '';
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
