import { useEffect, useState } from 'react';
import { LabBoard } from '../components/lab/LabBoard';
import { FunnelOverviewPage } from '../components/lab/funnel/FunnelOverviewPage';
import { FunnelDetailPage } from '../components/lab/funnel/FunnelDetailPage';
import { clearLabPath, pushLabPath, useLabRoute } from '../components/lab/funnel/labRoute';
import './LabPage.css';

/**
 * Lab — the analytics-insights dashboard page. The board is the default view;
 * multi-page insights (today: `render: funnel`) route to `/lab/<slug>` and
 * `/lab/<slug>/f/<funnelId>` with real history entries, so back/forward and
 * deep links work. Strictly self-contained; no reach into Roadmap.
 */
export function LabPage() {
  const route = useLabRoute();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  // Leaving the Lab page (sidebar/palette navigation unmounts us) resets the
  // path so a reload doesn't resurrect a funnel page under another section.
  useEffect(() => () => clearLabPath(), []);

  // Re-clicking "Insights" in the sidebar (or palette) while deep in a funnel
  // page returns to the board — the nav event fires for every navigate().
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const page = (e as CustomEvent<{ page?: string }>).detail?.page;
      if (page === 'lab') clearLabPath();
    };
    window.addEventListener('dreamcontext-navigate', onNavigate);
    return () => window.removeEventListener('dreamcontext-navigate', onNavigate);
  }, []);

  let content;
  if (route.slug && route.funnelId) {
    content = (
      <FunnelDetailPage
        slug={route.slug}
        funnelId={route.funnelId}
        onBack={() => pushLabPath(route.slug, null)}
        onBackToBoard={() => pushLabPath(null, null)}
        onToast={setToast}
      />
    );
  } else if (route.slug) {
    content = (
      <FunnelOverviewPage
        slug={route.slug}
        onBack={() => pushLabPath(null, null)}
        onToast={setToast}
      />
    );
  } else {
    content = <LabBoard />;
  }

  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      {content}
      {toast && route.slug && <div className="lab-toast">{toast}</div>}
    </div>
  );
}
