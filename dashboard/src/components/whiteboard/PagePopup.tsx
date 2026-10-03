import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';
import { emitInstance, useApi, useVault } from '../../context/VaultContext';
import { useKnowledgeList } from '../../hooks/useKnowledge';
import { useTasks } from '../../hooks/useTasks';
import { openExternalUrl } from '../../lib/desktop';
import { externalHref } from '../../lib/externalLinks';
import { DocumentReader, readerLinkAction } from '../appLink/DocumentReader';
import { revealPath } from '../sleepy/chat/chatEntities';
import {
  BackIcon, CloseIcon, CollapseIcon, ComputerIcon, CopyIcon, ExpandIcon, FolderIcon, ForwardIcon, MoreIcon,
  OpenInAppIcon,
} from './PanelIcons';
import {
  CLOSED_STACK, canGoBack, canGoForward, currentPage, escapeCloses, menuIndexAfter, owningPage, pageStackReducer,
  pageTitleFromPath, panelMenuItems, targetPath, togglePanelWidth, type PageTarget, type PanelMenuItem,
  type PanelWidth,
} from './pagePopupModel';
import { knowledgeTitle, parseWidgetLink, taskTitle } from './widgetModel';
import { useWbText } from './whiteboardHost';
import './PagePopup.css';

/**
 * THE PAGE PANEL: a knowledge page, a task, or any project .md / .pdf / .html read beside the
 * board without leaving it. It slides in from the board's RIGHT edge, the way the Brain page's
 * node drawer does, and covers nothing: it PUSHES the canvas. Collapsed, the panel sits in the
 * board body's flex row beside the canvas, so the canvas takes only the space left of it and
 * Excalidraw re-lays its own toolbar, "+ Add" and Library into that box (it observes its
 * container, so pointer coordinates follow). The canvas resizes once per open and once per
 * close; only the panel animates. The board's unsaved strokes, zoom and scroll, the app page
 * and the URL are untouched. "Expand" lays the panel OVER the whole board (absolute) — the
 * canvas is never squeezed to nothing — and the same button brings it back.
 *
 * The provider sits above the canvas (the board page mounts it around `WhiteboardCanvas`), so
 * a widget, which Excalidraw renders inside the canvas's own React tree, reaches it through
 * {@link usePagePopup}; so does the canvas's element-link handler. The panel keeps its own
 * back/forward stack: every link the reader follows (a document-relative link, a resolved
 * `[[wikilink]]`, a `dreamcontext://knowledge|task` link) is pushed onto it.
 *
 * The pieces stand alone for the wiki card's in-card reader: `DocumentReader variant="page"`,
 * the icons in PanelIcons.tsx and the stack reducer in pagePopupModel.ts need none of this
 * chrome.
 */

export interface PagePopupApi {
  /** Open the panel on this card's or link's page (a fresh stack). False when the ref is not readable. */
  openPage: (target: PageTarget) => boolean;
}

const PagePopupContext = createContext<PagePopupApi | null>(null);

/** The board's page panel, or null outside a board page (a widget then falls back to the old
 *  open-page event). */
export function usePagePopup(): PagePopupApi | null {
  return useContext(PagePopupContext);
}

export function PagePopupProvider({ children }: { children: ReactNode }) {
  const [stack, dispatch] = useReducer(pageStackReducer, CLOSED_STACK);
  const api = useMemo<PagePopupApi>(() => ({
    openPage: (target) => {
      const path = targetPath(target);
      if (!path) return false;
      dispatch({ type: 'open', path });
      return true;
    },
  }), []);
  const path = currentPage(stack);
  return (
    <PagePopupContext.Provider value={api}>
      {children}
      {path && (
        <PagePanel
          path={path}
          canBack={canGoBack(stack)}
          canForward={canGoForward(stack)}
          onBack={() => dispatch({ type: 'back' })}
          onForward={() => dispatch({ type: 'forward' })}
          onPush={(next) => dispatch({ type: 'push', path: next })}
          onClose={() => dispatch({ type: 'close' })}
        />
      )}
    </PagePopupContext.Provider>
  );
}

/** How long the slide-out may take before the panel is closed anyway (a hidden panel never
 *  reports its animation's end). */
const LEAVE_FALLBACK_MS = 400;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function PagePanel({ path, canBack, canForward, onBack, onForward, onPush, onClose }: {
  path: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onPush: (path: string) => void;
  onClose: () => void;
}) {
  const tx = useWbText();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<PanelWidth>('side');
  // The one-shot animation an Expand / Collapse plays. The width itself changes in ONE step:
  // collapsed, the panel is in flow and the canvas beside it resizes, and a canvas resized on
  // every frame of a width transition would re-lay Excalidraw sixty times a second.
  const [widthAnim, setWidthAnim] = useState<'widen' | 'narrow' | null>(null);
  const toggleWidth = () => {
    const next = togglePanelWidth(width);
    setWidth(next);
    setWidthAnim(prefersReducedMotion() ? null : next === 'full' ? 'widen' : 'narrow');
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The one-line status a menu action leaves ("Path copied", a refusal): kept here, because
  // the menu closes the moment its row is chosen.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const moreRef = useRef<HTMLButtonElement | null>(null);

  const owner = owningPage(path);
  const title = usePageTitle(path, owner);
  const full = width === 'full';

  // The menu is about the page it was opened on.
  useEffect(() => { setMenuOpen(false); setNote(null); }, [path]);

  // Focus moves in on open and goes back to where it was on close.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => { previous?.focus?.({ preventScroll: true }); };
  }, []);

  // Back to the first page disables Back under the pointer, and a disabled button drops
  // focus to the body, where Esc no longer reaches the panel: the panel takes it back. Focus
  // that is somewhere real (the canvas, after a card click) is left alone.
  useLayoutEffect(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body
      || (active instanceof HTMLButtonElement && active.disabled && !!panelRef.current?.contains(active));
    if (lost) panelRef.current?.focus({ preventScroll: true });
  }, [path, canBack, canForward]);

  // Closing slides the panel out first, then empties the stack.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (prefersReducedMotion()) { onCloseRef.current(); return; }
    setMenuOpen(false);
    setLeaving(true);
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onCloseRef.current(), LEAVE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  // A page opened while the panel slides out keeps it open.
  useEffect(() => { setLeaving(false); }, [path]);

  // Esc closes the ⋯ menu first, then the panel — and only those: taken on WINDOW in the
  // capture phase, before Excalidraw can read it as "deselect", and only while focus is in
  // the panel (a fullscreen board opened from it is a portal outside, with its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const panel = panelRef.current;
      if (!panel || !(e.target instanceof Node) || !panel.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (escapeCloses(menuOpenRef.current) === 'menu') {
        setMenuOpen(false);
        moreRef.current?.focus();
      } else {
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

  /** A link the reader followed: another page in this panel, an in-app link, or the web. */
  const follow = useCallback((next: string) => {
    if (readerLinkAction(next) !== 'url') { onPush(next); return; }
    const link = parseWidgetLink(next);
    if (link && (link.kind === 'knowledge' || link.kind === 'task')) {
      const p = targetPath({ kind: link.kind, ref: link.id });
      if (p) onPush(p);
      return;
    }
    const href = externalHref(next);
    if (href) void openExternalUrl(href);
  }, [onPush]);

  const expandLabel = full ? tx('whiteboard.panel.collapse', 'Collapse') : tx('whiteboard.panel.expand', 'Expand');
  const backLabel = tx('whiteboard.popup.back', 'Back');
  const forwardLabel = tx('whiteboard.popup.forward', 'Forward');
  const moreLabel = tx('whiteboard.panel.more', 'More actions');
  const closeLabel = tx('whiteboard.popup.close', 'Close');

  return (
    <div
      ref={panelRef}
      className={`wb-page-panel${full ? ' wb-page-panel--full' : ''}${widthAnim ? ` wb-page-panel--${widthAnim}` : ''}${leaving ? ' wb-page-panel--leaving' : ''}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      data-page-path={path}
      data-panel-width={width}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (leaving) onCloseRef.current();
        else setWidthAnim(null);
      }}
    >
      <div className="wb-page-panel-head">
        <div className="wb-page-panel-group">
          <PanelButton label={backLabel} onClick={onBack} disabled={!canBack}><BackIcon /></PanelButton>
          <PanelButton label={forwardLabel} onClick={onForward} disabled={!canForward}><ForwardIcon /></PanelButton>
        </div>
        <h2 className="wb-page-panel-title" title={path}>{title}</h2>
        <div className="wb-page-panel-group">
          <PanelButton label={expandLabel} onClick={toggleWidth} pressed={full}>
            {full ? <CollapseIcon /> : <ExpandIcon />}
          </PanelButton>
          <PanelButton
            ref={moreRef}
            label={moreLabel}
            onClick={() => setMenuOpen((open) => !open)}
            expanded={menuOpen}
            hasPopup
          >
            <MoreIcon />
          </PanelButton>
          <PanelButton label={closeLabel} onClick={requestClose}><CloseIcon /></PanelButton>
        </div>
        {menuOpen && (
          <PanelMenu
            path={path}
            anchor={moreRef}
            onNote={setNote}
            onClose={(refocus) => { setMenuOpen(false); if (refocus) moreRef.current?.focus(); }}
          />
        )}
      </div>
      {note && <p className="wb-page-panel-note" role="status">{note}</p>}
      <div className="wb-page-panel-body">
        <DocumentReader key={path} path={path} onOpen={follow} embedded vaultReads hostFileActions variant="page" />
      </div>
    </div>
  );
}

/** One header button: borderless, icon-only, one size, one hover. */
function PanelButton({ label, onClick, disabled, pressed, expanded, hasPopup, children, ref }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  hasPopup?: boolean;
  children: ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="wb-page-panel-icon"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={hasPopup ? expanded : undefined}
      aria-haspopup={hasPopup ? 'menu' : undefined}
    >
      {children}
    </button>
  );
}

/** How long "Path copied" stays before it goes. */
const NOTE_MS = 2400;

/**
 * The ⋯ menu: the page's secondary actions. Arrow keys / Home / End move between rows, Tab or
 * a click outside closes it, Esc closes it (the panel's Esc handler owns that key).
 */
function PanelMenu({ path, anchor, onNote, onClose }: {
  path: string;
  onNote: (text: string) => void;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
}) {
  const tx = useWbText();
  const api = useApi();
  const { bus } = useVault();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => panelMenuItems(path), [path]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The first row takes focus as the menu opens.
  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  // A press anywhere outside the menu and its ⋯ button closes it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || menuRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onCloseRef.current(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') { onClose(false); return; }
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = menuIndexAfter(current, e.key, rows.length);
    if (next === current) return;
    e.preventDefault();
    rows[next]?.focus();
  };

  return (
    <div ref={menuRef} className="wb-page-panel-menu" role="menu" aria-label={tx('whiteboard.panel.more', 'More actions')} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <MenuRow key={item.id} item={item} path={path} onNote={onNote} onDone={() => onClose(true)} api={api} bus={bus} />
      ))}
    </div>
  );
}

function MenuRow({ item, path, onNote: note, onDone, api, bus }: {
  item: PanelMenuItem;
  path: string;
  onNote: (text: string) => void;
  onDone: () => void;
  api: ReturnType<typeof useApi>;
  bus: EventTarget;
}) {
  const tx = useWbText();
  const run = () => {
    switch (item.id) {
      case 'open-owner':
        emitInstance(bus, 'dreamcontext-agent-open-page', { page: item.page, id: item.ownerId });
        break;
      case 'open-computer':
      case 'reveal':
        void revealPath(api, path, item.id === 'reveal' ? 'reveal' : 'auto').then((err) => {
          if (err) note(`${tx('whiteboard.panel.failed', 'Couldn’t do that —')} ${err}`);
        });
        break;
      case 'copy-path':
        void navigator.clipboard?.writeText(path).then(
          () => note(tx('whiteboard.panel.copied', 'Path copied')),
          () => note(tx('whiteboard.panel.copyFailed', 'Couldn’t copy the path')),
        );
        break;
    }
    onDone();
  };
  const { icon, label } = menuRowLook(item, tx);
  return (
    <button type="button" role="menuitem" tabIndex={-1} className="wb-page-panel-menu-item" onClick={run}>
      <span className="wb-page-panel-menu-icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function menuRowLook(item: PanelMenuItem, tx: (key: string, fallback: string) => string): { icon: ReactNode; label: string } {
  switch (item.id) {
    case 'open-owner':
      return {
        icon: <OpenInAppIcon />,
        label: item.page === 'tasks'
          ? tx('whiteboard.popup.openInTasks', 'Open in Tasks')
          : tx('whiteboard.popup.openInKnowledge', 'Open in Knowledge'),
      };
    case 'open-computer':
      return { icon: <ComputerIcon />, label: tx('whiteboard.panel.openOnComputer', 'Open on computer') };
    case 'reveal':
      return { icon: <FolderIcon />, label: tx('whiteboard.panel.reveal', 'Reveal in Finder') };
    case 'copy-path':
      return { icon: <CopyIcon />, label: tx('whiteboard.panel.copyPath', 'Copy path') };
  }
}

/** The panel's heading: a knowledge page's or a task's own title, else a readable file name. */
function usePageTitle(path: string, owner: { page: 'knowledge' | 'tasks'; id: string } | null): string {
  const knowledge = useKnowledgeList();
  const tasks = useTasks();
  if (owner?.page === 'knowledge') {
    const entry = knowledge.data?.find((e) => e.slug === owner.id);
    if (entry) return knowledgeTitle(entry);
  } else if (owner?.page === 'tasks') {
    const task = tasks.data?.find((t) => t.slug === owner.id);
    if (task) return taskTitle(task);
  }
  return pageTitleFromPath(path);
}
