import { useEffect, useSyncExternalStore } from 'react';
import { canonicalJson, type PublicCard } from '../../../src/lib/cards/public.js';
import type { RunViewSpec, SecretViewSpec } from './chatViewSpec';

/**
 * The server's run/secret card records of each chat (plan I1, J2, K1), as the window and the
 * phone page see them.
 *
 * A chat-host card never derives a cardRef: it finds the server's record by its `id` AND its
 * canonical spec (exactly what the agent wrote), the NEWEST record when a card was posted again,
 * and sends that record's cardRef back. The records arrive with the chat socket's `cards` frame
 * on every change, and once per chat from `GET /api/agent/cards` for a mount or a reload; until
 * that snapshot is in, a run card's ▶ stays disabled (no `cmd=` fallback race, J2).
 */

export type CardRecordView = PublicCard;

interface SessionCards { loaded: boolean; cards: PublicCard[] }

const store = new Map<string, SessionCards>();
const listeners = new Set<() => void>();
const inflight = new Set<string>();
let version = 0;

function emit(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

function isCards(v: unknown): v is PublicCard[] {
  return Array.isArray(v) && v.every((c) => !!c && typeof c === 'object' && typeof (c as PublicCard).cardRef === 'string' && typeof (c as PublicCard).id === 'string');
}

/** The chat socket's `cards` frame (chatSession.ts). */
export function applyCardsFrame(sessionId: unknown, cards: unknown): boolean {
  if (typeof sessionId !== 'string' || !isCards(cards)) return false;
  store.set(sessionId, { loaded: true, cards });
  emit();
  return true;
}

/** Load one chat's records once (mount, reload). `fetchJson` is the vault-scoped api's GET. */
export function loadCards(sessionId: string, fetchJson: (path: string) => Promise<unknown>): void {
  if (!sessionId || store.get(sessionId)?.loaded || inflight.has(sessionId)) return;
  inflight.add(sessionId);
  void fetchJson(`/agent/cards?session=${encodeURIComponent(sessionId)}`)
    .then((r) => {
      const cards = (r as { cards?: unknown } | null)?.cards;
      // A frame that arrived meanwhile is newer than this snapshot.
      if (!store.get(sessionId)?.loaded) store.set(sessionId, { loaded: true, cards: isCards(cards) ? cards : [] });
    })
    .catch(() => { if (!store.get(sessionId)?.loaded) store.set(sessionId, { loaded: true, cards: [] }); })
    .finally(() => { inflight.delete(sessionId); emit(); });
}

/** The record a drawn card is: same kind, same id, same canonical spec; the newest such. */
export function matchCard(cards: readonly PublicCard[], spec: RunViewSpec | SecretViewSpec): PublicCard | null {
  const want = canonicalJson(spec);
  let hit: PublicCard | null = null;
  for (const c of cards) if (c.kind === spec.type && c.id === spec.id && canonicalJson(c.spec) === want) hit = c;
  return hit;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The server record of a card drawn in chat `sessionId`. `loaded` false = not known yet. */
export function useCardRecord(
  sessionId: string | undefined,
  spec: RunViewSpec | SecretViewSpec,
  fetchJson: (path: string) => Promise<unknown>,
): { loaded: boolean; record: PublicCard | null } {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => { if (sessionId) loadCards(sessionId, fetchJson); }, [sessionId, fetchJson]);
  if (!sessionId) return { loaded: true, record: null };
  const s = store.get(sessionId);
  if (!s?.loaded) return { loaded: false, record: null };
  return { loaded: true, record: matchCard(s.cards, spec) };
}

/**
 * A chat's run card names its SERVER record instead of a command (plan H8, I1): the server
 * spawns the record's argv, or attaches this terminal to the run already going for it (one
 * started from the phone or Telegram included). `start` asks it to start when nothing runs;
 * `rerun` is the Mac's "Run again" of a closed card; `withheld` keeps the output from the agent.
 */
export interface CardTarget {
  sessionId: string;
  cardRef: string;
  start: boolean;
  withheld?: boolean;
  rerun?: boolean;
  /** The hands-free phone page: its own narrow path (`/api/agent/run-terminal`). */
  phone?: boolean;
}

/** The terminal URL for a card target: the Mac's chat-host mode, or the phone's own path. */
export function cardTerminalUrl(t: CardTarget, theme: string): string {
  const p = new URLSearchParams({ session: t.sessionId, card: t.cardRef, theme });
  if (t.start) p.set('start', '1');
  if (t.withheld) p.set('withheld', '1');
  if (t.rerun) p.set('rerun', '1');
  return `${t.phone ? '/api/agent/run-terminal' : '/api/agent/terminal'}?${p.toString()}`;
}

/** Tests only. */
export function _resetCardRecords(): void {
  store.clear();
  inflight.clear();
  emit();
}
