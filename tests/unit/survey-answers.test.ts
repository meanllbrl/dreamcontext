/**
 * Unit tests for the survey card's selection→answer arithmetic, and specifically the
 * free-text "Other" path.
 *
 * What carries the risk here:
 *   • the ANSWER STRING — the model must receive the user's TYPED text, never the word
 *     "Other" and never a blank; a wrong string here silently loses the answer;
 *   • the COMPLETENESS GATE — a chosen-but-empty "Other" must block Submit, otherwise the
 *     turn resumes with a question the model can't tell was answered;
 *   • the SENTINEL — a question that ships its own option literally labelled "Other" must
 *     stay distinguishable from the card's free-text row.
 */
import { describe, it, expect } from 'vitest';
import type { QuestionSpec } from '../../dashboard/src/lib/chatProtocol.js';
import { buildQuestionAnswer } from '../../dashboard/src/lib/chatProtocol.js';
import {
  OTHER_TOKEN, allValues, answeredCount, isAnswered, isComplete, isOtherChosen,
  resolveAnswers, resolveValues, setOtherText, togglePick, type SurveyPicks,
} from '../../dashboard/src/components/sleepy/chat/surveyAnswers.js';

const single: QuestionSpec = {
  question: 'What are you testing right now?',
  header: 'Test target',
  options: [{ label: 'Question card UI' }, { label: 'Answer round-trip' }],
  multiSelect: false,
};
const multi: QuestionSpec = {
  question: 'Which of these should I exercise in the same test pass?',
  options: [{ label: 'Long option labels' }, { label: 'Previews' }],
  multiSelect: true,
};

const empty: SurveyPicks = {};

describe('listed options (regression — the pre-existing path)', () => {
  it('single-select replaces the previous pick', () => {
    let picks = togglePick(empty, single, 'Question card UI');
    picks = togglePick(picks, single, 'Answer round-trip');
    expect(resolveValues(single, picks)).toEqual(['Answer round-trip']);
  });

  it('multiSelect accumulates in click order and toggles off', () => {
    let picks = togglePick(empty, multi, 'Previews');
    picks = togglePick(picks, multi, 'Long option labels');
    expect(resolveValues(multi, picks)).toEqual(['Previews', 'Long option labels']);
    picks = togglePick(picks, multi, 'Previews');
    expect(resolveValues(multi, picks)).toEqual(['Long option labels']);
  });

  it('an untouched question is unanswered and contributes no key', () => {
    expect(isAnswered(single, empty)).toBe(false);
    expect(resolveAnswers([single, multi], empty)).toEqual({});
  });
});

describe('the "Other" free-text path', () => {
  it('the TYPED TEXT is the answer — the word "Other" never reaches the model', () => {
    let picks = togglePick(empty, single, OTHER_TOKEN);
    picks = setOtherText(picks, single, 'The clickable file paths');
    expect(resolveValues(single, picks)).toEqual(['The clickable file paths']);
    expect(resolveAnswers([single], picks)).toEqual({
      [single.question]: 'The clickable file paths',
    });
    expect(JSON.stringify(resolveAnswers([single], picks))).not.toContain('Other');
  });

  it('chosen but blank (or whitespace) is UNFINISHED — not an answer, and Submit stays blocked', () => {
    const chosen = togglePick(empty, single, OTHER_TOKEN);
    expect(isOtherChosen(chosen, single.question)).toBe(true);
    expect(isAnswered(single, chosen)).toBe(false);
    expect(isComplete([single], chosen)).toBe(false);
    expect(resolveAnswers([single], chosen)).toEqual({});

    const blank = setOtherText(chosen, single, '   \n ');
    expect(isAnswered(single, blank)).toBe(false);
    expect(resolveAnswers([single], blank)).toEqual({});
  });

  it('the answer is trimmed', () => {
    const picks = setOtherText(empty, single, '  a custom answer\n');
    expect(resolveValues(single, picks)).toEqual(['a custom answer']);
  });

  it('typing selects the row on its own (no click needed first)', () => {
    const picks = setOtherText(empty, single, 'typed straight in');
    expect(isOtherChosen(picks, single.question)).toBe(true);
    expect(isComplete([single], picks)).toBe(true);
  });

  it('single-select: "Other" replaces a listed pick, and a listed pick replaces "Other"', () => {
    let picks = togglePick(empty, single, 'Question card UI');
    picks = setOtherText(picks, single, 'something else entirely');
    expect(resolveValues(single, picks)).toEqual(['something else entirely']);

    // Mis-clicked "Other"? Picking a listed option is the way back out.
    picks = togglePick(picks, single, 'Answer round-trip');
    expect(isOtherChosen(picks, single.question)).toBe(false);
    expect(resolveValues(single, picks)).toEqual(['Answer round-trip']);
  });

  it('multiSelect: free text rides alongside listed picks, comma-joined in click order', () => {
    let picks = togglePick(empty, multi, 'Previews');
    picks = setOtherText(picks, multi, 'RTL wrapping');
    expect(resolveAnswers([multi], picks)).toEqual({
      [multi.question]: 'Previews, RTL wrapping',
    });
  });

  it('multiSelect: de-selecting the row drops the text from the answer but keeps the draft', () => {
    let picks = togglePick(empty, multi, 'Previews');
    picks = setOtherText(picks, multi, 'RTL wrapping');
    picks = togglePick(picks, multi, OTHER_TOKEN);
    expect(resolveValues(multi, picks)).toEqual(['Previews']);
    // Re-selecting restores what was typed rather than making the user retype it.
    picks = togglePick(picks, multi, OTHER_TOKEN);
    expect(resolveValues(multi, picks)).toEqual(['Previews', 'RTL wrapping']);
  });

  it('does NOT collide with a question that ships its own option labelled "Other"', () => {
    const withLiteralOther: QuestionSpec = {
      question: 'Which lane?',
      options: [{ label: 'Fast' }, { label: 'Other' }],
      multiSelect: false,
    };
    // Picking the model's own "Other" option must not open/consume the free-text row…
    let picks = togglePick(empty, withLiteralOther, 'Other');
    expect(isOtherChosen(picks, withLiteralOther.question)).toBe(false);
    expect(resolveValues(withLiteralOther, picks)).toEqual(['Other']);
    expect(isAnswered(withLiteralOther, picks)).toBe(true);

    // …and the free-text row still works on that same question.
    picks = setOtherText(picks, withLiteralOther, 'a third lane');
    expect(resolveValues(withLiteralOther, picks)).toEqual(['a third lane']);
  });
});

describe('card-level readouts', () => {
  it('progress and "n selected" count free text like any other answer', () => {
    let picks = togglePick(empty, single, 'Question card UI');
    expect(answeredCount([single, multi], picks)).toBe(1);
    expect(isComplete([single, multi], picks)).toBe(false);

    picks = setOtherText(picks, multi, 'RTL wrapping');
    expect(answeredCount([single, multi], picks)).toBe(2);
    expect(isComplete([single, multi], picks)).toBe(true);
    expect(allValues([single, multi], picks)).toEqual(['Question card UI', 'RTL wrapping']);
  });

  it('a card with no questions is never "complete" (nothing to submit)', () => {
    expect(isComplete([], empty)).toBe(false);
  });
});

describe('end-to-end into the wire shape', () => {
  it('free text lands in the load-bearing {questions, answers} payload verbatim', () => {
    let picks = setOtherText(empty, single, 'the ⌘↵ shortcut');
    picks = togglePick(picks, multi, 'Long option labels');
    picks = setOtherText(picks, multi, 'RTL wrapping');

    const payload = buildQuestionAnswer([single, multi], resolveAnswers([single, multi], picks)) as {
      questions: QuestionSpec[];
      answers: Record<string, string>;
    };
    expect(payload.questions).toEqual([single, multi]);
    expect(payload.answers).toEqual({
      [single.question]: 'the ⌘↵ shortcut',
      [multi.question]: 'Long option labels, RTL wrapping',
    });
    // The sentinel is an internal UI token; it must never appear on the wire.
    expect(JSON.stringify(payload)).not.toContain(OTHER_TOKEN);
  });
});
