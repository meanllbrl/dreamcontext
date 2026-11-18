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
 * a pointer back is a SHORT text with nothing left once its "see earlier" / "nothing new" phrases
 * are cut out, never an answer that also says "as I wrote above" or "the other job still runs"; a wrong
 * language needs a clear majority of the other language's own words (quotes left out), never a
 * few English terms in a Turkish sentence.
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

/** Words that carry nothing on their own: articles, copulas, "and", filler ("tamam", "ok"). */
const EMPTY_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'it', 'its', 'this', 'that', 'on', 'for', 'of', 'to', 'and', 'we', 'you',
  'bu', 'şu', 'o', 'da', 'de', 've', 'bir', 'şey', 'hep', 'tamam', 'ok', 'okay', 'evet', 'peki', 'yes', 'sure', 'alright',
]);

/** A result in a word: done, failed, merged, live, an error. Any one makes the text news. */
const RESULT_WORD = /^(?:bit|tamamlan|geçt|geçme|kırıl|hata|başarı|düş|çök|yayın|canlı|hazır|açıl|açtım|kapan|birleş|merge|gönder|reddet|onaylan|fail|error|broke|done|finish|pass|ship|live|ready|complete|crash|refus|reject|approved|return|sent|open)/u;

/**
 * Nothing new in it, by what is LEFT: every pointer ("I wrote it above") and "nothing changed /
 * still waiting" phrase is cut out, and what remains may be at most one subject word per phrase
 * plus one ("Fatura işi hâlâ bekliyor", "The deploy is still running"), with no number and no
 * result word. Anything more is a reason, a result or a figure, and so news: "Deploy hâlâ
 * çalışıyor ama testler kırıldı", "Still waiting on Stripe — the webhook returned 500",
 * "Vergi raporu hâlâ çalışıyor (%80)" all go to him (review r1/r2, gate-drops-real-news: a phrase
 * found ANYWHERE is never the verdict; how the text is cut into clauses does not matter).
 * Returns how many phrases (and pointer phrases) were cut, or null when the text carries news.
 */
function emptyBesidesPhrases(t: string): { pointers: number; phrases: number } | null {
  if (/\p{N}/u.test(t)) return null;
  let rest = t;
  let pointers = 0;
  let phrases = 0;
  for (const re of POINTS_BACK) rest = rest.replace(new RegExp(re.source, 'giu'), () => { pointers += 1; phrases += 1; return ' '; });
  for (const re of NOTHING_NEW) rest = rest.replace(new RegExp(re.source, 'giu'), () => { phrases += 1; return ' '; });
  if (!phrases) return null;
  const words = rest.toLocaleLowerCase('tr-TR').split(/[^\p{L}]+/u).filter((w) => w && !EMPTY_WORDS.has(w));
  if (words.some((w) => RESULT_WORD.test(w))) return null;
  return words.length <= phrases + 1 ? { pointers, phrases } : null;
}

/** A short text whose point is that the answer was given earlier: it points back and carries
 *  nothing else new. He can never scroll to "above" on a phone, and on the Mac it tells him
 *  nothing. A result, a reason or a figure in it makes it an answer. */
export function pointsBack(text: string): boolean {
  const t = plain(text);
  if (!t || t.length > POINTER_MAX_CHARS) return false;
  return (emptyBesidesPhrases(t)?.pointers ?? 0) > 0;
}

/** A short text that only points back, says nothing changed or that something still waits, and
 *  carries nothing else: no result, no reason, no figure. */
export function saysNothingNew(text: string): boolean {
  const t = plain(text);
  if (!t || t.length > POINTER_MAX_CHARS) return false;
  return emptyBesidesPhrases(t) !== null;
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
 * and every text written for him (a reply mark or real length, `isOwnerProse`). Each is judged in
 * the SAME units the phone holds it by: `sections` cuts a text into its reply sections (the hub's
 * `splitReplySections`), so a section the hub held is a section asked for again (review r1,
 * held-without-retell). In an event turn a text with nothing new in it is just dropped (silence
 * was right), never re-asked.
 */
export function ownerTextFeedback(texts: readonly string[], opts: { lang?: OwnerLanguage | null; eventTurn: boolean; isOwnerProse: (t: string) => boolean; sections?: (t: string) => string[] }): string | null {
  const split = opts.sections ?? ((t: string) => [t]);
  const facing = texts
    .filter((t, i) => plain(t) && (i === texts.length - 1 || opts.isOwnerProse(t)))
    .flatMap((t) => split(t))
    .filter((t) => plain(t));
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
