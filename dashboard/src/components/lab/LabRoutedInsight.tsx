import { useLabInsight } from '../../hooks/useLab';
import { FunnelOverviewPage } from './funnel/FunnelOverviewPage';
import { LabAppPage } from './LabAppPage';

/**
 * `/lab/<slug>` with no sub-segment — dispatches by the insight's ACTUAL
 * render. `funnel` and `app` are both routed renders today (`chartRegistry`'s
 * `routed: true`); a bare `route.slug` used to render `FunnelOverviewPage`
 * unconditionally, which was only ever safe while funnel was the only one.
 *
 * Reads the render off the SAME `useLabInsight(slug)` query key
 * `FunnelOverviewPage`/`LabAppPage` read themselves — react-query dedupes by
 * key, so this dispatcher costs no extra request.
 */
export function LabRoutedInsight({ slug, onBack, onToast }: {
  slug: string;
  onBack: () => void;
  onToast: (msg: string) => void;
}) {
  const detail = useLabInsight(slug);
  const render = detail.data?.insight.render;

  if (render === 'app') {
    return <LabAppPage key={slug} slug={slug} pageId={null} onBack={onBack} onToast={onToast} />;
  }
  // Unknown/loading render defaults to the funnel page (today's only other
  // routed render, and the prior unconditional default) — FunnelOverviewPage
  // owns its own loading/error/empty states, so this never blanks the screen
  // while `detail` resolves.
  return <FunnelOverviewPage slug={slug} onBack={onBack} onToast={onToast} />;
}
