/**
 * The `eval/super-show` scorer (jarvis plan r9, AC11b). The owner's own case of 2026-10-20 stays
 * a negative fixture: it must FAIL.
 */
import { describe, it, expect } from 'vitest';
import { scoreShow, sentenceCount, type ScoreCase, type ScoreRun } from '../../eval/super-show/scorer.js';

const CASE: ScoreCase = {
  kind: 'task',
  gold: ['signup-form', 'pricing-page', 'email-digest', 'search-index', 'billing-retry'],
  notGold: ['old-landing', 'legacy-export', 'first-deploy'],
  titles: ['Signup form', 'Pricing page', 'Email digest', 'Search index', 'Billing retry'],
};
const card = (ref: string, place: 'float' | 'others' = 'float') => ({ id: `task-${ref}`, kind: 'task', ref, place });
const good: ScoreRun = {
  containers: CASE.gold.map((r) => card(r)),
  groups: [{ id: 'grp-1', cards: CASE.gold.map((r) => `task-${r}`), place: 'float' }],
  answer: "5 open tasks are on the stage, in 'Tasks'.",
};

describe('scoreShow', () => {
  it('a correct run passes', () => {
    expect(scoreShow(CASE, good)).toEqual({ pass: true, failed: [] });
  });

  it("the owner's case (a list in the chat, one card, another card closed) fails", () => {
    const owners: ScoreRun = {
      containers: [card('signup-form')],
      groups: [],
      answer: 'Here are your open tasks:\n- Signup form\n- Pricing page\n- Email digest\n- Search index\n- Billing retry\nI opened the first one.',
    };
    const v = scoreShow({ ...CASE, preOpen: ['task-other'] }, owners);
    expect(v.pass).toBe(false);
    expect(v.failed.join(' ')).toMatch(/a:.*c:.*e:.*f:/s);
  });

  it('cards opened but a list written too: fail', () => {
    expect(scoreShow(CASE, { ...good, answer: 'Done:\n1. Signup form\n2. Pricing page' }).pass).toBe(false);
  });

  it('no group, 5 scattered cards: fail', () => {
    expect(scoreShow(CASE, { ...good, groups: [] }).failed).toEqual(['e: more than 3 items, not in one group']);
  });

  it('a gold card in Others: fail', () => {
    const run = { ...good, groups: [{ ...good.groups[0], place: 'others' as const }] };
    expect(scoreShow(CASE, run).pass).toBe(false);
  });

  it('a finished task that was already open before the prompt is not counted as opened', () => {
    const run = { ...good, containers: [...good.containers, { ...card('old-landing', 'others'), id: 'task-old-landing' }] };
    expect(scoreShow({ ...CASE, preOpen: ['task-old-landing'] }, run).pass).toBe(true);
  });

  it('a finished task opened: fail; three sentences: fail', () => {
    expect(scoreShow(CASE, { ...good, containers: [...good.containers, card('old-landing')] }).pass).toBe(false);
    expect(scoreShow(CASE, { ...good, answer: 'One. Two. Three.' }).pass).toBe(false);
  });

  it('capacity: a card closed to make room fails; none stacked fails; stacked and kept passes', () => {
    const pre = ['task-x1', 'task-x2'];
    const kept = { ...good, containers: [...good.containers, { ...card('x1'), id: 'task-x1', place: 'others' as const }, { ...card('x2'), id: 'task-x2' }] };
    expect(scoreShow({ ...CASE, preOpen: pre }, kept).pass).toBe(true);
    const closed = { ...good, containers: [...good.containers, { ...card('x2'), id: 'task-x2', place: 'others' as const }] };
    expect(scoreShow({ ...CASE, preOpen: pre }, closed).failed).toEqual(['f: 1 open card(s) closed to make room']);
    const none = { ...good, containers: [...good.containers, { ...card('x1'), id: 'task-x1' }, { ...card('x2'), id: 'task-x2' }] };
    expect(scoreShow({ ...CASE, preOpen: pre }, none).failed).toEqual(['f: no open card went to Others']);
  });

  it('a 409 retried without a stack (items not opened) fails', () => {
    const run = { ...good, containers: [], groups: [], answer: 'The stage is full.' };
    expect(scoreShow({ ...CASE, preOpen: ['task-x1'] }, run).pass).toBe(false);
  });

  it('sentences are counted on prose, not on a code fence', () => {
    expect(sentenceCount("5 open tasks are on the stage. In 'Tasks'.")).toBe(2);
    expect(sentenceCount('Görevlerin sahnede, “Görevler” grubunda.')).toBe(1);
  });
});
