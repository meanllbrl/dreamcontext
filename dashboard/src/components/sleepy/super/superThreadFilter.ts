/**
 * The Super chat's thread filter (task ajanda-gunluk, plan ajanda-filtre C3): an agenda row's
 * press shows only that row's thread. Window memory, one entry per Super session id: a reload or
 * a new Super session clears it; folding, resizing or reopening the chat keeps it (D7).
 *
 * Nothing is staged in the composer (owner 2026-11-17: the strip alone says which thread he is
 * in): a message sent while filtered opens with the row's About block (`withThreadAbout`), so it
 * joins the row's thread with no chip on screen.
 */
import { useSyncExternalStore } from 'react';
import { msgRef, type PadRef } from '../../../lib/superTypes';
import type { ThreadKey } from './superHandover';

/** Where the full chat was when the filter began: restored on ×, Esc or the same row (D6). */
export interface ThreadAnchor {
  /** The first visible entry (its id; `ts` + `kind` survive a replay that renamed it). */
  id: string | null;
  ts: number;
  kind: string;
  /** Its top, in px from the scroller's top. */
  offset: number;
  /** The full chat followed the bottom. */
  stick: boolean;
}

export interface ThreadFilter {
  /** The agenda row's key: the same row's press clears, its highlight follows it. */
  rowKey: string;
  key: ThreadKey;
  /** A question or owner-card row: the card brought into view after the filter lands (D3). */
  focusItem?: string;
  /** The row's About block: a message sent while filtered opens with it (`withThreadAbout`). */
  about?: string;
  /** Set by the chat on entry. */
  anchor?: ThreadAnchor;
  /** Unread unit ids he saw while filtered (applied on clear, C4.3). */
  seen: Set<string>;
  /** Bumped on every set: one press, one landing. */
  n: number;
}

/** Why a filter ended: the chat restores its anchor only for his own way out. */
export type ClearReason = 'user' | 'gate' | 'switch' | 'session';

const filters = new Map<string, ThreadFilter>();
/** Per Super session, per row: the chipless sends made from its filter. They outlive the
 *  filter, so pressing the row again shows them (the server links only what the Super noted). */
const sentByRow = new Map<string, Map<string, PadRef[]>>();
const lastClear = new Map<string, { reason: ClearReason; was: ThreadFilter }>();
const listeners = new Set<() => void>();
let gen = 0;

function emit(): void {
  for (const fn of [...listeners]) fn();
}

export function subscribeThreadFilters(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function threadFilterOf(sid: string | null | undefined): ThreadFilter | null {
  return sid ? filters.get(sid) ?? null : null;
}

/** The filter of one Super session, live. */
export function useThreadFilter(sid: string | null | undefined): ThreadFilter | null {
  return useSyncExternalStore(subscribeThreadFilters, () => threadFilterOf(sid), () => null);
}

/** How the last filter of `sid` ended (read by the chat when its filter goes; kept until the
 *  next clear, so a render React repeats reads the same answer). */
export function lastClearOf(sid: string): { reason: ClearReason; was: ThreadFilter } | null {
  return lastClear.get(sid) ?? null;
}

// ── The jump gate (C4): a door to something the filter hides clears it first ──────────

/** Per Super session: does its filter hide this card (question, owner card, member card)? */
const hiders = new Map<string, (item: string) => boolean>();

/** The filtered chat says which cards it hides; null unregisters. */
export function setThreadHider(sid: string, hides: ((item: string) => boolean) | null): void {
  if (hides) hiders.set(sid, hides); else hiders.delete(sid);
}

/**
 * A door found no card for `item`. When a thread filter is hiding it, that filter ends (the
 * gate) and `retry` runs once the full chat has drawn; true then, the door is on its way.
 */
export function revealHiddenCard(item: string, retry: () => void): boolean {
  for (const [sid, hides] of hiders) {
    if (!filters.has(sid) || !hides(item)) continue;
    clearThreadFilter(sid, 'gate');
    afterDraw(retry);
    return true;
  }
  return false;
}

/** Two frames: the store's change has rendered and committed. */
export function afterDraw(fn: () => void): void {
  if (typeof requestAnimationFrame !== 'function') { setTimeout(fn, 0); return; }
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * An agenda row's press. The same row again clears (D6: 'off'); another row switches; no filter
 * sets one. `about`: the row's About block its sends open with (absent: sends go as typed).
 */
export function pressThread(sid: string, row: { rowKey: string; key: ThreadKey; focusItem?: string; about?: string }): 'on' | 'off' {
  const cur = filters.get(sid);
  if (cur && cur.rowKey === row.rowKey) {
    clearThreadFilter(sid, 'user');
    return 'off';
  }
  if (cur) lastClear.set(sid, { reason: 'switch', was: cur });
  gen += 1;
  const next: ThreadFilter = {
    rowKey: row.rowKey,
    key: { ...row.key, sent: [...row.key.sent, ...(sentByRow.get(sid)?.get(row.rowKey) ?? [])] },
    ...(row.focusItem ? { focusItem: row.focusItem } : {}),
    ...(row.about ? { about: row.about } : {}),
    // A switch keeps the full chat's place: × goes back there, not to the row before.
    ...(cur?.anchor ? { anchor: cur.anchor } : {}),
    seen: cur ? cur.seen : new Set(),
    n: gen,
  };
  filters.set(sid, next);
  emit();
  return 'on';
}

/** End the filter of `sid`. */
export function clearThreadFilter(sid: string, reason: ClearReason = 'user'): void {
  const cur = filters.get(sid);
  if (!cur) return;
  filters.delete(sid);
  lastClear.set(sid, { reason, was: cur });
  emit();
}

/** The chat recorded where the full chat was when the filter began. */
export function setThreadAnchor(sid: string, anchor: ThreadAnchor): void {
  const cur = filters.get(sid);
  if (cur && !cur.anchor) cur.anchor = anchor;
}

/** Unread units he saw inside the filter (no read is applied while it is on). */
export function noteThreadSeen(sid: string, ids: readonly string[]): void {
  const cur = filters.get(sid);
  if (!cur) return;
  for (const id of ids) cur.seen.add(id);
}

/**
 * The message a send in `sid` delivers: while filtered to a row it opens with the row's About
 * block, as if its chip had been staged, unless it is a slash command or already carries an
 * About block of his own (another row he chose: that message is his to address).
 */
export function withThreadAbout(sid: string | null | undefined, message: string, opts: { slash?: boolean; ownAbout?: boolean } = {}): string {
  const about = threadFilterOf(sid)?.about;
  if (!about || opts.slash || opts.ownAbout || message.includes(about)) return message;
  return `${about}\n\n${message}`;
}

/**
 * The session accepted a send while filtered (send, steer, enqueue: C3). A message that went
 * WITHOUT this row's About block (a slash command, his own About for another row) is linked by
 * its ref, so it stays in the thread (`key.sent`).
 */
export function noteThreadSend(sid: string | null | undefined, message: string, now = Date.now()): void {
  if (!sid) return;
  const cur = filters.get(sid);
  if (!cur) return;
  if (cur.about && message.includes(cur.about)) return;
  const pair: PadRef = { ref: msgRef(message), at: now };
  const rows = sentByRow.get(sid) ?? new Map<string, PadRef[]>();
  rows.set(cur.rowKey, [...(rows.get(cur.rowKey) ?? []), pair]);
  sentByRow.set(sid, rows);
  filters.set(sid, { ...cur, key: { ...cur.key, sent: [...cur.key.sent, pair] } });
  emit();
}

/** Tests only. */
export function __resetThreadFiltersForTests(): void {
  filters.clear();
  sentByRow.clear();
  lastClear.clear();
  hiders.clear();
  gen = 0;
}
