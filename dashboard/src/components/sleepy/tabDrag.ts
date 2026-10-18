/**
 * Dragging a session TAB — onto another tab (reorder), onto a pane's tab group (combine), or
 * onto a pane's left / centre / right third (split left, add as tab, split right) — on
 * POINTER events, not the browser's native drag and drop.
 *
 * Why not native DnD (task: the desktop app stays light on an 8GB MacBook Air). A native tab
 * drag froze the WebKit main thread for seconds (owner recording, 2026-10-17): every
 * `dragover` re-read `dataTransfer`, set state in each pane, and the drag start re-rendered
 * the whole 4k-line surface; WebKit also cancels a pointer stream once a native drag begins,
 * so the zones never highlighted and the drop layer could outlive the release. Here:
 *   - a press ARMS; a 4 px move starts the drag and captures the pointer to the tab;
 *   - every rect is measured ONCE at the start (re-measured on the next frame when something
 *     scrolls, the window resizes, or the panes change) and hit-testing is arithmetic on them;
 *   - the ghost moves by `transform` in one rAF per frame;
 *   - the store below changes only when the TARGET changes, so a pane re-renders only when
 *     the pointer crosses into or out of one of its zones;
 *   - the release runs the surface's executor with the last target; cancel, Escape, a
 *     window blur, a lost capture, or the dragged tab disappearing clear without acting;
 *   - the click that follows a drag's release is swallowed, so a drop never also selects.
 * Native FILE drops from the Finder are a different gesture and stay native (AgentSurface).
 *
 * One store per surface (a window can hold several projects, each with its own surface), so
 * a drag in one project never mounts drop layers in another.
 */
import { useSyncExternalStore } from 'react';

export type TabDropZone = 'left' | 'center' | 'right';

/** Where a dragged tab lands on release. */
export type TabDropTarget =
  | { kind: 'zone'; paneId: string; zone: TabDropZone }
  | { kind: 'group'; paneId: string }
  | { kind: 'reorder'; paneId: string; beforeSid: string };

export interface TabDragState {
  /** The session being dragged. */
  sid: string;
  /** What is under the pointer right now, or null over nothing droppable. */
  target: TabDropTarget | null;
}

/** A movement under this many px is a click, not a drag. */
export const TAB_DRAG_THRESHOLD_PX = 4;

export function sameTabTarget(a: TabDropTarget | null, b: TabDropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.paneId !== b.paneId) return false;
  if (a.kind === 'zone') return a.zone === (b as typeof a).zone;
  if (a.kind === 'reorder') return a.beforeSid === (b as typeof a).beforeSid;
  return true;
}

// ── The store ───────────────────────────────────────────────────────────────────────

export interface TabDragStore {
  get(): TabDragState | null;
  subscribe(cb: () => void): () => void;
  start(sid: string): void;
  /** Notifies only when the target actually changed. */
  setTarget(target: TabDropTarget | null): void;
  /** End the drag (drop or cancel) and return what it was. Idempotent. */
  end(): TabDragState | null;
  /** The panes changed under a drag (one opened or closed): its rects are stale. */
  layoutChanged(): void;
  onLayout(cb: () => void): () => void;
}

export function createTabDragStore(): TabDragStore {
  let state: TabDragState | null = null;
  const listeners = new Set<() => void>();
  const layoutListeners = new Set<() => void>();
  const emit = () => { for (const l of [...listeners]) l(); };
  return {
    get: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    start(sid) {
      state = { sid, target: null };
      emit();
    },
    setTarget(target) {
      if (!state || sameTabTarget(state.target, target)) return;
      state = { ...state, target };
      emit();
    },
    end() {
      const was = state;
      if (!was) return null;
      state = null;
      emit();
      return was;
    },
    // A separate channel: a layout change must not re-render every pane subscribed above.
    layoutChanged() {
      if (state) for (const l of [...layoutListeners]) l();
    },
    onLayout(cb) {
      layoutListeners.add(cb);
      return () => { layoutListeners.delete(cb); };
    },
  };
}

/** Is a tab being dragged on this surface? */
export function useTabDragActive(store: TabDragStore): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get() !== null, () => false);
}

/** Which of THIS pane's zones is under the pointer ('' for none) — a pane re-renders only
 *  when its own answer changes. */
export function useTabDragZone(store: TabDragStore, paneId: string): TabDropZone | '' {
  const read = () => {
    const t = store.get()?.target;
    return t?.kind === 'zone' && t.paneId === paneId ? t.zone : '';
  };
  return useSyncExternalStore(store.subscribe, read, () => '');
}

/** The whole drag state (the tab strip marks the dragged tab and the reorder / group target). */
export function useTabDrag(store: TabDragStore): TabDragState | null {
  return useSyncExternalStore(store.subscribe, store.get, () => null);
}

// ── Hit-testing (pure) ──────────────────────────────────────────────────────────────

export interface DragRect { left: number; top: number; right: number; bottom: number }

/** Every droppable rect, measured once when the drag starts. */
export interface DragGeometry {
  /** A pane's tab group (`.agent-pane-tabbar`) and the tabs inside it. */
  groups: Array<{ paneId: string; rect: DragRect; tabs: Array<{ sid: string; rect: DragRect }> }>;
  /** A pane's body (`.agent-pane`), split into left / centre / right thirds. */
  panes: Array<{ paneId: string; rect: DragRect }>;
}

const inside = (r: DragRect, x: number, y: number) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

/** The third of a pane a point is in — the drop layer's three EQUAL flex zones. */
export function zoneAt(rect: DragRect, x: number): TabDropZone {
  const third = (rect.right - rect.left) / 3;
  if (x < rect.left + third) return 'left';
  if (x >= rect.right - third) return 'right';
  return 'center';
}

/**
 * What a release at (x, y) would do. A tab beats its group (a tab scrolled out of its group's
 * visible box is not hit, because the group must contain the point first); a group beats
 * nothing; a pane answers with its zone. The dragged tab itself is no target.
 */
export function hitTestTabDrop(geom: DragGeometry, x: number, y: number, draggedSid: string): TabDropTarget | null {
  for (const g of geom.groups) {
    if (!inside(g.rect, x, y)) continue;
    const tab = g.tabs.find((t) => inside(t.rect, x, y));
    if (tab) return tab.sid === draggedSid ? null : { kind: 'reorder', paneId: g.paneId, beforeSid: tab.sid };
    return { kind: 'group', paneId: g.paneId };
  }
  for (const p of geom.panes) {
    if (inside(p.rect, x, y)) return { kind: 'zone', paneId: p.paneId, zone: zoneAt(p.rect, x) };
  }
  return null;
}

const rectOf = (el: Element): DragRect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** Read the geometry off a surface: `.agent-pane-tabbar[data-pane-id]` > `.agent-tab[data-sid]`
 *  and `.agent-pane[data-pane-id]`. */
export function measureDragGeometry(root: ParentNode): DragGeometry {
  const groups: DragGeometry['groups'] = [];
  for (const bar of Array.from(root.querySelectorAll<HTMLElement>('.agent-pane-tabbar[data-pane-id]'))) {
    groups.push({
      paneId: bar.dataset.paneId ?? '',
      rect: rectOf(bar),
      tabs: Array.from(bar.querySelectorAll<HTMLElement>('.agent-tab[data-sid]'))
        .map((t) => ({ sid: t.dataset.sid ?? '', rect: rectOf(t) })),
    });
  }
  const panes = Array.from(root.querySelectorAll<HTMLElement>('.agent-pane[data-pane-id]'))
    .map((p) => ({ paneId: p.dataset.paneId ?? '', rect: rectOf(p) }));
  return { groups, panes };
}

// ── The gesture ─────────────────────────────────────────────────────────────────────

/** The floating copy of the tab that follows the pointer. */
export interface TabGhost {
  /** Move by (dx, dy) from where the tab was. */
  move(dx: number, dy: number): void;
  remove(): void;
}

/** What the gesture needs from the pressed tab (an `HTMLElement` in the app). */
export type TabDragElement = EventTarget & {
  /** False once the tab left the DOM (a node, unlike the test fakes, always has it). */
  readonly isConnected?: boolean;
  setPointerCapture?(id: number): void;
  releasePointerCapture?(id: number): void;
  hasPointerCapture?(id: number): boolean;
};

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Capture as an OPTIONS OBJECT, never the bare `true`: Node's `EventTarget` reads only
 *  `options.capture` in `removeEventListener`, so a boolean there silently removes nothing
 *  (the post-drop click swallower then outlived its one click). Browsers accept both. */
const CAPTURE = { capture: true } as const;

export interface TabDragOptions {
  store: TabDragStore;
  /** The surface's executor, run once on a release over a target. */
  onDrop: (sid: string, target: TabDropTarget) => void;
  /** Rects to hit-test against (re-called after a scroll, a resize or a pane change). */
  measure: () => DragGeometry;
  /** Build the ghost (the app's default clones the tab into <body>). */
  ghost: () => TabGhost;
  /** Window-level events: Escape, blur, resize, scroll, and the post-drop click. */
  win: Listenable & { setTimeout(cb: () => void, ms: number): unknown; getSelection?: () => { removeAllRanges(): void } | null };
  raf?: (cb: () => void) => unknown;
}

interface PointerLike { pointerId: number; clientX: number; clientY: number }

/**
 * A press on a tab. Returns the disarm (the caller rarely needs it: the gesture tears itself
 * down on release / cancel). Nothing happens until the pointer has moved
 * {@link TAB_DRAG_THRESHOLD_PX}; a release before that is a plain click and is left alone.
 */
export function armTabDrag(down: PointerLike, el: TabDragElement, sid: string, opts: TabDragOptions): () => void {
  const { store, win } = opts;
  const raf = opts.raf ?? ((cb: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : win.setTimeout(cb, 16)));
  const id = down.pointerId;
  const x0 = down.clientX, y0 = down.clientY;
  let x = x0, y = y0;
  let dragging = false;
  let done = false;
  let framePending = false;
  // Scroll fires per scrolled element (every streaming transcript); measure once per frame.
  let geomDirty = false;
  let geom: DragGeometry = { groups: [], panes: [] };
  let ghost: TabGhost | null = null;
  let offStore: (() => void) | null = null;
  let offLayout: (() => void) | null = null;

  const frame = () => {
    framePending = false;
    if (!dragging || done) return;
    // Unmounted mid-drag (the overlay folded, the strip re-mounted at a breakpoint): its
    // capture went to the document, so no release may ever reach it. Stop without acting.
    if (el.isConnected === false) { finish(false); return; }
    if (geomDirty) { geomDirty = false; geom = opts.measure(); }
    ghost?.move(x - x0, y - y0);
    store.setTarget(hitTestTabDrop(geom, x, y, sid));
  };
  const schedule = () => {
    if (framePending) return;
    framePending = true;
    raf(frame);
  };

  const begin = () => {
    dragging = true;
    // A selection anchored before the threshold (a press beside the tab's text) would grow
    // over every pane the drag crosses; drop it once, as the drag begins.
    try { win.getSelection?.()?.removeAllRanges(); } catch { /* no selection API */ }
    geom = opts.measure();
    ghost = opts.ghost();
    store.start(sid);
    // Cleared from outside (the dragged tab's pane closed): stop without acting.
    offStore = store.subscribe(() => {
      const s = store.get();
      if (!s || s.sid !== sid) finish(false, false);
    });
    offLayout = store.onLayout(onRemeasure);
    win.addEventListener('scroll', onRemeasure, CAPTURE);
    win.addEventListener('resize', onRemeasure);
    schedule();
  };

  /** Tear down; on `drop`, run the executor with the target under the release point. */
  const finish = (drop: boolean, endStore = true) => {
    if (done) return;
    done = true;
    el.removeEventListener('pointermove', moveL);
    el.removeEventListener('pointerup', upL);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('lostpointercapture', onLost);
    win.removeEventListener('pointerup', upL, CAPTURE);
    win.removeEventListener('pointercancel', cancelL, CAPTURE);
    win.removeEventListener('keydown', keyL, CAPTURE);
    win.removeEventListener('blur', onCancel);
    win.removeEventListener('selectstart', noSelect, CAPTURE);
    win.removeEventListener('scroll', onRemeasure, CAPTURE);
    win.removeEventListener('resize', onRemeasure);
    offStore?.();
    offStore = null;
    offLayout?.();
    offLayout = null;
    ghost?.remove();
    ghost = null;
    if (!dragging) return;
    try { if (el.hasPointerCapture?.(id)) el.releasePointerCapture?.(id); } catch { /* released */ }
    if (drop && geomDirty) geom = opts.measure();
    const target = drop ? hitTestTabDrop(geom, x, y, sid) : null;
    if (endStore) store.end();
    // The click the browser dispatches right after this release belongs to the drag.
    if (drop) swallowNextClick(win);
    if (target) opts.onDrop(sid, target);
  };

  function onMove(e: PointerLike) {
    if (e.pointerId !== id) return;
    x = e.clientX; y = e.clientY;
    if (!dragging) {
      if (Math.hypot(x - x0, y - y0) < TAB_DRAG_THRESHOLD_PX) return;
      begin();
      return;
    }
    schedule();
  }
  function onUp(e: PointerLike) {
    if (e.pointerId !== id) return;
    x = e.clientX; y = e.clientY;
    finish(true);
  }
  function onCancel() { finish(false); }
  function onCancelPointer(e: PointerLike) {
    if (e.pointerId === id) finish(false);
  }
  // Capture is released on every pointerup too, AFTER it — by then `done` is set, so only a
  // capture lost mid-gesture (the tab unmounted, the OS took the pointer) cancels.
  function onLost() { finish(false); }
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (dragging) { e.preventDefault(); e.stopPropagation(); }
    finish(false);
  }
  function onRemeasure() {
    if (!dragging || done) return;
    geomDirty = true;
    schedule();
  }

  const moveL = onMove as unknown as EventListener;
  const upL = onUp as unknown as EventListener;
  const keyL = onKey as unknown as EventListener;
  const cancelL = onCancelPointer as unknown as EventListener;
  // Captured from the press, so a fast first move that leaves the tab is still seen (and the
  // plain click that follows a press without a drag still lands on the tab).
  try { el.setPointerCapture?.(id); } catch { /* the pointer is already gone */ }
  el.addEventListener('pointermove', moveL);
  el.addEventListener('pointerup', upL);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('lostpointercapture', onLost);
  // The tab can unmount while held (its session closed elsewhere): its capture and its own
  // listeners go with it, and without these the selectstart guard below would outlive the
  // press until the next Escape or blur. The first of the two copies to fire wins.
  win.addEventListener('pointerup', upL, CAPTURE);
  win.addEventListener('pointercancel', cancelL, CAPTURE);
  win.addEventListener('keydown', keyL, CAPTURE);
  win.addEventListener('blur', onCancel);
  // WebKit starts a text selection when the held pointer reaches selectable text, whatever
  // the tab's own user-select says; across long transcripts that selection is the whole
  // frame budget (measured 2026-10-17: 206k characters, 130 ms frames). No selection may
  // start while a tab is held.
  win.addEventListener('selectstart', noSelect, CAPTURE);
  return () => finish(false);
}

function noSelect(e: Event): void {
  e.preventDefault();
}

/** Swallow the one click that follows a drag's release (capture phase, gone after a tick). */
function swallowNextClick(win: TabDragOptions['win']): void {
  const eat = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    win.removeEventListener('click', eat, CAPTURE);
  };
  win.addEventListener('click', eat, CAPTURE);
  win.setTimeout(() => win.removeEventListener('click', eat, CAPTURE), 0);
}

/** The app's ghost: a copy of the tab, fixed over the page, moved by `transform` only. */
export function createTabGhost(tab: HTMLElement): TabGhost {
  const r = tab.getBoundingClientRect();
  const g = tab.cloneNode(true) as HTMLElement;
  g.classList.add('agent-tab-ghost');
  // A picture of the tab, not a second tab: no id, role, focus stop or session handle.
  for (const a of ['id', 'role', 'tabindex', 'data-sid', 'aria-selected', 'aria-controls']) g.removeAttribute(a);
  g.setAttribute('aria-hidden', 'true');
  g.style.left = `${r.left}px`;
  g.style.top = `${r.top}px`;
  g.style.width = `${r.width}px`;
  document.body.appendChild(g);
  return {
    move(dx, dy) { g.style.transform = `translate3d(${dx}px, ${dy}px, 0)`; },
    remove() { g.remove(); },
  };
}
