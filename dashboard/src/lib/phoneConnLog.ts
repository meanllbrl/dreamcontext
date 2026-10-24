/**
 * The phone's own connection log: a small ring of socket and card events, so the next time
 * the owner says "the phone misbehaved" there is evidence instead of a guess.
 *
 * Why it exists: on 2026-10-23 a question card lost its pick on the owner's phone while the
 * chat jumped every second; the measurements reproduced the symptom by dropping the socket,
 * but the trigger that dropped it on the owner's Mac was never found. The phone is the only
 * side that sees its own drops, so it keeps them, and the Sohbetler list sends them to the
 * Mac on a tap (`POST /api/handsfree/phone-log`).
 *
 * Bounded twice (≤ {@link PHONE_LOG_CAP} events, the last {@link PHONE_LOG_WINDOW_MS}), kept
 * in `sessionStorage` so a reload keeps the evidence (a `boot` event marks it), and carries
 * NO free text: every field is a number, a flag, an 8-char id prefix or a closed enum. Off the
 * phone surface `record` does nothing.
 */
import { isMacPhoneSurface } from './phoneSurface';

export const PHONE_LOG_CAP = 500;
export const PHONE_LOG_WINDOW_MS = 10 * 60_000;
export const PHONE_LOG_UA_MAX = 200;
const STORAGE_KEY = 'dc-phone-conn-log';

/** Every event kind. Mirrored by the server's validator (src/lib/handsfree/mac/phone-log.ts). */
export const PHONE_LOG_KINDS = [
  'boot', 'attempt', 'open', 'close', 'reattached', 'ask', 'card-mount', 'respawn', 'chip', 'submit-held',
] as const;
export type PhoneLogKind = (typeof PHONE_LOG_KINDS)[number];

/** Why, for the events that have a why. A closed set, never prose. */
export const PHONE_LOG_REASONS = [
  // respawn
  'account', 'mode', 'resume',
  // submit-held
  'offline', 'unsent',
  // chip
  'shown', 'hidden',
] as const;
export type PhoneLogReason = (typeof PHONE_LOG_REASONS)[number];

export interface PhoneLogEvent {
  /** Epoch ms. */
  t: number;
  k: PhoneLogKind;
  /** The conversation's first 8 characters ('' when there is none). */
  cid8: string;
  code?: number;
  busy?: boolean;
  /** The request id's first 8 characters. */
  req8?: string;
  reason?: PhoneLogReason;
}

export interface PhoneLogSnapshot {
  v: 1;
  app: string;
  ua: string;
  events: PhoneLogEvent[];
}

let events: PhoneLogEvent[] | null = null;

function storage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

function prune(list: PhoneLogEvent[], now: number): PhoneLogEvent[] {
  const fresh = list.filter((e) => now - e.t <= PHONE_LOG_WINDOW_MS);
  return fresh.length > PHONE_LOG_CAP ? fresh.slice(fresh.length - PHONE_LOG_CAP) : fresh;
}

/** Loaded once per page: what this tab logged before a reload, then a `boot` mark. */
function load(): PhoneLogEvent[] {
  if (events) return events;
  let saved: PhoneLogEvent[] = [];
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) saved = parsed.filter((e): e is PhoneLogEvent => !!e && typeof e === 'object' && typeof (e as PhoneLogEvent).t === 'number');
  } catch { /* a broken copy is no evidence */ }
  const now = Date.now();
  events = prune([...saved, { t: now, k: 'boot', cid8: '' }], now);
  save();
  return events;
}

function save(): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(events ?? [])); } catch { /* full or blocked: memory still has it */ }
}

const id8 = (s: string | undefined): string => (s ?? '').slice(0, 8);

/** Log one event. A no-op off the phone surface. */
export function recordPhoneEvent(
  k: PhoneLogKind,
  claudeId: string,
  extra: { code?: number; busy?: boolean; requestId?: string; reason?: PhoneLogReason } = {},
): void {
  if (!isMacPhoneSurface()) return;
  const now = Date.now();
  const ev: PhoneLogEvent = { t: now, k, cid8: id8(claudeId) };
  if (typeof extra.code === 'number') ev.code = extra.code;
  if (typeof extra.busy === 'boolean') ev.busy = extra.busy;
  if (extra.requestId) ev.req8 = id8(extra.requestId);
  if (extra.reason) ev.reason = extra.reason;
  events = prune([...load(), ev], now);
  save();
}

/** What the list's button sends to the Mac. */
export function phoneLogSnapshot(): PhoneLogSnapshot {
  const now = Date.now();
  const list = prune(load(), now);
  // Vite defines it; under plain Node (the unit tests) it does not exist.
  const app = typeof __DC_VERSION__ === 'string' ? __DC_VERSION__ : '';
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent ?? '') : '';
  return { v: 1, app, ua: ua.slice(0, PHONE_LOG_UA_MAX), events: list };
}

/** Tests only: forget the in-memory copy (the next call reloads from storage). */
export function resetPhoneLogForTests(): void {
  events = null;
}
