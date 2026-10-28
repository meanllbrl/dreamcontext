/**
 * Per-board scoping for WebKit's pinch-zoom gesture.
 *
 * WHY this exists: `@excalidraw/excalidraw` 0.18 registers its Safari pinch handlers
 * (`gesturestart` / `gesturechange` / `gestureend`) on `document`, and drives them from a
 * MODULE-LEVEL `gesture` object shared by every mounted `<Excalidraw>`. Nothing on that
 * path asks which editor the fingers were over, so on a page holding more than one board
 * — the Chat transcript draws several, plus the panel and the full-screen copy — a single
 * pinch reaches all of them, and because `gesture.initialScale` is one shared slot they
 * all land on the SAME zoom. That is the "zoom one board and every board zooms the same
 * way" report. It lives in upstream module state, so no amount of keying or remounting on
 * our side can separate the instances.
 *
 * Fix: take the three gesture events in the CAPTURE phase at `document` — which runs
 * before the editor's own bubble-phase listeners on that same node, so stopping there
 * disarms every instance at once — and replay the zoom onto the ONE board under the
 * fingers via the public imperative API. WKWebView is the desktop app's engine, where
 * pinch IS the zoom gesture, so it has to keep working rather than merely stop leaking.
 * Wheel/trackpad pan and ctrl+wheel zoom are untouched: those listeners are already bound
 * to each editor's own container, so they were never shared.
 *
 * The replay zooms the way Excalidraw's ctrl+wheel and touch pinch do (its Safari gesture
 * handler does not): while the fingers move, `shouldCacheIgnoreZoom` is on, so every element
 * is drawn from the bitmap it already has, scaled. Without it each step at a new zoom
 * re-rasterises every element on screen: on a board of tables that took WKWebView from 60 to
 * 23 fps, and a two-finger pan that jitters the scale a hair (83 % stays "83 %") cost the
 * same (2026-10-28). The flag drops when the
 * gesture ends, or PINCH_SETTLE_MS after its last step if WebKit never sends `gestureend`,
 * and that one frame redraws the board sharp at its final zoom.
 */

/** The slice of Excalidraw's appState the zoom math reads. */
export interface BoardViewport {
  scrollX: number;
  scrollY: number;
  offsetLeft: number;
  offsetTop: number;
  zoom: { value: number };
}

export type BoardViewportPatch = Pick<BoardViewport, 'scrollX' | 'scrollY' | 'zoom'>;

/**
 * What a pinch hands a board, straight into `updateScene({ appState })`: a step (the new
 * viewport, drawn from the cached bitmaps) or the settle that drops the flag again.
 */
export type PinchPatch =
  | (BoardViewportPatch & { shouldCacheIgnoreZoom: true })
  | { shouldCacheIgnoreZoom: false };

/** Excalidraw's own wait before it redraws sharp after a zoom (`resetShouldCacheIgnoreZoomDebounced`). */
export const PINCH_SETTLE_MS = 300;

// Excalidraw's own bounds and rounding, mirrored rather than imported — neither
// `getNormalizedZoom` nor MIN/MAX_ZOOM is reachable from the package's public entry.
export const MIN_BOARD_ZOOM = 0.1;
export const MAX_BOARD_ZOOM = 30;

export function normalizeBoardZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_BOARD_ZOOM;
  const rounded = Math.round(zoom * 1e6) / 1e6;
  return Math.min(MAX_BOARD_ZOOM, Math.max(MIN_BOARD_ZOOM, rounded));
}

/**
 * Zoom to `nextZoom` while holding the scene point under (viewportX, viewportY) still —
 * the same arithmetic as Excalidraw's internal `getStateForZoom`, so a replayed pinch
 * tracks the fingers exactly as an un-scoped one would.
 */
export function zoomAroundPoint(
  state: BoardViewport,
  viewportX: number,
  viewportY: number,
  nextZoom: number,
): BoardViewportPatch {
  const layerX = viewportX - state.offsetLeft;
  const layerY = viewportY - state.offsetTop;
  const current = state.zoom.value;
  const baseScrollX = state.scrollX + (layerX - layerX / current);
  const baseScrollY = state.scrollY + (layerY - layerY / current);
  return {
    scrollX: baseScrollX - (layerX - layerX / nextZoom),
    scrollY: baseScrollY - (layerY - layerY / nextZoom),
    zoom: { value: nextZoom },
  };
}

export interface PinchTarget {
  /** The board's own DOM subtree — decides which gestures belong to it. */
  el: HTMLElement;
  getViewport: () => BoardViewport | null;
  setViewport: (patch: PinchPatch) => void;
}

/**
 * The board a gesture belongs to: the registered subtree containing its target. A pinch
 * over page chrome belongs to NO board and must therefore move none of them — that case
 * is the whole reason this can't be solved with a listener per wrapper.
 */
export function resolvePinchTarget<T extends { el: { contains(node: Node): boolean } }>(
  targets: Iterable<T>,
  node: Node | null,
): T | null {
  if (!node) return null;
  for (const target of targets) {
    if (target.el.contains(node)) return target;
  }
  return null;
}

// ─── The document-level interceptor (installed while any board is mounted) ─────────────

/** WebKit's non-standard GestureEvent: `scale` is cumulative from `gesturestart`. */
type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

const targets = new Set<PinchTarget>();
let active: { target: PinchTarget; baseZoom: number; x: number; y: number } | null = null;
let installed = false;
/** The board drawn from cached bitmaps until it settles, and the backstop timer. */
let unsettled: PinchTarget | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/** Redraw the board sharp at the zoom it ended on (once, whatever ended the gesture). */
function settle(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  const target = unsettled;
  unsettled = null;
  if (target && targets.has(target)) target.setViewport({ shouldCacheIgnoreZoom: false });
}

/** Anchor the whole gesture on where it STARTED: `gesturechange` carries coordinates too,
 *  but a fixed anchor is what makes a pinch feel like it pins the scene under the fingers
 *  instead of drifting (Excalidraw pins its own anchor for the same reason). */
function anchorOf(event: GestureLike, el: HTMLElement): { x: number; y: number } {
  if (typeof event.clientX === 'number' && typeof event.clientY === 'number'
    && (event.clientX !== 0 || event.clientY !== 0)) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** A gesture over something that zooms ITSELF (a full-screen viewer's stage carries
 *  `data-pinch-owner`; usePanZoom.ts): that element handles the pinch and stops it before it
 *  bubbles to the document, where every editor's own handler sits. */
export function isPinchOwnerTarget(node: Node | null | undefined): boolean {
  const el = node && (node as Element).closest ? node as Element : node?.parentElement ?? null;
  return !!el?.closest?.('[data-pinch-owner]');
}

function onGesture(event: Event) {
  const gesture = event as GestureLike;
  const node = gesture.target as Node | null;
  // A pinch that starts over a board is the board's, wherever it sits. One that starts over a
  // pinch owner (and no board) is that owner's: let it through untouched, and drop any stale
  // board gesture (a missed gestureend) so it cannot steer a board meanwhile.
  if (gesture.type === 'gesturestart') {
    if (!resolvePinchTarget(targets, node) && isPinchOwnerTarget(node)) { active = null; return; }
  } else if (!active && isPinchOwnerTarget(node)) {
    return;
  }
  // preventDefault stops WebKit page-zooming the whole app; stopPropagation is the half
  // that matters here — it keeps the event from reaching EVERY editor's document-level
  // handler, which is what coupled the boards.
  gesture.preventDefault();
  gesture.stopPropagation();

  if (gesture.type === 'gestureend') {
    active = null;
    settle();
    return;
  }
  if (gesture.type === 'gesturestart') {
    const target = resolvePinchTarget(targets, gesture.target as Node | null);
    const viewport = target?.getViewport() ?? null;
    active = target && viewport
      ? { target, baseZoom: viewport.zoom.value, ...anchorOf(gesture, target.el) }
      : null;
    return;
  }
  if (!active) return;
  const viewport = active.target.getViewport();
  if (!viewport) return;
  const nextZoom = normalizeBoardZoom(active.baseZoom * (gesture.scale ?? 1));
  // A step that lands on the zoom the board already has moves nothing: no render at all.
  if (nextZoom === viewport.zoom.value) return;
  if (unsettled && unsettled !== active.target) settle();
  unsettled = active.target;
  active.target.setViewport({ ...zoomAroundPoint(viewport, active.x, active.y, nextZoom), shouldCacheIgnoreZoom: true });
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, PINCH_SETTLE_MS);
}

function setInstalled(next: boolean) {
  if (next === installed || typeof document === 'undefined') return;
  installed = next;
  for (const name of GESTURE_EVENTS) {
    if (next) document.addEventListener(name, onGesture, true);
    else document.removeEventListener(name, onGesture, true);
  }
}

/** Register a mounted board; returns the unregister to call on unmount. */
export function registerPinchTarget(target: PinchTarget): () => void {
  targets.add(target);
  setInstalled(true);
  return () => {
    targets.delete(target);
    if (active?.target === target) active = null;
    if (unsettled === target) {
      unsettled = null;
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (targets.size === 0) setInstalled(false);
  };
}
