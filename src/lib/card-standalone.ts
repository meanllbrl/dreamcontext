/**
 * A question card must stand on its own (owner, 2026-11-08: "bak örnek yok ama örnekteki gibi
 * diyor"). The owner reaches a card cold — from a notification, the bar, his phone — so a card
 * whose text points at something only the asking agent saw ("örnekteki gibi", "yukarıdaki
 * tablo", "as shown above") is unanswerable: the example lived in the agent's thinking, its
 * chat text or a sub-agent's report, never on the card.
 *
 * This is the mechanical half of that rule (`pattern-hook-delivered-must-not-miss-rules`): the
 * server reads every question card a chat raises — Claude's AskUserQuestion and the Codex /
 * Antigravity questions the T3 bridge turns into the same frame — and every `super ask`, and
 * hands a card that points off itself back to the agent with a diagnostic that says what to
 * add (`pattern-diagnostic-repair-loop`). The briefing line ("Asking — a card read cold") is
 * the other half.
 *
 * Tuned for RARE false positives (measured on 804 real cards, 2026-11-08): only phrases that,
 * on a card, can only mean "something you are not looking at" count, and each is cleared by
 * the card itself carrying the thing (an example marker, a preview, a picture, content right
 * after a "below").
 */

export type OffCardKind = 'example' | 'earlier' | 'below';

export interface OffCardFinding {
  /** The question (its text, as written) whose card points off itself. */
  question: string;
  /** The words that point, as found (lower-cased). */
  phrase: string;
  kind: OffCardKind;
}

/** A letter on either side means the match is inside a longer word. */
const L = '\\p{L}';
const word = (body: string): RegExp => new RegExp(`(?<!${L})(?:${body})(?!${L})`, 'giu');

/** "Like the example" with no example on the card. */
const EXAMPLE_REF = word([
  '[öo]rnekteki(?:\\s+gibi)?', '[öo]rnektekine', '[öo]rnektekiler', '[öo]rnekte',
  '(?:bu|[şs]u|o|yukar[ıi]daki|a[şs]a[ğg][ıi]daki|verdi[ğg]im|g[öo]sterdi[ğg]im)\\s+[öo]rne(?:k|[ğg])' + L + '*',
  '(?:in|from|like|as in)\\s+the\\s+example', '(?:this|that)\\s+example',
  'the\\s+example\\s+(?:above|below|I\\s+gave|I\\s+showed)',
].join('|'));

/** Anything on the card that IS an example, so a pointer to "the example" is answered. */
const EXAMPLE_PRESENT = word([
  '[öo]rnek\\s*[:：]', '[öo]rne[ğg]in', '[öo]r\\.', '[öo]r\\s*[:：]', 'mesela', 'diyelim\\s+ki',
  'e\\.g\\.', 'for\\s+example', 'for\\s+instance', 'example\\s*[:：]', 'say,',
].join('|'));

/** Something earlier in the chat the card cannot show. */
const EARLIER_REF = word([
  // "yukarıda" alone is also a place ("arama çubuğu yukarıda mı kalsın?"): only with a message.
  'yukar[ıi]?daki',
  'yukar[ıi]?da\\s+(?:mesaj|yazd|anlatt|g[öo]sterd|a[çc][ıi]klad|belirtt|payla[şs]t|s[öo]yled|listeled)' + L + '*',
  'g[öo]sterdi[ğg]im', 'bahsetti[ğg]im', 'anlatt[ıi][ğg][ıi]m', 'payla[şs]t[ıi][ğg][ıi]m',
  'as\\s+shown', 'shown\\s+above', 'as\\s+I\\s+(?:said|showed|mentioned|described|explained)',
  '(?:the|this|that)\\s+(?:table|list|draft|plan|report|diagram|chart|messages?|options?|screenshot|mockup)\\s+above',
  'above\\s+(?:table|list|draft|plan|report|diagram|chart|messages?|screenshot|mockup)',
  'I\\s+(?:showed|described|mentioned|shared)\\s+(?:earlier|before|above)',
  'see\\s+(?:my|the)\\s+(?:last|previous)\\s+message',
].join('|'));

/** "The messages below", which the card must then carry below it. */
const BELOW_REF = word(['a[şs]a[ğg][ıi]daki', 'a[şs]a[ğg][ıi]da', 'below', 'the\\s+following'].join('|'));

/** Options sit below the question on every card: "the options below" is on the card. */
const BELOW_IS_OPTIONS = /^\s*(?:\d+\s+)?(?:se[çc]enek|[şs][ıi]k|yol|option|choice)/iu;
/** A field that asks for a pick ("which of the following", "pick one below") means the options. */
const ASKS_A_PICK = /(?<!\p{L})(?:which|pick|choose|select|hangi\p{L}*|se[çc](?:in|elim|ece[ğg]iz|ilsin)?)(?!\p{L})/iu;

interface CardQuestion { question?: unknown; description?: unknown; options?: unknown }

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Lower-case for matching. `İ` → `i` by hand (plain lower-casing adds a combining dot); `I`
 *  → `i`, so English "as I said" matches; the Turkish stems accept `i` for `ı` (and plain
 *  letters for ö ş ğ ç), so "YUKARIDAKI" and an ASCII-typed "ornekteki" match too. */
function lower(s: string): string {
  return s.replace(/İ/g, 'i').toLowerCase();
}

function optionsOf(q: CardQuestion): Array<Record<string, unknown>> {
  return Array.isArray(q.options) ? q.options.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object') : [];
}

/**
 * Does the text right after a "below" carry the thing? Content follows when the field goes on
 * for a while after it (the draft pasted under "aşağıdaki mesajlar gönderilsin mi?") or a later
 * field of the card does (the description, the options' own words).
 */
function belowAnswered(field: string, end: number, laterChars: number): boolean {
  const rest = field.slice(end);
  if (BELOW_IS_OPTIONS.test(rest) || ASKS_A_PICK.test(field)) return true;
  return rest.replace(/\s+/g, ' ').trim().length >= 40 || laterChars >= 40;
}

/**
 * The places a card points off itself, or [] when it stands alone. `ask` is AskUserQuestion's
 * own input shape (`{title?, questions: [{question, description?, options: [{label,
 * description?, preview?}]}]}`); an unrecognised shape returns [] (never refuse what we cannot
 * read: `pattern-unrecognized-shape-returns-null`). `extra.shows` = the card carries pictures
 * of its own (`super ask --show`), which answer every pointer.
 */
export function offCardReferences(ask: unknown, extra: { shows?: boolean } = {}): OffCardFinding[] {
  if (!ask || typeof ask !== 'object' || extra.shows) return [];
  const questions = (ask as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  const title = str((ask as { title?: unknown }).title);
  const findings: OffCardFinding[] = [];
  for (const raw of questions) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as CardQuestion;
    const question = str(q.question);
    const description = str(q.description);
    const options = optionsOf(q);
    if (options.some((o) => str(o.preview).trim())) continue; // a picture of its own
    const optionWords = options.map((o) => `${str(o.label)} ${str(o.description)}`).join(' ');
    // The options sit under the question and its description: "each step below" may be them.
    const optionChars = options.map((o) => str(o.description)).join('').trim().length;
    const whole = lower([title, question, description, optionWords].join('\n'));
    const fields: Array<{ text: string; later: number }> = [
      { text: lower(question), later: description.trim().length + optionChars },
      { text: lower(description), later: optionChars },
    ];
    const seen = new Set<string>();
    const add = (phrase: string, kind: OffCardKind) => {
      const key = `${kind}:${phrase}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ question, phrase, kind });
    };
    const examplePresent = EXAMPLE_PRESENT.test(whole);
    EXAMPLE_PRESENT.lastIndex = 0;
    for (const f of fields) {
      if (!examplePresent) for (const m of f.text.matchAll(EXAMPLE_REF)) add(m[0], 'example');
      for (const m of f.text.matchAll(EARLIER_REF)) {
        // "yukarıdaki örnek" was already reported as a missing example.
        if (!examplePresent && /[öo]rne/u.test(f.text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 12))) continue;
        add(m[0], 'earlier');
      }
      for (const m of f.text.matchAll(BELOW_REF)) {
        const end = (m.index ?? 0) + m[0].length;
        if (!belowAnswered(f.text, end, f.later)) add(m[0], 'below');
      }
    }
  }
  return findings;
}

/**
 * The words handed back to the agent instead of showing the card: what points off the card,
 * why the owner cannot follow it, and exactly what to add. Plain English: the agent reads it,
 * the owner never does.
 */
export function offCardRefusal(findings: readonly OffCardFinding[]): string {
  const phrases = [...new Set(findings.map((f) => `"${f.phrase}"`))].join(', ');
  const kinds = new Set(findings.map((f) => f.kind));
  const what = kinds.has('example')
    ? 'the example itself (names, amounts, the steps in order) inside the question or its description'
    : 'the thing itself (the text, list, numbers or draft) inside the question or its description, or as an option preview';
  return [
    `Not shown to the owner: this card points at something that is not on it (${phrases}).`,
    'He reads cards cold, from a notification or the bar, without your chat, your thinking or any report you read, so he cannot see what you mean.',
    `Put ${what}, then ask again with the same options.`,
  ].join(' ');
}

/**
 * A chat child's question frame (`control_request{can_use_tool}` for AskUserQuestion: Claude's
 * own, or a Codex / Antigravity question the T3 bridge turned into one) that points off its
 * card: the request to deny and the words to deny it with. Null = show the card as usual,
 * including for every shape this does not recognise.
 */
export function offCardQuestionFrame(frame: Record<string, unknown> | null): { requestId: string; message: string } | null {
  if (!frame || frame.type !== 'control_request' || typeof frame.request_id !== 'string') return null;
  const req = frame.request as Record<string, unknown> | undefined;
  if (!req || req.subtype !== 'can_use_tool' || req.tool_name !== 'AskUserQuestion') return null;
  const findings = offCardReferences(req.input);
  return findings.length ? { requestId: frame.request_id, message: offCardRefusal(findings) } : null;
}
