import { dropThreadBucket } from '../agents/agentsChannelHost';
import { createChatSession, type ChatSession } from '../sleepy/chatSession';
import { DEFAULT_CHAT_MODE } from '../../lib/chatModes';

/**
 * Each agent card's two pieces of client state, both per CARD (two cards for one agent on one
 * board are two conversations) and both outliving the card remounting (Excalidraw remounts an
 * embeddable on every scroll out of view and back). Their death hangs off the board PAGE:
 * `WhiteboardsPage` calls {@link dropBoardAgentScratch} on unmount.
 *
 *  - the composer bucket: staged chips (a dragged board element lands here as a `ref` chip)
 *    and the unsent draft;
 *  - the card's own chat session (owner, 2026-10-05: "the card is a session of that whiteboard,
 *    like the notch Assistant"): a Chat-bridge conversation opened with the card's agent and
 *    board, never the automation's thread. Its conversation id is kept per machine in
 *    localStorage, not in the synced board file: the transcript lives on this machine.
 */

const PREFIX = 'wb-agent:';

/** Every bucket id handed out this app run, so the page can release them all. */
const minted = new Set<string>();

/** The bucket for one card: `wb-agent:<board>:<element id>`. Recorded for the page's drop. */
export function boardAgentScratchId(board: string, elementId: string): string {
  const id = `${PREFIX}${board}:${elementId}`;
  minted.add(id);
  return id;
}

// ── the card's session ──────────────────────────────────────────────────────────────────────

/** Which card: the project, the board and the card's Excalidraw element. */
export interface CardSpec {
  vault: string;
  board: string;
  elementId: string;
}

interface CardEntry {
  session: ChatSession | null;
  listeners: Set<() => void>;
}

const cards = new Map<string, CardEntry>();

function cardKey(c: CardSpec): string {
  return `${c.vault}|${c.board}|${c.elementId}`;
}

/** Where a card's conversation id is remembered on this machine. Exported for the test. */
export function cardConversationKey(c: CardSpec): string {
  return `dc.wbAgentConv.${c.vault}.${c.board}.${c.elementId}`;
}

function readConversation(c: CardSpec): string | null {
  try { return localStorage.getItem(cardConversationKey(c)); } catch { return null; }
}

function saveConversation(c: CardSpec, id: string): void {
  try { localStorage.setItem(cardConversationKey(c), id); } catch { /* the next open starts afresh */ }
}

function entryFor(c: CardSpec): CardEntry {
  const key = cardKey(c);
  let e = cards.get(key);
  if (!e) { e = { session: null, listeners: new Set() }; cards.set(key, e); }
  return e;
}

/** The card's live session, or null before its first activation. */
export function peekCardSession(c: CardSpec): ChatSession | null {
  return cards.get(cardKey(c))?.session ?? null;
}

/** Hear the card's session change (opened, replaced, busy, asking). Returns the unsubscribe. */
export function subscribeCardSession(c: CardSpec, fn: () => void): () => void {
  const e = entryFor(c);
  e.listeners.add(fn);
  return () => { e.listeners.delete(fn); };
}

/** True when this card has talked before on this machine (a conversation to continue). */
export function cardHasConversation(c: CardSpec): boolean {
  return !!readConversation(c);
}

/**
 * Open the card's session. `continue` keeps a live one, else resumes the remembered
 * conversation, else starts one; `new` ends the live one and starts afresh (the menu's
 * New conversation, the notch's own pattern); `resume` respawns the same conversation (the
 * Session ended banner).
 */
export function openCardSession(
  c: CardSpec & { agent: string; model: string; effort: string },
  how: 'continue' | 'new' | 'resume' = 'continue',
): ChatSession {
  const e = entryFor(c);
  if (how === 'continue' && e.session) return e.session;
  const previous = e.session;
  let id = how === 'new' ? null : previous?.claudeId ?? readConversation(c);
  const resume = !!id;
  if (!id) {
    id = crypto.randomUUID();
    saveConversation(c, id);
  }
  previous?.dispose();
  const notify = () => { for (const fn of e.listeners) fn(); };
  const cs = createChatSession(
    c.vault, false, notify, id, resume, c.model, c.effort, '', '', false, DEFAULT_CHAT_MODE, '', '',
    { agent: c.agent, board: c.board },
  );
  // The composer keys its chips on this, so a board element dragged onto the card lands here.
  cs.scratchId = boardAgentScratchId(c.board, c.elementId);
  e.session = cs;
  notify();
  return cs;
}

/** Release every card bucket (chips with their previews, and drafts) and end every card's
 *  session. Idempotent. The conversation ids stay remembered, so a card reopened later
 *  continues where it left off. */
export function dropBoardAgentScratch(): void {
  for (const id of minted) dropThreadBucket(id);
  minted.clear();
  for (const e of cards.values()) {
    e.session?.dispose();
    e.session = null;
  }
  cards.clear();
}
