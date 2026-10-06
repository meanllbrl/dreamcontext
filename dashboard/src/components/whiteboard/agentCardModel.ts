/**
 * The agent card's decisions, kept pure so they are tested without a canvas: the one status
 * word the card wears and the one line an S card shows.
 *
 * The card is its own chat session (boardAgentScratch.ts), so both read that session: whether
 * a turn is running, whether it waits on the owner, and its transcript items. The agent's
 * automation feed is not read here: what the card says stays in the card.
 *
 * No React, no CSS: root vitest imports this file.
 */

// ── the status word ───────────────────────────────────────────────────────────────────────────

export type AgentCardState =
  | { kind: 'working' }
  | { kind: 'needs-you' }
  | { kind: 'unapproved' }
  | { kind: 'idle' };

/**
 * One word for the card's header, in the order a reader needs it: an agent that is not
 * approved cannot be talked to at all (the server refuses its card), so that outranks
 * everything; then waiting on the reader; then working; else idle. Whether its schedule is
 * on does not matter here: the card is a conversation, not a run.
 */
export function agentCardState(input: {
  approved: boolean;
  /** The card's session has a turn running. */
  busy: boolean;
  /** The card's session waits on a permission or a question. */
  asking: boolean;
}): AgentCardState {
  if (!input.approved) return { kind: 'unapproved' };
  if (input.asking) return { kind: 'needs-you' };
  if (input.busy) return { kind: 'working' };
  return { kind: 'idle' };
}

// ── the S card's line ─────────────────────────────────────────────────────────────────────────

/** What the S card needs of a transcript item: its kind and, for the two it shows, its text. */
export interface CardItem {
  kind: string;
  text?: string;
}

/** The newest thing said in the card's conversation: the owner's message or the agent's text. */
export function lastSaid(items: readonly CardItem[]): { who: 'you' | 'agent'; text: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    // A dragged board element rides the message as a `dcref:wb/…` token; it is not prose.
    const text = (it.text ?? '').replace(/dcref:wb\/\S+/g, '').trim();
    if ((it.kind === 'user' || it.kind === 'text') && text) {
      return { who: it.kind === 'user' ? 'you' : 'agent', text };
    }
  }
  return null;
}

/** A line's text on one line, for the S card. */
export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── the card's last lines ─────────────────────────────────────────────────────────────────────

/** One line the card shows: who said it and what. */
export interface SaidLine {
  who: 'you' | 'agent';
  text: string;
}

/** The last `max` things said in the conversation, oldest first: the owner's messages and the
 *  agent's text, never tools or thinking, a dragged element's token taken out. */
export function lastLines(items: readonly CardItem[], max: number): SaidLine[] {
  const out: SaidLine[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < max; i--) {
    const it = items[i]!;
    const text = (it.text ?? '').replace(/dcref:wb\/\S+/g, '').trim();
    if ((it.kind === 'user' || it.kind === 'text') && text) out.push({ who: it.kind === 'user' ? 'you' : 'agent', text });
  }
  return out.reverse();
}

/** Older lines fade: the newest is full strength, the oldest of a full card a third. */
export function lineOpacity(index: number, count: number): number {
  const fromNewest = count - 1 - index;
  return Math.max(0.35, 1 - fromNewest * 0.13);
}
