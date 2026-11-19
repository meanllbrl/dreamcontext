import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { pollMs } from '../../../lib/windowActivity';
import { phoneAllows } from '../../../lib/phoneSurface';

/**
 * The app cards (install, publish, update, logo) waiting for the owner in this project, for the
 * Super Agent's screen (owner 2026-11-13: the Super said "press Onayla on the cards" and no card
 * was in front of him). Read from the server's own requests (`GET /api/apps/requests/waiting`), so
 * a card is here whoever asked (the Super, one of its jobs, any chat) and whether or not the agent
 * put its block in a reply. Proposal ids only: they read the card, never a grant.
 */
export function useWaitingAppCards(enabled: boolean): string[] {
  const api = useApi();
  // Laptop-only, like the card's own routes: on the phone, Telegram carries the buttons.
  const here = phoneAllows('GET', '/api/apps/requests/waiting');
  const q = useQuery({
    queryKey: ['apps', 'requests', 'waiting'],
    queryFn: () => api.get<{ cards?: unknown }>('/apps/requests/waiting').then((r) => (Array.isArray(r.cards) ? r.cards.filter((x): x is string => typeof x === 'string') : [])),
    enabled: enabled && here,
    retry: 0,
    refetchInterval: () => pollMs(2000),
  });
  return q.data ?? EMPTY;
}

const EMPTY: string[] = [];

/**
 * THE POP-UP QUEUE (owner 2026-11-16: "bu istek pop up olarak gelsin"): a waiting app card opens
 * by itself as a pop-up over the window, one at a time. Pure, so its rules are tested without a DOM:
 *
 * - `shown`: the card open now. It closes when it leaves the waiting list (decided here, on the
 *   notch or on Telegram, or expired) and the next waiting card takes its place.
 * - `later`: cards he closed without deciding (Esc, X, Sonra). Closing never decides: the card
 *   stays waiting, its row stays on the Super's screen and reopens it; it never pops up again
 *   by itself while it waits.
 * - `blocked`: another pop-up is open (he may be typing in it): nothing opens over it.
 */
export interface AppPopupState {
  readonly shown: string | null;
  readonly later: readonly string[];
}

export const APP_POPUP_START: AppPopupState = { shown: null, later: [] };

/** The state for a fresh waiting list. Returns the SAME object when nothing changed. */
export function appPopupStep(s: AppPopupState, waiting: readonly string[], blocked: boolean): AppPopupState {
  const live = new Set(waiting);
  const later = s.later.filter((id) => live.has(id));
  let shown = s.shown && live.has(s.shown) ? s.shown : null;
  if (!shown && !blocked) shown = waiting.find((id) => !later.includes(id)) ?? null;
  if (shown === s.shown && later.length === s.later.length) return s;
  return { shown, later };
}

/** He closed the pop-up without deciding (or decided it and the list has not caught up yet). */
export function appPopupLater(s: AppPopupState): AppPopupState {
  if (!s.shown) return s;
  return { shown: null, later: s.later.includes(s.shown) ? s.later : [...s.later, s.shown] };
}

/** He pressed a waiting card's row: it opens now (a card he closed comes back). */
export function appPopupReopen(s: AppPopupState, id: string): AppPopupState {
  return { shown: id, later: s.later.filter((x) => x !== id) };
}

/** What a pop-up never opens over: any open dialog (he may be typing in it; another project's app
 *  pop-up too), and the stage's own panels and menus that own Esc. */
const IN_THE_WAY = '[aria-modal="true"], .cmd-modal, .super-group-panel, .super-add-menu, .super-size-menu, .chat-cmp-ref-pop, .agent-composer-menu';
/** A key pressed this recently means he is typing: a pop-up would take the next keys. */
const TYPING_MS = 1500;
let lastKeyAt = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => { lastKeyAt = Date.now(); }, true);
}

function inTheWay(): boolean {
  if (typeof document === 'undefined') return false;
  return Date.now() - lastKeyAt < TYPING_MS || !!document.querySelector(IN_THE_WAY);
}

/**
 * The pop-up queue on the Super's screen: which waiting card is open now, and what he can do to
 * it (close it, or reopen one from its row; a decided card closes the same way). `enabled` false
 * (a member's stage, the phone, a folded stage, a project in the background) keeps what he
 * closed and opens nothing: a pop-up is only ever over the Super screen he is looking at.
 */
export function useAppPopup(waiting: readonly string[], enabled: boolean) {
  const [s, setS] = useState<AppPopupState>(APP_POPUP_START);
  useEffect(() => {
    if (!enabled) return undefined;
    const step = () => setS((cur) => appPopupStep(cur, waiting, inTheWay()));
    step();
    if (waiting.length === 0) return undefined;
    // A pop-up that was in the way closes without telling us: look again every second.
    const id = window.setInterval(step, pollMs(1000));
    return () => window.clearInterval(id);
  }, [waiting, enabled]);
  const later = useCallback(() => setS(appPopupLater), []);
  const reopen = useCallback((id: string) => setS((cur) => appPopupReopen(cur, id)), []);
  return { shown: enabled ? s.shown : null, later, reopen };
}
