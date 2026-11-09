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

/** Status rows go out silently: only the real reply buzzes. */
export const SILENT = { disable_notification: true } as const;
