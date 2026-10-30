import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar, type Page } from './Sidebar';
import { CommandPalette } from '../search/CommandPalette';
import { useVault, emitInstance } from '../../context/VaultContext';
import { readScopedRaw, writeScopedRaw } from '../../lib/scopedStorage';
import { useRailGlide } from './useRailGlide';
import { useIsMobile } from '../../hooks/useIsMobile';
import { PhoneBar } from './PhoneBar';
import { publishPage } from '../../lib/pageContext';
import { useIsNewShell } from '../../lib/uxMode';
import { NewShellControls } from './newshell/NewShellControls';
import './Shell.css';

const ACTIVE_PAGE_STORAGE_KEY = 'dreamcontext.dashboard.activePage';
const VALID_PAGES: readonly Page[] = ['tasks', 'roadmap', 'hypotheses', 'lab', 'automations', 'agents', 'core', 'knowledge', 'sleep', 'brain', 'council', 'taxonomy', 'settings', 'packs', 'about', 'announcements', 'whiteboards', 'relations'];
/** Pages only the new shell offers: classic never lands on one, even from a stored value. */
const NEW_SHELL_ONLY_PAGES: readonly Page[] = ['relations'];

/**
 * Which page a project was last on — per-project navigation, so it goes through the
 * scoped-storage RAW layer (not JSON): the stored value has always been the bare page name,
 * and staying on that format is what lets an existing pre-scoping value migrate correctly
 * (a JSON layer would try to `JSON.parse('tasks')` and fail on anything but the literal word
 * "tasks", silently losing everyone else's remembered page).
 */
function readStoredPage(vault: string | null, instanceId: string, newShell = false): Page {
  const valid = (p: string) => (VALID_PAGES as readonly string[]).includes(p) && (newShell || !NEW_SHELL_ONLY_PAGES.includes(p as Page));
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

export type NavOrigin = 'chat' | 'rail' | 'other';

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
  const [activePage, setActivePage] = useState<Page>(() => readStoredPage(vault, instanceId, newShell));
  const [origin, setOrigin] = useState<NavOrigin>('other');
  // The new shell's ← → in the title bar: this project's own page history.
  const historyRef = useRef<{ stack: Page[]; at: number }>({ stack: [activePage], at: 0 });
  const [historyRev, setHistoryRev] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // The phone (a narrow viewport AND a finger): one top bar, the rail as a drawer, no window
  // chrome. `body[data-phone]` lets every page's CSS key off ONE attribute.
  const phone = useIsMobile();
  const [phoneNavOpen, setPhoneNavOpen] = useState(false);
  useLayoutEffect(() => {
    if (!phone) { setPhoneNavOpen(false); return undefined; }
    document.body.dataset.phone = 'true';
    return () => { delete document.body.dataset.phone; };
  }, [phone]);
  useEffect(() => {
    if (!phoneNavOpen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPhoneNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phoneNavOpen]);
  const closePhoneNav = useCallback(() => setPhoneNavOpen(false), []);

  // ⌘K / Ctrl-K toggles the global command palette from anywhere (including over the
  // expanded agent overlay — the agent host only grabs ⌘D/⌘T/⌘W, never ⌘K). Gated on
  // `isActive` first: a hidden instance is `inert`, so it can't normally receive focus-bound
  // input, but a window-level keydown listener isn't focus-scoped — without this check a ⌘K
  // meant for the foreground project would also pop the palette of every backgrounded one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive) return;
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
    setActivePage(page);
    setOrigin(from);
    const h = historyRef.current;
    if (h.stack[h.at] !== page) {
      h.stack = [...h.stack.slice(0, h.at + 1), page].slice(-50);
      h.at = h.stack.length - 1;
      setHistoryRev((n) => n + 1);
    }
    setFocusId(id);
    setNonce((n) => n + 1);
    // Tell this instance's Agent overlay (mounted outside this tree, but inside the same
    // `ProjectInstance`) that the user navigated, so it auto-collapses from fullscreen and
    // reveals the page they picked. On the instance bus, not `window` — on `window` every
    // mounted project would hear another project's navigation and react to it.
    emitInstance(bus, 'dreamcontext-navigate', { page });
    writeScopedRaw(vault, ACTIVE_PAGE_STORAGE_KEY, page);
  }, [bus, vault]);

  const handleSidebarNavigate = useCallback(
    (page: Page, id?: string) => {
      navigate(page, id ?? null);
    },
    [navigate],
  );

  const clearFocus = useCallback(() => setFocusId(null), []);

  // ← → step through this project's page history without adding to it.
  const stepHistory = useCallback((delta: -1 | 1) => {
    const h = historyRef.current;
    const at = h.at + delta;
    if (at < 0 || at >= h.stack.length) return;
    h.at = at;
    setHistoryRev((n) => n + 1);
    const page = h.stack[at];
    setActivePage(page);
    setFocusId(null);
    setNonce((n) => n + 1);
    setOrigin('other');
    emitInstance(bus, 'dreamcontext-navigate', { page });
    writeScopedRaw(vault, ACTIVE_PAGE_STORAGE_KEY, page);
  }, [bus, vault]);
  const canBack = historyRef.current.at > 0;
  const canForward = historyRef.current.at < historyRef.current.stack.length - 1;
  void historyRev;

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
          canBack={canBack}
          canForward={canForward}
          onBack={() => stepHistory(-1)}
          onForward={() => stepHistory(1)}
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
      </div>
    );
  }

  return (
    <div className="shell" ref={shellRef} data-phone={phone ? 'true' : undefined}>
      {phone && isActive && <PhoneBar page={activePage} menuOpen={phoneNavOpen} onMenu={() => setPhoneNavOpen((o) => !o)} />}
      {!phone && <Header
        onNavigate={handleSidebarNavigate}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onOpenSearch={() => setPaletteOpen(true)}
      />}
      <div className="shell-body">
        <Sidebar activePage={activePage} onNavigate={handleSidebarNavigate} collapsed={sidebarCollapsed} phone={phone ? { open: phoneNavOpen, onClose: closePhoneNav } : undefined} />
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
