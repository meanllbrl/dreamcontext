import { useEffect, useRef, useState, type RefObject } from 'react';
import { newlyWaiting, swipeTarget, type HomeRow } from './phoneHome';

/** A swipe: at least this far sideways, at most this far up or down, within this long. */
const SWIPE_MIN_X = 72;
const SWIPE_MAX_Y = 48;
const SWIPE_MAX_MS = 800;
/** How long the waiting toast stays (a tap opens it sooner). */
const TOAST_MS = 10_000;

/**
 * The phone's chat screen across projects (hands-free sekmeler W3, owner D1), over the window's
 * ONE published fact (`chrome.deviceChats`, the same rows the drawer draws; this hook reads nothing
 * itself): a horizontal swipe moves to the next / previous OPEN chat in the drawer's order, and a
 * one-line toast says when another chat STARTS waiting (never one already waiting when the screen
 * opened, never the one on screen). Every open goes through `chrome.openChatRow`, the drawer rows'
 * own path, whichever project the row is in. The waiting count lives on the drawer toggle.
 *
 * The swipe listens NATIVELY on the surface (`hostRef`): the chat panes are portals whose React
 * parent is not the surface, so a synthetic touch inside a transcript never reaches a React handler
 * there; the DOM event does. Passive, so a swipe never blocks the transcript's own scroll.
 */
export function usePhoneChatNav(o: {
  vault: string;
  /** The device shell's rows (`chrome.deviceChats.rows`). */
  rows: readonly HomeRow[];
  /** The live read has answered: the first answer is the toast's baseline, never a toast. */
  liveAnswered: boolean;
  /** The chat screen is on screen (this project, the phone layout, expanded, drawer closed). */
  active: boolean;
  /** The phone layout at all: the listeners are attached only then. */
  enabled: boolean;
  activeTabId: string | null;
  /** The conversation the active tab holds (the Super's, when this project is handed over). */
  activeClaude: string | undefined;
  hostRef: RefObject<HTMLElement | null>;
  openChatRow: (vault: string, row: HomeRow) => void;
}): {
  swipe: 'next' | 'prev' | null;
  toast: HomeRow | null;
  openToast: () => void;
} {
  const superId = o.rows.find((r): r is Extract<HomeRow, { kind: 'super' }> => r.kind === 'super' && r.vault === o.vault)?.row.conversationId;
  const currentKey = !o.activeTabId ? null
    : o.activeClaude && o.activeClaude === superId ? `super:${o.vault}` : `${o.vault}:tab:${o.activeTabId}`;
  const [swipe, setSwipe] = useState<'next' | 'prev' | null>(null);
  useEffect(() => {
    if (!swipe) return undefined;
    const timer = setTimeout(() => setSwipe(null), 260);
    return () => clearTimeout(timer);
  }, [swipe]);

  const go = (r: HomeRow, dir?: 1 | -1) => {
    if (dir) setSwipe(dir === 1 ? 'next' : 'prev');
    o.openChatRow(r.vault, r);
  };

  // The swipe, through a ref so the native listeners never hold a stale render.
  const from = useRef<{ x: number; y: number; at: number } | null>(null);
  const latest = useRef({ active: o.active, rows: o.rows, currentKey, go });
  latest.current = { active: o.active, rows: o.rows, currentKey, go };
  useEffect(() => {
    const el = o.hostRef.current;
    if (!el || !o.enabled) return undefined;
    const start = (e: TouchEvent) => {
      from.current = null;
      const t = e.touches?.[0];
      if (!latest.current.active || e.touches.length !== 1 || !t) return;
      // A code block or a table scrolls sideways, and the composer is the owner's: never a swipe.
      if ((e.target as HTMLElement | null)?.closest('pre, table, textarea, input, .chat-cmp, .mchat-toast')) return;
      from.current = { x: t.clientX, y: t.clientY, at: Date.now() };
    };
    const end = (e: TouchEvent) => {
      const f = from.current;
      from.current = null;
      // A touch list can come without its point (a synthetic or cancelled touch): no swipe.
      const t = e.changedTouches?.[0];
      if (!f || !latest.current.active || !t) return;
      const dx = t.clientX - f.x;
      const dy = t.clientY - f.y;
      if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dy) > SWIPE_MAX_Y || Date.now() - f.at > SWIPE_MAX_MS) return;
      const dir: 1 | -1 = dx < 0 ? 1 : -1;
      const target = swipeTarget(latest.current.rows, latest.current.currentKey, dir);
      if (target) latest.current.go(target, dir);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', end, { passive: true });
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchend', end); };
  }, [o.enabled, o.hostRef]);

  // The toast: a chat that STARTED waiting since the last look. The first answer is the baseline.
  const seen = useRef<Set<string> | null>(null);
  const [toast, setToast] = useState<HomeRow | null>(null);
  const waitingKeys = o.rows.filter((r) => r.section === 'waiting').map((r) => r.key).join('|');
  useEffect(() => {
    if (!o.liveAnswered) return;
    const waiting = new Set(waitingKeys ? waitingKeys.split('|') : []);
    if (seen.current === null) { seen.current = waiting; return; }
    const fresh = o.active ? newlyWaiting(latest.current.rows, seen.current, currentKey) : null;
    seen.current = waiting;
    if (fresh) setToast(fresh);
  }, [waitingKeys, o.active, currentKey, o.liveAnswered]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return {
    swipe,
    toast: o.active ? toast : null,
    openToast: () => { const r = toast; setToast(null); if (r) go(r); },
  };
}
