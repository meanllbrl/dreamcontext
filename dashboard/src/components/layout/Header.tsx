import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useVault } from '../../context/VaultContext';
import { SearchIcon } from '../sleepy/TypeIcons';
import { UpdateBadge } from './UpdateBadge';
import { SleepDebtTracker } from './SleepDebtTracker';
import type { Page } from './Sidebar';
import './Header.css';

interface HeaderProps {
  /** Switch the active page (used by the update badge to open Packs). */
  onNavigate?: (page: Page, id?: string) => void;
  /** Whether the rail is collapsed (drives the toggle icon state). */
  sidebarCollapsed: boolean;
  /** Collapse/expand the rail — the title-bar owns this control. */
  onToggleSidebar: () => void;
  /** Open the global ⌘K command palette (the persistent search pill). */
  onOpenSearch?: () => void;
}

/**
 * One PROJECT's header — a sidebar toggle and the search pill on the left, that project's
 * own status controls on the right.
 *
 * It is no longer the title bar, and it no longer says which project it belongs to. One
 * window now holds several projects at once, so both of those became window-level jobs and
 * moved to `WindowChrome`: the chip strip names the projects, and the zoom control, the
 * theme toggle and the drag/maximize gestures belong to the window that contains them all.
 * What stays here is what is genuinely per-vault — this project's sleep debt, this project's
 * refresh, this project's update badge — because N of them are mounted at once and each must
 * answer for its own vault.
 */
export function Header({ onNavigate, sidebarCollapsed, onToggleSidebar, onOpenSearch }: HeaderProps) {
  const queryClient = useQueryClient();
  const { isActive } = useVault();
  const [refreshing, setRefreshing] = useState(false);

  // Manual refresh: pull every active query at once (sleep debt, tasks,
  // knowledge, …). Queries also poll on an interval, but this gives an
  // immediate update without waiting or switching pages.
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ type: 'active' });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <header className="header">
      <div className="header-left">
        <button
          className="header-icon-btn"
          data-testid="sidebar-collapse"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!sidebarCollapsed}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.4" y="2.4" width="13.2" height="11.2" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
            <line x1="6.1" y1="2.8" x2="6.1" y2="13.2" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>

        {/* Persistent global search pill → ⌘K command palette. A real <button> with
            data-no-drag so clicking it never starts the title-bar window drag. */}
        <button
          className="header-search-pill"
          data-no-drag
          onClick={onOpenSearch}
          title="Search the brain (⌘K)"
          aria-label="Search the brain"
        >
          <span className="header-search-pill-icon" aria-hidden="true"><SearchIcon size={14} /></span>
          <span className="header-search-pill-text">Search the brain…</span>
          <kbd className="header-search-pill-kbd">⌘K</kbd>
        </button>
      </div>

      <div className="header-right">
        <SleepDebtTracker onOpen={onNavigate ? () => onNavigate('sleep') : undefined} />
        <button
          className={`header-refresh ${refreshing ? 'header-refresh--spinning' : ''}`}
          onClick={refreshAll}
          disabled={refreshing || !isActive}
          title="Refresh now"
          aria-label="Refresh now"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13.65 4.5A6 6 0 1 0 14 8" />
            <path d="M14 2v3h-3" />
          </svg>
        </button>
        <UpdateBadge onManagePacks={onNavigate ? () => onNavigate('packs') : undefined} />
      </div>
    </header>
  );
}
