import { useCallback, useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar, type Page } from './Sidebar';
import './Shell.css';

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
  const [activePage, setActivePage] = useState<Page>('brain');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const navigate = useCallback((page: Page, id: string | null) => {
    setActivePage(page);
    setFocusId(id);
    setNonce((n) => n + 1);
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
      <Header />
      <div className="shell-body">
        <Sidebar activePage={activePage} onNavigate={handleSidebarNavigate} />
        <main className="shell-main">
          {children({ page: activePage, focusId, nonce, navigate, clearFocus })}
        </main>
      </div>
    </div>
  );
}
