/**
 * A card the chat skipped reaches the agent that wrote it (src/server/card-feedback.ts). The
 * answers below are the real ones from 3 Nov 2026: Antigravity (Gemini) and Codex both wrote the
 * two-line run card `"command":"ls\npwd"`, and the chat dropped it with only a note for the owner.
 */
import { describe, expect, it } from 'vitest';
import { CARD_FEEDBACK_TAG, CardFeedbackTracker, cardFeedback, endedClean, skippedCards, type TurnEnd } from '../../src/server/card-feedback.js';
import { isCardFeedbackText } from '../../src/lib/chat-view-spec.js';
import { userPromptOf } from '../../src/lib/transcript-history.js';
import { isInjectedUserText } from '../../src/lib/t3-bridge/codex-history.js';
import { parseViewBlock } from '../../dashboard/src/lib/chatViewSpec.js';

const fence = (json: string): string => '```dream-view\n' + json + '\n```';
const TWO_LINE_RUN = fence('{"type":"run","id":"ls-pwd","command":"ls\\npwd","why":"run ls and pwd sequentially"}');
const ONE_LINE_RUN = fence('{"type":"run","id":"git-status","command":"git status --short"}');
const title = (t: string): string => fence(`{"type":"title","text":"${t}"}`);

const assistant = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant', message: { role: 'assistant', model: 'gemini', content: [{ type: 'text', text }] }, parent_tool_use_id: null, ...extra,
});

describe('which cards the chat skipped', () => {
  it('names the two-line run card exactly as the owner was told it', () => {
    const skipped = skippedCards(`Here it is:\n\n${TWO_LINE_RUN}`);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toBe(parseViewBlock('{"type":"run","id":"ls-pwd","command":"ls\\npwd"}').notices[0]);
    expect(skipped[0]).toMatch(/spans several lines/);
  });

  it('is empty when every card was drawn, and for an answer with no card at all', () => {
    expect(skippedCards(`${ONE_LINE_RUN}\n\n${title('Git status')}`)).toEqual([]);
    expect(skippedCards('No cards here, just prose with ```code```.')).toEqual([]);
    expect(cardFeedback(ONE_LINE_RUN)).toBeNull();
  });

  it('says so when an answer held more cards than the chat draws', () => {
    const five = [1, 2, 3, 4, 5].map((n) => title(`Tab ${n}`)).join('\n\n');
    expect(skippedCards(five)).toEqual([expect.stringMatching(/more than 4 cards/)]);
  });

  it('reads an unclosed fence as no card yet, as the chat does', () => {
    expect(skippedCards('```dream-view\n{"type":"run","id":"x","command":"a\\nb"}')).toEqual([]);
  });
});

describe('the hidden turn', () => {
  const text = cardFeedback(TWO_LINE_RUN)!;

  it('tells the agent the card was not drawn, why, and the one-line rule, without relaxing it', () => {
    expect(text.startsWith(`<${CARD_FEEDBACK_TAG}>`)).toBe(true);
    expect(text).toMatch(/did NOT draw/);
    expect(text).toMatch(/spans several lines/);
    expect(text).toMatch(/ONE line/);
    expect(text).toMatch(/&&/);
  });

  it('never shows as owner text: not in the Claude history, not in a Codex or Antigravity thread', () => {
    expect(userPromptOf({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })).toBe('');
    expect(isInjectedUserText(text)).toBe(true);
  });
});

describe('one chat\'s tracker', () => {
  it('asks once at the turn\'s end, and never feeds back the answer to its own feedback', () => {
    const t = new CardFeedbackTracker();
    t.noteFrame(assistant('I dropped the terminal card above, click ▶'));
    t.noteFrame(assistant(TWO_LINE_RUN));
    expect(t.atResult(true)).toMatch(/spans several lines/);
    // The model repeats its mistake in the feedback turn: one extra turn, never a loop.
    t.noteFrame(assistant(TWO_LINE_RUN));
    expect(t.atResult(true)).toBeNull();
    // The owner's next turn is read again.
    t.noteFrame(assistant(TWO_LINE_RUN));
    expect(t.atResult(true)).not.toBeNull();
  });

  it('reads only the main agent\'s own words', () => {
    const t = new CardFeedbackTracker();
    t.noteFrame(assistant(TWO_LINE_RUN, { parent_tool_use_id: 'toolu_sub' }));
    t.noteFrame({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: TWO_LINE_RUN }] }, parent_tool_use_id: null });
    t.noteFrame({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: TWO_LINE_RUN }] } });
    expect(t.atResult(true)).toBeNull();
  });

  it('stays quiet after a turn that did not end cleanly, and forgets its words', () => {
    const t = new CardFeedbackTracker();
    t.noteFrame(assistant(TWO_LINE_RUN));
    expect(t.atResult(false)).toBeNull();
    expect(t.atResult(true)).toBeNull();
  });
});

describe('when a hidden turn may follow (reviewer 2026-11-03, M1 and M2)', () => {
  const clean: TurnEnd = {
    subtype: 'success', isError: false, terminalReason: 'completed', stopAsked: false, limited: false,
    rotating: false, respawning: false, turnsInFlight: 0, switchPending: false, heldTexts: 0, stdinEnding: false,
  };

  it('a turn that simply ended may be told', () => {
    expect(endedClean(clean)).toBe(true);
    expect(endedClean({ ...clean, terminalReason: undefined })).toBe(true);
  });

  it('a Stop is never answered by a hidden turn: Claude ends it as success with terminal_reason aborted_*', () => {
    expect(endedClean({ ...clean, terminalReason: 'aborted_tools' })).toBe(false);
    expect(endedClean({ ...clean, terminalReason: 'aborted_streaming' })).toBe(false);
    expect(endedClean({ ...clean, stopAsked: true })).toBe(false);
  });

  it('another writer owns the next turn: a pending switch, held owner texts, a closing stdin', () => {
    expect(endedClean({ ...clean, switchPending: true })).toBe(false);
    expect(endedClean({ ...clean, heldTexts: 1 })).toBe(false);
    expect(endedClean({ ...clean, stdinEnding: true })).toBe(false);
    expect(endedClean({ ...clean, turnsInFlight: 1 })).toBe(false);
  });

  it('an error, a limit, a rotation or a respawn is not clean', () => {
    expect(endedClean({ ...clean, subtype: 'error_during_execution' })).toBe(false);
    expect(endedClean({ ...clean, isError: true })).toBe(false);
    expect(endedClean({ ...clean, limited: true })).toBe(false);
    expect(endedClean({ ...clean, rotating: true })).toBe(false);
    expect(endedClean({ ...clean, respawning: true })).toBe(false);
  });

  it('the bridge tells the hidden turn from the owner words by the same tag (stdio.ts drops it when busy)', () => {
    expect(isCardFeedbackText(cardFeedback(TWO_LINE_RUN)!)).toBe(true);
    expect(isCardFeedbackText('OWNER words <dreamcontext-card-feedback>')).toBe(false);
  });
});
