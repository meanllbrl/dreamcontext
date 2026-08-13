import { createPortal } from 'react-dom';
import { useVault } from '../../context/VaultContext';
import { SearchIcon } from '../sleepy/TypeIcons';
import { UpdateBadge } from './UpdateBadge';
import { SleepDebtTracker } from './SleepDebtTracker';
import { useChromeSlots } from './chromeSlots';
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
 * One PROJECT's title-bar controls, portalled into the window's ONE bar.
 *
 * This used to be a second bar under the chip strip, which spent a full row on four
 * controls. The window bar has the room, so the strip and the controls now share it: the
 * rail toggle and the search pill go into the chrome's LEFT slot, the sleep tracker and the
 * update badge into its RIGHT slot, and the chip strip lives in between. The controls stay
 * mounted HERE — inside this instance's providers — because every one of them is per-vault:
 * the pill opens THIS project's palette, the tracker reads THIS project's sleep debt.
 *
 * Only the active instance renders into the slots. A portal escapes `.project-instance`, so
 * the `hidden`/`inert` shroud that hides a background project would never reach these — N
 * projects would stack N trackers into one slot. `isActive` is the gate instead.
 *
 * The manual refresh button is gone: queries poll on their own interval, and the one bar
 * has better things to hold.
 */
export function Header({ onNavigate, sidebarCollapsed, onToggleSidebar, onOpenSearch }: HeaderProps) {
  const { isActive } = useVault();
  const slots = useChromeSlots();

  if (!isActive) return null;

  return (
    <>
      {slots.left && createPortal(
        <>
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
        </>,
        slots.left,
      )}

      {slots.right && createPortal(
        <>
          <SleepDebtTracker onOpen={onNavigate ? () => onNavigate('sleep') : undefined} />
          <UpdateBadge onManagePacks={onNavigate ? () => onNavigate('packs') : undefined} />
        </>,
        slots.right,
      )}
    </>
  );
}
