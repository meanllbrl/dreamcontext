import { useCallback, useSyncExternalStore } from 'react';
import type { SuperDockPill } from '../components/sleepy/super/superHandover';

/**
 * A page talks to the ONE Super chat of its own project (the board writing field, owner
 * 2026-11-11): one hop on the project's bus, never the window, so one project's page never
 * writes into another project's Super.
 *
 * - {@link sendFromPage}: the page hands its message over; AgentSurface answers in the same
 *   tick (`dispatchEvent` is synchronous) and says whether the write itself went out. Nobody
 *   answering (no surface, a dormant tab) reads as `off`.
 * - {@link openSuperFromPage}: open the dock window.
 * - The presence store: AgentSurface publishes the Super's state (on, connected, busy, the
 *   pill's model, its children); the page publishes that its field is mounted, so the corner
 *   pill steps aside. The field renders only after the first publish.
 *
 * Pure but for the React hooks at the bottom: root vitest imports this file.
 */

export const SUPER_PAGE_SEND_EVENT = 'dreamcontext-super-page-send';
export const SUPER_PAGE_OPEN_EVENT = 'dreamcontext-super-page-open';

export type SuperPageRefusal = 'off' | 'connecting' | 'closed';

/** The event's detail: the answerer fills `accepted` (and `reason` when refused). */
export interface SuperPageSendDetail {
  text: string;
  accepted: boolean;
  reason?: SuperPageRefusal;
}

export type SuperPageSendResult = { accepted: true } | { accepted: false; reason: SuperPageRefusal };

/** Hand a message to this project's Super chat. At most one write per call. */
export function sendFromPage(bus: EventTarget, text: string): SuperPageSendResult {
  const detail: SuperPageSendDetail = { text, accepted: false };
  bus.dispatchEvent(new CustomEvent<SuperPageSendDetail>(SUPER_PAGE_SEND_EVENT, { detail }));
  if (detail.accepted) return { accepted: true };
  return { accepted: false, reason: detail.reason ?? 'off' };
}

export function openSuperFromPage(bus: EventTarget): void {
  bus.dispatchEvent(new CustomEvent(SUPER_PAGE_OPEN_EVENT));
}

/** The slice of a chat session the answer reads and writes through. */
export interface PageSendTarget {
  status: 'connecting' | 'open' | 'closed';
}

/**
 * AgentSurface's answer. `write` is `sendToSuper` bound to the session: true only when the frame
 * went out. Answered once: a second listener never sends the same words again.
 */
export function answerPageSend(
  detail: SuperPageSendDetail | undefined,
  opts: { on: boolean; session: PageSendTarget | undefined; write: (text: string) => boolean },
): void {
  if (!detail || typeof detail.text !== 'string' || detail.accepted || detail.reason) return;
  if (!opts.on) { detail.reason = 'off'; return; }
  if (!opts.session || opts.session.status === 'connecting') { detail.reason = 'connecting'; return; }
  if (opts.session.status !== 'open') { detail.reason = 'closed'; return; }
  if (opts.write(detail.text)) detail.accepted = true;
  else detail.reason = 'closed';
}

// ── presence ────────────────────────────────────────────────────────────────────────────────

export interface SuperPresenceChild {
  /** The owner message the job answers (`msgRef`), when the Super started it in his turn. */
  origin?: string;
  live: boolean;
}

export interface SuperPresence {
  on: boolean;
  connected: boolean;
  busy: boolean;
  /** When the Super's current turn was first seen running (ms); null while idle. */
  busySince: number | null;
  /** The corner pill's model: the field's mark draws the same state. */
  mark: SuperDockPill | null;
  children: SuperPresenceChild[];
}

interface Store {
  presence: SuperPresence | null;
  fieldMounted: boolean;
  listeners: Set<() => void>;
}

const stores = new WeakMap<EventTarget, Store>();

function storeOf(bus: EventTarget): Store {
  let s = stores.get(bus);
  if (!s) {
    s = { presence: null, fieldMounted: false, listeners: new Set() };
    stores.set(bus, s);
  }
  return s;
}

function notify(s: Store): void {
  for (const l of s.listeners) l();
}

/** AgentSurface: the Super's state (null when it unmounts). `busySince` is kept across
 *  publishes of the same turn and stamped `now` on the idle→busy edge. */
export function publishSuperPresence(
  bus: EventTarget,
  next: Omit<SuperPresence, 'busySince'> | null,
  now = Date.now(),
): void {
  const s = storeOf(bus);
  const prev = s.presence;
  const value: SuperPresence | null = next
    ? { ...next, busySince: next.busy ? (prev?.busy && prev.busySince !== null ? prev.busySince : now) : null }
    : null;
  if (JSON.stringify(value) === JSON.stringify(prev)) return;
  s.presence = value;
  notify(s);
}

export function readSuperPresence(bus: EventTarget): SuperPresence | null {
  return storeOf(bus).presence;
}

/** The page: its writing field is (not) on screen. */
export function publishFieldMounted(bus: EventTarget, mounted: boolean): void {
  const s = storeOf(bus);
  if (s.fieldMounted === mounted) return;
  s.fieldMounted = mounted;
  notify(s);
}

export function readFieldMounted(bus: EventTarget): boolean {
  return storeOf(bus).fieldMounted;
}

function useStore<T>(bus: EventTarget, read: (s: Store) => T): T {
  const subscribe = useCallback((cb: () => void) => {
    const s = storeOf(bus);
    s.listeners.add(cb);
    return () => { s.listeners.delete(cb); };
  }, [bus]);
  return useSyncExternalStore(subscribe, () => read(storeOf(bus)));
}

export function useSuperPresence(bus: EventTarget): SuperPresence | null {
  return useStore(bus, (s) => s.presence);
}

export function useFieldMounted(bus: EventTarget): boolean {
  return useStore(bus, (s) => s.fieldMounted);
}

// ── "working": tied to the message, not to the Super's turn (plan Decision 8) ───────────────

/** How long the work marks stay at most. */
export const WORK_MAX_MS = 15 * 60_000;
/** After the ACK the Super's state takes a moment to arrive: the marks hold this long. */
export const WORK_GRACE_MS = 8_000;

export interface WorkTrack {
  /** `msgRef` of the exact text sent. */
  ref: string;
  /** When the write was accepted (ms). */
  sentAt: number;
}

/**
 * Is the work a sent message started still going? True while the Super's turn that took it runs
 * (a turn first seen running at or after the send: a turn already running before it, an
 * unrelated event turn, never arms it alone), or any child whose `origin` is the message's ref
 * is live; for {@link WORK_GRACE_MS} after the ACK either way; never past {@link WORK_MAX_MS}.
 */
export function workGoing(track: WorkTrack | null, presence: SuperPresence | null, now: number): boolean {
  if (!track) return false;
  const age = now - track.sentAt;
  if (age < 0 || age >= WORK_MAX_MS) return false;
  if (age < WORK_GRACE_MS) return true;
  if (!presence) return false;
  const turn = presence.busy && presence.busySince !== null && presence.busySince >= track.sentAt;
  return turn || presence.children.some((c) => c.live && c.origin === track.ref);
}
