/**
 * Unit tests for the question card's selection→answer arithmetic.
 *
 * What carries the risk here:
 *   • the ONE FREE-TEXT FIELD — it is a NOTE when an option is picked and the ANSWER when
 *     nothing is; a note leaking into `answers` (or an own-answer leaking into `notes`)
 *     tells the model something the user did not say;
 *   • the COMPLETENESS GATE — Submit must not open on an unanswered question, and must open
 *     on a typed own-answer with no pick;
 *   • the WIRE SHAPE — what `buildQuestionAnswer` receives is what the model reads;
 *   • the SWIPE / BOARD predicates — they decide which surface the card draws.
 */
import { describe, it, expect } from 'vitest';
import type { QuestionSpec } from '../../dashboard/src/lib/chatProtocol.js';
import { buildQuestionAnswer } from '../../dashboard/src/lib/chatProtocol.js';
import {
  allValues, answeredCount, choose, firstUnansweredIndex, isAnswered, isBoard, isComplete,
  isSwipeDeck, numberValue, optionLetter, pickFor, resolveAnswers, resolveNote, resolveNotes,
  resolveValues, setText, setValue, textRole, toggleOther, togglePick, unclearMessage, type SurveyPicks,
} from '../../dashboard/src/components/sleepy/chat/surveyAnswers.js';
import {
  isLocalImageRef, localImageRefs, loneMedia, substituteImages,
} from '../../dashboard/src/components/sleepy/chat/previewImages.js';

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
const text: QuestionSpec = { question: 'Anything else?', options: [], kind: 'text' };
const number: QuestionSpec = { question: 'How many slides?', options: [], kind: 'number', min: 3, max: 20, defaultValue: 8 };

const empty: SurveyPicks = {};

describe('listed options', () => {
  it('single-select replaces the previous pick', () => {
    let picks = togglePick(empty, single, 'Question card UI');
    picks = togglePick(picks, single, 'Answer round-trip');
    expect(resolveValues(single, picks)).toEqual(['Answer round-trip']);
  });

  it('single-select: clicking the picked option again clears it (the way back to "none of these")', () => {
    let picks = togglePick(empty, single, 'Question card UI');
    picks = togglePick(picks, single, 'Question card UI');
    expect(isAnswered(single, picks)).toBe(false);
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

  it('choose() sets a pick outright — a swipe is a decision, never a toggle-off', () => {
    let picks = choose(empty, single, 'Question card UI');
    picks = choose(picks, single, 'Question card UI');
    expect(resolveValues(single, picks)).toEqual(['Question card UI']);
  });
});

describe('the one free-text field', () => {
  it('with NOTHING picked, the text IS the answer (trimmed)', () => {
    const picks = setText(empty, single, '  something else entirely\n');
    expect(textRole(single, picks)).toBe('answer');
    expect(resolveAnswers([single], picks)).toEqual({ [single.question]: 'something else entirely' });
    expect(resolveNotes([single], picks)).toEqual({});
    expect(isComplete([single], picks)).toBe(true);
  });

  it('with a pick, the text is a NOTE — the answer stays the label, the note travels apart', () => {
    let picks = togglePick(empty, single, 'Answer round-trip');
    picks = setText(picks, single, 'but only on the desktop app');
    expect(textRole(single, picks)).toBe('note');
    expect(resolveAnswers([single], picks)).toEqual({ [single.question]: 'Answer round-trip' });
    expect(resolveNote(single, picks)).toBe('but only on the desktop app');
  });

  it('the draft survives a pick being cleared — it becomes the answer instead of vanishing', () => {
    let picks = togglePick(empty, single, 'Answer round-trip');
    picks = setText(picks, single, 'a third lane');
    picks = togglePick(picks, single, 'Answer round-trip');
    expect(resolveAnswers([single], picks)).toEqual({ [single.question]: 'a third lane' });
    expect(resolveNotes([single], picks)).toEqual({});
  });

  it('blank text is neither an answer nor a note', () => {
    const picks = setText(empty, single, '   \n ');
    expect(isAnswered(single, picks)).toBe(false);
    expect(resolveNotes([single], setText(togglePick(empty, single, 'Question card UI'), single, '  '))).toEqual({});
  });

  it('a note never reaches `answers`, and an own-answer never reaches `notes`', () => {
    let picks = togglePick(empty, multi, 'Previews');
    picks = setText(picks, multi, 'RTL wrapping too');
    picks = setText(picks, single, 'a custom answer');
    expect(resolveAnswers([single, multi], picks)).toEqual({
      [single.question]: 'a custom answer',
      [multi.question]: 'Previews',
    });
    expect(resolveNotes([single, multi], picks)).toEqual({ [multi.question]: 'RTL wrapping too' });
  });
});

describe('"Other" — an own answer after a pick, without un-picking', () => {
  it('single-select: Other replaces the pick and turns the note into the answer', () => {
    let picks = togglePick(empty, single, 'Answer round-trip');
    picks = setText(picks, single, 'the receipt line');
    expect(textRole(single, picks)).toBe('note');
    picks = toggleOther(picks, single);
    expect(pickFor(picks, single.question).chosen).toEqual([]);
    expect(textRole(single, picks)).toBe('answer');
    expect(resolveAnswers([single], picks)).toEqual({ [single.question]: 'the receipt line' });
    expect(resolveNotes([single], picks)).toEqual({});
  });

  it('single-select: picking an option afterwards clears Other (one radio group)', () => {
    let picks = toggleOther(empty, single);
    picks = togglePick(picks, single, 'Question card UI');
    expect(pickFor(picks, single.question).other).toBe(false);
    expect(textRole(single, picks)).toBe('note');
  });

  it('Other with nothing typed is not an answer yet', () => {
    const picks = toggleOther(empty, single);
    expect(isAnswered(single, picks)).toBe(false);
  });

  it('multiSelect: Other adds the typed text after the ticked options', () => {
    let picks = togglePick(empty, multi, 'Previews');
    picks = toggleOther(picks, multi);
    picks = setText(picks, multi, 'dark theme');
    expect(resolveValues(multi, picks)).toEqual(['Previews', 'dark theme']);
    expect(resolveNotes([multi], picks)).toEqual({});
    picks = toggleOther(picks, multi);
    expect(resolveValues(multi, picks)).toEqual(['Previews']);
    expect(resolveNote(multi, picks)).toBe('dark theme');
  });

  it('a swipe decision clears Other', () => {
    const picks = choose(toggleOther(empty, single), single, 'Question card UI');
    expect(pickFor(picks, single.question).other).toBe(false);
  });
});

describe('text and number questions', () => {
  it('a text question answers with its field, and is a gap until something is typed', () => {
    expect(isAnswered(text, empty)).toBe(false);
    const picks = setText(empty, text, 'ship it friday');
    expect(resolveAnswers([text], picks)).toEqual({ [text.question]: 'ship it friday' });
    expect(resolveNotes([text], picks)).toEqual({});
  });

  it('a number question starts at its default, else its floor, and answers with its value', () => {
    expect(numberValue(number, empty)).toBe(8);
    expect(numberValue({ ...number, defaultValue: undefined }, empty)).toBe(3);
    expect(resolveAnswers([number], setValue(empty, number, 12))).toEqual({ [number.question]: '12' });
    expect(isAnswered(number, empty)).toBe(true);
  });
});

describe('card-level readouts', () => {
  it('progress counts typed answers like any other', () => {
    let picks = togglePick(empty, single, 'Question card UI');
    expect(answeredCount([single, multi], picks)).toBe(1);
    expect(isComplete([single, multi], picks)).toBe(false);
    picks = setText(picks, multi, 'RTL wrapping');
    expect(answeredCount([single, multi], picks)).toBe(2);
    expect(allValues([single, multi], picks)).toEqual(['Question card UI', 'RTL wrapping']);
  });

  it('a card with no questions is never "complete" (nothing to submit)', () => {
    expect(isComplete([], empty)).toBe(false);
  });

  it('firstUnansweredIndex points at the first gap and is -1 once none is left', () => {
    expect(firstUnansweredIndex([single, multi], empty)).toBe(0);
    const firstDone = togglePick(empty, single, 'Question card UI');
    expect(firstUnansweredIndex([single, multi], firstDone)).toBe(1);
    expect(firstUnansweredIndex([single, multi], togglePick(firstDone, multi, 'Previews'))).toBe(-1);
  });
});

describe('which surface the card draws', () => {
  const yesNo = (question: string): QuestionSpec => ({
    question, options: [{ label: 'Keep' }, { label: 'Drop' }], multiSelect: false,
  });

  it('swipe only when the agent asked for it AND every question is a two-way single choice', () => {
    expect(isSwipeDeck([yesNo('a'), yesNo('b')], 'swipe')).toBe(true);
    expect(isSwipeDeck([yesNo('a')], undefined)).toBe(false);
    expect(isSwipeDeck([yesNo('a'), single, multi], 'swipe')).toBe(false);
    expect(isSwipeDeck([{ ...yesNo('a'), options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] }], 'swipe')).toBe(false);
    expect(isSwipeDeck([text], 'swipe')).toBe(false);
    expect(isSwipeDeck([], 'swipe')).toBe(false);
  });

  it('a board as soon as one option carries a preview', () => {
    expect(isBoard(single)).toBe(false);
    expect(isBoard({ ...single, options: [{ label: 'A', preview: '<b>a</b>' }, { label: 'B' }] })).toBe(true);
    expect(isBoard(text)).toBe(false);
  });

  it('options are lettered A, B, C, D', () => {
    expect([0, 1, 2, 3].map(optionLetter)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('"Unclear? Ask again"', () => {
  it('tells the agent how to re-ask, and carries what the user typed', () => {
    const msg = unclearMessage([single, multi], setText(empty, multi, 'what is a round-trip here?'));
    expect(msg).toMatch(/did not understand/);
    expect(msg).toMatch(/`title`/);
    expect(msg).toMatch(/`description`/);
    expect(msg).toContain('what is a round-trip here?');
  });

  it('says nothing about typed text when there is none', () => {
    expect(unclearMessage([single], empty)).not.toMatch(/They wrote/);
  });
});

describe('end-to-end into the wire shape', () => {
  it('answers and notes land in the load-bearing payload verbatim', () => {
    let picks = setText(empty, single, 'the ⌘↵ shortcut');
    picks = togglePick(picks, multi, 'Long option labels');
    picks = setText(picks, multi, 'and RTL');
    const payload = buildQuestionAnswer(
      [single, multi], resolveAnswers([single, multi], picks), { notes: resolveNotes([single, multi], picks) },
    );
    expect(payload).toEqual({
      questions: [single, multi],
      answers: { [single.question]: 'the ⌘↵ shortcut', [multi.question]: 'Long option labels' },
      annotations: { [multi.question]: { notes: 'and RTL' } },
    });
  });
});

describe('project pictures and clips in a preview', () => {
  it('only project-relative sources are ours to inline', () => {
    expect(isLocalImageRef('docs/shot.png')).toBe(true);
    for (const src of ['https://x.io/a.png', 'data:image/png;base64,AA', 'blob:x', '//cdn/a.png', '/api/agent/file?p=1', '#a', ''])
      expect(isLocalImageRef(src), src).toBe(false);
  });

  it('collects distinct local refs in order, and substitutes only what loaded', () => {
    const html = '<div><img src="a.png"><img class="x" src=\'b.png\'><img src="a.png"><img src="https://x/c.png"></div>';
    expect(localImageRefs(html)).toEqual(['a.png', 'b.png']);
    const out = substituteImages(html, { 'a.png': 'data:image/png;base64,AAA' });
    expect(out).toContain('src="data:image/png;base64,AAA"');
    expect(out.match(/data:image/g)).toHaveLength(2);         // both a.png occurrences
    expect(out).toContain("src='b.png'");                     // failed load stays as written
    expect(out).toContain('src="https://x/c.png"');
  });

  it('a lone clip or picture is drawn natively; anything around it keeps the sandbox', () => {
    expect(loneMedia('<video src="tmp/a.mp4"></video>')).toEqual({ kind: 'video', src: 'tmp/a.mp4' });
    expect(loneMedia('  <img src="docs/b.png" alt="b">  ')).toEqual({ kind: 'image', src: 'docs/b.png' });
    expect(loneMedia('<div><video src="tmp/a.mp4"></video></div>')).toBeNull();
    expect(loneMedia('<video src="https://x/a.mp4"></video>')).toBeNull();
    expect(loneMedia(undefined)).toBeNull();
  });
});
