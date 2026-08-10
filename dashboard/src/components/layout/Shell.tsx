import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar, type Page } from './Sidebar';
import { CommandPalette } from '../search/CommandPalette';
import { useVault, emitInstance } from '../../context/VaultContext';
import { readScopedRaw, writeScopedRaw } from '../../lib/scopedStorage';
import './Shell.css';

const ACTIVE_PAGE_STORAGE_KEY = 'dreamcontext.dashboard.activePage';
const VALID_PAGES: readonly Page[] = ['tasks', 'roadmap', 'hypotheses', 'lab', 'core', 'knowledge', 'sleep', 'brain', 'council', 'taxonomy', 'settings', 'packs', 'about', 'announcements'];

/**
 * Which page a project was last on — per-project navigation, so it goes through the
 * scoped-storage RAW layer (not JSON): the stored value has always been the bare page name,
 * and staying on that format is what lets an existing pre-scoping value migrate correctly
 * (a JSON layer would try to `JSON.parse('tasks')` and fail on anything but the literal word
 * "tasks", silently losing everyone else's remembered page).
 */
function readStoredPage(vault: string | null, instanceId: string): Page {
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
    if (requested && (VALID_PAGES as readonly string[]).includes(requested)) {
      return requested as Page;
    }
  } catch {
    // URL unparseable — fall through to the stored page.
  }
  const stored = readScopedRaw(vault, ACTIVE_PAGE_STORAGE_KEY);
  if (stored && (VALID_PAGES as readonly string[]).includes(stored)) {
    return stored as Page;
  }
  return 'tasks';
}

export interface ShellNavigation {
  page: Page;
  focusId: string | null;
  /** Incremented each time navigate is called so consumers can react to repeated focus events. */
  nonce: number;
  navigate: (page: Page, focusId: string | null) => void;
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
  const [activePage, setActivePage] = useState<Page>(() => readStoredPage(vault, instanceId));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

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
  // area — its expanded left edge reads `--app-content-left`, which this attribute flips.
  // Scoped to the instance (not `<html>`) because one window now holds several projects, each
  // with its own content-area rect.
  useEffect(() => {
    const instanceEl = shellRef.current?.closest('.project-instance');
    if (instanceEl instanceof HTMLElement) {
      instanceEl.dataset.sidebar = sidebarCollapsed ? 'collapsed' : 'expanded';
    }
  }, [sidebarCollapsed]);

  const navigate = useCallback((page: Page, id: string | null) => {
    setActivePage(page);
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

  // Stable so <CommandModal>'s topmost-Esc effect doesn't re-register (and re-assert
  // the palette as top of the overlay stack) on every Shell re-render — which would
  // otherwise let Esc close the palette out from under a ⌘P switcher opened on top.
  const closePalette = useCallback(() => setPaletteOpen(false), []);

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
        <main className="shell-main">
          {children({ page: activePage, focusId, nonce, navigate, clearFocus })}
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
