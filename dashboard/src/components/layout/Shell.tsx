import { useCallback, useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar, type Page } from './Sidebar';
import { useSidebarCollapse } from '../../hooks/useSidebarCollapse';
import './Shell.css';

const ACTIVE_PAGE_STORAGE_KEY = 'dreamcontext.dashboard.activePage';
const VALID_PAGES: readonly Page[] = ['sleepy', 'tasks', 'core', 'knowledge', 'features', 'sleep', 'brain', 'council', 'taxonomy', 'settings', 'packs', 'about'];

function readStoredPage(): Page {
  if (typeof window === 'undefined') return 'brain';
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
  return 'sleepy';
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
  const { collapsed, toggle: toggleSidebar } = useSidebarCollapse();

  const navigate = useCallback((page: Page, id: string | null) => {
    setActivePage(page);
    setFocusId(id);
    setNonce((n) => n + 1);
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
      <Header onNavigate={handleSidebarNavigate} sidebarCollapsed={collapsed} onToggleSidebar={toggleSidebar} />
      <div className="shell-body">
        <Sidebar activePage={activePage} onNavigate={handleSidebarNavigate} collapsed={collapsed} />
        <main className="shell-main">
          {children({ page: activePage, focusId, nonce, navigate, clearFocus })}
        </main>
      </div>
    </div>
  );
}
