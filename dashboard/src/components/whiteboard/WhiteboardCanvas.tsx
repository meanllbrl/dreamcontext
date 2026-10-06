import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CaptureUpdateAction, Excalidraw, getCommonBounds, getSceneVersion, newElementWith,
  reconcileElements, restoreElements,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { AppState, BinaryFileData, DataURL, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
  ExcalidrawElement, ExcalidrawEmbeddableElement, FileId, NonDeleted, OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import { emitInstance, useVault } from '../../context/VaultContext';
import { useAutomations } from '../../hooks/useAutomations';
import { AgentDialog } from '../agents/AgentDialog';
import { openExternalUrl } from '../../lib/desktop';
import { DEFAULT_WIDGET_BOXES, DEFAULT_WIDGET_SIZES, isCardColor, nearestWidgetSize, type CardColor, type WidgetPayload, type WidgetSize } from '../../lib/whiteboardWidgets';
import { handleLinkOpen, installHyperlinkGuard } from './linkRouting';
import { usePagePopup } from './PagePopup';
import { reconcileRemoteScene } from './sceneSync';
import { isPictureOf, type BoardPictures } from './boardPictures';
import { WidgetPalette } from './WidgetPalette';
import {
  WIDGET_STROKE, hasWidgetStroke, humaniseSlug, isWidgetLink, newElementId, readWidgetPayload, selectionIsOnlyWidgets,
  widgetLink,
} from './widgetModel';
import { placeNewWidget, widgetSizeOf } from './widgetSize';
import { WidgetSizePicker } from './WidgetSizePicker';
import {
  dropOnAgentCard, hoverTargetOf, linkOpenerId, samePicker, setWidgetColor, setWidgetSize, sizePickerFor, subscribeWidgetActivation,
  subscribeWidgetSnapping, type AgentDropHandler, type AgentHoverHandler, type DropContext, type SizePickerState,
} from './canvasGestures';
import { agentCardsOf, panelAgentSlug, registerCardLocator, setBoardCards, setDropTarget } from './agentPanelState';
import { boardAfterWheel } from './htmlWidgetFrame';
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
  /** Fold a polled (or PUT-merged) remote element list into the live scene:
   *  `restoreElements(remote, null)` + `reconcileElements`, applied with `CaptureUpdateAction.NEVER`.
   *  Does NOT fire `onSceneChange`: nothing the user did changed. */
  applyRemoteElements: (remote: readonly unknown[]) => void;
  /** Take pictures the board refused for good off the scene, and say why. */
  dropPictures: (fileIds: readonly string[], reason: string) => void;
  /** Every element, tombstones included: the list a save sends. */
  getElements: () => readonly OrderedExcalidrawElement[];
  getSceneVersion: () => number;
}

export interface WhiteboardCanvasProps {
  /** The board this canvas shows: agent cards send it, and a drop's references name it. */
  boardSlug: string;
  initialScene: WhiteboardScene;
  onApi?: (api: WhiteboardCanvasApi | null) => void;
  /** The board's pictures: the canvas fetches the ones it lacks (boardPictures.ts). */
  pictures?: BoardPictures;
  /** Called when the scene's content changed (not on a mere selection or scroll), with every
   *  element including tombstones. The page debounces its save. */
  onSceneChange?: (elements: readonly OrderedExcalidrawElement[]) => void;
  /** A clicked `dreamcontext://<kind>/<id>` element link. Default: a task or knowledge page opens
   *  in the board page's page popup when there is one, else on its own page in the app. */
  onInternalLink?: (kind: string, id: string) => void;
}


const UI_OPTIONS = {
  tools: { image: true },
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
export default function WhiteboardCanvas({ boardSlug, initialScene, onApi, pictures, onSceneChange, onInternalLink }: WhiteboardCanvasProps) {
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
  const picturesRef = useRef(pictures);
  picturesRef.current = pictures;
  /** Fetch the pictures in `elements` this canvas does not hold yet, and show them as they land. */
  const loadPictures = useCallback((elements: readonly unknown[]) => {
    const api = apiRef.current;
    const store = picturesRef.current;
    if (!api || !store) return;
    const held = api.getFiles();
    store.load(elements, (id) => !!held[id], (file) => {
      const data: BinaryFileData = {
        id: file.id as FileId,
        mimeType: file.mimeType as BinaryFileData['mimeType'],
        dataURL: file.dataURL as DataURL,
        created: Date.now(),
      };
      apiRef.current?.addFiles([data]);
    });
  }, []);

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

  // Read once: the page remounts for another board. Its pictures' bytes come separately.
  const [initial] = useState(() => {
    return {
      data: {
        elements: initialScene.elements as readonly ExcalidrawElement[],
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
    wheelBoard: (wheel, anchor) => {
      const api = apiRef.current;
      if (!api) return;
      const st = api.getAppState();
      const next = boardAfterWheel(
        { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value, offsetLeft: st.offsetLeft, offsetTop: st.offsetTop },
        wheel,
        anchor,
      );
      api.updateScene({ appState: { scrollX: next.scrollX, scrollY: next.scrollY, zoom: { value: next.zoom as never } } });
    },
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

  // ── drag-to-ask: an element dropped on an agent card (or the agent panel) goes back and
  // becomes a chip in that agent's composer, the panel's ─────────────────────────────────────
  const boardSlugRef = useRef(boardSlug);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  boardSlugRef.current = boardSlug;
  const { data: automations } = useAutomations();
  const automationsRef = useRef(automations);
  automationsRef.current = automations;
  const dropContext = useCallback((): DropContext | null => {
    const vaultNow = vaultRef.current;
    const board = boardSlugRef.current;
    if (!vaultNow || !board) return null;
    return {
      vault: vaultNow,
      board,
      tx: txRef.current,
      agentOf: (slug) => {
        const a = automationsRef.current?.find((x) => x.slug === slug);
        return a ? { title: a.title, approved: a.approved } : null;
      },
      panelAgent: () => panelAgentSlug(vaultNow, board, automationsRef.current),
      toast,
    };
  }, [toast]);
  const agentDrop = useCallback<AgentDropHandler>((api, drag) => {
    const ctx = dropContext();
    return !!ctx && dropOnAgentCard(api, drag, ctx);
  }, [dropContext]);
  const agentHover = useCallback<AgentHoverHandler>((api, drag) => {
    const ctx = dropContext();
    if (!ctx) return;
    setDropTarget(ctx.vault, ctx.board, drag ? hoverTargetOf(api, drag, ctx) : null);
  }, [dropContext]);
  const agentDropRef = useRef(agentDrop);
  agentDropRef.current = agentDrop;
  const agentHoverRef = useRef(agentHover);
  agentHoverRef.current = agentHover;

  // The panel's Find its card: bring the card into view (zoom kept unless it would not fit).
  useEffect(() => registerCardLocator(vault, boardSlug, (elementId) => {
    const api = apiRef.current;
    const el = api?.getSceneElements().find((e) => e.id === elementId);
    if (!api || !el) return;
    const st = api.getAppState();
    const fits = el.width * st.zoom.value <= st.width * 0.9 && el.height * st.zoom.value <= st.height * 0.9;
    api.scrollToContent(el, { fitToViewport: !fits, viewportZoomFactor: 0.8, animate: true, duration: 350 });
  }), [vault, boardSlug]);

  // ── the page's handle ─────────────────────────────────────────────────────────────────────
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  const unsubscribers = useRef<(() => void)[]>([]);
  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    unsubscribers.current.forEach((off) => off());
    unsubscribers.current = [
      ...subscribeWidgetSnapping(api, (a, drag) => agentDropRef.current(a, drag), (a, drag) => agentHoverRef.current(a, drag)),
      ...subscribeWidgetActivation(api),
    ];
    onApiRef.current?.({
      excalidraw: api,
      applyRemoteElements: (remote) => {
        const reconciled = reconcileRemoteScene(
          {
            restoreElements: (els, local) => restoreElements(els as readonly ExcalidrawElement[], local),
            reconcileElements: (local, rem, appState: AppState) =>
              reconcileElements(local, rem as readonly RemoteExcalidrawElement[], appState),
          },
          api.getSceneElementsIncludingDeleted(),
          remote,
          api.getAppState(),
        );
        lastVersion.current = getSceneVersion(reconciled);
        api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
        loadPictures(reconciled);
      },
      dropPictures: (fileIds, reason) => {
        const ids = new Set(fileIds);
        // Never saved (its bytes never landed), so it leaves outright, not as a tombstone.
        api.updateScene({
          elements: api.getSceneElementsIncludingDeleted().filter((el) => !isPictureOf(el, ids)),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        const said = txRef.current('whiteboard.pictures.refused', 'This picture could not be kept on the board');
        toast(reason ? `${said}: ${reason}` : said);
      },
      getElements: () => api.getSceneElementsIncludingDeleted(),
      getSceneVersion: () => getSceneVersion(api.getSceneElementsIncludingDeleted()),
    });
    loadPictures(initial.data.elements);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    unsubscribers.current.forEach((off) => off());
    unsubscribers.current = [];
    onApiRef.current?.(null);
  }, []);

  // ── saves: content changes only ───────────────────────────────────────────────────────────
  const handleChange = useCallback((elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
    // Before the version check: selection, scroll and zoom move the control without a content change.
    const nextPicker = sizePickerFor(elements, appState);
    setSizePicker((prev) => (samePicker(prev, nextPicker) ? prev : nextPicker));
    // With the select tool only: another tool's properties are for what it is about to draw.
    setWidgetsOnly(appState.activeTool.type === 'selection' && selectionIsOnlyWidgets(elements, appState.selectedElementIds));
    // The panel knows every agent with a card here (heard only when the list really changes).
    // Before the version check: a poll's remote copy has already recorded its version.
    if (boardSlug) setBoardCards(vault, boardSlug, agentCardsOf(elements));

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
    lastVersion.current = version;
    // An undo can bring back a picture whose bytes this canvas never held.
    loadPictures(elements);
    // Also fires once as the mounted scene first settles. A save of an unchanged scene is a
    // byte-level no-op on the server, and one that `restoreElements` repaired is worth saving.
    onSceneChangeRef.current?.(elements);
  }, [vault, boardSlug, loadPictures]);

  // ── adding a widget ───────────────────────────────────────────────────────────────────────
  const addWidget = useCallback((payload: WidgetPayload, at: { x: number; y: number }) => {
    const api = apiRef.current;
    if (!api) return;
    const id = newElementId();
    // A kind with its own default box (the tall agent card) comes in at that box, free-form.
    const own = payload.size ? undefined : DEFAULT_WIDGET_BOXES[payload.kind];
    const size = payload.size ?? (own ? nearestWidgetSize(own[0], own[1]) : DEFAULT_WIDGET_SIZES[payload.kind]);
    const box = placeNewWidget(at, own ? { width: own[0], height: own[1] } : size);
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
