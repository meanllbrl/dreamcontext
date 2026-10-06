import { dropThreadBucket } from '../agents/agentsChannelHost';
import { createChatSession, type ChatSession } from '../sleepy/chatSession';
import { DEFAULT_CHAT_MODE } from '../../lib/chatModes';

/**
 * The board agents' client state, outliving the cards and the panel remounting (Excalidraw
 * remounts an embeddable on every scroll out of view and back):
 *
 *  - each agent's ONE conversation on a board (owner, 2026-10-06: "card = identity, the
 *    conversation always in the panel"): a Chat-bridge session opened with the agent and the
 *    board, never the automation's thread, keyed `home.<agent>` whether the agent lives on the
 *    board (its manifest names it) or only has a card there. Its conversation id is kept per
 *    machine in localStorage, not in the synced board file: the transcript lives on this machine.
 *  - the composer buckets: staged chips (a board element dropped on an agent's card or on the
 *    panel lands as a `ref` chip) and the unsent draft.
 *
 * The conversations survive the owner leaving the Whiteboard page (`WhiteboardsPage` drops
 * the rest with {@link dropBoardAgentScratch} `keepHome`); they end with their project or with
 * the sweep ({@link sweepHomeSessions}) once their board is no longer open.
 */

const PREFIX = 'wb-agent:';

/** Every bucket id handed out this app run, so the page can release them. */
const minted = new Set<string>();

const HOME_PREFIX = 'home.';

/**
 * The key an agent's conversation on a board goes by (`home.<agent>`): the panel and every card
 * of that agent on the board are one conversation. Kept under the name it had when only home
 * agents had one, so a conversation remembered then still opens. Excalidraw element ids never
 * contain a dot-led `home.`.
 */
export function homeCardId(agent: string): string {
  return `${HOME_PREFIX}${agent}`;
}

function isHomeCard(elementId: string): boolean {
  return elementId.startsWith(HOME_PREFIX);
}

/** The bucket for one card: `wb-agent:<vault>:<board>:<element id>`, the project encoded (a
 *  board slug, an element id and `home.<agent>` hold no `:`). Recorded for the drops. */
export function boardAgentScratchId(vault: string, board: string, elementId: string): string {
  const id = `${PREFIX}${encodeURIComponent(vault)}:${board}:${elementId}`;
  minted.add(id);
  return id;
}

/** The vault and board hold no `:` (the vault is encoded), so the element id is everything
 *  after the second one, colons and all. */
function parseBucket(id: string): { vault: string; board: string; elementId: string } | null {
  const rest = id.slice(PREFIX.length);
  const i = rest.indexOf(':');
  const j = i < 0 ? -1 : rest.indexOf(':', i + 1);
  if (j < 0) return null;
  try { return { vault: decodeURIComponent(rest.slice(0, i)), board: rest.slice(i + 1, j), elementId: rest.slice(j + 1) }; } catch { return null; }
}

function dropBucket(id: string): void {
  dropThreadBucket(id);
  minted.delete(id);
}

/** The composer bucket a board element dropped for `agent` goes to: that agent's conversation
 *  on the board, the one the panel shows. */
export function cardScratchId(vault: string, board: string, agent: string): string {
  return boardAgentScratchId(vault, board, homeCardId(agent));
}

// ── a board's older per-card conversations ───────────────────────────────────────────────

/** Boards (`<vault>|<board>|`) whose file this page has read, their agent cards' older
 *  conversations handed to the home keys. Cleared with the page's drop. */
const adoptedBoards = new Set<string>();
const adoptListeners = new Set<() => void>();
/** `<vault>|<board>|`, the vault encoded so a `|` in it never shifts the board. */
const boardKey = (vault: string, board: string) => `${encodeURIComponent(vault)}|${board}|`;
const ofVault = (key: string, vault: string) => key.startsWith(`${encodeURIComponent(vault)}|`);

export function subscribeAdoption(fn: () => void): () => void {
  adoptListeners.add(fn);
  return () => { adoptListeners.delete(fn); };
}

/**
 * The board's file is in: each agent card's own conversation from before the panel goes to its
 * agent's home conversation ({@link adoptHomeConversation}), before the panel opens one. The
 * cards themselves mount later (Excalidraw renders embeddables after the scene), too late when
 * the panel is already open. Called with no cards when the board did not load.
 */
export function adoptBoardCards(vault: string, board: string, cards: readonly { elementId: string; agent: string }[]): void {
  for (const c of cards) adoptHomeConversation({ vault, board, elementId: c.elementId }, c.agent);
  adoptedBoards.add(boardKey(vault, board));
  for (const fn of adoptListeners) fn();
}

/** Whether the panel may open this board's home conversation (heard via subscribeAdoption). */
export function boardCardsAdopted(vault: string, board: string): boolean {
  return adoptedBoards.has(boardKey(vault, board));
}

// ── the card's session ──────────────────────────────────────────────────────────────────────

/** Which card: the project, the board and the card's Excalidraw element. */
export interface CardSpec {
  vault: string;
  board: string;
  elementId: string;
}

interface CardEntry {
  spec: CardSpec;
  session: ChatSession | null;
  listeners: Set<() => void>;
  /** Set while a sweep waits for this busy home session to go idle (the unsubscribe). */
  watch: (() => void) | null;
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
  if (!e) {
    e = { spec: { vault: c.vault, board: c.board, elementId: c.elementId }, session: null, listeners: new Set(), watch: null };
    cards.set(key, e);
  }
  return e;
}

/** An entry holding no session and heard by nobody is gone; one still heard stays, so its
 *  listeners hear the next open (a deleted entry would leave them on a dead object). */
function forgetIfUnused(e: CardEntry): void {
  const key = cardKey(e.spec);
  if (!e.session && e.listeners.size === 0 && cards.get(key) === e) cards.delete(key);
}

/** The card's live session, or null before its first activation. */
export function peekCardSession(c: CardSpec): ChatSession | null {
  return cards.get(cardKey(c))?.session ?? null;
}

/** Hear the card's session change (opened, replaced, busy, asking). Returns the unsubscribe. */
export function subscribeCardSession(c: CardSpec, fn: () => void): () => void {
  const e = entryFor(c);
  e.listeners.add(fn);
  return () => { e.listeners.delete(fn); forgetIfUnused(e); };
}

/** The conversation this card continues on this machine, or null before its first one. */
export function cardConversationId(c: CardSpec): string | null {
  return readConversation(c);
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
  unwatch(e);
  previous?.dispose();
  const notify = () => { for (const fn of e.listeners) fn(); };
  const cs = createChatSession(
    c.vault, false, notify, id, resume, c.model, c.effort, '', '', false, DEFAULT_CHAT_MODE, '', '',
    { agent: c.agent, board: c.board },
  );
  // The composer keys its chips on this, so a board element dragged onto the card lands here.
  cs.scratchId = boardAgentScratchId(c.vault, c.board, c.elementId);
  e.session = cs;
  notify();
  return cs;
}

/**
 * A card that used to keep its own conversation (before the panel) hands it to the board's
 * home conversation, once, so the owner's history is not lost when the two became one.
 */
export function adoptHomeConversation(from: CardSpec, agent: string): void {
  const home = { ...from, elementId: homeCardId(agent) };
  if (isHomeCard(from.elementId) || readConversation(home)) return;
  const id = readConversation(from);
  if (id) saveConversation(home, id);
}

function unwatch(e: CardEntry): void {
  e.watch?.();
  e.watch = null;
}

function endEntry(e: CardEntry): void {
  unwatch(e);
  const bucket = e.session?.scratchId;
  e.session?.dispose();
  e.session = null;
  if (bucket) dropBucket(bucket);
  for (const fn of [...e.listeners]) fn();
  forgetIfUnused(e);
}

/** Release card buckets (chips with their previews, and drafts) and end card sessions.
 *  Idempotent. The conversation ids stay remembered, so a card reopened later continues where
 *  it left off. `vault` limits it to one project's cards (the others' pages are still open);
 *  `keepHome` spares the boards' home conversations (the agent panel's), which outlive the
 *  page but never their project: `ProjectInstance` drops its vault's on unmount. */
export function dropBoardAgentScratch(opts: { vault?: string; keepHome?: boolean } = {}): void {
  const mine = (vault: string) => !opts.vault || vault === opts.vault;
  for (const e of [...cards.values()]) {
    if (!mine(e.spec.vault)) continue;
    if (opts.keepHome && isHomeCard(e.spec.elementId)) continue;
    endEntry(e);
  }
  // Buckets no session held (a draft, or chips dropped on a card that never opened).
  for (const id of [...minted]) {
    const b = parseBucket(id);
    // An id this module cannot read belongs to no project it can name: only the full drop takes it.
    if (!b) { if (opts.vault) continue; } else {
      if (!mine(b.vault)) continue;
      if (opts.keepHome && isHomeCard(b.elementId)) continue;
    }
    dropBucket(id);
  }
  if (!opts.vault) latestKeep.clear(); else latestKeep.delete(opts.vault);
  const gone = (k: string) => !opts.vault || ofVault(k, opts.vault);
  for (const k of [...adoptedBoards]) if (gone(k)) adoptedBoards.delete(k);
}

/** The newest sweep's verdict per project, read again when a busy session it spared goes idle. */
const latestKeep = new Map<string, (board: string, agent: string) => boolean>();

/**
 * Bound the live home conversations of a project to the ones still wanted: while the owner is
 * on the Whiteboard page, `keep(board, agent)` holds the open board's home agents; every other
 * home conversation (another board visited earlier, a deleted board, an agent no longer at home
 * there) ends, with its draft. One mid-turn or waiting on the owner finishes first: it is
 * watched, and ends when it goes idle unless a newer sweep wants it again. Its conversation id
 * is remembered, so reopening it resumes.
 */
export function sweepHomeSessions(vault: string, keep: (board: string, agent: string) => boolean): void {
  latestKeep.set(vault, keep);
  const wanted = (board: string, elementId: string) =>
    !!latestKeep.get(vault)?.(board, elementId.slice(HOME_PREFIX.length));
  for (const e of [...cards.values()]) {
    const { spec, session } = e;
    if (spec.vault !== vault || !isHomeCard(spec.elementId)) continue;
    if (wanted(spec.board, spec.elementId)) { unwatch(e); continue; }
    if (!session || !(session.busy || session.asking)) { endEntry(e); continue; }
    if (e.watch) continue;
    e.watch = session.subscribe(() => {
      if (e.session !== session) { unwatch(e); return; }
      if (wanted(spec.board, spec.elementId)) { unwatch(e); return; }
      // Never inside the session's own notify: end it on the next tick, if still unwanted and idle.
      if (session.busy || session.asking) return;
      queueMicrotask(() => {
        if (e.session !== session || !e.watch || session.busy || session.asking) return;
        if (wanted(spec.board, spec.elementId)) { unwatch(e); return; }
        endEntry(e);
      });
    });
  }
  for (const id of [...minted]) {
    const b = parseBucket(id);
    if (!b || b.vault !== vault || !isHomeCard(b.elementId) || wanted(b.board, b.elementId)) continue;
    if (cards.get(cardKey(b))?.session) continue;
    dropBucket(id);
  }
}
