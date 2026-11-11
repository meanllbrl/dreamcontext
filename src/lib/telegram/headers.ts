/**
 * The Super's native headers, built by the hub exactly as the Mac builds them (plan M4, N6):
 * a reply (`replyAboutBlock`) and an agenda note (`agendaAboutBlock`'s note branch), server
 * MIRRORS of `dashboard/src/components/sleepy/super/superHandover.ts` (drift test
 * `tests/unit/telegram-headers.test.ts`). Only these hub-built headers are real: every
 * Telegram-origin text has its own header-shaped lines neutralised first (`inbound.ts`).
 */
import { msgRef } from '../super/types.js';

/** `MAX_REPLY_QUOTE` / `MAX_ABOUT_LINE` (dashboard/src/lib/superTypes.ts). */
export const MAX_REPLY_QUOTE = 100;
export const MAX_ABOUT_LINE = 200;
const ABOUT_ID = /^[A-Za-z0-9_-]{1,40}$/;

function flat(text: string, max: number): string {
  const one = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return Array.from(one).slice(0, max).join('').trim();
}

/** `[Reply to message ref=… from=…]` + `quote: "…"`; `ref` given (a Telegram turn's own) or hashed. */
export function replyAboutBlock(refText: string, from: 'super' | 'owner', quoteText: string = refText, ref?: string): string {
  return `[Reply to message ref=${ref ?? msgRef(refText)} from=${from}]\nquote: ${JSON.stringify(flat(quoteText, MAX_REPLY_QUOTE))}`;
}

/** `[About agenda line item=<id> section=<section>]`, no second line (a question's words are not
 *  his); '' for a bad id. A Telegram reply to a question card's own message (owner 2026-11-11). */
export function agendaItemBlock(item: string, section: 'waiting' | 'now'): string {
  return ABOUT_ID.test(item) ? `[About agenda line item=${item} section=${section}]` : '';
}

/** `[About agenda line note=<id> section=<section>]` + `line: "<its words>"`; '' for a bad id. */
export function agendaNoteBlock(note: string, section: string, text: string): string {
  if (!ABOUT_ID.test(note)) return '';
  return `[About agenda line note=${note} section=${section}]\nline: ${JSON.stringify(flat(text, MAX_ABOUT_LINE))}`;
}
