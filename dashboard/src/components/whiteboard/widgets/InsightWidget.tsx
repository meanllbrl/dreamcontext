import { useLabInsight, type InsightDetail } from '../../../hooks/useLab';
import { formatValue } from '../../lab/chartBody';
import { Sparkline } from '../../lab/Sparkline';
import { InsightView } from '../../sleepy/chat/InsightView';
import { isValidWidgetRef } from '../widgetModel';
import { useWbText } from '../whiteboardHost';
import { WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * A Lab insight on the board, drawn by slug, so a tracked metric has exactly one source: the
 * synced cache.
 *
 * It renders to its size (A17): S is the headline number and its label, M adds the change since
 * the previous point and a sparkline, L is chat's `InsightView` card and XL its full view. S and
 * M read the same cached detail `InsightView` reads (same query key, no second request) and
 * format the number the way every Lab readout does.
 */
export function InsightWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const ref = isValidWidgetRef(payload.ref) ? payload.ref : null;
  // Same query key as InsightView's own, so this costs no second request. It is here to turn a
  // dangling ref into an explicit "not found" whatever InsightView's own wording is.
  const { isError, data, isLoading } = useLabInsight(ref);
  const title = payload.title || data?.insight.title || ref || tx('whiteboard.kind.insight', 'Insight');

  let body;
  if (!ref) {
    body = <WidgetNotice tone="missing">{tx('whiteboard.widget.badRef', 'This widget has no valid reference.')}</WidgetNotice>;
  } else if (isError || (!isLoading && !data)) {
    body = (
      <WidgetNotice tone="missing">
        {tx('whiteboard.insight.notFound', 'Insight not found:')}&nbsp;<code>{ref}</code>
      </WidgetNotice>
    );
  } else if (size === 's' || size === 'm') {
    body = data
      ? <InsightHeadline detail={data} withTrend={size === 'm'} />
      : <WidgetNotice tone="loading">{tx('whiteboard.widget.loading', 'Loading…')}</WidgetNotice>;
  } else {
    body = <InsightView spec={{ type: 'insight', id: ref, view: size === 'xl' ? 'full' : 'card' }} />;
  }

  // S and M carry the title in the header; L and XL get it from the insight card itself.
  const headTitle = size === 's' || size === 'm' ? title : '';
  return <WidgetFrame kind="insight" title={headTitle} active={active} size={size}>{body}</WidgetFrame>;
}

/** The number, big, with its unit; on M also the change since the previous point and a trend. */
function InsightHeadline({ detail, withTrend }: { detail: InsightDetail; withTrend: boolean }) {
  const tx = useWbText();
  const points = detail.cache?.series?.[0]?.points ?? [];
  const latest = detail.cache?.latest ?? points[points.length - 1]?.v ?? null;
  const unit = detail.cache?.unit ?? detail.insight.unit ?? null;
  const prev = points.length >= 2 ? points[points.length - 2].v : null;
  const delta = latest !== null && prev !== null ? latest - prev : null;
  const value = formatValue(latest, null);

  return (
    <div className="wb-insight-headline">
      <div className="wb-insight-figure">
        <span className={`wb-insight-value${value.length > 7 ? ' is-long' : ''}`}>{value}</span>
        {unit && <span className="wb-insight-unit">{unit}</span>}
      </div>
      {withTrend && (
        <div className="wb-insight-trend">
          {delta !== null && (
            <span className={`wb-insight-delta${delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : ''}`}>
              {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {formatValue(Math.abs(delta), null)}
            </span>
          )}
          <Sparkline points={points.slice(-24)} width={132} height={32} />
        </div>
      )}
      {!detail.cache?.fetchedAt && (
        <span className="wb-insight-foot">{tx('whiteboard.insight.neverSynced', 'Never synced')}</span>
      )}
    </div>
  );
}
