/**
 * What of the Super's text may reach the owner (Doc's 7-day friction report, 2026-11-18,
 * finding 2): his language. The briefing already said "write in his language", and the Super
 * broke it 26 times a day to a Turkish owner ("The Revenue Administration has sent you one
 * e-notice a month since June…"), with the `<owner-language>` note in the very turn. A rule that
 * lives only in a prompt is a rule nothing enforces, so this is the server's check:
 *
 *  - the Telegram hub holds a section not in his language (`telegramHold`), so it never reaches
 *    the phone;
 *  - the chat route, at the turn's end, hands the Super ONE hidden note naming what was held and
 *    asking it to write that answer again, in his language (`ownerTextFeedback`).
 *
 * A wrong language needs a clear majority of the other language's own words (quotes left out),
 * never a few English terms in a Turkish sentence.
 *
 * Not here (owner 2026-11-19, at the review's stop: "Daralt: bu kuralı tamamen çıkar"): holding
 * a reply that only points back to an earlier message, or says nothing changed. Four review
 * rounds showed no detector tells such a line from a short result in two languages, and a line
 * too many costs him less than a result never sent. It is a follow-up of its own.
 */
import { languageVotes, type OwnerLanguage } from './owner-language.js';

/** The Super's reply marks and notch cues, and fenced blocks: never part of what he reads. */
function plain(text: string): string {
  return (text ?? '')
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*$/gm, '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .trim();
}

/** Quoted spans ("…", “…”, ‘…’, «…»): an error message or a title he is shown verbatim, never
 *  the language the Super writes him in. A straight ' is Turkish grammar (PR'ı), never a quote. */
function unquoted(t: string): string {
  return t.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»|`[^`\n]*`/g, ' ');
}

/** The other language, clearly: his language is known and the text's own words (quotes left out)
 *  are mostly the other one (at least 4 words of it and more than twice his). A few English terms
 *  in Turkish pass, and so does a Turkish answer quoting an English error. */
export function inWrongLanguage(text: string, lang: OwnerLanguage | null | undefined): boolean {
  if (!lang) return false;
  const v = languageVotes(unquoted(plain(text)));
  const [his, other] = lang === 'Turkish' ? [v.tr, v.en] : [v.en, v.tr];
  return other >= 4 && other > 2 * his;
}

export type HoldReason = 'language';

/** Why one section of the Super's text must not reach the phone, or null when it may go. */
export function telegramHold(text: string, opts: { lang?: OwnerLanguage | null }): HoldReason | null {
  return inWrongLanguage(text, opts.lang) ? 'language' : null;
}

/** The tag of the Super's hidden correction turn's part (inside the card-feedback turn). */
export const OWNER_TEXT_GATE_TAG = 'owner-text-gate';

/**
 * The hidden note for one finished Super turn, or null when every owner-facing text passed.
 * `texts`: the main agent's text blocks of the turn, in order. Owner-facing = the turn's last text
 * and every text written for him (a reply mark or real length, `isOwnerProse`). Each is judged in
 * the SAME units the phone holds it by: `sections` cuts a text into its reply sections (the hub's
 * `splitReplySections`), so a section the hub held is a section asked for again (review r1,
 * held-without-retell).
 */
export function ownerTextFeedback(texts: readonly string[], opts: { lang?: OwnerLanguage | null; isOwnerProse: (t: string) => boolean; sections?: (t: string) => string[] }): string | null {
  const split = opts.sections ?? ((t: string) => [t]);
  const facing = texts
    .filter((t, i) => plain(t) && (i === texts.length - 1 || opts.isOwnerProse(t)))
    .flatMap((t) => split(t))
    .filter((t) => plain(t));
  const lines: string[] = [];
  if (opts.lang && facing.some((t) => inWrongLanguage(t, opts.lang))) {
    lines.push(`Your last answer to him was not in ${opts.lang}. He writes ${opts.lang}, and his phone did not get it. Write that same answer again, in ${opts.lang} only, as short as it was.`);
  }
  if (!lines.length) return null;
  return [`<${OWNER_TEXT_GATE_TAG}>`, ...lines, 'Do not mention this note itself.', `</${OWNER_TEXT_GATE_TAG}>`].join('\n');
}
