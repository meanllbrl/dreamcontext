import type { QuestionSpec } from '../../../lib/chatProtocol';

/**
 * Pure selection→answer arithmetic for the AskUserQuestion survey card (state 5),
 * including the free-text "Other" path.
 *
 * The tool contract is that "Other" is ALWAYS available and is never part of the option
 * list the model sends ("There should be no 'Other' option, that will be provided
 * automatically"), so the CARD appends that row itself and carries the typed text as a
 * per-question draft. What ships in the `answers` record is the TEXT, not the word
 * "Other" — the model reads that string as the user's actual answer, and a literal
 * "Other" would tell it nothing.
 *
 * Why a sentinel token instead of the literal string `'Other'`: a question is free to
 * ship a real option labelled "Other", and a label-keyed selection set would then make
 * the two indistinguishable — clicking the free-text row would light up the model's own
 * option and its text would be dropped. `OTHER_TOKEN` holds a control character no
 * option label can collide with.
 *
 * DOM-free on purpose: what counts as answered, and the exact string that reaches the
 * model, are the load-bearing parts and are unit-tested without a renderer.
 */

/** Selection token for the auto-appended free-text row. Never sent to the model. */
export const OTHER_TOKEN = '\u0000other';

export interface QuestionPick {
  /** Selected option labels in click order; may contain {@link OTHER_TOKEN}. */
  chosen: string[];
  /** Free text typed into the "Other" row. Only read while the token is chosen. */
  otherText: string;
}

/** Draft state for a whole card, keyed by question text (the same key `answers` uses). */
export type SurveyPicks = Record<string, QuestionPick>;

const EMPTY_PICK: QuestionPick = { chosen: [], otherText: '' };

export function pickFor(picks: SurveyPicks, question: string): QuestionPick {
  return picks[question] ?? EMPTY_PICK;
}

/**
 * Toggle one option (or the free-text row) for a question. multiSelect adds/removes and
 * keeps click order; single-select replaces — including replacing a listed option with
 * the free-text row, and vice versa, which is how a mis-click on "Other" is undone.
 */
export function togglePick(picks: SurveyPicks, q: QuestionSpec, label: string): SurveyPicks {
  const cur = pickFor(picks, q.question);
  const chosen = q.multiSelect
    ? (cur.chosen.includes(label) ? cur.chosen.filter((l) => l !== label) : [...cur.chosen, label])
    : [label];
  return { ...picks, [q.question]: { ...cur, chosen } };
}

/**
 * Record the free text. Typing is itself intent to answer, so the token is (re-)selected
 * — under multiSelect that leaves any listed picks alone, and under single-select it
 * takes over, matching what clicking the row does.
 */
export function setOtherText(picks: SurveyPicks, q: QuestionSpec, text: string): SurveyPicks {
  const cur = pickFor(picks, q.question);
  const chosen = cur.chosen.includes(OTHER_TOKEN)
    ? cur.chosen
    : (q.multiSelect ? [...cur.chosen, OTHER_TOKEN] : [OTHER_TOKEN]);
  return { ...picks, [q.question]: { chosen, otherText: text } };
}

export function isOtherChosen(picks: SurveyPicks, question: string): boolean {
  return pickFor(picks, question).chosen.includes(OTHER_TOKEN);
}

/**
 * The answer values for one question, in click order, with the token replaced by the
 * trimmed free text. A chosen-but-blank "Other" contributes nothing — an empty string
 * is not an answer.
 */
export function resolveValues(q: QuestionSpec, picks: SurveyPicks): string[] {
  const { chosen, otherText } = pickFor(picks, q.question);
  const other = otherText.trim();
  return chosen
    .map((label) => (label === OTHER_TOKEN ? other : label))
    .filter((value) => value.length > 0);
}

/**
 * Answered = at least one resolved value AND, when the free-text row is chosen, non-blank
 * text. A selected "Other" with an empty box is an UNFINISHED answer, not an implicit
 * skip — submitting it would send the model a question it can't see was answered.
 */
export function isAnswered(q: QuestionSpec, picks: SurveyPicks): boolean {
  if (isOtherChosen(picks, q.question) && !pickFor(picks, q.question).otherText.trim()) return false;
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
 * module's contract) and "Other" already resolved to its text. Unanswered questions are
 * omitted rather than sent blank.
 */
export function resolveAnswers(questions: QuestionSpec[], picks: SurveyPicks): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const q of questions) {
    if (!isAnswered(q, picks)) continue;
    picked[q.question] = resolveValues(q, picks).join(', ');
  }
  return picked;
}
