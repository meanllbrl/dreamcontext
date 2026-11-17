/**
 * The Super chat's thread filter (task ajanda-gunluk, plan ajanda-filtre C3): an agenda row's
 * press shows only that row's thread. Window memory, one entry per Super session id: a reload or
 * a new Super session clears it; folding, resizing or reopening the chat keeps it (D7).
 *
 * The store owns the About chip it stages (D4): staged on the press, re-staged after every send
 * the session accepted while filtered, and taken back on clear or switch if still unsent. A chip
 * he staged himself is never touched (a `flash` result stores nothing).
 */
import { useSyncExternalStore } from 'react';
import { msgRef, type PadRef } from '../../../lib/superTypes';
import { insertRef, nextAttachmentId, readScratch, withdrawRef, type Attachment } from '../chat/composerScratch';
import { refKey } from '../chat/composerRefs';
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
  /** The chip this filter staged, while it is staged. */
  attachment?: { convId: string; id: string };
  /** What to stage again after each send. */
  chip?: { convId: string; name: string; text: string };
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

/** The chip a filter staged: found back in the scratch by its target (`insertRef` returns no id). */
function stagedId(convId: string, text: string): string | undefined {
  const key = refKey({ text });
  const hit = readScratch(convId).attachments.find((a) => a.kind === 'about' && (key ? refKey(a) === key : a.text === text));
  return hit?.id;
}

function stage(chip: ThreadFilter['chip']): ThreadFilter['attachment'] {
  if (!chip) return undefined;
  const att: Attachment = { id: nextAttachmentId(), kind: 'about', name: chip.name, text: chip.text, quiet: true };
  // `flash`: he has this chip staged already, it is his; `max`: nothing was added.
  if (insertRef(chip.convId, att) !== 'added') return undefined;
  const id = stagedId(chip.convId, chip.text);
  return id ? { convId: chip.convId, id } : undefined;
}

function unstage(f: ThreadFilter): void {
  if (f.attachment) withdrawRef(f.attachment.convId, f.attachment.id);
}

/**
 * An agenda row's press. The same row again clears (D6: 'off'); another row switches; no filter
 * sets one. `chip`: the row's About chip for the Super composer (absent: none staged).
 */
export function pressThread(sid: string, row: { rowKey: string; key: ThreadKey; focusItem?: string; chip?: ThreadFilter['chip'] }): 'on' | 'off' {
  const cur = filters.get(sid);
  if (cur && cur.rowKey === row.rowKey) {
    clearThreadFilter(sid, 'user');
    return 'off';
  }
  if (cur) {
    unstage(cur);
    lastClear.set(sid, { reason: 'switch', was: cur });
  }
  gen += 1;
  const next: ThreadFilter = {
    rowKey: row.rowKey,
    key: { ...row.key, sent: [...row.key.sent, ...(sentByRow.get(sid)?.get(row.rowKey) ?? [])] },
    ...(row.focusItem ? { focusItem: row.focusItem } : {}),
    ...(row.chip ? { chip: row.chip } : {}),
    // A switch keeps the full chat's place: × goes back there, not to the row before.
    ...(cur?.anchor ? { anchor: cur.anchor } : {}),
    seen: cur ? cur.seen : new Set(),
    n: gen,
  };
  next.attachment = stage(row.chip);
  filters.set(sid, next);
  emit();
  return 'on';
}

/** End the filter of `sid`. Its chip goes if still staged and unsent; his own never. */
export function clearThreadFilter(sid: string, reason: ClearReason = 'user'): void {
  const cur = filters.get(sid);
  if (!cur) return;
  unstage(cur);
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
 * The session accepted a send while filtered (send, steer, enqueue: C3). The row's chip is staged
 * again for the next message; a message that went WITHOUT this row's chip is linked by its ref,
 * so it stays in the thread (`key.sent`).
 */
export function noteThreadSend(sid: string | null | undefined, message: string, now = Date.now()): void {
  if (!sid) return;
  const cur = filters.get(sid);
  if (!cur) return;
  const carried = !!cur.chip && message.includes(cur.chip.text);
  const pair: PadRef | null = carried ? null : { ref: msgRef(message), at: now };
  const sent: PadRef[] = pair ? [...cur.key.sent, pair] : cur.key.sent;
  if (pair) {
    const rows = sentByRow.get(sid) ?? new Map<string, PadRef[]>();
    rows.set(cur.rowKey, [...(rows.get(cur.rowKey) ?? []), pair]);
    sentByRow.set(sid, rows);
  }
  const next: ThreadFilter = { ...cur, key: { ...cur.key, sent } };
  // The sent chip left with the message; one still staged (a slash command keeps it) is reused.
  const still = cur.attachment && readScratch(cur.attachment.convId).attachments.some((a) => a.id === cur.attachment!.id);
  next.attachment = still ? cur.attachment : stage(cur.chip);
  filters.set(sid, next);
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
