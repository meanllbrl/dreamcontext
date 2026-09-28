import type { QuestionSpec } from '../../../lib/chatProtocol';

/**
 * Pure selection→answer arithmetic for the AskUserQuestion card (state 5).
 *
 * ONE FREE-TEXT FIELD PER QUESTION, and what it means depends on the pick. The card used to
 * carry an "Other" row that expanded a textarea when clicked — and that expansion is what
 * made the card jump: it sits at the bottom of a transcript that follows the bottom, so
 * every pixel it grew pushed the question up and off (owner report 2026-09-26). The field is
 * now always on screen, under the options, and resolves by what is chosen:
 *   • an option is picked  → the text is a NOTE on that pick. It travels as
 *     `annotations[question].notes` and the model reads it as `notes: …` after the answer;
 *   • nothing is picked     → the text IS the answer;
 *   • "Other" is picked     → the text IS the answer too (with multiSelect, one more value
 *                             after the ticked options).
 * A choice therefore never has to be abandoned to say something about it, which is what
 * the owner asked for ("seçeneğe bastığı zaman bu seçeneğe ek not ekleyebilmeli").
 *
 * "Other" came back as a ROW (owner 2026-09-26: "burada other diyemiyor muyum") — with the
 * field already on screen, picking it only flips what the field means and focuses it, so it
 * can be a plain row again without growing the card. Without it, writing your own answer
 * after a pick meant knowing to click the picked row again to clear it.
 *
 * `text` questions answer with the field itself; `number` questions with their value.
 *
 * DOM-free on purpose: what counts as answered, and the exact strings that reach the model,
 * are the load-bearing parts and are unit-tested without a renderer.
 */

export interface QuestionPick {
  /** Selected option labels in click order. */
  chosen: string[];
  /** The one free-text field: a note on the pick, or the answer when nothing is picked. */
  text: string;
  /** A `number` question's value, once the user has moved it. */
  value?: number;
  /** "Other" is picked: the field is an answer, not a note on a pick. */
  other?: boolean;
}

/** Draft state for a whole card, keyed by question text (the same key `answers` uses). */
export type SurveyPicks = Record<string, QuestionPick>;

const EMPTY_PICK: QuestionPick = { chosen: [], text: '' };

export function pickFor(picks: SurveyPicks, question: string): QuestionPick {
  return picks[question] ?? EMPTY_PICK;
}

function kindOf(q: QuestionSpec): 'choice' | 'text' | 'number' {
  return q.kind ?? 'choice';
}

/**
 * Toggle one option. multiSelect adds/removes and keeps click order; single-select replaces,
 * and clicking the picked option again clears it. A single-select pick also clears "Other" —
 * the two are one radio group.
 */
export function togglePick(picks: SurveyPicks, q: QuestionSpec, label: string): SurveyPicks {
  const cur = pickFor(picks, q.question);
  const on = cur.chosen.includes(label);
  const chosen = q.multiSelect
    ? (on ? cur.chosen.filter((l) => l !== label) : [...cur.chosen, label])
    : (on ? [] : [label]);
  const other = q.multiSelect ? cur.other : false;
  return { ...picks, [q.question]: { ...cur, chosen, other } };
}

/** Toggle "Other". Single-select: it replaces the pick (radio). multiSelect: it adds the typed
 *  text as one more value next to whatever is ticked. */
export function toggleOther(picks: SurveyPicks, q: QuestionSpec): SurveyPicks {
  const cur = pickFor(picks, q.question);
  const other = !cur.other;
  const chosen = q.multiSelect || !other ? cur.chosen : [];
  return { ...picks, [q.question]: { ...cur, chosen, other } };
}

/** Set a single-select pick outright (the swipe deck: a swipe is a decision, not a toggle). */
export function choose(picks: SurveyPicks, q: QuestionSpec, label: string): SurveyPicks {
  const cur = pickFor(picks, q.question);
  return { ...picks, [q.question]: { ...cur, chosen: [label], other: false } };
}

export function setText(picks: SurveyPicks, q: QuestionSpec, text: string): SurveyPicks {
  return { ...picks, [q.question]: { ...pickFor(picks, q.question), text } };
}

export function setValue(picks: SurveyPicks, q: QuestionSpec, value: number): SurveyPicks {
  return { ...picks, [q.question]: { ...pickFor(picks, q.question), value } };
}

/** The value a `number` question shows before it is touched: its default, else its floor. */
export function numberValue(q: QuestionSpec, picks: SurveyPicks): number {
  const v = pickFor(picks, q.question).value;
  if (typeof v === 'number') return v;
  if (typeof q.defaultValue === 'number') return q.defaultValue;
  return q.min ?? 0;
}

/** What the free-text field is doing right now — drives its placeholder. */
export function textRole(q: QuestionSpec, picks: SurveyPicks): 'note' | 'answer' {
  const { chosen, other } = pickFor(picks, q.question);
  return kindOf(q) === 'choice' && chosen.length > 0 && !other ? 'note' : 'answer';
}

/**
 * The answer values for one question, in click order. For a choice with no pick, the typed
 * text stands in; with "Other" picked it is appended after the ticked options. A blank field
 * contributes nothing (an empty string is not an answer), so "Other" with nothing typed is
 * not yet an answer.
 */
export function resolveValues(q: QuestionSpec, picks: SurveyPicks): string[] {
  const { chosen, text, other } = pickFor(picks, q.question);
  const typed = text.trim();
  switch (kindOf(q)) {
    case 'text': return typed ? [typed] : [];
    case 'number': return [String(numberValue(q, picks))];
    default:
      if (other) return typed ? [...chosen, typed] : [...chosen];
      return chosen.length ? [...chosen] : (typed ? [typed] : []);
  }
}

/** The note riding on a pick, or '' — only a CHOICE with a pick has one. */
export function resolveNote(q: QuestionSpec, picks: SurveyPicks): string {
  return textRole(q, picks) === 'note' ? pickFor(picks, q.question).text.trim() : '';
}

export function isAnswered(q: QuestionSpec, picks: SurveyPicks): boolean {
  return resolveValues(q, picks).length > 0;
}

export function answeredCount(questions: QuestionSpec[], picks: SurveyPicks): number {
  return questions.filter((q) => isAnswered(q, picks)).length;
}

export function isComplete(questions: QuestionSpec[], picks: SurveyPicks): boolean {
  return questions.length > 0 && questions.every((q) => isAnswered(q, picks));
}

/**
 * Index of the first still-unanswered question, or -1 when there is none. The paged card
 * shows one question at a time, so "what's left" is no longer visible on screen — this is
 * what the "n left" affordance jumps to, and where ⌘↵ goes instead of submitting.
 */
export function firstUnansweredIndex(questions: QuestionSpec[], picks: SurveyPicks): number {
  return questions.findIndex((q) => !isAnswered(q, picks));
}

/** Every resolved value across the card — the "n selected" readout and the receipt line. */
export function allValues(questions: QuestionSpec[], picks: SurveyPicks): string[] {
  return questions.flatMap((q) => resolveValues(q, picks));
}

/**
 * The `picked` record `buildQuestionAnswer` expects: question text → answer string, with
 * multiple selections comma-joined (that joining is the caller's job per the protocol
 * module's contract). Unanswered questions are omitted rather than sent blank.
 */
export function resolveAnswers(questions: QuestionSpec[], picks: SurveyPicks): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const q of questions) {
    if (!isAnswered(q, picks)) continue;
    picked[q.question] = resolveValues(q, picks).join(', ');
  }
  return picked;
}

/** question text → note, for every question whose pick carries one. */
export function resolveNotes(questions: QuestionSpec[], picks: SurveyPicks): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const q of questions) {
    const note = resolveNote(q, picks);
    if (note) notes[q.question] = note;
  }
  return notes;
}

/**
 * The deny message the "Unclear" button sends. A DENY and not an answer, because the CLI's
 * input schema has no free-response field (`response` is output-only and would be stripped),
 * and because it is honestly not an answer: the tool result the model reads is this text,
 * which tells it exactly how to ask again. Whatever the user had typed rides along — often
 * that is precisely the part they did not follow.
 */
export function unclearMessage(questions: QuestionSpec[], picks: SurveyPicks): string {
  const typed = questions
    .map((q) => pickFor(picks, q.question).text.trim())
    .filter(Boolean);
  const said = typed.length ? ` They wrote: "${typed.join(' / ')}".` : '';
  return 'The user did not understand this question and did not answer it.' + said
    + ' Ask again with AskUserQuestion, written to be answered cold by someone who has not'
    + ' read this conversation: a `title` naming the work in progress, the question in plain'
    + ' words, a `description` saying why you need this now and what changes with the answer,'
    + ' and options that each say what happens if picked. If the choice is visual, give each'
    + ' option a `preview`.';
}

/** Option letters for the A/B/C board and the swipe deck's hints. */
export function optionLetter(i: number): string {
  return String.fromCharCode(65 + i);
}

/** True when the card should be drawn as a swipe deck: the agent asked for it, and every
 *  question is a two-way single choice (a swipe has exactly two directions). */
export function isSwipeDeck(questions: QuestionSpec[], source: string | undefined): boolean {
  return source === 'swipe'
    && questions.length > 0
    && questions.every((q) => kindOf(q) === 'choice' && !q.multiSelect && q.options.length === 2);
}

/** True when a question's options should be drawn as a visual board rather than rows. */
export function isBoard(q: QuestionSpec): boolean {
  return kindOf(q) === 'choice' && q.options.some((o) => !!o.preview);
}
