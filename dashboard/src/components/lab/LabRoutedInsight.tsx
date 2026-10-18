import { useLabInsight } from '../../hooks/useLab';
import { FunnelDetailPage } from './funnel/FunnelDetailPage';
import { FunnelExplorerPage } from './funnel/FunnelExplorerPage';
import { FunnelOverviewPage } from './funnel/FunnelOverviewPage';
import { LabAppPage } from './LabAppPage';

/**
 * `/lab/<slug>` and `/lab/<slug>/f/<funnelId>` — dispatches by the insight's
 * ACTUAL shape. A `preset: funnel-explorer` insight is its explorer card, full
 * page, on both addresses (the picked funnel rides the path). Otherwise `funnel`
 * and `app` are the routed renders (`chartRegistry`'s `routed: true`); a bare
 * `route.slug` used to render `FunnelOverviewPage` unconditionally, which was
 * only ever safe while funnel was the only one.
 *
 * Reads the insight off the SAME `useLabInsight(slug)` query key
 * `FunnelOverviewPage`/`FunnelDetailPage`/`LabAppPage` read themselves —
 * react-query dedupes by key, so this dispatcher costs no extra request.
 */
export function LabRoutedInsight({ slug, funnelId = null, onBack, onBackToInsight, onToast }: {
  slug: string;
  funnelId?: string | null;
  onBack: () => void;
  /** `/f/<funnelId>` → `/lab/<slug>` (the funnel detail page's breadcrumb). */
  onBackToInsight?: () => void;
  onToast: (msg: string) => void;
}) {
  const detail = useLabInsight(slug);
  const insight = detail.data?.insight;

  if (insight?.preset === 'funnel-explorer') {
    return <FunnelExplorerPage key={slug} slug={slug} funnelId={funnelId} title={insight.title} onBack={onBack} onToast={onToast} />;
  }
  // Unknown/loading shape keeps the page this address always drew — each
  // owns its own loading/error/empty states, so this never blanks the screen
  // while `detail` resolves.
  if (funnelId) {
    return (
      <FunnelDetailPage
        slug={slug}
        funnelId={funnelId}
        onBack={onBackToInsight ?? onBack}
        onBackToBoard={onBack}
        onToast={onToast}
      />
    );
  }
  if (insight?.render === 'app') {
    return <LabAppPage key={slug} slug={slug} pageId={null} onBack={onBack} onToast={onToast} />;
  }
  return <FunnelOverviewPage slug={slug} onBack={onBack} onToast={onToast} />;
}
