import { useCallback, useEffect, useState } from 'react';
import { BoardPage } from '../components/lab/board/BoardPage';
import { FunnelDetailPage } from '../components/lab/funnel/FunnelDetailPage';
import { LabAppPage } from '../components/lab/LabAppPage';
import { LabRoutedInsight } from '../components/lab/LabRoutedInsight';
import {
  clearLabPath,
  flushBufferedRoute,
  pushLabBoardPath,
  pushLabPath,
  setLabRouteWritable,
  useLabRoute,
} from '../components/lab/funnel/labRoute';
import { useInstanceEvent, useVault } from '../context/VaultContext';
import type { FocusTarget } from '../hooks/useFocusTarget';
import { useLabPrefs } from '../hooks/useLabPrefs';
import './LabPage.css';

interface LabPageProps {
  /** Shell navigation focus — opens that insight's detail panel (⌘K recall hit). */
  focus?: FocusTarget;
}

/**
 * Lab — the analytics-insights dashboard page. Boards are the default view:
 * the bare page opens the saved board (`.lab-prefs.json` `activeBoard`, else
 * the first), `/lab/b/<board>` opens that one, and picking a tab pushes its
 * address and saves it. Multi-page insights (`render: funnel` and `render: app`) route to
 * `/lab/<slug>` and a render-specific sub-segment (`/f/<funnelId>` for
 * funnel, `/p/<pageId>` for app) with real history entries, so back/forward
 * and deep links work. A bare `/lab/<slug>` dispatches by the insight's
 * actual render (`LabRoutedInsight`) rather than assuming funnel. Strictly
 * self-contained; no reach into Roadmap.
 */
export function LabPage({ focus }: LabPageProps = {}) {
  const { bus, isActive } = useVault();
  const route = useLabRoute();
  const { prefs, setActiveBoard } = useLabPrefs();
  const [toast, setToast] = useState<string | null>(null);
  const onBoardChange = useCallback((slug: string) => {
    setActiveBoard(slug);
    pushLabBoardPath(slug, 'push', bus);
  }, [setActiveBoard, bus]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  // Leaving the Lab page (sidebar/palette navigation unmounts us) resets the
  // path so a reload doesn't resurrect a funnel page under another section.
  // Declared BEFORE the address-bar effect on purpose: React runs a component's cleanups in
  // declaration order, so on unmount this one still runs while we hold the address bar.
  useEffect(() => () => clearLabPath(bus), [bus]);

  // This page is the only surface that routes, so it is also the one that claims the
  // window's single address bar for its project — held while this chip is the one you're
  // looking at, handed back when it isn't. Coming forward restores the route parked on the
  // way out, which is what makes switching chips land you where you left the funnel.
  useEffect(() => {
    if (!isActive) return;
    setLabRouteWritable(true, bus);
    flushBufferedRoute();
    return () => setLabRouteWritable(false, bus);
  }, [isActive, bus]);

  // Re-clicking "Insights" in the sidebar (or palette) while deep in a funnel
  // page returns to the board — the nav event fires for every navigate(). On this instance's
  // bus, not `window`: `Shell` emits it per project, so on `window` one project's navigation
  // would reset every other open project's funnel page to its board.
  useInstanceEvent<{ page?: string } | undefined>('dreamcontext-navigate', (detail) => {
    if (detail?.page === 'lab') clearLabPath(bus);
  });

  let content;
  if (route.slug && route.funnelId) {
    content = (
      <FunnelDetailPage
        slug={route.slug}
        funnelId={route.funnelId}
        onBack={() => pushLabPath(route.slug, null, bus)}
        onBackToBoard={() => pushLabPath(null, null, bus)}
        onToast={setToast}
      />
    );
  } else if (route.slug && route.pageId) {
    content = (
      <LabAppPage
        key={route.slug}
        slug={route.slug}
        pageId={route.pageId}
        onBack={() => pushLabPath(null, null, bus)}
        onToast={setToast}
      />
    );
  } else if (route.slug) {
    content = (
      <LabRoutedInsight
        slug={route.slug}
        onBack={() => pushLabPath(null, null, bus)}
        onToast={setToast}
      />
    );
  } else {
    content = (
      <BoardPage
        board={route.board ?? prefs.activeBoard}
        onBoardChange={onBoardChange}
        focus={focus}
      />
    );
  }

  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      {content}
      {toast && route.slug && <div className="lab-toast">{toast}</div>}
    </div>
  );
}
