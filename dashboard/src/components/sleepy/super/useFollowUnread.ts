import { useCallback, useRef, type MutableRefObject, type RefObject } from 'react';
import {
  doorTarget, emptyPassed, followAnchors, followTop, landingFor, passAll as passAllOf, PROSE_LANDING, START_SLACK,
  type FollowAnchor, type Span, type UnreadUnit,
} from './superUnread';
import { lineHostOf } from './useSuperUnread';

/**
 * THE FOLLOW of the Super chat (owner 2026-11-12): new content never pushes the START of the
 * first unread message out of view. The pin asks `target` before it writes the bottom, at the
 * write and in its next-frame re-assert, so both share one target; when the cap bites the pane
 * writes it once and the view becomes unpinned and held, and from then on only the reader moves
 * it. Every rule is in superUnread.ts; this holds the refs.
 *
 * Every callback here has a STABLE identity and reads its inputs through a ref: the pane's
 * ResizeObserver and re-home hook re-subscribe on identity, and a gap in either loses a height
 * change (plan r1 E6).
 */
export interface FollowUnread {
  /** Where a pinned view goes instead of the bottom, or null for the bottom. `allowUp`: the opened
   *  pane's first landing, which may go up and reveal a row above the mounted window; otherwise a
   *  pinned view only moves down. `{ reveal: true }`: a reveal was started, it lands by itself. */
  target: (el: HTMLElement, allowUp: boolean) => { top: number; node: HTMLElement } | { reveal: true } | null; // node: the anchor's row; its start is lineHostOf(node)
  /** The reader chose the end (Latest, a send, his own scroll to the bottom). */
  passAll: () => void;
  /** A door to a question (the band's Answer, the agenda's waiting row; K1 = A). */
  door: (item: string) => 'card' | 'unread';
  /** The door's memory ends: the reader went elsewhere by another path. */
  forgetDoor: () => void;
  /** The first unpassed anchor's id, for the pane's landing effect; '' for none. */
  anchorKey: () => string;
}

export interface FollowInputs {
  enabled: boolean;
  items: ReadonlyArray<{ id: string; kind: string; done?: boolean }>;
  unread: readonly UnreadUnit[];
  rowOf: (u: UnreadUnit) => HTMLElement | null;
  measureTop: (node: Element, scroller: HTMLElement) => number;
  /** Unpins and mounts an item above the window; null: no such item (ChatPane.releaseToItem). */
  releaseToItem: (itemId: string) => boolean | null;
  jump: (unit: UnreadUnit, opts?: { instant?: boolean }) => void;
  setStick: (next: boolean) => void;
  jumpHeldRef: MutableRefObject<boolean>;
}

const keyOf = (a: FollowAnchor | null): string => (!a ? '' : 'itemId' in a ? a.itemId : `q:${a.question}`);

/** The Super text being written now: the newest item, an unfinished text. */
function liveTextOf(items: FollowInputs['items']): string | null {
  const last = items[items.length - 1];
  return last && last.kind === 'text' && !last.done ? last.id : null;
}

function viewOf(scroller: HTMLElement): Span {
  const box = scroller.getBoundingClientRect();
  return { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, window.innerHeight) };
}
const spanOf = (el: HTMLElement): Span => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };

export function useFollowUnread(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>): {
  follow: FollowUnread;
  inputs: MutableRefObject<FollowInputs | null>;
} {
  const inputs = useRef<FollowInputs | null>(null);
  const passed = useRef(emptyPassed());
  const lastDoor = useRef<string | null>(null);

  /** Rows above the mounted window have no element: older than the first item drawn. */
  const aboveWindow = useCallback((itemId: string): boolean => {
    const inp = inputs.current;
    const root = contentRef.current;
    if (!inp || !root) return false;
    const first = root.querySelector<HTMLElement>('[data-item-id]')?.dataset.itemId;
    if (!first) return false;
    const at = inp.items.findIndex((it) => it.id === itemId);
    const firstAt = inp.items.findIndex((it) => it.id === first);
    return at >= 0 && firstAt >= 0 && at < firstAt;
  }, [contentRef]);

  const rowOfAnchor = useCallback((a: FollowAnchor): HTMLElement | null => {
    const inp = inputs.current;
    const root = contentRef.current;
    if (!inp || !root) return null;
    if (a.unit) return inp.rowOf(a.unit);
    return 'itemId' in a ? root.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(a.itemId)}"]`) : null;
  }, [contentRef]);

  const target = useCallback<FollowUnread['target']>((el, allowUp) => {
    const inp = inputs.current;
    if (!inp?.enabled || el.clientHeight === 0) return null;
    const live = liveTextOf(inp.items);
    for (const a of followAnchors(inp.items, inp.unread, passed.current, live)) {
      const row = rowOfAnchor(a);
      if (!row) {
        // Above the mounted window: only an opened pane's first landing goes up to it. A pinned
        // follow walks on, as for a start above the view: the next candidate decides, so a new
        // report below is still held (end review r1). A block inside the window that drew nothing
        // is skipped too (plan r1 E2).
        if ('itemId' in a && aboveWindow(a.itemId)) {
          if (!allowUp || !a.unit) continue;
          if (inp.releaseToItem(a.itemId) === null) continue;
          inp.jump(a.unit, { instant: true });
          return { reveal: true };
        }
        continue;
      }
      const host = lineHostOf(row);
      const top = inp.measureTop(host, el);
      // Its start already above a pinned view: moving down cannot show it, and holding on it would
      // only make the follow creep (the pill points at it). The next candidate decides.
      if (!allowUp && top < el.scrollTop - START_SLACK) continue;
      const landing = 'question' in a ? landingFor('question', row.getBoundingClientRect().height, el.clientHeight) : PROSE_LANDING;
      const next = followTop(el.scrollHeight - el.clientHeight, top, landing, allowUp ? 0 : el.scrollTop);
      return next.held ? { top: next.top, node: row } : null;
    }
    return null;
  }, [rowOfAnchor, aboveWindow]);

  const passAll = useCallback(() => {
    const inp = inputs.current;
    if (!inp) return;
    passAllOf(passed.current, inp.unread, liveTextOf(inp.items));
  }, []);

  const door = useCallback<FollowUnread['door']>((item) => {
    const inp = inputs.current;
    const scroller = scrollRef.current;
    const toCard = (): 'card' => {
      if (!inp) return 'card';
      const unit = inp.unread.find((u) => u.question === item) ?? { key: `q:${item}`, ts: 0, itemId: null, question: item };
      inp.setStick(false);
      inp.jumpHeldRef.current = true;
      inp.jump(unit);
      return 'card';
    };
    // The next press for the same question, with no reader input since, goes to the card however
    // many unread lie between (plan r1 E3).
    const again = lastDoor.current === item && !!inp?.jumpHeldRef.current;
    lastDoor.current = item;
    if (!inp || !scroller || again) return toCard();
    const prose = inp.unread.filter((u) => u.itemId);
    const cardUnit = { key: `q:${item}`, ts: 0, itemId: null, question: item };
    const card = inp.rowOf(cardUnit);
    const kept: UnreadUnit[] = [];
    const rows: Array<Span | null> = [];
    for (const u of prose) {
      const el = inp.rowOf(u);
      if (el) { kept.push(u); rows.push(spanOf(lineHostOf(el))); } else if (u.itemId && aboveWindow(u.itemId)) { kept.push(u); rows.push(null); }
    }
    const at = doorTarget(rows, card ? spanOf(card) : null, viewOf(scroller));
    const unit = kept[at];
    if (!unit?.itemId || inp.releaseToItem(unit.itemId) === null) return toCard();
    inp.setStick(false);
    inp.jumpHeldRef.current = true;
    inp.jump(unit);
    return 'unread';
  }, [scrollRef, aboveWindow]);

  const forgetDoor = useCallback(() => { lastDoor.current = null; }, []);

  const anchorKey = useCallback(() => {
    const inp = inputs.current;
    if (!inp?.enabled) return '';
    return keyOf(followAnchors(inp.items, inp.unread, passed.current, liveTextOf(inp.items))[0] ?? null);
  }, []);

  const follow = useRef<FollowUnread>({ target, passAll, door, forgetDoor, anchorKey }).current;
  return { follow, inputs };
}
