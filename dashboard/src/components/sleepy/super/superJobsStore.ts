import type { PhonePermission } from './usePhoneSuperQuestions';
import { useSyncExternalStore } from 'react';
import type { SuperAskSpec, SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession } from '../chatSession';
import type { SurveyRead } from '../chat/SurveyCard';
import type { KnownCard, StageNow } from '../../../lib/turnCards';

/**
 * The one channel between the centre chat's event lines and the stage: a child's name in an
 * event line shows that child beside the centre (the agenda is the super's notepad, not a list
 * of children, so there is no row to point at). Module state in this window only; no request,
 * no timer. The stage listens while it is mounted; with none nothing happens.
 */
type Listener = (row: string) => void;
const listeners = new Set<Listener>();

/** Show what `row` names (`c:<child session id>`). */
export function openJobRow(row: string): void {
  for (const fn of [...listeners]) fn(row);
}

/** The stage's subscription; returns the unsubscribe. */
export function onOpenJobRow(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ─── What the centre's event lines read (titles, the batches that render full) ────────────


export interface SuperEventContext {
  ownerBatches: readonly string[];
  /** A member Super's turns for main Super (plan-r10 1): marked "Super için", never unread. */
  mainBatches?: readonly string[];
  /** A member Super's open and recent `request`/`reply` items by id, with main's text: its live
   *  delivery chip carries no text, so its framed block reads it here (plan-r10 1). */
  requests?: Readonly<Record<string, { kind: 'request' | 'reply'; text: string }>>;
  titleFor: (child: string) => string;
}
const contexts = new Map<string, SuperEventContext>();
const ctxListeners = new Set<() => void>();
const ctxKeys = new Map<string, string>();

/** The surface publishes, for its super session, what an event line needs; null withdraws it.
 *  Only a real change notifies (the key is the batches and the titles), so a re-render of the
 *  stage never re-renders the centre's transcript. */
export function publishSuperEventContext(sessionId: string, ctx: SuperEventContext | null, key = ''): void {
  if (!ctx) {
    if (!contexts.delete(sessionId)) return;
    ctxKeys.delete(sessionId);
  } else {
    if (ctxKeys.get(sessionId) === key && contexts.has(sessionId)) return;
    contexts.set(sessionId, ctx);
    ctxKeys.set(sessionId, key);
  }
  for (const fn of [...ctxListeners]) fn();
}

function subscribeCtx(fn: () => void): () => void {
  ctxListeners.add(fn);
  return () => { ctxListeners.delete(fn); };
}

/** The event-line context of `sessionId` (null for any chat that is not a handed-over super). */
export function useSuperEventContext(sessionId: string | null): SuperEventContext | null {
  const read = () => (sessionId ? contexts.get(sessionId) ?? null : null);
  return useSyncExternalStore(subscribeCtx, read, read);
}

// ─── The questions the super chat draws as cards (superQuestions.ts) ────────

/** What a question card in the super chat reads: the record's open owner questions and the
 *  sessions an answer rides on. Published by AgentSurface, which holds the record whether or not
 *  the stage is up; null = no live record (taken back): the cards are static. */
export interface SuperQuestionView {
  open: readonly SuperQueueItem[];
  /** MAIN's chat only: AI Team members waiting on the owner (`member` mirrors), each drawn as a
   *  card that opens that member (`openMemberMirrors`). */
  members?: readonly SuperQueueItem[];
  superSession: ChatSession | undefined;
  sessionFor: (claudeId: string) => ChatSession | undefined;
  /** A surface that holds no child's socket (the hands-free phone): each child question's card
   *  as the server read it from the child, and the route that answers it through the Mac window
   *  (`/api/agent/super-answer`). Absent on the laptop, which answers through the child's chat. */
  remote?: SuperRemoteQuestions;
  /** A Super `ask`'s report cards on the stage, each with the click that brings it into view
   *  (`SuperQueueItem.read`); absent where no stage can be arranged. */
  readsOf?: (item: SuperQueueItem) => SurveyRead[];
  /** The owner cards its children left (sahip-karti-yerinde K7): every `owner` item of this
   *  record that carries a card handle and is open, plus one this window saw open and whose result
   *  line is set (`delivery`), so the card shows its outcome in place. Drawn from the RECORD
   *  (`item.card`), never from chat text. Member mirrors with a card are in `members`. */
  cards?: readonly SuperQueueItem[];
  /** A child's job name (the slot's heading "<child> needs you"). */
  titleFor?: (claudeId: string) => string;
  /** A child parked to save memory (its tab kept dormant): the "Paused" chip. */
  pausedFor?: (claudeId: string) => boolean;
}

/** An owner item that stands for a card the slot draws (K7): a crew child's card wait. */
export function isOwnerCardItem(q: Pick<SuperQueueItem, 'kind' | 'card'>): boolean {
  return (q.kind === 'owner' || q.kind === 'member') && !!q.card;
}

/** Card items this window saw open: a closed one stays in the slot only while its result line
 *  says where the result went (bounded; a reload starts clean). */
const seenOpenCards = new Set<string>();
const SEEN_CAP = 200;

/** The card items the slot draws, oldest first (K7). */
export function slotCardItems(queue: readonly SuperQueueItem[]): SuperQueueItem[] {
  const out: SuperQueueItem[] = [];
  for (const q of queue) {
    if (q.kind !== 'owner' || !q.card) continue;
    if (q.state !== 'done') {
      seenOpenCards.add(q.id);
      if (seenOpenCards.size > SEEN_CAP) seenOpenCards.delete(seenOpenCards.values().next().value as string);
      out.push(q);
    } else if (q.delivery && seenOpenCards.has(q.id)) {
      out.push(q);
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** What a card item's slot redraws on (its handle, state and result line). */
export function slotCardKey(items: readonly SuperQueueItem[]): string {
  return items.map((q) => [q.id, q.state, q.delivery ?? '', q.card?.cardRef ?? '', q.card?.deliverTo ?? '', q.sessionId].join('\u0003')).join('\u0001');
}

// ─── The bar's ▶ Run lands in the slot (K7) ───────────────────────────────────

type SlotRun = { n: number; shown: string };
const slotRuns = new Map<string, SlotRun>();
const slotRunListeners = new Set<() => void>();
const slotMounted = new Map<string, number>();
let slotRunSeq = 0;

/** The slot card of `itemId` is mounted (it returns the unmount). */
export function mountOwnerSlot(itemId: string): () => void {
  slotMounted.set(itemId, (slotMounted.get(itemId) ?? 0) + 1);
  return () => {
    const n = (slotMounted.get(itemId) ?? 1) - 1;
    if (n <= 0) { slotMounted.delete(itemId); slotRuns.delete(itemId); } else slotMounted.set(itemId, n);
  };
}

/**
 * The bar's ▶ Run: start the run in the slot, with the command the bar DREW (`shown`). The slot's
 * run card starts it only when that is exactly the command it draws, and mints the ticket for it.
 * False when no slot is mounted for the item (the caller brings the Super chat up and says so).
 */
export function requestSlotRun(itemId: string, shown: string): boolean {
  if (!slotMounted.has(itemId)) return false;
  slotRuns.set(itemId, { n: ++slotRunSeq, shown });
  for (const fn of [...slotRunListeners]) fn();
  return true;
}

function subscribeSlotRuns(fn: () => void): () => void {
  slotRunListeners.add(fn);
  return () => { slotRunListeners.delete(fn); };
}

/** The newest ▶ Run the bar asked of this item's slot. */
export function useSlotRunRequest(itemId: string): SlotRun | undefined {
  const read = () => slotRuns.get(itemId);
  return useSyncExternalStore(subscribeSlotRuns, read, read);
}

/** Bring an item's card in the Super chat's slot into view (the bar's verbs, Show, the agenda's
 *  Waiting line). False when it is not drawn (the chat not on screen). */
export function showOwnerSlot(itemId: string, root: ParentNode = document): boolean {
  const card = [...root.querySelectorAll<HTMLElement>('[data-testid="super-owner-card"]')].find((el) => el.dataset.item === itemId);
  if (!card || !card.isConnected) return false;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  card.querySelector<HTMLElement>('input, button:not([disabled])')?.focus({ preventScroll: true });
  return true;
}

/** Tests only. */
export function _resetOwnerSlots(): void {
  seenOpenCards.clear();
  slotRuns.clear();
  slotMounted.clear();
}

/** The phone's way to a child question it cannot hold (usePhoneSuperQuestions.ts). */
export interface SuperRemoteQuestions {
  /** The child's AskUserQuestion as the card draws it, or null (words only). */
  cardOf: (itemId: string) => SuperAskSpec | null;
  /** Send the owner's answer. `ok`: the child has it; `retry`: it did not, and another tap may
   *  land (the window away, a socket down, a timeout); neither: stale, answered elsewhere. */
  answer: (item: SuperQueueItem, body: { picked: Record<string, string>; notes?: Record<string, string> } | { unclear: string }) => Promise<{ ok: boolean; retry: boolean }>;
  /** A child's permission that waits for the owner: its tool and command, as the server read
   *  them from the child (null: not a permission, or gone). */
  permissionOf?: (itemId: string) => PhonePermission | null;
  /** The owner's Allow or Deny on it, through the Mac window (`/api/agent/super-permission`). */
  answerPermission?: (item: SuperQueueItem, choice: 'allow' | 'deny') => Promise<{ ok: boolean; retry: boolean; error?: string }>;
}
const questionViews = new Map<string, SuperQuestionView>();
const questionKeys = new Map<string, string>();
const questionListeners = new Set<() => void>();

/** Only a real change notifies (the key: the open items and the super session), so the cards
 *  re-render on a question's arrival or close, never on every record push. */
export function publishSuperQuestions(sessionId: string, view: SuperQuestionView | null, key = ''): void {
  if (!view) {
    if (!questionViews.delete(sessionId)) return;
    questionKeys.delete(sessionId);
  } else {
    if (questionKeys.get(sessionId) === key && questionViews.has(sessionId)) return;
    questionViews.set(sessionId, view);
    questionKeys.set(sessionId, key);
  }
  for (const fn of [...questionListeners]) fn();
}

function subscribeQuestions(fn: () => void): () => void {
  questionListeners.add(fn);
  return () => { questionListeners.delete(fn); };
}

/** The question view of `sessionId` (null for any chat that is not a live super). */
export function useSuperQuestions(sessionId: string | null): SuperQuestionView | null {
  const read = () => (sessionId ? questionViews.get(sessionId) ?? null : null);
  return useSyncExternalStore(subscribeQuestions, read, read);
}

// ─── The stage as the answers' card tiles read it (turnCards.ts) ──────────────────────────

/**
 * What a tile under a Super answer needs from the stage (owner 2026-11-08): where each card is now
 * and the click that brings one back. Published by AgentSurface, which holds the record, for its
 * super session; null withdraws it (a surface going away, the record taken back), and then a tile
 * draws from the turn's own record and opens full screen instead.
 */
export interface SuperStageView {
  now: StageNow;
  /** Bring a card (side by side) or a group (presented) to the front of the stage, from Others too. */
  bring: (target: { card: string } | { group: string }) => void;
  /** Open again cards the owner closed (the owner's own open): one side by side, several as a
   *  group presented. Resolves false when none could be opened. */
  reopen: (cards: readonly KnownCard[]) => Promise<boolean>;
}
const stageViews = new Map<string, SuperStageView>();
const stageKeys = new Map<string, string>();
const stageListeners = new Set<() => void>();

/** Only a real change notifies (the key: each card's id, place and title, each group's cards). */
export function publishSuperStage(sessionId: string, view: SuperStageView | null, key = ''): void {
  if (!view) {
    if (!stageViews.delete(sessionId)) return;
    stageKeys.delete(sessionId);
  } else {
    if (stageKeys.get(sessionId) === key && stageViews.has(sessionId)) {
      // Same cards: keep the newest click (it closes over the newest record) without a re-render.
      stageViews.set(sessionId, view);
      return;
    }
    stageViews.set(sessionId, view);
    stageKeys.set(sessionId, key);
  }
  for (const fn of [...stageListeners]) fn();
}

function subscribeStage(fn: () => void): () => void {
  stageListeners.add(fn);
  return () => { stageListeners.delete(fn); };
}

/** The stage of `sessionId` as the tiles read it (null: no stage record here). */
export function useSuperStage(sessionId: string | null | undefined): SuperStageView | null {
  const read = () => (sessionId ? stageViews.get(sessionId) ?? null : null);
  return useSyncExternalStore(subscribeStage, read, read);
}
