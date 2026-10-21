import { useSyncExternalStore } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession } from '../chatSession';

/**
 * The one channel between the centre chat's event lines and the job bar (plan r4 D8): a name in
 * an event line opens the list at that row. Module state in this window only; no request, no
 * timer. The bar listens while it is mounted; with no bar nothing happens.
 */
type Listener = (row: string) => void;
const listeners = new Set<Listener>();

/** Open the job list at `row` (a JobRow key, e.g. `c:<child session id>`). */
export function openJobRow(row: string): void {
  for (const fn of [...listeners]) fn(row);
}

/** The bar's subscription; returns the unsubscribe. */
export function onOpenJobRow(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ─── What the centre's event lines read (titles, the batches that render full) ────────────


export interface SuperEventContext {
  ownerBatches: readonly string[];
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
  superSession: ChatSession | undefined;
  sessionFor: (claudeId: string) => ChatSession | undefined;
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
