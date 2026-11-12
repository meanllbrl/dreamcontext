import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ApiClient } from '../../../api/client';
import { getWindowActivity, onWindowActivity } from '../../../lib/windowActivity';
import {
  advanceDwell, chooseLine, firstMountedRow, leadIndex, mergeMarks, nextUnreadIndex, ownerCanRead, readMarksOf, sideOf, readSide, startSeen, unreadOf, unreadUnits, withRead,
  type ReadMark, type ReadMarks, type Span, type UnreadItem, type UnreadUnit,
} from './superUnread';
import { dropSuperUnread, publishSuperUnread } from './superUnreadStore';
import { forSuper } from './superApi';
import type { SuperId } from '../../../lib/superTypes';

const TICK_MS = 250;
const FLUSH_MS = 300;
/** Looks a unit inside the mounted range has no row before it counts as nothing to see. */
const GONE_TICKS = 4;
/** A failed read or write tries again, later each time. */
const RETRY_MS = 3000;
const MAX_RETRIES = 6;

export type UnreadEdge = 'up' | 'down' | null;

export interface SuperUnread {
  count: number;
  /** What is unread, oldest first: the follow keeps the first one's start in view. */
  units: readonly UnreadUnit[];
  /** The next jump goes to a question card: the pill names it (owner 2026-11-12). */
  nextQuestion: boolean;
  /** The marks are loaded: what is unread is known (before that, nothing is). */
  ready: boolean;
  /** Where the nearest unread out of view lies; null: all of it is on screen. */
  edge: UnreadEdge;
  /** Where the next jump goes. */
  next: () => UnreadUnit | null;
  rowOf: (u: UnreadUnit) => HTMLElement | null;
  /** Look again now: a jump just landed. */
  look: () => void;
  markAll: () => void;
}

/** One message: the same key at another time is another one. */
const unitId = (u: UnreadUnit) => `${u.key}|${u.ts}`;

function rowOf(root: HTMLElement, u: UnreadUnit): HTMLElement | null {
  return root.querySelector<HTMLElement>(u.itemId
    ? `[data-item-id="${CSS.escape(u.itemId)}"]`
    : `[data-testid="super-question-card"][data-item="${CSS.escape(u.question ?? '')}"]`);
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
 * dots and the divider painted as ATTRIBUTES on rows other components own (so this feature adds
 * no prop to a row or a card, and superUnread.css alone draws it), the dwell clock, the count.
 * Painting takes no layout room: a read never moves a row.
 * `enabled` false: nothing runs, no request, no timer.
 */
export function useSuperUnread({ enabled, vault, superId = 'main', api, items, fold, ownerBatches, mainBatches, openQuestions, scrollRef, contentRef, dividerLabel, isPinned, isGliding, isWalking }: {
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
  /** A jump is under way: nothing counts as seen and the bar holds still until it lands. */
  isGliding: () => boolean;
  /** The reader has not moved since the last jump: the next one goes on from it. */
  isWalking: () => boolean;
}): SuperUnread {
  const [marks, setMarks] = useState<ReadMarks | null>(null);
  const [edge, setEdge] = useState<UnreadEdge>(null);
  const [nextQuestion, setNextQuestion] = useState(false);
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
    if (!enabled) { setMarks(null); setEdge(null); setNextQuestion(false); pending.current = []; return undefined; }
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

  const unread = useMemo(() => {
    if (!enabled || !marks) return [];
    return unreadOf(unreadUnits(items, { fold, ownerBatches, openQuestions, ...(mainBatches?.length ? { mainBatches } : {}) }), marks);
  }, [enabled, marks, items, fold, ownerBatches, mainBatches, openQuestions]);
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  const count = unread.length;

  const paneToken = useRef({}).current;
  // Keyed by vault + superId (plan-r10 1): a member's count never lands on main's row.
  const asking = openQuestions.length > 0;
  useEffect(() => {
    if (enabled && vault) publishSuperUnread(vault, count, paneToken, superId, asking);
  }, [enabled, vault, count, paneToken, superId, asking]);
  useEffect(() => (enabled && vault ? () => dropSuperUnread(vault, paneToken, superId) : undefined), [enabled, vault, paneToken, superId]);

  // A MEMBER's stage read to the end tells the server (plan r4 D7): its replies stop counting on
  // the Team row. Only once its marks are LOADED (before that the count is a false 0), only while
  // the window is seen, and again whenever the chat grows (every turn end is a new item), so a
  // reply that lands while he reads is cleared too. Never for main (the server refuses it).
  const seenSent = useRef<string>('');
  const lastItem = items.length ? `${items.length}:${items[items.length - 1].id}` : '0';
  useEffect(() => {
    if (superId === 'main' || !enabled || !marks || count !== 0) return undefined;
    const send = () => {
      if (!getWindowActivity().visible || seenSent.current === lastItem) return;
      seenSent.current = lastItem;
      void apiRef.current.post<unknown>('/agent/super-read', { seen: true }).catch(() => { seenSent.current = ''; });
    };
    send();
    return onWindowActivity(() => send());
  }, [superId, enabled, marks, count, lastItem]);

  const markRead = useCallback((seen: readonly UnreadUnit[]) => {
    if (!seen.length) return;
    const read = seen.map(({ key, ts }) => ({ key, ts }));
    pending.current.push(...read);
    setMarks((m) => (m ? withRead(m, read) : m));
    queueFlush();
  }, [queueFlush]);

  // Every unit, by mark: never "everything before now", which would swallow what lands later.
  const markAll = useCallback(() => {
    markRead(unreadRef.current);
    setEdge(null);
    setNextQuestion(false);
  }, [markRead]);

  const rowOfUnit = useCallback((u: UnreadUnit) => {
    const root = contentRef.current;
    return root ? rowOf(root, u) : null;
  }, [contentRef]);

  const walkingRef = useRef(isWalking);
  walkingRef.current = isWalking;
  const walkedTo = useRef<HTMLElement | null>(null);
  const next = useCallback((): UnreadUnit | null => {
    const root = contentRef.current;
    const scroller = scrollRef.current;
    const units = unreadRef.current;
    if (!root || !scroller) return units[0] ?? null;
    const rows = units.map((u) => rowOf(root, u));
    const from = walkingRef.current() && walkedTo.current?.isConnected ? spanOf(walkedTo.current) : null;
    const unit = units[nextUnreadIndex(rows.map((el) => (el ? spanOf(el) : null)), viewOf(scroller), from)] ?? null;
    walkedTo.current = unit ? rowOf(root, unit) : null;
    return unit;
  }, [contentRef, scrollRef]);

  // Painted after every commit: a row the window just mounted has to get its dot before the
  // browser draws it. Only what differs is touched, and a streaming token that changed no row
  // stops before it measures anything.
  const painted = useRef(new Set<HTMLElement>());
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
    const rows = unreadRef.current.map((u) => rowOf(root, u));
    if (!force && rows.length === rowsThen.current.length && rows.every((el, i) => el === rowsThen.current[i])) return;
    rowsThen.current = rows;
    const want = new Set<HTMLElement>();
    for (const el of rows) if (el) want.add(el);
    for (const el of painted.current) if (!want.has(el)) el.removeAttribute('data-unread');
    for (const el of want) if (!el.hasAttribute('data-unread')) el.setAttribute('data-unread', '');
    painted.current = want;

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
  const hasUnread = count > 0;
  // A line outlives the last unread until it leaves the screen, and only a look can see that.
  const watching = hasUnread || lineShown;
  useEffect(() => {
    if (!watching) {
      setEdge(null);
      setNextQuestion(false);
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
      const units = unreadRef.current;
      const rows = units.map((u) => rowOf(root, u));
      const firstMounted = firstMountedRow(units, rows.map(Boolean));
      const visible: string[] = [];
      const gone: UnreadUnit[] = [];
      // Rebuilt each look, so only a unit still waiting can keep the timer alive.
      const waiting = new Map<string, number>();
      let next: UnreadEdge = null;
      units.forEach((u, i) => {
        const el = rows[i];
        if (!el) {
          // Behind the window's ceiling it can be revealed; below the first mounted row there is
          // nothing to reveal (a block that drew nothing), and it must not hold a count for ever.
          if (firstMounted < 0 || i < firstMounted) { next = 'up'; return; }
          const n = (missing.current.get(unitId(u)) ?? 0) + 1;
          if (n >= GONE_TICKS && canRead) gone.push(u);
          else waiting.set(unitId(u), n);
          return;
        }
        const row = spanOf(el);
        // Seen needs the START on screen (owner 2026-11-12): the end of a tall message filling
        // the view is not a read, and its arrow points at where it begins.
        if (startSeen(row, view)) { visible.push(unitId(u)); return; }
        const side = readSide(row, view);
        if (side === 'above') next = 'up';
        else if (next === null && side === 'below') next = 'down';
      });
      missing.current = waiting;
      // The arrow says where the next click goes: a walk goes on down past what it left above.
      const walked = walkingRef.current() && walkedTo.current?.isConnected ? spanOf(walkedTo.current) : null;
      if (walked && rows.some((el) => { const r = el && spanOf(el); return !!r && r.top > walked.top && readSide(r, view) === 'below'; })) next = 'down';
      setEdge(next);
      // A peek at where the next jump goes, never `next()` (that moves the walk).
      const peek = next ? units[nextUnreadIndex(rows.map((el) => (el ? spanOf(el) : null)), view, walked)] : undefined;
      setNextQuestion(!!peek?.question);
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
  useEffect(() => { tickRef.current(); }, [unreadKey]);
  const look = useCallback(() => { tickRef.current(); }, []);

  return { count, units: unread, nextQuestion, ready: enabled && !!marks, edge, next, rowOf: rowOfUnit, look, markAll };
}
