/**
 * The explicit "remember this" cue (learning loop C4). Pure; run on HIS words only
 * (`promptOwnerText` in the hook, the ledger's `own` wherever the list decides something).
 *
 * It is a cue, never a capture path: measured, a word list sees 6% of his rule turns, so capture
 * does not depend on it (D5). The prompt hook prints one must-print line when it matches; it writes
 * nothing and makes no rule active, so a phrase inside quoted text costs at most one idle reminder.
 * Where the list decides (G1's explicit turn for `learn --by sleep`, sleep's "stated, not yet
 * stored"), it reads the ledger's `own` text.
 *
 * The explicit list, minus reminders ("remind me", "hatırlat") and questions (a sentence that asks).
 */

/** The one line the prompt hook prints when he asked for a rule to be remembered. */
export const REMEMBER_INTENT_LINE =
  'He asked you to remember a rule: run `dreamcontext learn` before this turn ends, then repeat its line.';

const L = 'a-z0-9çğıöşü';
/** Not followed by another letter: JS `\b` does not know Turkish letters. */
const END = `(?![${L}])`;
const START = `(?<![${L}])`;

const EXPLICIT: RegExp[] = [
  // Turkish
  new RegExp(`${START}(bunu|şunu|sunu|bunları|bunlari|şunları|sunlari|şu kuralı|bu kuralı)\\s+(da\\s+|de\\s+|iyice\\s+|lütfen\\s+|lutfen\\s+)?(hatırla|hatirla|hatırlayın|hatirlayin|unutma|unutmayın|unutmayin|aklında tut|aklinda tut|aklına yaz|aklina yaz|not et|not al|öğren|ogren|kaydet|kural yap|kural olarak kaydet)${END}`, 'u'),
  new RegExp(`${START}(hatırla|hatirla|hatırlayın|hatirlayin|unutma|unutmayın|unutmayin)\\s*[:!]`, 'u'),
  new RegExp(`${START}(aklında|aklinda|aklınızda|aklinizda)\\s+(tut|bulunsun|olsun)${END}`, 'u'),
  new RegExp(`${START}(hafızana|hafizana|beynine|kurallarına|kurallarina|tercihlerime)\\s+(yaz|kaydet|al|ekle|işle|isle)${END}`, 'u'),
  new RegExp(`${START}bundan (sonra|böyle|boyle)\\s+(hep|her zaman|daima|asla|hiç|hic|hiçbir zaman|hicbir zaman)${END}`, 'u'),
  new RegExp(`${START}(bir daha|bir daha asla)\\s+(bunu\\s+|böyle\\s+|boyle\\s+|şunu\\s+)?([${L}]+\\s+)?(yapma|etme|yazma|kullanma|söyleme|soyleme|sorma|açma|acma)${END}`, 'u'),
  new RegExp(`${START}(bu|şu|su) (bir )?(kural|tercihim)(dır|dir|dur)?${END}`, 'u'),
  new RegExp(`${START}kalıcı (olarak|bir kural)${END}`, 'u'),
  // English
  /\bremember (this|that|these|it|to|my|the rule)\b/,
  /\bremember\s*:/,
  /\b(don't|do not|never) forget (this|that|to)\b/,
  /\bfrom now on\b/,
  /\bgoing forward,? (always|never|please|do|don't)\b/,
  /\bkeep (this|that|it) in mind\b/,
  /\bmake (this|that|it) a (rule|standing rule)\b/,
  /\b(note|save|store|record) (this|that) as a (rule|preference)\b/,
  /\bmemori[sz]e (this|that)\b/,
  /\bfor future reference\b/,
  /\b(never|don't|do not) (ever )?do (this|that) again\b/,
];

const REMINDER: RegExp[] = [
  new RegExp(`${START}(hatırlat|hatirlat)`, 'u'),
  /\bremind (me|us)\b/,
  /\breminder\b/,
  /\bset an? (alarm|timer)\b/,
];

/** A sentence that asks: ends in "?", or opens with a "do you remember"-style question. */
const QUESTION_OPEN = new RegExp(
  `^(do you remember|did you remember|can you remember|will you remember|hatırlıyor mu|hatirliyor mu|hatırladın mı|hatirladin mi)`,
  'u',
);

function sentences(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when one sentence of `text` is an explicit standing-rule ask (not a reminder, not a question). */
export function detectRememberIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const s of sentences(text)) {
    if (s.endsWith('?') || QUESTION_OPEN.test(s)) continue;
    if (REMINDER.some((re) => re.test(s))) continue;
    if (EXPLICIT.some((re) => re.test(s))) return true;
  }
  return false;
}
