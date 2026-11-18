/**
 * What of the Super's text may reach the owner (Doc's 7-day friction report, 2026-11-18).
 *
 * The briefing already said "never point him above", "write nothing for an event that repeats
 * a result he already has" and "write in his language", and the Super broke all three dozens of
 * times a day: 22 "I wrote it above" lines a day (58 on 15 Nov), seven of them in a row in one
 * Tilki morning, even as the answer to "ne durumdayız"; 26 English messages a day to a Turkish
 * owner ("The Revenue Administration has sent you one e-notice a month since June…"), with the
 * `<owner-language>` note in the very turn. A rule that lives only in a prompt is a rule nothing
 * enforces, so these are the server's checks, read by every surface that carries the Super's
 * words to him:
 *
 *  - the Telegram hub holds a section that fails one (`telegramHold`), so it never reaches the
 *    phone;
 *  - the chat route, at the turn's end, hands the Super ONE hidden note naming what was held and
 *    asking it to write that answer properly (`ownerTextFeedback`): the answer itself, in his
 *    language, never a pointer back;
 *  - the Mac folds a no-news line of an event turn with the turn's other steps
 *    (superHandover.ts `isOwnerProse`).
 *
 * Pure (no node imports): the dashboard reads it too. The detectors are deliberately narrow:
 * a pointer back is a SHORT text whose point is "see earlier", never a long answer that also
 * says "as I wrote above"; a wrong language needs a clear majority of the other language's
 * words, never a few English terms in a Turkish sentence.
 */
import { languageVotes, type OwnerLanguage } from './owner-language.js';

/** A text up to this long can be "only a pointer back"; a longer one carries its own content. */
export const POINTER_MAX_CHARS = 320;

/** The Super's reply marks and notch cues, and fenced blocks: never part of what he reads. */
function plain(text: string): string {
  return (text ?? '')
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*$/gm, '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .trim();
}

/** "I wrote it above / in my previous message", Turkish and English. */
const POINTS_BACK = [
  /(yukar[ıi]da|bir [öo]nceki mesaj(?:[ıi]m)?da|[öo]nceki mesaj(?:[ıi]m)?da|son mesaj[ıi]mda|az [öo]nce)\s+(?:da\s+)?(yazd[ıi]m|s[öo]yledim|anlatt[ıi]m|belirttim|payla[şs]t[ıi]m|ilettim|verdim)/i,
  /(durumu|sonucu|cevab[ıi]|cevap|bunu|bunlar[ıi])\s+(yukar[ıi]da|[öo]nceki mesajda|bir [öo]nceki mesajda)/i,
  /\bI(?:'ve| have)?\s+(?:already\s+)?(?:told|wrote|said|mentioned|shared|gave|answered|covered)\b[^.\n]{0,40}\b(?:above|earlier|before|previous(?:ly| message| reply)?|last message)\b/i,
  /\b(?:see|as I (?:said|wrote|mentioned)|as (?:noted|stated|mentioned))\s+(?:my (?:previous|last) (?:message|reply)|above)\b/i,
];

/** "Nothing changed / still waiting": news only when he asked for it. */
const NOTHING_NEW = [
  /de[ğg]i[şs]en (?:bir )?[şs]ey yok|yeni (?:bir )?(?:[şs]ey|geli[şs]me|haber) yok|h[âa]l[âa] (?:bekliyor|ayn[ıi]|s[üu]r[üu]yor|[çc]al[ıi][şs][ıi]yor)/i,
  /\b(?:nothing (?:new|has changed|changed)|no (?:news|change|update)s?\b|still (?:waiting|running|pending|the same))\b/i,
];

/** A short text whose point is that the answer was given earlier: he can never scroll to it on a
 *  phone, and on the Mac it tells him nothing. */
export function pointsBack(text: string): boolean {
  const t = plain(text);
  return !!t && t.length <= POINTER_MAX_CHARS && POINTS_BACK.some((re) => re.test(t));
}

/** A short text that only points back, says nothing changed or that something still waits. */
export function saysNothingNew(text: string): boolean {
  const t = plain(text);
  return !!t && t.length <= POINTER_MAX_CHARS && (pointsBack(t) || NOTHING_NEW.some((re) => re.test(t)));
}

/** The other language, clearly: his language is known and the text's words are mostly the other
 *  one (at least 4 words of it and more than twice his). A few English terms in Turkish pass. */
export function inWrongLanguage(text: string, lang: OwnerLanguage | null | undefined): boolean {
  if (!lang) return false;
  const v = languageVotes(plain(text));
  const [his, other] = lang === 'Turkish' ? [v.tr, v.en] : [v.en, v.tr];
  return other >= 4 && other > 2 * his;
}

export type HoldReason = 'language' | 'points-back' | 'no-news';

/**
 * Why one section of the Super's text must not reach the phone, or null when it may go.
 * `eventTurn`: the server opened the turn (a child finished, an event) and he did not ask: a
 * "nothing changed" line is then noise; in his own turn it can be the answer he asked for.
 */
export function telegramHold(text: string, opts: { lang?: OwnerLanguage | null; eventTurn: boolean }): HoldReason | null {
  if (inWrongLanguage(text, opts.lang)) return 'language';
  if (pointsBack(text)) return 'points-back';
  if (opts.eventTurn && saysNothingNew(text)) return 'no-news';
  return null;
}

/** The tag of the Super's hidden correction turn's part (inside the card-feedback turn). */
export const OWNER_TEXT_GATE_TAG = 'owner-text-gate';

/**
 * The hidden note for one finished Super turn, or null when every owner-facing text passed.
 * `texts`: the main agent's text blocks of the turn, in order. Owner-facing = the turn's last text
 * and every text written for him (a reply mark or real length, `isOwnerProse`). In an event turn
 * a pointer back or a "nothing new" line is just dropped (silence was right), never re-asked.
 */
export function ownerTextFeedback(texts: readonly string[], opts: { lang?: OwnerLanguage | null; eventTurn: boolean; isOwnerProse: (t: string) => boolean }): string | null {
  const facing = texts.filter((t, i) => plain(t) && (i === texts.length - 1 || opts.isOwnerProse(t)));
  const lines: string[] = [];
  if (opts.lang && facing.some((t) => inWrongLanguage(t, opts.lang))) {
    lines.push(`Your last answer to him was not in ${opts.lang}. He writes ${opts.lang}, and his phone did not get it. Write that same answer again, in ${opts.lang} only, as short as it was.`);
  }
  if (!opts.eventTurn && facing.some((t) => pointsBack(t))) {
    lines.push('Your answer pointed him to an earlier message. He cannot scroll back on his phone and never sees "above" as an answer: write the answer itself now, in one or two lines (the result, or what still runs and why).');
  }
  if (!lines.length) return null;
  return [`<${OWNER_TEXT_GATE_TAG}>`, ...lines, 'Do not mention this note itself.', `</${OWNER_TEXT_GATE_TAG}>`].join('\n');
}
