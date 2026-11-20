import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar, type Page } from './Sidebar';
import { CommandPalette } from '../search/CommandPalette';
import { useVault, emitInstance, useInstanceEvent } from '../../context/VaultContext';
import { readScopedRaw, writeScopedRaw } from '../../lib/scopedStorage';
import { useRailGlide } from './useRailGlide';
import { publishPage } from '../../lib/pageContext';
import { planProjectSwitch, publishShownSurface, readShownSurface, takeProjectSwitch } from '../../lib/projectSwitchPage';
import { AGENT_SURFACE_EXPANDED_EVENT } from '../../lib/agentSettings';
import { runChatLadder } from '../../lib/chatLadder';
import { DRAWER_PAGE_EVENT } from '../../lib/drawerIntents';
import { useOpenItem } from '../../lib/openItem';
import { CHAT_MOVE_MAX_MS } from './navRecorder';
import { useChrome } from './WindowChrome';
import { readDeviceShell, useIsNewShell } from '../../lib/uxMode';
import { DEVICE_HIDDEN_PAGES } from './newshell/railModel';
import { NewShellControls } from './newshell/NewShellControls';
import { SettingsWindow, type SettingsWindowFocus } from '../settings/window/SettingsWindow';
import './Shell.css';

const ACTIVE_PAGE_STORAGE_KEY = 'dreamcontext.dashboard.activePage';
const VALID_PAGES: readonly Page[] = ['tasks', 'roadmap', 'hypotheses', 'lab', 'automations', 'agents', 'core', 'knowledge', 'sleep', 'brain', 'council', 'settings', 'whiteboards', 'relations', 'stats', 'apps'];
/** Pages only the new shell offers: classic never lands on one, even from a stored value. */
const NEW_SHELL_ONLY_PAGES: readonly Page[] = ['relations'];

/** A page name this shell knows (a window landing's page is checked against it). */
export function isShellPage(p: unknown): p is Page {
  return typeof p === 'string' && (VALID_PAGES as readonly string[]).includes(p);
}

/** A chat closing this soon after a navigation is that navigation's doing (it collapses the
 *  chat), never a separate act of the owner's. */
const NAV_COLLAPSE_MS = 1_000;

/**
 * Which page a project was last on — per-project navigation, so it goes through the
 * scoped-storage RAW layer (not JSON): the stored value has always been the bare page name,
 * and staying on that format is what lets an existing pre-scoping value migrate correctly
 * (a JSON layer would try to `JSON.parse('tasks')` and fail on anything but the literal word
 * "tasks", silently losing everyone else's remembered page).
 */
function readStoredPage(vault: string | null, instanceId: string, newShell = false): Page {
  const valid = (p: string) => (VALID_PAGES as readonly string[]).includes(p) && (newShell || !NEW_SHELL_ONLY_PAGES.includes(p as Page))
    // A device shell has no Settings or Project Relations: a stored or linked one lands on Tasks.
    && !(newShell && readDeviceShell() && DEVICE_HIDDEN_PAGES.has(p as Page));
  if (typeof window === 'undefined') return 'tasks';
  // A `/lab/<slug>` deep link (multi-page insights — funnel overview/detail) must land on
  // the Lab page regardless of the remembered page. There is exactly one URL for the whole
  // window, so only the FIRST instance may claim it — a chip opened afterward reads this
  // same pathname and must not also jump itself to Lab.
  if (instanceId === 'inst-1') {
    try {
      if (window.location.pathname.startsWith('/lab/')) return 'lab';
    } catch {
      // fall through
    }
  }
  // An explicit `?page=<page>` deep-link wins over the remembered page, so a URL
  // can land directly on a section (used by the launcher and for sharing links).
  try {
    const requested = new URLSearchParams(window.location.search).get('page');
    if (requested && valid(requested)) {
      return requested as Page;
    }
  } catch {
    // URL unparseable — fall through to the stored page.
  }
  const stored = readScopedRaw(vault, ACTIVE_PAGE_STORAGE_KEY);
  if (stored && valid(stored)) {
    return stored as Page;
  }
  return 'tasks';
}

/**
 * The new shell has no Settings page: Settings is a window over the page behind. A stored or
 * `?page=settings` value lands on Tasks with the window open.
 */
function initialPage(vault: string | null, instanceId: string, newShell: boolean): { page: Page; settings: boolean } {
  const page = readStoredPage(vault, instanceId, newShell);
  if (newShell && page === 'settings') return { page: 'tasks', settings: true };
  return { page, settings: false };
}

/** `'landing'`: a window move landed it (the project rail, ← →, a switch's carry, ⌘K across
 *  projects); the window's recorder tells it from the owner's own navigation by this. */
export type NavOrigin = 'chat' | 'rail' | 'other' | 'landing';

export interface ShellNavigation {
  page: Page;
  focusId: string | null;
  /** Incremented each time navigate is called so consumers can react to repeated focus events. */
  nonce: number;
  /** Where the last navigation came from: a chat link (`'chat'`, so the new shell's PageBar
   *  offers "← Chat"), the rail, or anything else. */
  origin: NavOrigin;
  navigate: (page: Page, focusId: string | null, origin?: NavOrigin) => void;
  clearFocus: () => void;
}

interface ShellProps {
  children: (nav: ShellNavigation) => ReactNode;
  /**
   * Rail width, hoisted to the window chrome: with N projects mounted at once, each running
   * its own collapse state would diverge the moment one of them toggled — two rails of
   * different widths in one window reads as broken. The KEY behind this stays window-global
   * on purpose (see `WindowChrome`); only the state's single owner moved.
   */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function Shell({ children, sidebarCollapsed, onToggleSidebar }: ShellProps) {
  const { vault, instanceId, isActive, bus } = useVault();
  const newShell = useIsNewShell();
  const [initial] = useState(() => initialPage(vault, instanceId, newShell));
  const [activePage, setActivePage] = useState<Page>(initial.page);
  // The new shell's Settings window: open over the page, which stays exactly as it was.
  const [settingsWindow, setSettingsWindow] = useState<SettingsWindowFocus | null>(
    () => (initial.settings ? { focusId: null, nonce: 0 } : null),
  );
  const closeSettingsWindow = useCallback(() => setSettingsWindow(null), []);
  // A remembered 'settings' (the classic page someone left on before switching layouts) opens
  // the window once; it is then remembered as the page behind, or it would reopen every launch.
  useEffect(() => {
    if (newShell && initial.settings && readScopedRaw(vault, ACTIVE_PAGE_STORAGE_KEY) === 'settings') {
      writeScopedRaw(vault, ACTIVE_PAGE_STORAGE_KEY, initial.page);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, for the stored value read at mount
  const [origin, setOrigin] = useState<NavOrigin>('other');
  // Navigation B: ← → are the WINDOW's (WindowChrome's place history). This Shell reports what it
  // shows, and whether the owner caused the change, to the window's recorder.
  const chrome = useChrome();
  // Who caused the next report: the owner (a non-`landing` navigate, his own Chat open or close)
  // or a landing. Taken by the report, then false (an item publish is nobody's act).
  const ownerRef = useRef<{ byOwner: boolean; navAt: number }>({ byOwner: false, navAt: 0 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // A phone is always a device shell (lib/uxMode.ts), so it is never here in the classic shell:
  // a classic-frozen tablet that rotates narrow keeps its Header and the desktop layout. The
  // phone layer's `body[data-phone]` is the window's (WindowChrome).

  // ⌘K / Ctrl-K toggles the global command palette from anywhere (including over the
  // expanded agent overlay — the agent host only grabs ⌘D/⌘T/⌘W, never ⌘K). Gated on
  // `isActive` first: a hidden instance is `inert`, so it can't normally receive focus-bound
  // input, but a window-level keydown listener isn't focus-scoped — without this check a ⌘K
  // meant for the foreground project would also pop the palette of every backgrounded one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive) return;
      // The Settings window has its own search: ⌘K does not open the palette under it.
      if (document.body.dataset.settingsWindow) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  // Publish the sidebar collapse state on the nearest `.project-instance` ancestor so
  // surfaces mounted OUTSIDE the Shell tree but INSIDE that instance (the expanded Agent
  // overlay, a sibling of Shell under `ProjectInstance`) can bound themselves to the content
  // area — its left edge follows this attribute (AgentTerminal.css). Scoped to the instance
  // (not `<html>`) because one window now holds several projects, each with its own
  // content-area rect. A LAYOUT effect: nothing animates the overlay's edge any more, so it
  // has to land in the same frame as the rail it sits against, not one paint later.
  // Not in the new shell: there is no collapsible sidebar, and the overlay is bounded to the
  // instance box instead (AgentTerminal.css, D4).
  useLayoutEffect(() => {
    if (newShell) return;
    const instanceEl = shellRef.current?.closest('.project-instance');
    if (instanceEl instanceof HTMLElement) {
      instanceEl.dataset.sidebar = sidebarCollapsed ? 'collapsed' : 'expanded';
    }
  }, [sidebarCollapsed, newShell]);

  // The open page, on the same element, for surfaces outside this tree that step aside on a
  // page: the corner agent dock and Chat button do not sit over a whiteboard's cards
  // (owner, 2026-10-05; AgentTerminal.css).
  useLayoutEffect(() => {
    const instanceEl = shellRef.current?.closest('.project-instance');
    if (instanceEl instanceof HTMLElement) instanceEl.dataset.page = activePage;
  }, [activePage]);
  // The same page for the Super dock's page chip (lib/pageContext.ts), on this instance's bus.
  useEffect(() => {
    publishPage(bus, activePage);
    return () => publishPage(bus, null);
  }, [bus, activePage]);

  // The rail's motion — see useRailGlide.ts. Declared after the attribute above, so the
  // slab measures the rail with the overlay's edge already moved.
  const glideRef = useRef<HTMLDivElement | null>(null);
  useRailGlide(shellRef, glideRef, sidebarCollapsed);

  const navigate = useCallback((page: Page, id: string | null, from: NavOrigin = 'other') => {
    // A device shell never shows Settings or Project Relations, whoever asks (a chat's link, the
    // setup notice): it drives another machine's project set.
    if (newShell && readDeviceShell() && DEVICE_HIDDEN_PAGES.has(page)) return;
    // New shell: Settings opens as a window. The page behind, its history and its stored
    // value stay, and no `dreamcontext-navigate` goes out (that would collapse an expanded chat).
    if (newShell && page === 'settings') {
      setSettingsWindow((prev) => ({ focusId: id, nonce: (prev?.nonce ?? 0) + 1 }));
      return;
    }
    setActivePage(page);
    setOrigin(from);
    ownerRef.current = { byOwner: from !== 'landing', navAt: Date.now() };
    setFocusId(id);
    setNonce((n) => n + 1);
    // Tell this instance's Agent overlay (mounted outside this tree, but inside the same
    // `ProjectInstance`) that the user navigated, so it auto-collapses from fullscreen and
    // reveals the page they picked. On the instance bus, not `window` — on `window` every
    // mounted project would hear another project's navigation and react to it.
    emitInstance(bus, 'dreamcontext-navigate', { page });
    writeScopedRaw(vault, ACTIVE_PAGE_STORAGE_KEY, page);
  }, [bus, vault, newShell]);

  // ⌘U opens Stats from anywhere, as in T3 Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'u') return;
      if (document.body.dataset.settingsWindow) return;
      e.preventDefault();
      navigate('stats', null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, navigate]);

  // Switching project keeps the page (owner 2026-11-03, lib/projectSwitchPage.ts): the project
  // on screen publishes its page and whether Chat is open; the one coming on screen follows once.
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // The carried or landed Chat's ladder (lib/chatLadder.ts: a freshly mounted surface is not
  // listening yet) stops the moment it opens, and on any navigation: it never reopens a chat the
  // owner closed or left.
  const ladderRef = useRef<(() => void) | null>(null);
  const stopChatRetries = useCallback(() => { ladderRef.current?.(); ladderRef.current = null; }, []);
  const startChatLadder = useCallback(() => {
    stopChatRetries();
    ladderRef.current = runChatLadder(bus, CHAT_MOVE_MAX_MS, {
      isOpen: () => chatOpenRef.current,
      stillActive: () => isActiveRef.current,
    });
    if (chatOpenRef.current) stopChatRetries();
  }, [bus, stopChatRetries]);
  useInstanceEvent<boolean>(AGENT_SURFACE_EXPANDED_EVENT, (open) => {
    const isOpen = open === true;
    // An open the ladder asked for is a landing's; a close right after a navigation is that
    // navigation's; any other open or close is the owner's (the rail's Chat row, Esc).
    const byOwner = isOpen ? ladderRef.current === null : Date.now() - ownerRef.current.navAt > NAV_COLLAPSE_MS;
    ownerRef.current = { ...ownerRef.current, byOwner };
    setChatOpen(isOpen);
    if (isOpen) stopChatRetries();
  });
  useInstanceEvent('dreamcontext-navigate', stopChatRetries);
  // A window move landing on this project's Chat (C5): the chat expands as it stands.
  useInstanceEvent<{ page?: unknown }>(DRAWER_PAGE_EVENT, (detail) => {
    if (detail?.page === 'chat') startChatLadder();
  });
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const arrived = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    // Only the owner's own switch carries the page: a link, a start or a drawer row lands itself.
    if (!arrived || !vault || !takeProjectSwitch(vault)) return undefined;
    const plan = planProjectSwitch(readShownSurface(), { page: activePage, chat: chatOpen },
      (p) => !(newShell && readDeviceShell() && DEVICE_HIDDEN_PAGES.has(p)));
    if (plan.navigate) navigate(plan.navigate, null, 'landing');
    // Closing the chat with a navigate signal no page reads as its own (Lab clears its open funnel
    // on `page: 'lab'`); the agent surface collapses on any.
    if (plan.chat === false && !plan.navigate) {
      ownerRef.current = { byOwner: false, navAt: Date.now() };
      emitInstance(bus, 'dreamcontext-navigate', { page: null });
    }
    if (plan.chat !== true) return undefined;
    // A project mounted by this switch has no chat surface listening yet: ask until it opens.
    startChatLadder();
    return stopChatRetries;
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps -- once per arrival on screen
  useEffect(() => {
    if (isActive) publishShownSurface({ page: activePage, chat: chatOpen });
  }, [isActive, activePage, chatOpen]);

  // What this project shows, to the window's recorder (C3): on becoming active and on every
  // change, only while active. The open item travels only when it belongs to the shown page.
  const openItem = useOpenItem(bus);
  const itemOnPage = openItem && openItem.page === activePage ? openItem : null;
  const reportedRef = useRef(false);
  const reportShown = chrome.reportShown;
  useEffect(() => {
    if (!newShell || !vault) return;
    if (!isActive) { reportedRef.current = false; return; }
    const becoming = !reportedRef.current;
    reportedRef.current = true;
    const byOwner = !becoming && ownerRef.current.byOwner;
    ownerRef.current = { ...ownerRef.current, byOwner: false };
    reportShown(vault, { page: activePage, chatOpen, item: itemOnPage ? { id: itemOnPage.id, label: itemOnPage.label } : null, byOwner });
  }, [newShell, vault, isActive, activePage, chatOpen, itemOnPage?.id, itemOnPage?.label, reportShown]); // eslint-disable-line react-hooks/exhaustive-deps -- the item by value

  const handleSidebarNavigate = useCallback(
    (page: Page, id?: string) => {
      navigate(page, id ?? null);
    },
    [navigate],
  );

  const clearFocus = useCallback(() => setFocusId(null), []);

  // Stable so <CommandModal>'s topmost-Esc effect doesn't re-register (and re-assert
  // the palette as top of the overlay stack) on every Shell re-render — which would
  // otherwise let Esc close the palette out from under a ⌘P switcher opened on top.
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // One object per navigation, not per render: the page (a memoized router) re-renders when
  // the owner navigates, never because the rail folded or the palette opened. A fold while
  // the Super Agent takes the screen re-rendered the whole page behind it, and its layout
  // reads forced a full layout in the hand-over's first frame.
  const nav = useMemo<ShellNavigation>(
    () => ({ page: activePage, focusId, nonce, origin, navigate, clearFocus }),
    [activePage, focusId, nonce, origin, navigate, clearFocus],
  );

  if (newShell) {
    return (
      <div className="shell" ref={shellRef}>
        <NewShellControls
          activePage={activePage}
          onNavigate={(page) => navigate(page, null, 'rail')}
          onOpenSearch={() => setPaletteOpen(true)}
        />
        <div className="shell-body">
          <main className="shell-main">
            {children(nav)}
          </main>
        </div>
        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          onNavigate={navigate}
        />
        {isActive && settingsWindow && (
          <SettingsWindow open focus={settingsWindow} onClose={closeSettingsWindow} />
        )}
      </div>
    );
  }

  return (
    <div className="shell" ref={shellRef}>
      <Header
        onNavigate={handleSidebarNavigate}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onOpenSearch={() => setPaletteOpen(true)}
      />
      <div className="shell-body">
        <Sidebar activePage={activePage} onNavigate={handleSidebarNavigate} collapsed={sidebarCollapsed} />
        <div className="sidebar-glide" ref={glideRef} aria-hidden="true"><div className="sidebar-glide-slab" /></div>
        <main className="shell-main">
          {children(nav)}
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onNavigate={navigate}
      />
    </div>
  );
}
