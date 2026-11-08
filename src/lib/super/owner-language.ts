/**
 * The owner's language, said to the Super Agent in so many words (owner 2026-11-08, Tilki: he
 * wrote Turkish, the Super answered in English, then kept English through the next event turn
 * and its handoff).
 *
 * Why a rule was not enough: "write in his language" sat once in a briefing hundreds of thousands
 * of tokens back, and every event note, tool output and harness reminder after it is English. An
 * event note even said "in the language the owner writes to you in, never the language of this
 * note", which a long session read as "the language of your last reply". So the SERVER decides
 * the language from his words, keeps it on the Super's record (it survives a restart and a fresh
 * session), and every turn names it: his message carries `ownerLanguageBlock`, an event turn
 * ends with `ownerLanguageLine`. Both blocks are server-written and start with `<` or `[`, so no
 * replay shows them as his words; both ride every tool (Claude, Codex, Antigravity) because they
 * are plain text in the turn the bridge forwards.
 *
 * Detection is deliberately small: Turkish and English, the two languages this product's owners
 * write in. Anything it cannot tell (a short "ok", a path, another language) returns null and the
 * remembered language stands; with none remembered the block still says "the language of his
 * message above".
 */

export type OwnerLanguage = 'Turkish' | 'English';
export const OWNER_LANGUAGES: readonly OwnerLanguage[] = ['Turkish', 'English'];

/** Letters only Turkish uses among the Latin alphabets this detector meets. */
const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
/** Common Turkish words written without Turkish letters (an ASCII keyboard, a quick reply). */
const TURKISH_WORDS = new Set([
  've', 'bu', 'bir', 'ile', 'mi', 'mu', 'ne', 'da', 'de', 'ama', 'gibi', 'yok', 'var', 'olsun',
  'tamam', 'evet', 'hayir', 'simdi', 'neden', 'nasil', 'devam', 'onu', 'bunu', 'sonra', 'daha',
  'olmali', 'yap', 'yapalim', 'bak', 'bence', 'lazim', 'hepsi', 'icin', 'cok', 'ben', 'sen',
  'misin', 'mısın', 'degil', 'oldu', 'olur', 'peki', 'hadi', 'kadar', 'göre', 'gore', 'şu', 'su',
]);
const ENGLISH_WORDS = new Set([
  'the', 'and', 'is', 'are', 'to', 'of', 'it', 'you', 'this', 'that', 'what', 'please', 'can',
  'should', 'with', 'for', 'not', 'do', 'does', 'why', 'how', 'make', 'let', 'just', 'now',
  'yes', 'no', 'go', 'on', 'be', 'have', 'we', 'i', 'my', 'your', 'there', 'here', 'would',
]);

/** His own words: without the headers and quotes the window adds, code, links and paths. */
function ownWords(text: string): string {
  return (text ?? '')
    .split('\n')
    // `[About …]`, `[Reply to …]`, `[Picture N: …]`, `[On page …]` headers and their `quote:`.
    .filter((line) => !/^\s*\[(About|Reply to|Picture|On page)\b/.test(line) && !/^\s*quote:\s/.test(line))
    .join('\n')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/(?:^|\s)[~.]?\/\S+/g, ' ');
}

/** The language of one owner message, or null when the words do not tell. */
export function detectOwnerLanguage(text: string): OwnerLanguage | null {
  const words = ownWords(text);
  if (TURKISH_LETTERS.test(words)) return 'Turkish';
  const tokens = words.toLowerCase().match(/[a-z']+/g) ?? [];
  let tr = 0;
  let en = 0;
  for (const w of tokens) {
    if (TURKISH_WORDS.has(w)) tr += 1;
    if (ENGLISH_WORDS.has(w)) en += 1;
  }
  if (tr > en && tr >= 1) return 'Turkish';
  if (en > tr && en >= 2) return 'English';
  return null;
}

/** A value read back from the record: one of ours, or nothing. */
export function asOwnerLanguage(v: unknown): OwnerLanguage | undefined {
  return typeof v === 'string' && (OWNER_LANGUAGES as readonly string[]).includes(v) ? v as OwnerLanguage : undefined;
}

/** The block every owner message to the Super carries, right after his words. */
export function ownerLanguageBlock(lang: OwnerLanguage | null | undefined): string {
  return lang
    ? `<owner-language> He writes ${lang}. Every word you write to him in this turn is ${lang}, whatever language this note, the briefing, tool output, a child's words or your own earlier replies are in. </owner-language>`
    : '<owner-language> Write to him in the language of his message above, whatever language this note, the briefing, tool output, a child\'s words or your own earlier replies are in. </owner-language>';
}

/** The last line of every server-written turn (events, owed, handover, recap), once his
 *  language is known: the same rule, said where the turn ends. */
export function ownerLanguageLine(lang: OwnerLanguage | null | undefined): string | null {
  return lang ? `[owner language] The owner writes ${lang}: any text you write him in this turn is ${lang}, whatever language this note or your earlier replies are in.` : null;
}
