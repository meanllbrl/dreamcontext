import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../context/ThemeContext';
import { startWindowDrag, toggleMaximizeWindow } from '../../lib/desktop';
import { SearchIcon } from '../sleepy/TypeIcons';
import { UpdateBadge } from './UpdateBadge';
import type { Page } from './Sidebar';
import './Header.css';

const ZOOM_LEVELS = [0.85, 0.9, 1.0, 1.1, 1.2];
const ZOOM_STORAGE_KEY = 'dreamcontext-zoom';

function getStoredZoom(): number {
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (stored !== null) {
      const val = parseFloat(stored);
      if (ZOOM_LEVELS.includes(val)) return val;
    }
  } catch { /* ignore */ }
  return 1.0;
}

function applyZoom(zoom: number) {
  document.documentElement.style.setProperty('--zoom', String(zoom));
  // Broadcast so surfaces that don't read CSS font tokens can react — notably the
  // embedded Agent terminal, whose xterm font size is set imperatively in JS and
  // would otherwise ignore app zoom entirely.
  window.dispatchEvent(new CustomEvent('dreamcontext-zoom', { detail: zoom }));
}

/** Active vault display name (passed by the launcher via `?vault=`). */
function readVaultLabel(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('vault') ?? '';
  } catch {
    return '';
  }
}

interface HeaderProps {
  /** Switch the active page (used by the update badge to open Packs). */
  onNavigate?: (page: Page) => void;
  /** Whether the rail is collapsed (drives the toggle icon state). */
  sidebarCollapsed: boolean;
  /** Collapse/expand the rail — the title-bar owns this control. */
  onToggleSidebar: () => void;
  /** Open the global ⌘K command palette (the persistent search pill). */
  onOpenSearch?: () => void;
}

/**
 * Title bar. Mirrors the design: a sidebar toggle on the left, the active vault
 * name centered, and utility controls on the right. The brand wordmark lives
 * ONLY in the sidebar lockup now — the header no longer repeats it.
 */
export function Header({ onNavigate, sidebarCollapsed, onToggleSidebar, onOpenSearch }: HeaderProps) {
  const { theme, setTheme, resolved } = useTheme();
  const queryClient = useQueryClient();
  const [zoom, setZoom] = useState(getStoredZoom);
  const [refreshing, setRefreshing] = useState(false);

  const vaultLabel = readVaultLabel();

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

  useEffect(() => {
    applyZoom(zoom);
  }, [zoom]);

  const cycleTheme = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  };

  const themeLabel = theme === 'system' ? `System (${resolved})` : resolved === 'dark' ? 'Dark' : 'Light';

  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const canZoomOut = zoomIndex > 0;
  const canZoomIn = zoomIndex < ZOOM_LEVELS.length - 1;

  const changeZoom = (delta: -1 | 1) => {
    const nextIndex = zoomIndex + delta;
    if (nextIndex < 0 || nextIndex >= ZOOM_LEVELS.length) return;
    const next = ZOOM_LEVELS[nextIndex];
    setZoom(next);
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(next)); } catch { /* ignore */ }
  };

  return (
    <header
      className="header"
      // NOTE: deliberately NO `data-tauri-drag-region`. That attribute injects
      // Tauri's OWN drag + double-click-maximize handlers, and the dblclick →
      // toggleMaximize part fires even with `dragDropEnabled: false` — competing
      // with our handler (and macOS native zoom) and flickering the window
      // between maximized/restored. We remove it and own both gestures in JS.
      //
      // Drag: start ONLY after the pointer moves past a small threshold, so plain
      // clicks and double-clicks are NOT forwarded to the native window (which
      // would trigger native zoom on top of ours). Maximize is our single,
      // deterministic onDoubleClick below.
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target;
        if (target instanceof Element &&
            target.closest('button, input, a, select, textarea, [role="button"], [data-no-drag]')) return;
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 4 || Math.abs(me.clientY - sy) > 4) {
            cleanup();
            void startWindowDrag(target);
          }
        };
        const cleanup = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', cleanup);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', cleanup);
      }}
      onDoubleClick={(e) => void toggleMaximizeWindow(e.target)}
    >
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

      {vaultLabel && <div className="header-vault" title={vaultLabel}>{vaultLabel}</div>}

      <div className="header-right">
        <button
          className={`header-refresh ${refreshing ? 'header-refresh--spinning' : ''}`}
          onClick={refreshAll}
          disabled={refreshing}
          title="Refresh now"
          aria-label="Refresh now"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13.65 4.5A6 6 0 1 0 14 8" />
            <path d="M14 2v3h-3" />
          </svg>
        </button>
        <UpdateBadge onManagePacks={onNavigate ? () => onNavigate('packs') : undefined} />
        <div className="zoom-controls">
          <button className="zoom-btn" onClick={() => changeZoom(-1)} disabled={!canZoomOut} title="Zoom out">-</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="zoom-btn" onClick={() => changeZoom(1)} disabled={!canZoomIn} title="Zoom in">+</button>
        </div>
        <button className="theme-toggle" onClick={cycleTheme} title={`Theme: ${themeLabel}`}>
          {resolved === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 1zm0 10a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 11zm7-3a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 15 8zM5 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 5 8zm7.07-4.07a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 1 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zM6.05 10.66a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 0 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zm7.72 3.12a.5.5 0 0 1-.71 0l-1.41-1.41a.5.5 0 1 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM5.34 6.05a.5.5 0 0 1-.71 0L3.22 4.64a.5.5 0 0 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
