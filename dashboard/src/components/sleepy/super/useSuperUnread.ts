import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ApiClient } from '../../../api/client';
import { getWindowActivity, onWindowActivity } from '../../../lib/windowActivity';
import {
  advanceDwell, chooseLine, firstMountedRow, leadIndex, mergeMarks, ownerCanRead, readMarksOf, readsAfterFilter, sideOf, readSide, startSeen, unreadOf, unreadSinceRead, unreadUnits, withRead,
  type ReadMark, type ReadMarks, type Span, type UnreadItem, type UnreadUnit,
} from './superUnread';
import { dropSuperUnread, noteMemberSeen, publishSuperUnread } from './superUnreadStore';
import { forSuper } from './superApi';
import type { SuperId } from '../../../lib/superTypes';

const TICK_MS = 250;
const FLUSH_MS = 300;
/** Looks a unit inside the mounted range has no row before it counts as nothing to see. */
const GONE_TICKS = 4;
/** A failed read or write tries again, later each time. */
const RETRY_MS = 3000;
const MAX_RETRIES = 6;

export interface SuperUnread {
  count: number;
  /** What is unread, oldest first: the opening lands on the first one. */
  units: readonly UnreadUnit[];
  /** Unread messages lying below the view: the "↓ N yeni" button's number (owner 2026-11-13). */
  below: number;
  /** The marks are loaded: what is unread is known (before that, nothing is). */
  ready: boolean;
  rowOf: (u: UnreadUnit) => HTMLElement | null;
  /** Look again now: a jump just landed. */
  look: () => void;
}

/** One message: the same key at another time is another one. */
const unitId = (u: UnreadUnit) => `${u.key}|${u.ts}`;

function rowOf(root: HTMLElement, u: UnreadUnit): HTMLElement | null {
  if (u.itemId) return root.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(u.itemId)}"]`);
  // A question's card, or an owner card a child left (it is a message of the chat, in its place).
  const q = CSS.escape(u.question ?? '');
  return root.querySelector<HTMLElement>(`[data-testid="super-question-card"][data-item="${q}"], [data-testid="super-owner-card"][data-item="${q}"]`);
}

/** The line stands in the gap above a message, so above its reply strip when it wears one. */
export function lineHostOf(row: HTMLElement): HTMLElement {
  const before = row.previousElementSibling;
  return before instanceof HTMLElement && before.hasAttribute('data-reply-strip') ? before : row;
}

function viewOf(scroller: HTMLElement): Span {
  const box = scroller.getBoundingClientRect();
  return { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, window.innerHeight) };
}

const spanOf = (el: HTMLElement): Span => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
};

/**
 * The Super chat's read state on the live pane: marks loaded from and written to the server, the
 * "Okunmamış" line painted as ATTRIBUTES on a row other components own (so this feature adds no
 * prop to a row or a card, and superUnread.css alone draws it), the dwell clock, the count and
 * how many unread messages lie below the view. No per-row dots (owner 2026-11-13).
 * Painting takes no layout room: a read never moves a row.
 * `enabled` false: nothing runs, no request, no timer.
 */
export function useSuperUnread({ enabled, vault, superId = 'main', api, items, fold, ownerBatches, mainBatches, openQuestions, scrollRef, contentRef, dividerLabel, isPinned, isGliding, hidden = null }: {
  enabled: boolean;
  /** The project the rail's count goes to; null = this pane publishes none. */
  vault: string | null;
  /** Whose chat this is (plan-r10 1): its read marks and its count are that super's. */
  superId?: SuperId;
  api: ApiClient;
  items: readonly UnreadItem[];
  fold: boolean;
  ownerBatches: readonly string[];
  /** A member's turns for main Super: never unread for the owner. */
  mainBatches?: readonly string[];
  openQuestions: ReadonlyArray<{ id: string; createdAt: number }>;
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  dividerLabel: () => string;
  isPinned: () => boolean;
  /** A jump is under way: nothing counts as seen until it lands. */
  isGliding: () => boolean;
  /**
   * An agenda row's thread is shown (ajanda-filtre C4.3): which units it hides. While set, nothing
   * is marked read; a unit it hides is never gone, never below, never the line's lead; what he saw
   * is kept and, when the filter ends, read only where it cannot hide an older unread message
   * (`readsAfterFilter`).
   */
  hidden?: ((u: UnreadUnit) => boolean) | null;
}): SuperUnread {
  const [marks, setMarks] = useState<ReadMarks | null>(null);
  const [below, setBelow] = useState(0);
  const pending = useRef<ReadMark[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A member's marks are its own (`?superId=m:<slug>`); main's requests are unchanged.
  const apiRef = useRef(forSuper(api, superId));
  apiRef.current = forSuper(api, superId);

  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
  const liveRef = useRef(enabled);
  liveRef.current = enabled;
  /** Never past the hand-over: the server refuses a late write, so a retry would only spin. */
  const retryLater = useCallback((run: () => void, err: unknown) => {
    if (retries.current === 0) console.warn('[super] read marks request failed', err);
    if (retries.current >= MAX_RETRIES || retryTimer.current || !liveRef.current) return;
    retries.current += 1;
    retryTimer.current = setTimeout(() => { retryTimer.current = null; run(); }, RETRY_MS * 2 ** (retries.current - 1));
  }, []);

  useEffect(() => {
    if (!enabled) { setMarks(null); setBelow(0); pending.current = []; return undefined; }
    let live = true;
    const load = () => {
      void apiRef.current.get<unknown>('/agent/super-read').then((raw) => {
        const got = readMarksOf(raw);
        // No record yet: this write starts it, at now.
        return got ?? apiRef.current.post<unknown>('/agent/super-read', {}).then(readMarksOf);
      }).then((got) => {
        retries.current = 0;
        if (live && got) setMarks((m) => (m ? mergeMarks(m, got) : got));
      }).catch((err) => { if (live) retryLater(load, err); });
    };
    load();
    // Another surface may have read meanwhile.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, retryLater, superId]);

  const flush = useCallback(() => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    if (!liveRef.current) return;
    const read = pending.current.splice(0, 200);
    if (!read.length) return;
    void apiRef.current.post<unknown>('/agent/super-read', { read })
      .then((raw) => {
        retries.current = 0;
        const got = readMarksOf(raw);
        if (got) setMarks((m) => (m ? mergeMarks(m, got) : got));
        if (pending.current.length) flush();
      })
      .catch((err) => {
        pending.current.unshift(...read);
        retryLater(flush, err);
      });
  }, [retryLater]);
  const queueFlush = useCallback(() => {
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
      flush();
    };
  }, [flush]);

  const units = useMemo(
    () => (enabled ? unreadUnits(items, { fold, ownerBatches, openQuestions, ...(mainBatches?.length ? { mainBatches } : {}) }) : []),
    [enabled, items, fold, ownerBatches, mainBatches, openQuestions],
  );
  const unread = useMemo(() => (enabled && marks ? unreadOf(units, marks) : []), [enabled, marks, units]);
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  // The row's number (main's and a member's alike): only what is newer than the newest message he
  // read. An older one stays unread in the pane, never on the row (unreadSinceRead).
  const count = useMemo(() => unreadSinceRead(units, unread).length, [units, unread]);

  const paneToken = useRef({}).current;
  // Keyed by vault + superId (plan-r10 1): a member's count never lands on main's row.
  const asking = openQuestions.length > 0;
  useEffect(() => {
    if (enabled && vault) publishSuperUnread(vault, count, paneToken, superId, asking);
  }, [enabled, vault, count, paneToken, superId, asking]);
  useEffect(() => (enabled && vault ? () => dropSuperUnread(vault, paneToken, superId) : undefined), [enabled, vault, paneToken, superId]);

  // A MEMBER's stage read to its NEWEST message tells the server (plan r4 D7): its replies stop
  // counting on the Team row. Only once its marks are LOADED (before that nothing is known), only
  // while the window is seen, and again whenever the chat grows (every turn end is a new item), so
  // a reply that lands while he reads is cleared too. Never for main (the server refuses it).
  // The newest, not every unit: an older unit he never scrolled up to held `seen` back for days,
  // so the row kept its number (owner 2026-11-15, a 12). `count` is already that rule.
  const seenSent = useRef<string>('');
  const lastItem = items.length ? `${items.length}:${items[items.length - 1].id}` : '0';
  const newestIsRead = count === 0;
  useEffect(() => {
    if (superId === 'main' || !enabled || !marks || !newestIsRead) return undefined;
    const send = () => {
      if (!getWindowActivity().visible || seenSent.current === lastItem) return;
      seenSent.current = lastItem;
      void apiRef.current.post<unknown>('/agent/super-read', { seen: true })
        .then(() => { if (vault) noteMemberSeen(vault); })
        .catch(() => { seenSent.current = ''; });
    };
    send();
    return onWindowActivity(() => send());
  }, [superId, enabled, marks, newestIsRead, lastItem, vault]);

  // The filter's deferred reads (C4.3). A reload drops them: they stay unread, the safe side.
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const seenWhile = useRef(new Map<string, UnreadUnit>());
  const filtering = !!hidden;

  const markRead = useCallback((seen: readonly UnreadUnit[]) => {
    if (!seen.length) return;
    if (hiddenRef.current) {
      for (const u of seen) seenWhile.current.set(unitId(u), u);
      return;
    }
    const read = seen.map(({ key, ts }) => ({ key, ts }));
    pending.current.push(...read);
    setMarks((m) => (m ? withRead(m, read) : m));
    queueFlush();
  }, [queueFlush]);

  const rowOfUnit = useCallback((u: UnreadUnit) => {
    const root = contentRef.current;
    return root ? rowOf(root, u) : null;
  }, [contentRef]);

  // The filter ended: what he saw inside it is read, unless reading it would hide an older unread
  // message the count includes (the count is "after the newest read"): those wait for the full
  // chat's own reading.
  const wasFiltering = useRef(false);
  useEffect(() => {
    if (filtering) { wasFiltering.current = true; return; }
    if (!wasFiltering.current) return;
    wasFiltering.current = false;
    const saw = [...seenWhile.current.values()];
    seenWhile.current = new Map();
    if (saw.length) markRead(readsAfterFilter(units, unreadRef.current, saw));
  }, [filtering, units, markRead]);

  // Painted after every commit: a row the window just mounted has to get its line before the
  // browser draws it. A streaming token that changed no row stops before it measures anything.
  const labelFor = useRef(dividerLabel);
  labelFor.current = dividerLabel;
  const pinnedRef = useRef(isPinned);
  pinnedRef.current = isPinned;
  const glidingRef = useRef(isGliding);
  glidingRef.current = isGliding;
  const lineOn = useRef<HTMLElement | null>(null);
  const [lineShown, setLineShown] = useState(false);
  const rowsThen = useRef<ReadonlyArray<HTMLElement | null>>([]);
  const paint = useCallback((force: boolean) => {
    const root = contentRef.current;
    const scroller = scrollRef.current;
    if (!root || !scroller) return;
    const hides = hiddenRef.current;
    const rows = unreadRef.current.filter((u) => !hides || !hides(u)).map((u) => rowOf(root, u));
    if (!force && rows.length === rowsThen.current.length && rows.every((el, i) => el === rowsThen.current[i])) return;
    rowsThen.current = rows;

    const view = viewOf(scroller);
    const leadRow = rows[leadIndex(rows.map((el) => (el ? el.getBoundingClientRect().top : null)))] ?? null;
    const lead = leadRow ? lineHostOf(leadRow) : null;
    const heldEl = lineOn.current?.isConnected ? lineOn.current : null;
    const inView = (el: HTMLElement | null) => !!el && sideOf(spanOf(el), view) === 'in';
    const choice = chooseLine({
      held: !!heldEl, heldInView: inView(heldEl), heldIsLead: !!heldEl && heldEl === lead,
      lead: !!lead, leadInView: inView(lead), pinned: pinnedRef.current(),
    });
    const line = choice === 'held' ? heldEl : choice === 'lead' ? lead : null;
    if (line === lineOn.current) return;
    lineOn.current?.removeAttribute('data-unread-first');
    lineOn.current?.removeAttribute('data-unread-label');
    line?.setAttribute('data-unread-first', '');
    line?.setAttribute('data-unread-label', labelFor.current());
    lineOn.current = line;
    setLineShown(!!line);
  }, [contentRef, scrollRef]);
  useLayoutEffect(() => { paint(false); });

  // Looked at again when something can have changed, never on a free-running clock (the window
  // rules, super-surface.test.ts): the only timer runs while a unit is being dwelled on, or a
  // missing row waits out GONE_TICKS, and it ends with them.
  const started = useRef(new Map<string, number>());
  const missing = useRef(new Map<string, number>());
  const tickRef = useRef<() => void>(() => {});
  const hasUnread = unread.length > 0;
  // A line outlives the last unread until it leaves the screen, and only a look can see that.
  const watching = hasUnread || lineShown;
  useEffect(() => {
    if (!watching) {
      setBelow(0);
      started.current = new Map();
      missing.current = new Map();
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const scroller = scrollRef.current;
      const root = contentRef.current;
      if (!scroller || !root) return;
      if (glidingRef.current()) return; // it looks when it lands
      paint(true);
      const box = scroller.getBoundingClientRect();
      const view = viewOf(scroller);
      const shown = box.width > 0 && view.bottom > view.top;
      const onTop = shown ? document.elementFromPoint(box.left + box.width / 2, (view.top + view.bottom) / 2) : null;
      const activity = getWindowActivity();
      const canRead = ownerCanRead({
        docVisible: activity.visible,
        focused: activity.focused,
        paneShown: !!onTop && scroller.contains(onTop),
      });
      const hides = hiddenRef.current;
      const units = hides ? unreadRef.current.filter((u) => !hides(u)) : unreadRef.current;
      const rows = units.map((u) => rowOf(root, u));
      const firstMounted = firstMountedRow(units, rows.map(Boolean));
      const visible: string[] = [];
      const gone: UnreadUnit[] = [];
      // Rebuilt each look, so only a unit still waiting can keep the timer alive.
      const waiting = new Map<string, number>();
      let under = 0;
      units.forEach((u, i) => {
        const el = rows[i];
        if (!el) {
          // Behind the window's ceiling it can be revealed; below the first mounted row there is
          // nothing to reveal (a block that drew nothing), and it must not hold a count for ever.
          if (firstMounted < 0 || i < firstMounted) return;
          const n = (missing.current.get(unitId(u)) ?? 0) + 1;
          // Filtered: nothing is gone (its row may simply not be drawn here).
          if (n >= GONE_TICKS && canRead && !hides) gone.push(u);
          else waiting.set(unitId(u), n);
          return;
        }
        const row = spanOf(el);
        // Seen needs the START on screen (owner 2026-11-12): the end of a tall message filling
        // the view is not a read, and its arrow points at where it begins.
        if (startSeen(row, view)) { visible.push(unitId(u)); return; }
        if (readSide(row, view) === 'below') under += 1;
      });
      missing.current = waiting;
      setBelow(under);
      const step = advanceDwell(started.current, canRead ? visible : [], Date.now());
      started.current = step.started;
      const seen = new Set(step.seen);
      markRead([...units.filter((u) => seen.has(unitId(u))), ...gone]);
      if (started.current.size > 0 || (canRead && missing.current.size > 0)) timer = setTimeout(tick, TICK_MS);
    };
    tickRef.current = tick;
    const soon = () => { if (!timer) timer = setTimeout(tick, TICK_MS); };
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', soon, { passive: true });
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    if (scroller) sized?.observe(scroller);
    if (contentRef.current) sized?.observe(contentRef.current);
    const offActivity = onWindowActivity(soon);
    // What covered the pane has no event of its own; closing it is a gesture.
    window.addEventListener('pointerup', soon, true);
    window.addEventListener('keyup', soon, true);
    tick();
    return () => {
      if (timer) clearTimeout(timer);
      tickRef.current = () => {};
      scroller?.removeEventListener('scroll', soon);
      sized?.disconnect();
      offActivity();
      window.removeEventListener('pointerup', soon, true);
      window.removeEventListener('keyup', soon, true);
    };
  }, [watching, scrollRef, contentRef, markRead, paint]);
  // By what is unread, not by the array: `items` is a new list on every streamed token, and a
  // height it grew is already the ResizeObserver's above.
  const unreadKey = unread.map(unitId).join('\n');
  useEffect(() => { tickRef.current(); }, [unreadKey, filtering, hidden]);
  const look = useCallback(() => { tickRef.current(); }, []);

  return { count, units: unread, below, ready: enabled && !!marks, rowOf: rowOfUnit, look };
}
