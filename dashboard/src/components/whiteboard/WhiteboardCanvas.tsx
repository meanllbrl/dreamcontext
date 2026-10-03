import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CaptureUpdateAction, Excalidraw, getCommonBounds, getSceneVersion, newElementWith,
  reconcileElements, restoreElements, sceneCoordsToViewportCoords, viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
  ExcalidrawElement, ExcalidrawEmbeddableElement, NonDeleted, OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import { emitInstance, useVault } from '../../context/VaultContext';
import { openExternalUrl } from '../../lib/desktop';
import { registerPinchTarget } from '../../lib/excalidrawPinch';
import { DEFAULT_WIDGET_SIZES, type WidgetPayload, type WidgetSize } from '../../lib/whiteboardWidgets';
import { handleLinkOpen, installHyperlinkGuard } from './linkRouting';
import { usePagePopup } from './PagePopup';
import { IMAGES_LATER_MESSAGE, reconcileRemoteScene, stripImageElements } from './sceneSync';
import { WidgetPalette } from './WidgetPalette';
import {
  WIDGET_STROKE, hasWidgetStroke, isWidgetLink, newElementId, readWidgetPayload, selectionIsOnlyWidgets, widgetLink,
} from './widgetModel';
import {
  isPresetBox, placeNewWidget, placeSizePicker, resizeInPlace, snapAfterGesture, widgetSizeOf, type WidgetGeometry,
} from './widgetSize';
import { WidgetSizePicker } from './WidgetSizePicker';
import { WhiteboardHostContext, useDataTheme, useWbText, type WhiteboardHost } from './whiteboardHost';
import { WIDGET_REGISTRY } from './widgets/registry';
import { WidgetFrame, WidgetNotice } from './widgets/WidgetFrame';
import './WhiteboardCanvas.css';

/** The scene the page hands in once, at mount. The page remounts (via `key`) for another board. */
export interface WhiteboardScene {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
}

/**
 * What the page gets to drive the canvas with (D5). Everything it needs to reconcile lives
 * here, so the page never imports the heavy Excalidraw bundle itself.
 */
export interface WhiteboardCanvasApi {
  excalidraw: ExcalidrawImperativeAPI;
  /** Fold a polled (or PUT-merged) remote element list into the live scene: images out, then
   *  `restoreElements(remote, null)` + `reconcileElements`, applied with `CaptureUpdateAction.NEVER`.
   *  Does NOT fire `onSceneChange`: nothing the user did changed. */
  applyRemoteElements: (remote: readonly unknown[]) => void;
  /** Every element, tombstones included: the list a save sends. */
  getElements: () => readonly OrderedExcalidrawElement[];
  getSceneVersion: () => number;
}

export interface WhiteboardCanvasProps {
  initialScene: WhiteboardScene;
  onApi?: (api: WhiteboardCanvasApi | null) => void;
  /** Called when the scene's content changed (not on a mere selection or scroll), with every
   *  element including tombstones, images already removed. The page debounces its save. */
  onSceneChange?: (elements: readonly OrderedExcalidrawElement[]) => void;
  /** A clicked `dreamcontext://<kind>/<id>` element link. Default: a task or knowledge page opens
   *  in the board page's page popup when there is one, else on its own page in the app. */
  onInternalLink?: (kind: string, id: string) => void;
}

interface PaletteState {
  left: number;
  top: number;
  scene: { x: number; y: number };
  /** The right-click that opened it, so "Canvas menu" can hand it back to Excalidraw. */
  origin?: { target: EventTarget; clientX: number; clientY: number };
}

/** The selected widget's size control, in the canvas wrapper's pixel space. */
interface SizePickerState {
  id: string;
  left: number;
  top: number;
  size: WidgetSize;
  /** The box was dragged to a free-form size: no preset is current, and every one applies. */
  custom: boolean;
}

/** An element's box and version at pointer-down: what a gesture is measured against. */
type GestureSnapshot = Map<string, WidgetGeometry & { version: number }>;

const UI_OPTIONS = {
  tools: { image: false },
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
} as const;

const PALETTE_W = 280;
/** Gap between a selected widget's bottom edge and its size control, in screen px. */
const SIZE_PICKER_GAP = 10;
const PALETTE_H = 380;
const HIT_SLOP_PX = 4;

/**
 * The editable whiteboard (D9). A separate component from the read-only viewer
 * (`core/ExcalidrawCanvas.tsx`), whose view-mode guards stay untouched.
 *
 * Widgets are `embeddable` elements with a `dreamcontext://` link (D3): `validateEmbeddable`
 * accepts only that scheme, so Excalidraw's own iframe embed never runs, and `renderEmbeddable`
 * always returns our component (a null would let Excalidraw fall back to its own iframe).
 *
 * Lazy-loaded through `LazyWhiteboardCanvas`, which points Excalidraw at the self-hosted fonts
 * before this module (and the Excalidraw bundle) is imported.
 */
export default function WhiteboardCanvas({ initialScene, onApi, onSceneChange, onInternalLink }: WhiteboardCanvasProps) {
  const tx = useWbText();
  const theme = useDataTheme();
  const { bus } = useVault();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lastVersion = useRef<number>(-1);
  const passThrough = useRef(false);
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [sizePicker, setSizePicker] = useState<SizePickerState | null>(null);
  /** The selection is only widgets: Excalidraw's properties panel and link popup are hidden. */
  const [widgetsOnly, setWidgetsOnly] = useState(false);
  const strokeFixPending = useRef(false);

  const onSceneChangeRef = useRef(onSceneChange);
  onSceneChangeRef.current = onSceneChange;
  const onInternalLinkRef = useRef(onInternalLink);
  onInternalLinkRef.current = onInternalLink;
  // The board page's page popup (PagePopup.tsx), when this canvas sits under one.
  const pagePopup = usePagePopup();
  const pagePopupRef = useRef(pagePopup);
  pagePopupRef.current = pagePopup;
  const txRef = useRef(tx);
  txRef.current = tx;

  const toast = useCallback((message: string) => {
    apiRef.current?.setToast({ message, closable: true, duration: 4000 });
  }, []);

  // Read once: the page remounts for another board. Images are refused here too (D10), since a
  // hand-made board can carry one and every save of it would then be rejected.
  const [initial] = useState(() => {
    const stripped = stripImageElements(initialScene.elements as readonly ExcalidrawElement[]);
    return {
      imagesRemoved: stripped.visible,
      data: {
        elements: stripped.elements,
        appState: {
          viewBackgroundColor: typeof initialScene.appState?.viewBackgroundColor === 'string'
            ? initialScene.appState.viewBackgroundColor
            : 'transparent',
        },
        scrollToContent: true,
      },
    };
  });

  // ── the widget host: how a widget writes its own payload ──────────────────────────────────
  const host = useMemo<WhiteboardHost>(() => ({
    toast,
    commitWidget: (elementId, update) => {
      const api = apiRef.current;
      if (!api) return;
      const all = api.getSceneElementsIncludingDeleted();
      const cur = all.find((el) => el.id === elementId);
      const payload = readWidgetPayload(cur);
      if (!cur || cur.isDeleted || !payload) return;
      const next = newElementWith(cur, {
        customData: { ...(cur.customData ?? {}), dc: update(payload) },
      });
      // ONE call: the new element AND it staying the active embeddable. Excalidraw compares
      // `activeEmbeddable.element` by reference, so without this the second tick needs a
      // second activating click.
      api.updateScene({
        elements: all.map((el) => (el.id === elementId ? next : el)),
        appState: { activeEmbeddable: { element: next, state: 'active' } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
  }), [toast]);

  // ── the page's handle ─────────────────────────────────────────────────────────────────────
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  const unsubscribers = useRef<(() => void)[]>([]);
  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    unsubscribers.current.forEach((off) => off());
    unsubscribers.current = [...subscribeWidgetSnapping(api), ...subscribeWidgetActivation(api)];
    onApiRef.current?.({
      excalidraw: api,
      applyRemoteElements: (remote) => {
        const stripped = stripImageElements(remote as readonly ExcalidrawElement[]);
        const reconciled = reconcileRemoteScene(
          {
            restoreElements: (els, local) => restoreElements(els as readonly ExcalidrawElement[], local),
            reconcileElements: (local, rem, appState: AppState) =>
              reconcileElements(local, rem as readonly RemoteExcalidrawElement[], appState),
          },
          api.getSceneElementsIncludingDeleted(),
          stripped.elements,
          api.getAppState(),
        );
        lastVersion.current = getSceneVersion(reconciled);
        api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
      },
      getElements: () => api.getSceneElementsIncludingDeleted(),
      getSceneVersion: () => getSceneVersion(api.getSceneElementsIncludingDeleted()),
    });
  }, []);
  useEffect(() => () => {
    unsubscribers.current.forEach((off) => off());
    unsubscribers.current = [];
    onApiRef.current?.(null);
  }, []);

  useEffect(() => {
    if (!initial.imagesRemoved) return;
    const timer = window.setTimeout(() => toast(txRef.current('whiteboard.images.later', IMAGES_LATER_MESSAGE)), 300);
    return () => window.clearTimeout(timer);
  }, [initial.imagesRemoved, toast]);

  // ── saves: content changes only, images refused first (D10) ───────────────────────────────
  const handleChange = useCallback((elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
    // Before the version check: selection, scroll and zoom move the control without a content change.
    const nextPicker = sizePickerFor(elements, appState);
    setSizePicker((prev) => (samePicker(prev, nextPicker) ? prev : nextPicker));
    // With the select tool only: another tool's properties are for what it is about to draw.
    setWidgetsOnly(appState.activeTool.type === 'selection' && selectionIsOnlyWidgets(elements, appState.selectedElementIds));

    // A widget with a visible stroke (Phase-1, CLI-made, or given a colour) draws a second frame
    // around its card; normalise it once. Also before the version check: a poll's remote copy
    // arrives through `applyRemoteElements`, which has already recorded its version.
    if (elements.some(hasWidgetStroke)) {
      if (!strokeFixPending.current) {
        strokeFixPending.current = true;
        // Never inside Excalidraw's own onChange: the follow-up update reports the clean scene,
        // and that one saves.
        queueMicrotask(() => {
          strokeFixPending.current = false;
          const api = apiRef.current;
          if (!api) return;
          api.updateScene({
            elements: api.getSceneElementsIncludingDeleted().map((el) => (
              hasWidgetStroke(el) ? newElementWith(el, { strokeColor: WIDGET_STROKE }) : el
            )),
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        });
      }
      return;
    }

    const version = getSceneVersion(elements);
    if (version === lastVersion.current) return;
    const stripped = stripImageElements(elements);
    if (stripped.removed) {
      // Never inside Excalidraw's own onChange: the follow-up update reports the clean scene.
      queueMicrotask(() => {
        apiRef.current?.updateScene({ elements: stripped.elements, captureUpdate: CaptureUpdateAction.NEVER });
      });
      if (stripped.visible) toast(txRef.current('whiteboard.images.later', IMAGES_LATER_MESSAGE));
      return;
    }
    lastVersion.current = version;
    // Also fires once as the mounted scene first settles. A save of an unchanged scene is a
    // byte-level no-op on the server, and one that `restoreElements` repaired is worth saving.
    onSceneChangeRef.current?.(elements);
  }, [toast]);

  // ── adding a widget ───────────────────────────────────────────────────────────────────────
  const addWidget = useCallback((payload: WidgetPayload, at: { x: number; y: number }) => {
    const api = apiRef.current;
    if (!api) return;
    const id = newElementId();
    const size = payload.size ?? DEFAULT_WIDGET_SIZES[payload.kind];
    const box = placeNewWidget(at, size);
    // `convertToExcalidrawElements` passes an embeddable skeleton through untouched (it needs a
    // complete element), so `restoreElements` is what fills the schema defaults here.
    const [el] = restoreElements([{
      type: 'embeddable',
      id,
      ...box,
      strokeColor: WIDGET_STROKE,
      backgroundColor: 'transparent',
      strokeWidth: 1,
      roughness: 0,
      roundness: null,
      seed: Math.floor(Math.random() * 2 ** 31),
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      link: widgetLink(payload.kind, payload.ref ?? id),
      customData: { dc: { ...payload, size } },
    } as unknown as ExcalidrawElement], null);
    if (!el) return;
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), el],
      appState: { selectedElementIds: { [el.id]: true } } as Pick<AppState, 'selectedElementIds'>,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setPalette(null);
  }, []);

  // ── the size control (A17): S / M / L / XL on the selected widget ─────────────────────────
  const setWidgetSize = useCallback((elementId: string, size: WidgetSize) => {
    const api = apiRef.current;
    if (!api) return;
    const all = api.getSceneElementsIncludingDeleted();
    const cur = all.find((el) => el.id === elementId);
    const payload = readWidgetPayload(cur);
    if (!cur || cur.isDeleted || !payload) return;
    const { size: _size, ...box } = resizeInPlace(cur, size);
    const next = newElementWith(cur, { ...box, customData: { ...(cur.customData ?? {}), dc: { ...payload, size } } });
    const active = api.getAppState().activeEmbeddable;
    api.updateScene({
      elements: all.map((el) => (el.id === elementId ? next : el)),
      // An active widget stays active (Excalidraw compares the element by reference).
      ...(active?.element.id === elementId
        ? { appState: { activeEmbeddable: { element: next, state: active.state } } }
        : {}),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  // ── right-click: empty canvas → our palette, an element → Excalidraw's menu (D8) ──────────
  const sceneAt = useCallback((clientX: number, clientY: number) => {
    const api = apiRef.current;
    if (!api) return null;
    return viewportCoordsToSceneCoords({ clientX, clientY }, api.getAppState());
  }, []);

  const hitsElement = useCallback((clientX: number, clientY: number) => {
    const api = apiRef.current;
    const p = sceneAt(clientX, clientY);
    if (!api || !p) return true; // unsure: leave it to Excalidraw
    const slop = HIT_SLOP_PX / api.getAppState().zoom.value;
    return api.getSceneElements().some((el) => {
      const [x1, y1, x2, y2] = getCommonBounds([el]);
      return p.x >= x1 - slop && p.x <= x2 + slop && p.y >= y1 - slop && p.y <= y2 + slop;
    });
  }, [sceneAt]);

  const placePalette = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { left: 0, top: 0 };
    return {
      left: Math.max(0, Math.min(clientX - rect.left, rect.width - PALETTE_W)),
      top: Math.max(0, Math.min(clientY - rect.top, rect.height - PALETTE_H)),
    };
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onContextMenu = (e: MouseEvent) => {
      if (passThrough.current) { passThrough.current = false; return; }
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== 'CANVAS') return; // toolbars, menus, widgets: untouched
      if (hitsElement(e.clientX, e.clientY)) return; // Excalidraw's element menu
      const scene = sceneAt(e.clientX, e.clientY);
      if (!scene) return;
      e.preventDefault();
      e.stopPropagation();
      setPalette({
        ...placePalette(e.clientX, e.clientY),
        scene,
        origin: { target, clientX: e.clientX, clientY: e.clientY },
      });
    };
    wrap.addEventListener('contextmenu', onContextMenu, true);
    return () => wrap.removeEventListener('contextmenu', onContextMenu, true);
  }, [hitsElement, sceneAt, placePalette]);

  const openCanvasMenu = useCallback(() => {
    const origin = palette?.origin;
    setPalette(null);
    if (!origin) return;
    passThrough.current = true;
    origin.target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: origin.clientX, clientY: origin.clientY, view: window,
    }));
    passThrough.current = false;
  }, [palette]);

  const openPaletteFromButton = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const scene = sceneAt(cx, cy);
    if (!scene) return;
    setPalette({ left: Math.max(0, rect.width - PALETTE_W - 16), top: 56, scene });
  }, [sceneAt]);

  // ── "Click to interact" (A18): Excalidraw sets the hover state from the canvas's own
  // pointermove and clears it only on the next one, so a pointer that leaves a widget straight
  // off the canvas (onto the sidebar, a toolbar, the size control) left the hint up. Any move
  // over something that is not the canvas, or out of the wrapper, clears it here.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const clearHover = () => {
      const api = apiRef.current;
      if (api?.getAppState().activeEmbeddable?.state !== 'hover') return;
      api.updateScene({ appState: { activeEmbeddable: null } });
    };
    const onMove = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') clearHover();
    };
    wrap.addEventListener('pointerleave', clearHover);
    wrap.addEventListener('pointermove', onMove, true);
    return () => {
      wrap.removeEventListener('pointerleave', clearHover);
      wrap.removeEventListener('pointermove', onMove, true);
    };
  }, []);

  // ── pinch scoped to this board (see lib/excalidrawPinch.ts) ───────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    return registerPinchTarget({
      el,
      getViewport: () => apiRef.current?.getAppState() ?? null,
      setViewport: (patch) => apiRef.current?.updateScene({
        appState: patch as unknown as Pick<AppState, 'scrollX' | 'scrollY' | 'zoom'>,
      }),
    });
  }, []);

  // ── element links (D3): preventDefault first, then route ──────────────────────────────────
  const onLinkOpen = useCallback((element: { link?: string | null }, event: { preventDefault(): void }) => {
    handleLinkOpen(element, event, {
      ownOrigin: window.location.origin,
      openExternal: (url) => { void openExternalUrl(url); },
      openInternal: (kind, id) => {
        if (onInternalLinkRef.current) { onInternalLinkRef.current(kind, id); return; }
        if (kind === 'task' || kind === 'knowledge') {
          // Read over the board in the popup; the board itself stays put.
          if (pagePopupRef.current?.openPage({ kind, ref: id })) return;
          emitInstance(bus, 'dreamcontext-agent-open-page', { page: kind === 'task' ? 'tasks' : 'knowledge', id });
        }
      },
      toast,
      droppedMessage: txRef.current('whiteboard.link.dropped', 'This link cannot be opened from a whiteboard.'),
    });
  }, [bus, toast]);

  // The popup anchor's click, taken on `window` before the app-global external-link handler
  // on `document` can open it (see installHyperlinkGuard). Routed through the same onLinkOpen.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    return installHyperlinkGuard(window, wrap, (href, event) => onLinkOpen({ link: href }, event));
  }, [onLinkOpen]);

  // ── widgets ───────────────────────────────────────────────────────────────────────────────
  const renderEmbeddable = useCallback((element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) => {
    const active = appState.activeEmbeddable?.element === element && appState.activeEmbeddable.state === 'active';
    const payload = readWidgetPayload(element);
    // Never null: a null hands the element to Excalidraw's own iframe.
    if (!payload) {
      return (
        <WidgetFrame kind="unknown" title={txRef.current('whiteboard.widget.unknown', 'Unknown widget')} active={active}>
          <WidgetNotice tone="missing">{txRef.current('whiteboard.widget.unknownBody', 'This widget has no readable content.')}</WidgetNotice>
        </WidgetFrame>
      );
    }
    const Widget = WIDGET_REGISTRY[payload.kind];
    const size = widgetSizeOf(payload.size, element.width, element.height);
    // Keyed by what makes a widget a different thing, so e.g. a web widget whose URL changed
    // under it does not keep the previous URL's "loaded" state.
    return <Widget key={`${payload.kind}:${payload.ref ?? ''}:${payload.url ?? ''}`} elementId={element.id} payload={payload} active={active} size={size} height={element.height} />;
  }, []);

  const renderTopRightUI = useCallback(() => (
    <button type="button" className="wb-add-btn" onClick={openPaletteFromButton}>
      + {txRef.current('whiteboard.add', 'Add')}
    </button>
  ), [openPaletteFromButton]);

  return (
    <WhiteboardHostContext.Provider value={host}>
      <div ref={wrapRef} className={widgetsOnly ? 'wb-canvas-wrap wb-canvas-wrap--widgets-selected' : 'wb-canvas-wrap'}>
        <Excalidraw
          excalidrawAPI={handleApi}
          initialData={initial.data as never}
          theme={theme}
          onChange={handleChange}
          onLinkOpen={onLinkOpen}
          validateEmbeddable={isWidgetLink}
          renderEmbeddable={renderEmbeddable}
          renderTopRightUI={renderTopRightUI}
          UIOptions={UI_OPTIONS}
        />
        {sizePicker && (
          <WidgetSizePicker
            left={sizePicker.left}
            top={sizePicker.top}
            size={sizePicker.size}
            custom={sizePicker.custom}
            onPick={(size) => setWidgetSize(sizePicker.id, size)}
          />
        )}
        {palette && (
          <WidgetPalette
            left={palette.left}
            top={palette.top}
            onClose={() => setPalette(null)}
            onPick={(payload) => addWidget(payload, palette.scene)}
            onCanvasMenu={palette.origin ? openCanvasMenu : undefined}
          />
        )}
      </div>
    </WhiteboardHostContext.Provider>
  );
}

/**
 * Grid snapping (A17), once per gesture: a snapshot of every element's box at pointer-down,
 * compared at pointer-up (a frame later, once Excalidraw has committed the gesture). Only
 * widgets the gesture moved or resized snap; free drawing is never touched, and a move that
 * also carried free drawing does not snap (it would tear the widget from what moved with it).
 * `snapAfterGesture` answers null for a widget already in place, so the snap never re-triggers.
 */
function subscribeWidgetSnapping(api: ExcalidrawImperativeAPI): (() => void)[] {
  let before: GestureSnapshot | null = null;
  let frame = 0;
  const offDown = api.onPointerDown(() => {
    before = new Map();
    for (const el of api.getSceneElements()) {
      before.set(el.id, { x: el.x, y: el.y, width: el.width, height: el.height, version: el.version });
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

function snapWidgets(api: ExcalidrawImperativeAPI, before: GestureSnapshot): void {
  const all = api.getSceneElementsIncludingDeleted();
  const changed = all.filter((el) => !el.isDeleted && before.get(el.id) && before.get(el.id)!.version !== el.version);
  if (changed.length === 0) return;
  const snapMove = changed.every((el) => readWidgetPayload(el) !== null);
  const patches = new Map<string, ExcalidrawElement>();
  for (const el of changed) {
    const payload = readWidgetPayload(el);
    if (!payload || el.type !== 'embeddable' || el.angle) continue;
    const snap = snapAfterGesture(before.get(el.id)!, el, payload.size, { snapMove });
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

function subscribeWidgetActivation(api: ExcalidrawImperativeAPI): (() => void)[] {
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
function forwardClick(clientX: number, clientY: number): void {
  const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!target || !target.closest('.wb-widget') || target.tagName === 'IFRAME') return;
  if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'radio')) {
    target.focus();
    return;
  }
  target.click();
}

/** Where the size control goes: under the one selected, unrotated widget, and nowhere while a
 *  drag, resize or rotation is in progress. */
function sizePickerFor(elements: readonly OrderedExcalidrawElement[], appState: AppState): SizePickerState | null {
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
  return { id: el.id, ...at, size, custom: !isPresetBox(el.width, el.height, size) };
}

function samePicker(a: SizePickerState | null, b: SizePickerState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.left === b.left && a.top === b.top && a.size === b.size && a.custom === b.custom;
}
