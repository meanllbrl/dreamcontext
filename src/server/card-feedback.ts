/**
 * A card the chat did not draw, told to the AGENT that wrote it.
 *
 * The chat validates every `dream-view` card before it draws it (chat-view-spec.ts) and shows the
 * owner a one-line note for a card it skipped: a run card whose command spans two lines, a fifth
 * card in one answer, a secret card with no key. Until this module the agent never heard that.
 * It went on believing its card was on screen and said so ("I dropped the terminal card above,
 * click ▶", Antigravity, owner 2026-11-03), and Codex wrote the same two-line run card. A refusal
 * the agent cannot see is a claim it keeps making (checkout-directive.ts says the same of a refused
 * checkout).
 *
 * So the server reads the turn's answer with the SAME rules at the turn's end and, when a card was
 * skipped, writes one hidden turn to the agent naming what was skipped and why, so it can send the
 * card again correctly and correct what it told the owner. The rules are never relaxed: a run card
 * still shows in full what it runs, on one line.
 *
 * Hidden: the text starts with `<`, which the transcript history and the past-chats index read as
 * the harness's, never the owner's (transcript-history.ts `userPromptOf`). At most once per owner
 * turn: the answer to a feedback turn is never fed back again, so a model that repeats its mistake
 * costs one extra turn, never a loop.
 */
import { MAX_VIEWS_PER_MESSAGE, parseViewBlock } from '../lib/chat-view-spec.js';

/** The chat's own `dream-view` fence (chatActions.ts BLOCK_FENCE_RE, the view half): indented or
 *  not, backticks or tildes, closed by the same fence. An unclosed fence is not a card yet. */
const VIEW_FENCE_RE = /^([ \t]*)(```|~~~)[ \t]*dream-view[ \t]*\r?\n([\s\S]*?)\r?\n?\1\2[ \t]*$/gim;

/** The tag the hidden turn is wrapped in. */
export const CARD_FEEDBACK_TAG = 'dreamcontext-card-feedback';

/** What the chat skipped in one answer, as the owner was told it; empty = every card was drawn. */
export function skippedCards(answer: string): string[] {
  const notices: string[] = [];
  let count = 0;
  let overCap = false;
  for (const m of answer.replace(/\u0000/g, '').matchAll(VIEW_FENCE_RE)) {
    count += 1;
    if (count > MAX_VIEWS_PER_MESSAGE) { overCap = true; continue; }
    notices.push(...parseViewBlock(m[3] ?? '').notices);
  }
  if (overCap) notices.push(`An answer asked for more than ${MAX_VIEWS_PER_MESSAGE} cards: the ones after the ${MAX_VIEWS_PER_MESSAGE}th were not drawn. Send the rest in your next answer.`);
  return notices;
}

/** The hidden turn for one answer, or null when nothing was skipped. */
export function cardFeedback(answer: string): string | null {
  const skipped = skippedCards(answer);
  if (!skipped.length) return null;
  return [
    `<${CARD_FEEDBACK_TAG}>`,
    'The chat did NOT draw part of your last answer. The owner sees only this note where the card should be:',
    ...skipped.map((n) => `- ${n}`),
    'If you told the owner a card is there, say plainly that it was not drawn, then send it again by the rules: a run card\'s "command" is ONE line (join steps with && or ;, or write a script and run that), and one answer holds at most ' + `${MAX_VIEWS_PER_MESSAGE} cards. Do not mention this note itself.`,
    `</${CARD_FEEDBACK_TAG}>`,
  ].join('\n');
}

/**
 * One chat's bookkeeping: the main agent's words this turn, and whether the turn now ending was a
 * feedback turn. Fed every frame of the child's stdout; asked once at each main `result`.
 */
export class CardFeedbackTracker {
  private words: string[] = [];
  private answeringFeedback = false;

  /** A frame from the child: the main agent's text blocks are kept, a sub-agent's and the
   *  bridge's own notes (`<synthetic>`) are not. */
  noteFrame(obj: Record<string, unknown>): void {
    if (obj.type !== 'assistant' || obj.parent_tool_use_id) return;
    const message = obj.message as { model?: unknown; content?: unknown } | undefined;
    if (message?.model === '<synthetic>' || !Array.isArray(message?.content)) return;
    for (const b of message.content) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
        this.words.push((b as { text: string }).text);
      }
    }
  }

  /**
   * The main turn ended: the hidden turn to write now, or null. `ok` = the turn ended normally
   * (no error, no refusal, nothing else about to restart or rotate the session).
   */
  atResult(ok: boolean): string | null {
    const answer = this.words.join('\n\n');
    this.words = [];
    const wasFeedback = this.answeringFeedback;
    this.answeringFeedback = false;
    if (!ok || wasFeedback) return null;
    const text = cardFeedback(answer);
    if (text) this.answeringFeedback = true;
    return text;
  }
}
