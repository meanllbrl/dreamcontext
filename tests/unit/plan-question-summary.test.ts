/**
 * A Plan child's design question reached the owner without the plan (owner 2026-11-12: "plan
 * hazır, soru soruyor ama bana önce planı hiç söylemedi"). The class, every path:
 * - the source: a Plan chat's question card with no plan summary goes back to the agent with
 *   what to add, on every tool (Claude's AskUserQuestion and the T3 bridge's same frame);
 * - Codex / Antigravity have no question description: the lines above the question become one;
 * - the Plan briefing says it; the Super's event turn and its `queue ask` reply say it too.
 * Synthetic project and names (`pattern-synthetic-fixtures-for-published-artifacts`).
 */
import { describe, it, expect } from 'vitest';
import { MIN_PLAN_BULLETS, PLAN_SUMMARY_REFUSAL, carriesPlanSummary, planQuestionFrame } from '../../src/lib/plan-question.js';
import { offCardQuestionFrame } from '../../src/lib/card-standalone.js';
import { ToWire, splitQuestionLead, type WireFrame } from '../../src/lib/t3-bridge/to-wire.js';
import { modeBriefing } from '../../src/server/chat-modes.js';
import { PLAN_QUESTION_LINE, superBatchText } from '../../src/lib/super/inbox.js';
import { PLAN_QUEUE_ASK_WARNING, queueAskWarning } from '../../src/lib/super/ask-summary.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';

const OPTIONS = [
  { label: '(b) Filter by ids (Recommended)', description: 'The store filters in its own DB and sends the ids; the ranking stays.' },
  { label: "(a) Copy the partner's schema", description: 'Copies the fields onto the catalogue row; a daily sync is needed.' },
];

/** The card of 2026-11-12, renamed: one decision sentence, no plan. */
const BARE = {
  title: 'Acme search filter → 4 decisions before build',
  questions: [{
    header: 'Design',
    question: 'Which design should the Acme assistant filter go with?',
    description: 'The partner proposed adding is_free/minutes/category to the catalogue row. The plan recommends (b).',
    options: OPTIONS,
  }],
};

const SUMMARY = [
  'The assistant cannot filter recommendations by price, length or category.',
  '- /v1/recommend takes free, max_minutes and category',
  '- The store filters in its own DB and sends candidate ids',
  '- Ranking runs only inside that set, before the limit',
  '- No catalogue copy, no daily sync',
].join('\n');

const WITH_SUMMARY = { ...BARE, questions: [{ ...BARE.questions[0], description: SUMMARY }] };

const frame = (input: unknown, tool = 'AskUserQuestion') => ({
  type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: tool, input },
});

describe('a Plan chat question carries the plan', () => {
  it('the bare card of 2026-11-12 goes back to the agent, with what to add', () => {
    expect(carriesPlanSummary(BARE)).toBe(false);
    const out = planQuestionFrame(frame(BARE), 'plan');
    expect(out).toEqual({ requestId: 'req-1', message: PLAN_SUMMARY_REFUSAL });
    expect(PLAN_SUMMARY_REFUSAL).toContain("FIRST question's description");
    expect(PLAN_SUMMARY_REFUSAL).toContain('problem in one sentence');
    expect(PLAN_SUMMARY_REFUSAL).toContain('above the question');
    // It never pointed off itself: the off-card gate alone let it through.
    expect(offCardQuestionFrame(frame(BARE))).toBeNull();
  });

  it('a card whose first question opens with the problem and 3+ bullets goes as it is', () => {
    expect(carriesPlanSummary(WITH_SUMMARY)).toBe(true);
    expect(planQuestionFrame(frame(WITH_SUMMARY), 'plan')).toBeNull();
    // Numbered and "•" bullets count; the summary may sit in the question text (a tool with no description).
    const numbered = { questions: [{ question: 'Problem.\n1. a\n2) b\n• c\nWhich one?', options: OPTIONS }] };
    expect(carriesPlanSummary(numbered)).toBe(true);
  });

  it(`fewer than ${MIN_PLAN_BULLETS} bullets, or the summary only on a later question, is not enough`, () => {
    const two = { questions: [{ question: 'Q?', description: 'Problem.\n- a\n- b', options: OPTIONS }] };
    expect(carriesPlanSummary(two)).toBe(false);
    const later = { questions: [BARE.questions[0], { question: 'Second?', description: SUMMARY, options: OPTIONS }] };
    expect(carriesPlanSummary(later)).toBe(false);
  });

  it('only a Plan chat, only AskUserQuestion, and never a shape it cannot read', () => {
    for (const mode of ['develop', 'basic', 'super', 'assistant']) expect(planQuestionFrame(frame(BARE), mode), mode).toBeNull();
    expect(planQuestionFrame(frame({ command: 'ls' }, 'Bash'), 'plan')).toBeNull();
    expect(planQuestionFrame({ type: 'assistant' }, 'plan')).toBeNull();
    expect(planQuestionFrame(null, 'plan')).toBeNull();
    for (const odd of [null, 'text', {}, { questions: 'x' }, { questions: [] }, { questions: [null] }]) expect(carriesPlanSummary(odd)).toBe(true);
  });

  it('the Plan briefing tells it, with the place the summary goes', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('**Every card you ask carries the plan**');
    expect(brief).toMatch(/first question's\s+`description` opens with the problem in one sentence/);
    expect(brief).toMatch(/a tool with no description: those lines above the question/);
    expect(modeBriefing('develop', { worktreeAllowed: false })).not.toContain('Every card you ask carries the plan');
  });
});

describe('a Codex / Antigravity question: the lines above it become its description', () => {
  it('splits a multi-line question whose last line asks', () => {
    expect(splitQuestionLead(`${SUMMARY}\nWhich design should the filter go with?`)).toEqual({
      question: 'Which design should the filter go with?', description: SUMMARY,
    });
    expect(splitQuestionLead('One line?')).toEqual({ question: 'One line?' });
    expect(splitQuestionLead('Line one\nnot a question')).toEqual({ question: 'Line one\nnot a question' });
    expect(splitQuestionLead('Problem.\nWhich one?\n\n')).toEqual({ question: 'Which one?', description: 'Problem.' });
  });

  const ask = (questions: Array<{ id: string; question: string }>) => ({
    type: 'turn_item.updated',
    turnItem: {
      id: 'q-1', threadId: 'pt-1', nativeItemRef: null, title: null, type: 'user_input_request', status: 'waiting', requestId: 'r-1',
      questions: questions.map((q) => ({ ...q, header: 'Design', options: [{ label: 'Ids', description: '' }, { label: 'Schema', description: '' }] })),
    },
  });
  const wire = (questions: Array<{ id: string; question: string }>) => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    w.translate({ type: 'provider_turn.updated', providerTurn: { status: 'running' } } as never, 1000);
    const out: WireFrame[] = w.translate(ask(questions) as never, 1000);
    const card = out.find((f) => f.type === 'control_request')!;
    return { w, card, input: (card.request as { input: { questions: Array<Record<string, unknown>> } }).input };
  };

  it('the card the gate reads carries the summary, and the answer maps back to the tool', () => {
    const { w, card, input } = wire([{ id: '0', question: `${SUMMARY}\nWhich design?` }]);
    expect(input.questions[0]).toMatchObject({ question: 'Which design?', description: SUMMARY });
    expect(planQuestionFrame(card as never, 'plan')).toBeNull();
    expect(w.answersFor(String(card.request_id), { answers: { 'Which design?': 'Ids' } })).toEqual({ '0': 'Ids' });
  });

  it('a bare Codex question in a Plan chat is caught like Claude\'s', () => {
    const { card } = wire([{ id: '0', question: 'Which design?' }]);
    expect(planQuestionFrame(card as never, 'plan')?.message).toBe(PLAN_SUMMARY_REFUSAL);
  });

  it('two questions the split would make the same keep their whole text', () => {
    const { w, card, input } = wire([{ id: '0', question: 'Part A.\nWhich one?' }, { id: '1', question: 'Part B.\nWhich one?' }]);
    expect(input.questions.map((q) => q.question)).toEqual(['Part A.\nWhich one?', 'Part B.\nWhich one?']);
    expect(input.questions.every((q) => !('description' in q))).toBe(true);
    expect(w.answersFor(String(card.request_id), { answers: { 'Part B.\nWhich one?': 'Schema' } })).toEqual({ '1': 'Schema' });
  });
});

describe("the Super, when a plan child's question reaches it", () => {
  const state = (mode?: string): SuperState => {
    const s = emptySuperState();
    s.children.p = { sessionId: 'p', brief: 'plan the search filter', adopted: false, startedAt: 1, ...(mode ? { mode } : {}) } as SuperState['children'][string];
    return s;
  };
  const question = [{ id: 'q-1', sessionId: 'p', kind: 'question' as const, state: 'pending' as const, createdAt: 1, direct: true as const }];

  it('its event turn says to show the plan whole, once, for a plan child only', () => {
    const text = superBatchText('/tmp/acme/_dream_context', state('plan'), question, 'b-1');
    expect(text.split(PLAN_QUESTION_LINE).length).toBe(2);
    expect(PLAN_QUESTION_LINE).toContain('--show <its card>');
    expect(superBatchText('/tmp/acme/_dream_context', state('develop'), question, 'b-1')).not.toContain(PLAN_QUESTION_LINE);
    expect(superBatchText('/tmp/acme/_dream_context', state('plan'), [{ ...question[0], kind: 'done' as const }], 'b-1')).not.toContain(PLAN_QUESTION_LINE);
  });

  it('`queue ask` of a plan child with no report card carries a warning', () => {
    expect(queueAskWarning('plan', 0)).toBe(PLAN_QUEUE_ASK_WARNING);
    expect(queueAskWarning('plan', 1)).toBeNull();
    expect(queueAskWarning('develop', 0)).toBeNull();
    expect(queueAskWarning(undefined, 0)).toBeNull();
  });
});
