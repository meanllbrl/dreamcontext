import { useLayoutEffect, useRef, useState } from 'react';
import { useLabInsight, type InsightDetail } from '../../../hooks/useLab';
import { formatValue } from '../../lab/chartBody';
import { LineChart } from '../../lab/LineChart';
import { Sparkline } from '../../lab/Sparkline';
import { InsightView } from '../../sleepy/chat/InsightView';
import { isValidWidgetRef } from '../widgetModel';
import { useWbText } from '../whiteboardHost';
import { WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/** The renders whose story is one time series: drawn here as the number over one line chart. */
const SERIES_RENDERS = new Set(['number', 'line']);

/**
 * A Lab insight on the board, drawn by slug, so a tracked metric has exactly one source: the
 * synced cache.
 *
 * It renders to its size (A17): S is the headline number and its label, M adds the change since
 * the previous point and a sparkline, L and XL are the number and its change over ONE chart the
 * width of the card (A19). Every size reads the same cached detail `InsightView` reads (same
 * query key, no second request) and formats the number the way every Lab readout does.
 *
 * L/XL do not reuse `InsightView` for a number or line insight: its full `number` body is the
 * figure WITH a sparkline AND a line chart (two charts), and its chart keeps a fixed height the
 * card letterboxes. Other renders (bar, pie, funnel…) are one chart already and stay on it.
 */
export function InsightWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const ref = isValidWidgetRef(payload.ref) ? payload.ref : null;
  // Same query key as InsightView's own, so this costs no second request. It is here to turn a
  // dangling ref into an explicit "not found" whatever InsightView's own wording is.
  const { isError, data, isLoading } = useLabInsight(ref);
  const title = payload.title || data?.insight.title || ref || tx('whiteboard.kind.insight', 'Insight');

  let body;
  let ownTitle = true;
  if (!ref) {
    body = <WidgetNotice tone="missing">{tx('whiteboard.widget.badRef', 'This widget has no valid reference.')}</WidgetNotice>;
  } else if (isError || (!isLoading && !data)) {
    body = (
      <WidgetNotice tone="missing">
        {tx('whiteboard.insight.notFound', 'Insight not found:')}&nbsp;<code>{ref}</code>
      </WidgetNotice>
    );
  } else if (!data) {
    body = <WidgetNotice tone="loading">{tx('whiteboard.widget.loading', 'Loading…')}</WidgetNotice>;
  } else if (size === 's' || size === 'm') {
    body = <InsightHeadline detail={data} variant={size === 'm' ? 'trend' : 'number'} />;
  } else if (SERIES_RENDERS.has(data.insight.render)) {
    body = (
      <div className="wb-insight-wide">
        <InsightHeadline detail={data} variant="delta" />
        <InsightChart detail={data} />
      </div>
    );
  } else {
    // The insight card carries its own title.
    ownTitle = false;
    body = <InsightView spec={{ type: 'insight', id: ref, view: size === 'xl' ? 'full' : 'card' }} />;
  }

  return <WidgetFrame kind="insight" title={ownTitle ? title : ''} active={active} size={size}>{body}</WidgetFrame>;
}

/**
 * The number, big, with its unit. `trend` (M) adds the change since the previous point and a
 * sparkline; `delta` (L/XL) adds the change only, because the chart under it is the trend.
 */
function InsightHeadline({ detail, variant }: { detail: InsightDetail; variant: 'number' | 'trend' | 'delta' }) {
  const tx = useWbText();
  const points = detail.cache?.series?.[0]?.points ?? [];
  const latest = detail.cache?.latest ?? points[points.length - 1]?.v ?? null;
  const unit = detail.cache?.unit ?? detail.insight.unit ?? null;
  const prev = points.length >= 2 ? points[points.length - 2].v : null;
  const delta = latest !== null && prev !== null ? latest - prev : null;
  const value = formatValue(latest, null);
  const deltaChip = delta !== null && (
    <span className={`wb-insight-delta${delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : ''}`}>
      {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {formatValue(Math.abs(delta), null)}
    </span>
  );

  return (
    <div className={`wb-insight-headline wb-insight-headline--${variant}`}>
      <div className="wb-insight-figure">
        <span className={`wb-insight-value${value.length > 7 ? ' is-long' : ''}`}>{value}</span>
        {unit && <span className="wb-insight-unit">{unit}</span>}
        {variant === 'delta' && deltaChip}
      </div>
      {variant === 'trend' && (
        <div className="wb-insight-trend">
          {deltaChip}
          <Sparkline points={points.slice(-24)} width={132} height={32} />
        </div>
      )}
      {!detail.cache?.fetchedAt && (
        <span className="wb-insight-foot">{tx('whiteboard.insight.neverSynced', 'Never synced')}</span>
      )}
    </div>
  );
}

/** LineChart's fixed viewBox width; its `height` prop is the viewBox height. */
const CHART_VIEW_WIDTH = 560;

/**
 * The Lab's line chart, filling the space left under the headline. LineChart draws into a
 * 560-wide viewBox at the height it is given, so the height handed to it is the box's own
 * aspect ratio at that width: the drawing then fills the box edge to edge instead of being
 * letterboxed. Layout sizes (not the bounding rect) so the board's zoom transform is ignored.
 */
function InsightChart({ detail }: { detail: InsightDetail }) {
  const tx = useWbText();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [viewHeight, setViewHeight] = useState<number | null>(null);
  const series = detail.cache?.series ?? [];

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const { clientWidth: w, clientHeight: h } = box;
      if (w > 0 && h > 0) setViewHeight(Math.max(40, Math.round((CHART_VIEW_WIDTH * h) / w)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={boxRef} className="wb-insight-chart">
      {viewHeight !== null && (
        <LineChart
          series={series}
          unit={detail.cache?.unit ?? detail.insight.unit ?? null}
          height={viewHeight}
          emptyHint={tx('whiteboard.insight.noData', 'No data yet.')}
        />
      )}
    </div>
  );
}
