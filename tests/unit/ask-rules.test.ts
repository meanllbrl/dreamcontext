/**
 * Fewer question cards, ruled by kind (owner, 2026-11-18: "daha az soru kartı", "Uygula, plan
 * onayı da kalksın"). 713 Super cards in 30 days were read one by one: 365 should never have been
 * a card. No briefing line said when NOT to ask and six pushed towards asking, so the rule is ONE
 * text (`src/lib/ask-rules.ts`) and every asker reads it: the Super and a member's Super, every
 * chat on every tool and a Super's child, Plan mode, the notes an ask answers with, and the
 * orchestration guide. This file pins that reach, and that the lines which pushed are gone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_DECIDED_LINE, ASK_HIS_KINDS, ASK_NEVER_KINDS, ASK_RULES, ASK_RULES_SHORT } from '../../src/lib/ask-rules.js';
import { SUPER_BRIEF_TEXT, SUPER_TELEGRAM_LINE, memberSlotOf, modeBriefing, superBriefing, superMemberBriefing } from '../../src/server/chat-modes.js';
import { CHAT_SURFACE_BRIEFING, SUPER_CHILD_BRIEFING } from '../../src/server/chat-surface.js';
import { BATCH_LAST_LINE, MEMBER_LINE, PLAN_DONE_LINE, PLAN_QUESTION_LINE, heldLastLine } from '../../src/lib/super/inbox.js';
import { PLAN_REPORT_REFUSAL, START_ASK_NOTE, START_ASK_WARNING } from '../../src/lib/super/ask-summary.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');
const flat = (s: string): string => s.replace(/\s+/g, ' ');
const GUIDE = flat(read('skill/references/super-orchestration.md'));
const INBOX_SRC = read('src/lib/super/inbox.ts');
const MEMBER = superMemberBriefing(memberSlotOf({ slug: 'doc', title: 'Doc', prompt: 'You look after the logs.' }));

describe('the ask rules are one text, by kind and never by count', () => {
  it('says when a card comes at all, and rules by kind', () => {
    expect(ASK_RULES).toContain('A question card comes only when the work is truly blocked: a decision only he can make, or a step only he can do.');
    expect(ASK_RULES).toContain('By kind, never by count');
    // Owner: no count caps anywhere. The rule names kinds, never "at most N cards".
    expect(ASK_RULES).not.toMatch(/at most \d|no more than \d|\d+ cards? (a|per) /i);
  });

  it('keeps as his exactly what he said stays his: a real person, a publish, money, data, the irreversible, a screen', () => {
    for (const kind of ['a message to a real person', 'a publish or anything that goes live or leaves his machine (a push, a pull request, a merge to the default branch, a deploy, a release)', 'money', 'real data (deleted, migrated, overwritten)', 'any other step that cannot be undone', 'a screen he will see (its drawing first)', 'a choice that grows or contradicts what he asked for']) {
      expect(ASK_HIS_KINDS, kind).toContain(kind);
    }
    expect(ASK_RULES).toContain(`**His, one tap:** ${ASK_HIS_KINDS}. Those ready together on one subject go in ONE card.`);
  });

  it('names what is never a card: housekeeping, a technical choice, starting asked work, a reading review, a repeat', () => {
    for (const kind of ['housekeeping (tidying memory, a local commit, a local branch, restarting a stuck job, a screenshot taken again)', 'a technical choice (names, order, libraries, the split, models)', 'starting or going on with work he asked for or approved ("shall I start", "shall I continue", "the next wave?")', 'a review that only reads', 'a question whose card is still open or already answered']) {
      expect(ASK_NEVER_KINDS, kind).toContain(kind);
    }
    expect(ASK_RULES).toContain(`**Yours, never a card:** ${ASK_NEVER_KINDS}. Whatever stays on his machine and can be undone: ${ASK_DECIDED_LINE}.`);
    expect(ASK_DECIDED_LINE).toBe('decide, do it, and say in one line what you did and that he can say otherwise');
  });

  it('one card is one decision, a look waits for its drawing, nothing is asked twice, text and card never repeat', () => {
    expect(ASK_RULES).toContain('**One card, one decision:** the small choices beside it you take as you would recommend and list in your text.');
    expect(ASK_RULES).toContain('An option that is a look: no card before its drawing exists.');
    // End review r1: "never twice" holds only while the card is open. The server closes a card on a
    // message written about it (and a member's card on any message), so a decision of his that was
    // closed undecided gets ONE reworded card: it never stays in prose alone.
    expect(ASK_RULES).toContain('**Never twice:** a card that is still open is never asked again: answer his message, and close it when his words answer it.');
    expect(ASK_RULES).toContain('A card his message closed without deciding (he wrote that he did not understand it, or about something else) and that is still his by kind: explain in plain words, in text, then ONE reworded card, never the same one.');
    expect(ASK_RULES).toContain('**Text and card never repeat each other:** no line that a question waits (the card sits right under your text), and what he must read stands in ONE place.');
    expect(ASK_RULES).toContain('He corrects a call you made: undo it; the same kind corrected again is a written rule from then on.');
  });
});

describe('every asker reads the same rule', () => {
  it('the Super, a member\'s Super and a resumed session carry it whole', () => {
    for (const b of [superBriefing(), MEMBER, SUPER_BRIEF_TEXT]) {
      expect(b).toContain('## When you ask him');
      expect(b).toContain(ASK_RULES);
      expect(b).toContain('Work he asked for or approved never waits for a second yes: a finished plan that changes no screen is\nbuilt at once');
      expect(b).toContain('A\nquestion of a child or a member is yours first (Events).');
      expect(b).toContain('His words answered your open card:\n`super queue done <ask id>`.');
      expect(b).toContain('A call of yours he corrected twice: `dreamcontext learn`.');
    }
  });

  it('every chat on every tool carries it in the Asking section, before how a card is written', () => {
    // One briefing file feeds Claude, Codex and Antigravity chats (agent-chat.ts briefingArg).
    // It rides in every chat turn, so it is the short form: the same two kind lists, word for word.
    const ask = CHAT_SURFACE_BRIEFING.slice(CHAT_SURFACE_BRIEFING.indexOf('## Asking'));
    expect(ask.indexOf(ASK_RULES_SHORT)).toBeGreaterThan(0);
    expect(ask.indexOf(ASK_RULES_SHORT)).toBeLessThan(ask.indexOf('When you do ask:'));
    expect(ask).toContain('Every card must stand alone:');
    expect(ASK_RULES_SHORT).toContain('A card only when the work is truly blocked: a decision only he can make, or a step only he can do.');
    expect(ASK_RULES_SHORT).toContain(`His, by kind: ${ASK_HIS_KINDS}; those ready together go in ONE card.`);
    expect(ASK_RULES_SHORT).toContain(`Never a card: ${ASK_NEVER_KINDS}.`);
    expect(ASK_RULES_SHORT).toContain(`Whatever stays on his machine and can be undone: ${ASK_DECIDED_LINE}.`);
    expect(ASK_RULES_SHORT).toContain('One card is one decision, never asked again while it is open or once it is answered, never repeated in your text.');
  });

  it('a Super\'s child takes the call that is its own and asks only when blocked or the choice is the owner\'s by kind', () => {
    expect(SUPER_CHILD_BRIEFING).toContain('What your brief, the project and the\nbrain settle is never asked: take the call that is yours by the Asking rules above and name it\nin your last reply.');
    expect(SUPER_CHILD_BRIEFING).toContain("Truly blocked, or the choice is the owner's by kind:\nuse AskUserQuestion");
  });

  it('Plan mode asks only what is left and is his, and a plan that changes no screen asks for no approval', () => {
    const plan = modeBriefing('plan', { worktreeAllowed: false });
    expect(plan).toContain('What the request, your brief or the brain answers is\n   never asked: take it and write it in the plan as an assumption.');
    expect(plan).toContain('Ask only what is left and is\n   his alone to say, in ONE card, then WAIT');
    expect(plan).toContain('A plan that changes no screen\n   asks for no approval: write `UX/UI change: none` in technical details and go on.');
    // A screen still waits for his yes on its drawing (soul: the owner agrees the outcome before a build).
    expect(plan).toContain('No yes from the owner himself, no progress.');
  });

  it('the orchestration guide says the same kinds, word for word', () => {
    expect(GUIDE).toContain('**A card only when the work is truly blocked**');
    expect(GUIDE).toContain(`**His, one tap:** ${ASK_HIS_KINDS}. Those ready together on one subject go in ONE card.`);
    expect(GUIDE).toContain(`**Yours, never a card:** ${ASK_NEVER_KINDS}.`);
    expect(GUIDE).toContain(`Whatever stays on his machine and can be undone: ${ASK_DECIDED_LINE}.`);
    expect(GUIDE).toContain('**No start card for work he asked for or approved**');
    expect(GUIDE).toContain('A finished plan that changes no screen is built at once');
    expect(GUIDE).toContain("A child's question is yours first");
    expect(GUIDE).toContain('the summary stands there only: neither your text nor the card repeats it');
  });
});

describe('the lines that pushed towards asking are gone', () => {
  const SOURCES = ['src/server/chat-modes.ts', 'src/server/chat-surface.ts', 'src/lib/super/inbox.ts', 'src/lib/super/owner-question.ts', 'src/lib/super/ask-summary.ts'].map(read).join('\n');

  it('no briefing, note or guide tells an asker to write that a question waits', () => {
    for (const text of [SOURCES, GUIDE]) {
      expect(text).not.toMatch(/say in one line that a question waits/i);
      expect(text).not.toContain('the text says in one line that a question waits');
      expect(text).not.toContain('your one line FIRST');
      expect(text).not.toContain('one line (a question waits) FIRST');
    }
    expect(superBriefing()).toContain('and the text never says that a question waits');
    expect(superBriefing()).toContain('Write nothing between tool calls, and nothing');
  });

  it('a child\'s question is the Super\'s first, everywhere the Super is told about one', () => {
    for (const text of [SOURCES, GUIDE]) expect(text).not.toContain('only when the brief and the project settle it');
    expect(superBriefing()).toContain("A child's QUESTION is yours first");
    expect(BATCH_LAST_LINE).toContain('Every question is yours first');
    expect(BATCH_LAST_LINE).toContain(`Only what is his by kind goes to him (${ASK_HIS_KINDS})`);
    // An event turn stays silent (owner 2026-10-21): the Super's own call is named with the job's result.
    expect(BATCH_LAST_LINE).toContain('name your call the next time you write to him about that job, never as a line in this turn');
    expect(superBriefing()).toContain('undone (name that call the next time you write to him about that job)');
    expect(heldLastLine()).toContain('it is yours first');
    expect(PLAN_QUESTION_LINE).toContain('It is yours first');
    expect(MEMBER_LINE).toContain('A waits=ask question is yours first');
    // What stays his is still never answered or worked around.
    expect(MEMBER_LINE).toContain('Every item you do not answer yourself (a waits=ask that is his by kind, a waits=question, a permission, an owner card) is his to decide: never answer, allow or work around it; tell him in one line which member waits and on what');
  });

  it('asked or approved work gets no start card, and a plan summary stands in one place', () => {
    expect(PLAN_DONE_LINE).toContain('never ask him to start it. Start its develop child now');
    // Only a READY plan is built: a stop card or a refused `plan link` stays his (end review r1).
    expect(PLAN_DONE_LINE).toContain('A plan that is ready (`dreamcontext tasks ready <slug>` passes; one stopped on its stop card, or with a refused `plan link`, is his card and never built past)');
    expect(PLAN_DONE_LINE).toContain('(when `delegate` answers `held` with `kept: true`: that it waits its turn; `not_kept` or `pool_full`: that it did NOT start, and why)');
    expect(superBriefing()).toContain('neither your text nor the card repeats it');
    for (const text of [SOURCES, GUIDE]) {
      expect(text).not.toContain('your text gives the same summary');
      expect(text).not.toContain('give him the same summary in your text');
      expect(text).not.toContain('write him the same summary');
    }
    for (const w of [START_ASK_NOTE, START_ASK_WARNING]) expect(w).toContain('Work he asked for or approved starts and goes on without a card');
    expect(PLAN_REPORT_REFUSAL).toContain('your text does not repeat it');
  });

  it('an open card is never asked again, on the Mac or on Telegram', () => {
    expect(superBriefing()).toContain('so answer that message and never ask the open card again');
    expect(SUPER_TELEGRAM_LINE).toContain('When his message left the card open (`<super-ask-still-open>`): answer his message and never ask the open card again, in a card or in prose');
    expect(SUPER_TELEGRAM_LINE).not.toContain('ask again with a new `super ask` card');
    expect(superBriefing()).toContain('Its card still open (`<super-ask-still-open>`): it stays, never a second one.');
  });

  it('a card his message CLOSED without deciding, still his by kind, gets one reworded card (end review r1)', () => {
    // The server closes the Super's card on a message written about it, and a member's card on any
    // message of his in its chat (asksAnswered): the decision must not stay in prose alone.
    expect(superBriefing()).toContain('His message closed it (written about the card, or his "ask again" tap, `[super answer] … unclear`) and the decision\nis still his: ONE reworded card with what was missing, never the same card.');
    expect(SUPER_TELEGRAM_LINE).toContain("When his message closed it without deciding (a reply to the card that he did not understand, `<super-ask-closed>` in a member's chat) and the decision is still his: explain in plain words, then ONE reworded card.");
    expect(GUIDE).toContain('A card his message closed without deciding');
    expect(GUIDE).toContain("in a member's chat any message of his closes it");
    // The member's own closed-card note says the same as the rule, never the opposite.
    expect(INBOX_SRC).toContain('and the decision is still his by kind: answer this message first, in plain words, then ask ONE reworded');
  });

  it('his idea is weighed and done; a card only against a decision he made or what is his by kind', () => {
    const b = superBriefing();
    expect(b).toContain('Sound: say so\nin one line and why, and do it. Weak: say in one line where and what you do about it, and go on. A card\nonly when it contradicts a decision HE made or is his by kind (below): it names both sides.');
    expect(b).not.toContain('he decides in a `super ask`.');
    expect(GUIDE).not.toContain('he decides in a `super ask` card');
  });
});
