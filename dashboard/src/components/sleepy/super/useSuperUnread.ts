import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ApiClient } from '../../../api/client';
import {
  advanceDwell, mergeMarks, mostlyVisible, ownerCanRead, readMarksOf, sideOf, unreadOf, unreadUnits, withRead,
  type ReadMark, type ReadMarks, type Span, type UnreadItem, type UnreadUnit,
} from './superUnread';
import { dropSuperUnread, publishSuperUnread } from './superUnreadStore';

const TICK_MS = 250;
const FLUSH_MS = 300;
/** Ticks a unit inside the mounted range has no row before it counts as nothing to see. */
const GONE_TICKS = 4;

export type UnreadEdge = 'up' | 'down' | null;

export interface SuperUnread {
  count: number;
  /** Where the nearest unread out of view lies; null: all of it is on screen. */
  edge: UnreadEdge;
  first: UnreadUnit | null;
  markAll: () => void;
}

function rowOf(root: HTMLElement, u: UnreadUnit): HTMLElement | null {
  return root.querySelector<HTMLElement>(u.itemId
    ? `[data-item-id="${CSS.escape(u.itemId)}"]`
    : `[data-testid="super-question-card"][data-item="${CSS.escape(u.question ?? '')}"]`);
}

/**
 * The Super chat's read state on the live pane: marks loaded from and written to the server, the
 * dots and the divider painted as ATTRIBUTES on rows other components own (so this feature adds
 * no prop to a row or a card, and superUnread.css alone draws it), the dwell clock, the count.
 * `enabled` false: nothing runs, no request, no timer.
 */
export function useSuperUnread({ enabled, vault, api, items, fold, ownerBatches, openQuestions, scrollRef, contentRef, dividerLabel }: {
  enabled: boolean;
  /** The project the rail's count goes to; null = this pane publishes none. */
  vault: string | null;
  api: ApiClient;
  items: readonly UnreadItem[];
  fold: boolean;
  ownerBatches: readonly string[];
  openQuestions: ReadonlyArray<{ id: string; createdAt: number }>;
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  dividerLabel: (count: number) => string;
}): SuperUnread {
  const [marks, setMarks] = useState<ReadMarks | null>(null);
  const [edge, setEdge] = useState<UnreadEdge>(null);
  const pending = useRef<ReadMark[]>([]);
  const allBefore = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!enabled) { setMarks(null); return undefined; }
    let live = true;
    const load = () => {
      void apiRef.current.get<unknown>('/agent/super-read').then((raw) => {
        const got = readMarksOf(raw);
        if (live && got) setMarks((m) => (m ? mergeMarks(m, got) : got));
      }).catch(() => { /* no marks, no dots: the chat itself is unaffected */ });
    };
    load();
    // Another surface may have read meanwhile.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled]);

  const flush = useCallback(() => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    const read = pending.current.splice(0, 200);
    const before = allBefore.current;
    allBefore.current = 0;
    if (!read.length && !before) return;
    void apiRef.current.post<unknown>('/agent/super-read', { ...(read.length ? { read } : {}), ...(before ? { allBefore: before } : {}) })
      .then((raw) => {
        const got = readMarksOf(raw);
        if (got) setMarks((m) => (m ? mergeMarks(m, got) : got));
        if (pending.current.length) flush();
      })
      .catch(() => {
        // Kept, to go out with the next read.
        pending.current.unshift(...read);
        allBefore.current = Math.max(allBefore.current, before);
      });
  }, []);
  const queueFlush = useCallback(() => {
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);

  const unread = useMemo(() => {
    if (!enabled || !marks) return [];
    return unreadOf(unreadUnits(items, { fold, ownerBatches, openQuestions }), marks);
  }, [enabled, marks, items, fold, ownerBatches, openQuestions]);
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  const count = unread.length;

  useEffect(() => {
    if (!enabled || !vault) return undefined;
    publishSuperUnread(vault, count);
    return undefined;
  }, [enabled, vault, count]);
  useEffect(() => (enabled && vault ? () => dropSuperUnread(vault) : undefined), [enabled, vault]);

  const markRead = useCallback((seen: readonly UnreadUnit[]) => {
    if (!seen.length) return;
    const read = seen.map(({ key, ts }) => ({ key, ts }));
    pending.current.push(...read);
    setMarks((m) => (m ? withRead(m, read) : m));
    queueFlush();
  }, [queueFlush]);

  const markAll = useCallback(() => {
    const now = Date.now();
    allBefore.current = now;
    setMarks((m) => (m ? { since: Math.max(m.since, now), read: m.read } : m));
    queueFlush();
    setEdge(null);
  }, [queueFlush]);

  // Painted after every commit: a row the window just mounted has to get its dot before the
  // browser draws it. Only what differs is touched, so a streaming token costs a lookup.
  const painted = useRef(new Set<HTMLElement>());
  const labelFor = useRef(dividerLabel);
  labelFor.current = dividerLabel;
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const want = new Set<HTMLElement>();
    const rows = unread.map((u) => rowOf(root, u));
    const first = rows[0];
    for (const el of rows) if (el) want.add(el);
    for (const el of painted.current) {
      if (!want.has(el)) { el.removeAttribute('data-unread'); el.removeAttribute('data-unread-first'); el.removeAttribute('data-unread-label'); }
    }
    for (const el of want) {
      if (!el.hasAttribute('data-unread')) el.setAttribute('data-unread', '');
      if (el === first) {
        el.setAttribute('data-unread-first', '');
        el.setAttribute('data-unread-label', labelFor.current(count));
      } else if (el.hasAttribute('data-unread-first')) {
        el.removeAttribute('data-unread-first');
        el.removeAttribute('data-unread-label');
      }
    }
    painted.current = want;
  });

  const hasUnread = count > 0;
  useEffect(() => {
    if (!hasUnread) { setEdge(null); return undefined; }
    let started = new Map<string, number>();
    const missing = new Map<string, number>();
    const tick = () => {
      const scroller = scrollRef.current;
      const root = contentRef.current;
      if (!scroller || !root) return;
      const box = scroller.getBoundingClientRect();
      const view: Span = { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, window.innerHeight) };
      const shown = box.width > 0 && view.bottom > view.top;
      const onTop = shown ? document.elementFromPoint(box.left + box.width / 2, (view.top + view.bottom) / 2) : null;
      const canRead = ownerCanRead({
        docVisible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        paneShown: !!onTop && scroller.contains(onTop),
      });
      const units = unreadRef.current;
      const rows = units.map((u) => rowOf(root, u));
      const firstMounted = rows.findIndex(Boolean);
      const visible: string[] = [];
      const gone: UnreadUnit[] = [];
      let next: UnreadEdge = null;
      units.forEach((u, i) => {
        const el = rows[i];
        if (!el) {
          // Behind the window's ceiling it can be revealed; inside the mounted range there is
          // nothing to reveal (a block that drew nothing), and it must not hold a count for ever.
          if (firstMounted < 0 || i < firstMounted) { next = 'up'; return; }
          const n = (missing.get(u.key) ?? 0) + 1;
          missing.set(u.key, n);
          if (n >= GONE_TICKS && canRead) gone.push(u);
          return;
        }
        missing.delete(u.key);
        const r = el.getBoundingClientRect();
        const row = { top: r.top, bottom: r.bottom };
        if (mostlyVisible(row, view)) { visible.push(u.key); return; }
        const side = sideOf(row, view);
        if (side === 'above') next = 'up';
        else if (next === null && side === 'below') next = 'down';
      });
      setEdge(next);
      const step = advanceDwell(started, canRead ? visible : [], Date.now());
      started = step.started;
      const seen = new Set(step.seen);
      markRead([...units.filter((u) => seen.has(u.key)), ...gone]);
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [hasUnread, scrollRef, contentRef, markRead]);

  return { count, edge, first: unread[0] ?? null, markAll };
}
