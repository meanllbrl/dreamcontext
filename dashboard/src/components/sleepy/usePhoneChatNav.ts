import { useEffect, useRef, useState, type RefObject } from 'react';
import type { LiveChatWire, SuperChatWire } from '../handsfree/macContract';
import type { PastSession } from './ChatHistoryPicker';
import { openElsewhere } from './PhoneChatList';
import { clearPendingOpens } from '../handsfree/macAdopt';
import { newlyWaiting, swipeTarget, waitingElsewhere, type HomeRow } from './phoneHome';
import { listTap, superTap } from './phoneList';
import type { StackTab } from './phoneStack';
import { usePhoneHome } from './usePhoneHome';

/** A swipe: at least this far sideways, at most this far up or down, within this long. */
const SWIPE_MIN_X = 72;
const SWIPE_MAX_Y = 48;
const SWIPE_MAX_MS = 800;
/** How long the waiting toast stays (a tap opens it sooner). */
const TOAST_MS = 10_000;

/**
 * The phone's chat screen across projects (hands-free sekmeler W3, owner D1), from the same rows
 * the Sohbetler list draws (usePhoneHome): a horizontal swipe moves to the next / previous OPEN
 * chat in the list's order, the back button counts chats waiting elsewhere, and a one-line toast
 * says when another chat STARTS waiting (never one already waiting when the screen opened, never
 * the one on screen). A row of another project opens there (`openElsewhere`).
 *
 * The swipe listens NATIVELY on the surface (`hostRef`): the chat panes are portals whose React
 * parent is not the surface, so a synthetic touch inside a transcript never reaches a React handler
 * there; the DOM event does. Passive, so a swipe never blocks the transcript's own scroll.
 */
export function usePhoneChatNav(o: {
  vault: string;
  tabs: readonly StackTab[];
  /** The chat screen is on screen (this project, the phone layout, expanded). */
  active: boolean;
  /** The phone layout at all: the listeners are attached only then. */
  enabled: boolean;
  activeTabId: string | null;
  /** The conversation the active tab holds (the Super's, when this project is handed over). */
  activeClaude: string | undefined;
  hostRef: RefObject<HTMLElement | null>;
  chrome: { addTab(vault: string): Promise<unknown> };
  open: {
    selectTab: (paneId: string, id: string) => void;
    openSuperOnPhone: (row: SuperChatWire) => void;
    resumePastSession: (past: PastSession) => void;
    adoptLiveChat: (chat: LiveChatWire) => void;
  };
}): {
  waitingElsewhere: number;
  swipe: 'next' | 'prev' | null;
  toast: HomeRow | null;
  openToast: () => void;
} {
  const home = usePhoneHome({ vault: o.vault, tabs: o.tabs, active: o.active });
  const superHere = home.live?.supers?.find((x) => x.vault === o.vault)?.conversationId;
  const currentKey = !o.activeTabId ? null
    : o.activeClaude && o.activeClaude === superHere ? `super:${o.vault}` : `${o.vault}:tab:${o.activeTabId}`;
  const [swipe, setSwipe] = useState<'next' | 'prev' | null>(null);
  useEffect(() => {
    if (!swipe) return undefined;
    const timer = setTimeout(() => setSwipe(null), 260);
    return () => clearTimeout(timer);
  }, [swipe]);

  const go = (r: HomeRow, dir?: 1 | -1) => {
    if (dir) setSwipe(dir === 1 ? 'next' : 'prev');
    if (r.vault !== o.vault) { openElsewhere(r, o.chrome); return; }
    clearPendingOpens();
    if (r.kind === 'super') {
      const st = superTap(r.row, o.tabs);
      if (st && 'select' in st) o.open.selectTab(st.select.paneId, st.select.id);
      else if (st) o.open.openSuperOnPhone(st.open);
      return;
    }
    if (r.kind === 'closed') { o.open.resumePastSession(r.row.past); return; }
    const d = listTap(r.row);
    if ('select' in d) o.open.selectTab(d.select.paneId, d.select.id);
    else if ('adopt' in d) o.open.adoptLiveChat(d.adopt);
  };

  // The swipe, through a ref so the native listeners never hold a stale render.
  const from = useRef<{ x: number; y: number; at: number } | null>(null);
  const latest = useRef({ active: o.active, rows: home.rows, currentKey, go });
  latest.current = { active: o.active, rows: home.rows, currentKey, go };
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
  const waitingKeys = home.rows.filter((r) => r.section === 'waiting').map((r) => r.key).join('|');
  const hasLive = !!home.live;
  useEffect(() => {
    if (!hasLive) return;
    const waiting = new Set(waitingKeys ? waitingKeys.split('|') : []);
    if (seen.current === null) { seen.current = waiting; return; }
    const fresh = o.active ? newlyWaiting(latest.current.rows, seen.current, currentKey) : null;
    seen.current = waiting;
    if (fresh) setToast(fresh);
  }, [waitingKeys, o.active, currentKey, hasLive]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return {
    waitingElsewhere: o.active ? waitingElsewhere(home.rows, currentKey) : 0,
    swipe,
    toast: o.active ? toast : null,
    openToast: () => { const r = toast; setToast(null); if (r) go(r); },
  };
}
