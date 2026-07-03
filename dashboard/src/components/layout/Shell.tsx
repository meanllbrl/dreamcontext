import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar, type Page } from './Sidebar';
import { CommandPalette } from '../search/CommandPalette';
import { useSidebarCollapse } from '../../hooks/useSidebarCollapse';
import './Shell.css';

const ACTIVE_PAGE_STORAGE_KEY = 'dreamcontext.dashboard.activePage';
const VALID_PAGES: readonly Page[] = ['tasks', 'roadmap', 'core', 'knowledge', 'features', 'sleep', 'brain', 'council', 'taxonomy', 'settings', 'packs', 'about'];

function readStoredPage(): Page {
  if (typeof window === 'undefined') return 'tasks';
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
  try {
    const stored = window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY);
    if (stored && (VALID_PAGES as readonly string[]).includes(stored)) {
      return stored as Page;
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through to default
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
}

export function Shell({ children }: ShellProps) {
  const [activePage, setActivePage] = useState<Page>(readStoredPage);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { collapsed, toggle: toggleSidebar } = useSidebarCollapse();

  // ⌘K / Ctrl-K toggles the global command palette from anywhere (including over the
  // expanded agent overlay — the agent host only grabs ⌘D/⌘T/⌘W, never ⌘K).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Publish the sidebar collapse state on <html> so surfaces mounted OUTSIDE the Shell
  // tree (the Agent overlay, at the app root) can bound themselves to the content area —
  // its expanded left edge reads `--app-content-left`, which this attribute flips.
  useEffect(() => {
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  }, [collapsed]);

  const navigate = useCallback((page: Page, id: string | null) => {
    setActivePage(page);
    setFocusId(id);
    setNonce((n) => n + 1);
    // Tell the Agent overlay (mounted outside this tree, at the app root) that the user
    // navigated, so it auto-collapses from fullscreen and reveals the page they picked.
    window.dispatchEvent(new CustomEvent('dreamcontext-navigate', { detail: { page } }));
    try {
      window.localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, page);
    } catch {
      // localStorage unavailable — ignore
    }
  }, []);

  const handleSidebarNavigate = useCallback(
    (page: Page) => {
      navigate(page, null);
    },
    [navigate],
  );

  const clearFocus = useCallback(() => setFocusId(null), []);

  return (
    <div className="shell">
      <Header
        onNavigate={handleSidebarNavigate}
        sidebarCollapsed={collapsed}
        onToggleSidebar={toggleSidebar}
        onOpenSearch={() => setPaletteOpen(true)}
      />
      <div className="shell-body">
        <Sidebar activePage={activePage} onNavigate={handleSidebarNavigate} collapsed={collapsed} />
        <main className="shell-main">
          {children({ page: activePage, focusId, nonce, navigate, clearFocus })}
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
      />
    </div>
  );
}
