/**
 * The canvas's gestures and overlays, outside the component (WhiteboardCanvas.tsx): widget
 * snapping after a move or resize, click forwarding into an embeddable, and
 * where the selected widget's size control goes.
 */

/** The selected widget's size control, in the canvas wrapper's pixel space. */
import { CaptureUpdateAction, newElementWith, sceneCoordsToViewportCoords } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement, ExcalidrawEmbeddableElement, NonDeleted, OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import { isCardColor, type CardColor, type WidgetPayload, type WidgetSize } from '../../lib/whiteboardWidgets';
import { readWidgetPayload } from './widgetModel';
import { isPresetBox, placeSizePicker, resizeInPlace, snapAfterGesture, widgetSizeOf, type WidgetGeometry } from './widgetSize';

export interface SizePickerState {
  id: string;
  left: number;
  top: number;
  size: WidgetSize;
  /** The box was dragged to a free-form size: no preset is current, and every one applies. */
  custom: boolean;
  /** The card's tint, null for the plain card. */
  color: CardColor | null;
}

/** An element's box and version at pointer-down: what a gesture is measured against. */
export type GestureSnapshot = Map<string, WidgetGeometry & { version: number }>;

/** Gap between a selected widget's bottom edge and its size control, in screen px. */
const SIZE_PICKER_GAP = 10;

/**
 * Grid snapping (A17), once per gesture: a snapshot of every element's box at pointer-down,
 * compared at pointer-up (a frame later, once Excalidraw has committed the gesture). Only
 * widgets the gesture moved or resized snap; free drawing is never touched, and a move that
 * also carried free drawing does not snap (it would tear the widget from what moved with it).
 * `snapAfterGesture` answers null for a widget already in place, so the snap never re-triggers.
 */
export function subscribeWidgetSnapping(api: ExcalidrawImperativeAPI): (() => void)[] {
  let before: GestureSnapshot | null = null;
  let frame = 0;
  const offDown = api.onPointerDown(() => {
    before = new Map();
    for (const el of api.getSceneElementsIncludingDeleted()) {
      if (!el.isDeleted) before.set(el.id, { x: el.x, y: el.y, width: el.width, height: el.height, version: el.version });
    }
  });
  const offUp = api.onPointerUp(() => {
    const snapshot = before;
    before = null;
    if (!snapshot) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => snapWidgets(api, snapshot));
  });
  return [offDown, offUp, () => cancelAnimationFrame(frame)];
}

export function snapWidgets(api: ExcalidrawImperativeAPI, before: GestureSnapshot): void {
  const all = api.getSceneElementsIncludingDeleted();
  const changed = all.filter((el) => !el.isDeleted && before.get(el.id) && before.get(el.id)!.version !== el.version);
  if (changed.length === 0) return;
  const snapMove = changed.every((el) => readWidgetPayload(el) !== null);
  // The widgets that stayed put: a moved card may line up with, or sit one gap beside, them.
  const moving = new Set(changed.map((el) => el.id));
  const neighbours = all.filter((el) => !el.isDeleted && !moving.has(el.id) && el.type === 'embeddable' && !el.angle && readWidgetPayload(el))
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
  const patches = new Map<string, ExcalidrawElement>();
  for (const el of changed) {
    const payload = readWidgetPayload(el);
    if (!payload || el.type !== 'embeddable' || el.angle) continue;
    const snap = snapAfterGesture(before.get(el.id)!, el, payload.size, { snapMove, neighbours });
    if (!snap) continue;
    const { size, ...box } = snap;
    patches.set(el.id, newElementWith(el, { ...box, customData: { ...(el.customData ?? {}), dc: { ...payload, size } } }));
  }
  if (patches.size === 0) return;
  const active = api.getAppState().activeEmbeddable;
  const activeNext = active ? patches.get(active.element.id) : undefined;
  api.updateScene({
    elements: all.map((el) => patches.get(el.id) ?? el),
    ...(active && activeNext
      ? { appState: { activeEmbeddable: { element: activeNext as NonDeleted<ExcalidrawEmbeddableElement>, state: active.state } } }
      : {}),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/**
 * One click to interact (A18): Excalidraw activates an embeddable only on a click in its centre
 * third, and that click never reaches the card, so ticking a todo took two clicks. Here a plain
 * click anywhere on an inactive widget (no drag, no resize handle, no modifier) activates it,
 * then the same click is handed to whatever sits under the pointer: a checkbox ticks, a button
 * fires, a field takes focus. The hand-off waits out Excalidraw's own centre-click activation
 * (a 100ms timer holding the element it hit), so a tick that replaces the element is not undone.
 */
const CLICK_FORWARD_DELAY_MS = 120;

/** The board's wheel latch: on the canvas wrapper while a pan runs (WhiteboardCanvas.css). A
 *  trackpad's momentum fires every ~16ms, so a gap this long means the gesture is over. */
export const WHEEL_LATCH_CLASS = 'wb-canvas-wrap--wheeling';
export const WHEEL_LATCH_MS = 250;

export function subscribeWidgetActivation(api: ExcalidrawImperativeAPI): (() => void)[] {
  let timer = 0;
  const off = api.onPointerUp((activeTool, pointerDownState, event) => {
    if (activeTool.type !== 'selection' || event.button !== 0) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (pointerDownState.drag.hasOccurred || pointerDownState.resize.handleType || pointerDownState.boxSelection.hasOccurred) return;
    const hitId = pointerDownState.hit.element?.id;
    if (!hitId) return;
    const el = api.getSceneElements().find((e) => e.id === hitId);
    if (!el || el.type !== 'embeddable' || el.angle || !readWidgetPayload(el)) return;
    const current = api.getAppState().activeEmbeddable;
    if (current?.element.id === el.id && current.state === 'active') return;
    api.updateScene({
      appState: {
        activeEmbeddable: { element: el as NonDeleted<ExcalidrawEmbeddableElement>, state: 'active' },
        selectedElementIds: { [el.id]: true },
      },
    });
    const { clientX, clientY } = event;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => forwardClick(clientX, clientY), CLICK_FORWARD_DELAY_MS);
  });
  return [off, () => window.clearTimeout(timer)];
}

/** Hands an activating click to the widget control under the pointer. A field takes focus;
 *  anything else inside a widget card gets a click (a label ticks its checkbox). */
export function forwardClick(clientX: number, clientY: number): void {
  const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!target || !target.closest('.wb-widget') || target.tagName === 'IFRAME') return;
  if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'radio')) {
    target.focus();
    return;
  }
  target.click();
}

/** The element whose hyperlink popup was clicked: the one selected element carrying that link
 *  (the popup anchor hands over only the href). */
export function linkOpenerId(api: ExcalidrawImperativeAPI | null, link: string | null | undefined): string | undefined {
  if (!api || !link) return undefined;
  const selected = api.getAppState().selectedElementIds;
  const hits = api.getSceneElements().filter((el) => selected[el.id] && el.link === link);
  return hits.length === 1 ? hits[0]!.id : undefined;
}

/** Where the size control goes: under the one selected, unrotated widget, and nowhere while a
 *  drag, resize or rotation is in progress. */
export function sizePickerFor(elements: readonly OrderedExcalidrawElement[], appState: AppState): SizePickerState | null {
  if (appState.selectedElementsAreBeingDragged || appState.isResizing || appState.isRotating) return null;
  const ids = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]);
  if (ids.length !== 1) return null;
  const el = elements.find((e) => e.id === ids[0]);
  if (!el || el.isDeleted || el.type !== 'embeddable' || el.angle) return null;
  const payload = readWidgetPayload(el);
  if (!payload) return null;
  const tl = sceneCoordsToViewportCoords({ sceneX: el.x, sceneY: el.y }, appState);
  const br = sceneCoordsToViewportCoords({ sceneX: el.x + el.width, sceneY: el.y + el.height }, appState);
  const at = placeSizePicker(
    {
      left: tl.x - appState.offsetLeft,
      top: tl.y - appState.offsetTop,
      right: br.x - appState.offsetLeft,
      bottom: br.y - appState.offsetTop,
    },
    { width: appState.width, height: appState.height },
    SIZE_PICKER_GAP,
  );
  const size = widgetSizeOf(payload.size, el.width, el.height);
  return { id: el.id, ...at, size, custom: !isPresetBox(el.width, el.height, size), color: isCardColor(payload.color) ? payload.color : null };
}

export function samePicker(a: SizePickerState | null, b: SizePickerState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.left === b.left && a.top === b.top && a.size === b.size && a.custom === b.custom && a.color === b.color;
}

/** Rewrite one widget, keeping an active widget active (Excalidraw compares it by reference). */
function patchWidget(
  api: ExcalidrawImperativeAPI,
  elementId: string,
  patch: (cur: OrderedExcalidrawElement, payload: WidgetPayload) => Partial<ExcalidrawElement>,
): void {
  const all = api.getSceneElementsIncludingDeleted();
  const cur = all.find((el) => el.id === elementId);
  const payload = readWidgetPayload(cur);
  if (!cur || cur.isDeleted || !payload) return;
  const next = newElementWith(cur, patch(cur, payload) as never);
  const active = api.getAppState().activeEmbeddable;
  api.updateScene({
    elements: all.map((el) => (el.id === elementId ? next : el)),
    ...(active?.element.id === elementId
      ? { appState: { activeEmbeddable: { element: next as never, state: active.state } } }
      : {}),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/** The size control (A17): S / M / L / XL on the selected widget. */
export function setWidgetSize(api: ExcalidrawImperativeAPI, elementId: string, size: WidgetSize): void {
  patchWidget(api, elementId, (cur, payload) => {
    const { size: _size, ...box } = resizeInPlace(cur, size);
    return { ...box, customData: { ...(cur.customData ?? {}), dc: { ...payload, size } } };
  });
}

/** A card's colour (owner, 2026-10-05): a tint on the card's own surface; null clears it. */
export function setWidgetColor(api: ExcalidrawImperativeAPI, elementId: string, color: CardColor | null): void {
  patchWidget(api, elementId, (cur, payload) => {
    const { color: _old, ...rest } = payload;
    return { customData: { ...(cur.customData ?? {}), dc: color ? { ...rest, color } : rest } };
  });
}
