/**
 * A question card's picks, kept OUTSIDE the card.
 *
 * SurveyCard is keyed by its requestId, and the card can unmount while the question is still
 * open: a `reattached busy:false` clears `pending` and the server re-sends the same ask, a
 * phone leaving the chat for the Sohbetler list and coming back remounts the pane. Local
 * `useState` died with it, so the owner's pick vanished under their thumb (hands-free,
 * 2026-10-23). This store outlives the card and the pane; the card reads it on mount.
 *
 * A WRITTEN answer is not proof it ARRIVED: there is no ack frame, and a dead phone socket can
 * stay OPEN until TCP gives up. So a sent answer only marks `sentAt`; the draft dies when the
 * session's turn moves on without the question (a `result` with the id no longer pending — a
 * lost answer is re-sent by the server on reattach BEFORE any `result`), when the tab closes
 * for good, or at the cap.
 *
 * Zero React, zero session: chatSession.ts, SurveyCard and AgentSurface all import it.
 */
import type { SurveyPicks } from './surveyAnswers';

export interface SurveyDraft {
  picks: SurveyPicks;
  page: number;
  /** When an answer carrying these picks was written to the socket (not proof it arrived). */
  sentAt?: number;
}

/** Enough for every open card of every tab; the oldest goes first (Map insertion order). */
export const SURVEY_DRAFT_CAP = 64;

const drafts = new Map<string, SurveyDraft>();

export function surveyDraftKey(claudeId: string, requestId: string): string {
  return `${claudeId}\u0000${requestId}`;
}

/** The conversation and request a key was made from (for the phone's connection log). */
export function surveyDraftOwner(key: string): { claudeId: string; requestId: string } {
  const at = key.indexOf('\u0000');
  return at < 0 ? { claudeId: '', requestId: key } : { claudeId: key.slice(0, at), requestId: key.slice(at + 1) };
}

/** The draft for this card, fitted to the questions it has NOW: a page past the end is
 *  clamped and a pick for a question that is gone is dropped. */
export function readSurveyDraft(key: string, questionKeys: readonly string[]): SurveyDraft | null {
  const d = drafts.get(key);
  if (!d) return null;
  const known = new Set(questionKeys);
  const picks: SurveyPicks = {};
  for (const [q, pick] of Object.entries(d.picks)) if (known.has(q)) picks[q] = pick;
  const page = Math.max(0, Math.min(d.page, questionKeys.length - 1));
  return { picks, page, ...(d.sentAt !== undefined ? { sentAt: d.sentAt } : {}) };
}

export function writeSurveyDraft(key: string, picks: SurveyPicks, page: number): void {
  const was = drafts.get(key);
  drafts.delete(key);   // re-insert: the most recently touched is the last evicted
  drafts.set(key, { picks, page, ...(was?.sentAt !== undefined ? { sentAt: was.sentAt } : {}) });
  while (drafts.size > SURVEY_DRAFT_CAP) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function markSurveyDraftSent(key: string, at = Date.now()): void {
  const d = drafts.get(key);
  if (d) drafts.set(key, { ...d, sentAt: at });
}

export function dropSurveyDraft(key: string): void {
  drafts.delete(key);
}

/** Every draft of one conversation (the tab closed for good). */
export function dropSurveyDraftsFor(claudeId: string): void {
  const prefix = `${claudeId}\u0000`;
  for (const k of [...drafts.keys()]) if (k.startsWith(prefix)) drafts.delete(k);
}

/** A `result` on this conversation: the drafts whose question is no longer open are done. */
export function dropSettledSurveyDrafts(claudeId: string, openRequestIds: readonly string[]): void {
  const prefix = `${claudeId}\u0000`;
  const open = new Set(openRequestIds.map((r) => surveyDraftKey(claudeId, r)));
  for (const k of [...drafts.keys()]) if (k.startsWith(prefix) && !open.has(k)) drafts.delete(k);
}

/** Tests only. */
export function clearSurveyDraftsForTests(): void {
  drafts.clear();
}
