import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CaptureUpdateAction, Excalidraw, getCommonBounds, getSceneVersion, newElementWith,
  reconcileElements, restoreElements,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
  ExcalidrawElement, ExcalidrawEmbeddableElement, NonDeleted, OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import { emitInstance, useVault } from '../../context/VaultContext';
import { AgentDialog } from '../agents/AgentDialog';
import { openExternalUrl } from '../../lib/desktop';
import { DEFAULT_WIDGET_SIZES, isCardColor, type CardColor, type WidgetPayload, type WidgetSize } from '../../lib/whiteboardWidgets';
import { handleLinkOpen, installHyperlinkGuard } from './linkRouting';
import { usePagePopup } from './PagePopup';
import { IMAGES_LATER_MESSAGE, reconcileRemoteScene, stripImageElements } from './sceneSync';
import { WidgetPalette } from './WidgetPalette';
import {
  WIDGET_STROKE, hasWidgetStroke, humaniseSlug, isWidgetLink, newElementId, readWidgetPayload, selectionIsOnlyWidgets,
  widgetLink,
} from './widgetModel';
import { placeNewWidget, widgetSizeOf } from './widgetSize';
import { WidgetSizePicker } from './WidgetSizePicker';
import {
  dropOnAgentCard, linkOpenerId, samePicker, setWidgetColor, setWidgetSize, sizePickerFor, subscribeWidgetActivation,
  subscribeWidgetSnapping, type AgentDropHandler, type SizePickerState,
} from './canvasGestures';
import { useCanvasPalette } from './useCanvasPalette';
import { useCanvasWrapEffects } from './useCanvasWrapEffects';
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
  /** The board this canvas shows: agent cards send it, and a drop's references name it. */
  boardSlug: string;
  initialScene: WhiteboardScene;
  onApi?: (api: WhiteboardCanvasApi | null) => void;
  /** Called when the scene's content changed (not on a mere selection or scroll), with every
   *  element including tombstones, images already removed. The page debounces its save. */
  onSceneChange?: (elements: readonly OrderedExcalidrawElement[]) => void;
  /** A clicked `dreamcontext://<kind>/<id>` element link. Default: a task or knowledge page opens
   *  in the board page's page popup when there is one, else on its own page in the app. */
  onInternalLink?: (kind: string, id: string) => void;
}


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
export default function WhiteboardCanvas({ boardSlug, initialScene, onApi, onSceneChange, onInternalLink }: WhiteboardCanvasProps) {
  const tx = useWbText();
  const theme = useDataTheme();
  const { bus, vault } = useVault();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lastVersion = useRef<number>(-1);
  const [sizePicker, setSizePicker] = useState<SizePickerState | null>(null);
  /** The selection is only widgets: Excalidraw's properties panel and link popup are hidden. */
  const [widgetsOnly, setWidgetsOnly] = useState(false);
  const strokeFixPending = useRef(false);
  /** "New agent" from the palette: where its card goes once the create lands. */
  const [newAgentAt, setNewAgentAt] = useState<{ x: number; y: number } | null>(null);

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

  // The panel keeps the card that opened it in view (PagePopup.tsx): it reads and pans this
  // board's viewport, never its zoom.
  useEffect(() => {
    if (!pagePopup) return;
    return pagePopup.attachBoard({
      viewport: () => {
        const s = apiRef.current?.getAppState();
        return s ? { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value } : null;
      },
      setScroll: ({ scrollX, scrollY }) => apiRef.current?.updateScene({ appState: { scrollX, scrollY } }),
      canvasSize: () => {
        const r = wrapRef.current?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
      },
      elementBox: (id) => {
        const el = apiRef.current?.getSceneElements().find((e) => e.id === id);
        if (!el) return null;
        const [x1, y1, x2, y2] = getCommonBounds([el]);
        return { x1, y1, x2, y2 };
      },
    });
  }, [pagePopup]);

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
    boardSlug,
  }), [toast, boardSlug]);

  // ── drag-to-ask: an element dropped on an agent card goes back and becomes a chip there ──
  const boardSlugRef = useRef(boardSlug);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  boardSlugRef.current = boardSlug;
  const agentDrop = useCallback<AgentDropHandler>((api, drag) => {
    const vaultNow = vaultRef.current;
    return !!vaultNow && dropOnAgentCard(api, drag, { vault: vaultNow, board: boardSlugRef.current, tx: txRef.current });
  }, []);
  const agentDropRef = useRef(agentDrop);
  agentDropRef.current = agentDrop;

  // ── the page's handle ─────────────────────────────────────────────────────────────────────
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  const unsubscribers = useRef<(() => void)[]>([]);
  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    unsubscribers.current.forEach((off) => off());
    unsubscribers.current = [
      ...subscribeWidgetSnapping(api, (a, drag) => agentDropRef.current(a, drag)),
      ...subscribeWidgetActivation(api),
    ];
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

  // ── the size control (A17) and a card's colour: canvasGestures.ts ──────────────────────────
  const setSize = useCallback((elementId: string, size: WidgetSize) => {
    if (apiRef.current) setWidgetSize(apiRef.current, elementId, size);
  }, []);
  const setColor = useCallback((elementId: string, color: CardColor | null) => {
    if (apiRef.current) setWidgetColor(apiRef.current, elementId, color);
  }, []);

  // ── right-click: empty canvas → our palette, an element → Excalidraw's menu (D8) ──────────
  const { palette, setPalette, openCanvasMenu, openPaletteFromButton } = useCanvasPalette(wrapRef, apiRef);

  useCanvasWrapEffects(wrapRef, apiRef);

  // ── element links (D3): preventDefault first, then route ──────────────────────────────────
  const onLinkOpen = useCallback((element: { id?: string; link?: string | null }, event: { preventDefault(): void }) => {
    handleLinkOpen(element, event, {
      ownOrigin: window.location.origin,
      openExternal: (url) => { void openExternalUrl(url); },
      openInternal: (kind, id) => {
        if (onInternalLinkRef.current) { onInternalLinkRef.current(kind, id); return; }
        if (kind === 'task' || kind === 'knowledge') {
          // Read over the board in the popup; the board itself stays put.
          if (pagePopupRef.current?.openPage({ kind, ref: id }, element.id ?? linkOpenerId(apiRef.current, element.link))) return;
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
    const widget = <Widget key={`${payload.kind}:${payload.ref ?? ''}:${payload.url ?? ''}`} elementId={element.id} payload={payload} active={active} size={size} height={element.height} />;
    // The wrapper takes no box (`display: contents`); it carries the card's colour, which the
    // card's own CSS mixes into its surface (widgets.css). Always there, so a colour change
    // never remounts the widget (an agent card would lose its session).
    return <div className="wb-widget-tint" data-card-color={isCardColor(payload.color) ? payload.color : undefined}>{widget}</div>;
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
            key={sizePicker.id}
            left={sizePicker.left}
            top={sizePicker.top}
            size={sizePicker.size}
            custom={sizePicker.custom}
            color={sizePicker.color}
            onPick={(size) => setSize(sizePicker.id, size)}
            onColor={(color) => setColor(sizePicker.id, color)}
          />
        )}
        {palette && (
          <WidgetPalette
            left={palette.left}
            top={palette.top}
            onClose={() => setPalette(null)}
            onPick={(payload) => addWidget(payload, palette.scene)}
            onCanvasMenu={palette.origin ? openCanvasMenu : undefined}
            onNewAgent={() => { setNewAgentAt(palette.scene); setPalette(null); }}
          />
        )}
        {newAgentAt && createPortal(
          <AgentDialog
            agent={null}
            initial={{ title: '', description: '', mode: 'call', whiteboard: boardSlug }}
            onClose={() => setNewAgentAt(null)}
            onToast={toast}
            onCreated={(slug) => addWidget({ v: 1, kind: 'agent', ref: slug, title: humaniseSlug(slug) }, newAgentAt)}
          />,
          document.body,
        )}
      </div>
    </WhiteboardHostContext.Provider>
  );
}
