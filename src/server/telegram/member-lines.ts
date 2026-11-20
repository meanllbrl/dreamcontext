/**
 * The lines a member's item leads with on Telegram (plan super-v3 Ü6, K10). Only the Super's bot
 * sends (rule pntigf67lj); a member's wait opens with the member's name in BOLD, its words after
 * it ("<b>Sage</b> bir rutin istiyor"). Every name and word is redacted, then escaped: none of it
 * is trusted HTML. Pure.
 */
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';

/** A routine fact that is an approval of the routine itself (a new routine, or a changed one): its
 *  automation card goes out whole, never a summary line (consent is given on what was shown). */
export function routineIsApproval(fact: string | undefined): boolean {
  return !!fact && /^(not-approved|change-pending):/.test(fact);
}

const clean = (s: string, max: number) => redactSecrets(s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);

/** "<b>Sage</b> <words>": the bold name, then the plain rest. No name: the words alone. */
export function memberLeadHtml(who: string | null | undefined, words: string): string {
  const name = clean(who ?? '', 60);
  const rest = escapeHtml(clean(words, 600));
  return name ? `<b>${escapeHtml(name)}</b> ${rest}` : rest;
}
