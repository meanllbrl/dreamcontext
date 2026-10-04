import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useLabExplorer } from '../../../hooks/useBoards';
import { useLabInsight, type InsightDetail } from '../../../hooks/useLab';
import { EMPTY_VIEW, setTab, type CardView } from '../../lab/board/cardViewState';
import { formatValue } from '../../lab/chartBody';
import { LineChart } from '../../lab/LineChart';
import { Sparkline } from '../../lab/Sparkline';
import { InsightView } from '../../sleepy/chat/InsightView';
import { isValidWidgetRef } from '../widgetModel';
import { useWbText } from '../whiteboardHost';
import { FunnelMini } from './FunnelMini';
import { lanesTab } from './funnelWidgetModel';
import { LabCardView } from './LabCardView';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import { WidgetWindowChip } from './WidgetWindowChip';
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
 * figure WITH a sparkline AND a line chart (two charts). Other renders (bar, pie…) are one chart already and stay on it.
 *
 * A FUNNEL is its own lane: S/M draw the headline (top-step users, the share that reached the
 * last step) over a mini lane (`FunnelMini`); L/XL draw the Lab funnel explorer itself, the card
 * `lab board add-card --preset funnel-explorer` makes (breakdown chips, Daily / Benchmark / Flow
 * / Steps / Segments tabs), opened on Steps, with a full-screen view. A funnel insight whose cache
 * holds no funnel set (never synced) falls back to the plain card.
 *
 * Every size prints the window the data is for and, once the widget is active, lets it change
 * (`WidgetWindowChip`: the insight's range tweak, then a re-sync).
 */
export function InsightWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const ref = isValidWidgetRef(payload.ref) ? payload.ref : null;
  // Same query key as InsightView's own, so this costs no second request. It is here to turn a
  // dangling ref into an explicit "not found" whatever InsightView's own wording is.
  const { isError, data, isLoading } = useLabInsight(ref);
  const title = payload.title || data?.insight.title || ref || tx('whiteboard.kind.insight', 'Insight');
  const [fullscreen, setFullscreen] = useState(false);
  const funnel = !!data?.cache?.funnel && data.insight.render === 'funnel';
  const explorer = funnel && (size === 'l' || size === 'xl');

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
  } else if (explorer && ref) {
    body = <FunnelExplorerBody slug={ref} fullscreen={fullscreen} onExitFullscreen={() => setFullscreen(false)} fallback={<InsightView spec={{ type: 'insight', id: ref, view: 'card' }} />} />;
  } else if (funnel && (size === 's' || size === 'm')) {
    body = <FunnelMini detail={data} size={size} />;
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

  return (
    <WidgetFrame
      kind="insight"
      title={ownTitle ? title : ''}
      active={active}
      size={size}
      meta={ref && data ? <WidgetWindowChip slug={ref} /> : null}
      actions={explorer ? (
        <WidgetButton onClick={() => setFullscreen(true)} title={tx('whiteboard.labCard.fullscreen', 'Full screen')}>⤢</WidgetButton>
      ) : null}
    >
      {body}
    </WidgetFrame>
  );
}

/**
 * The funnel explorer of one insight (`GET /api/lab/explorer/:slug`), drawn as the Lab card,
 * opened on its Steps tab. The explorer's tab and chip labels follow the dashboard's language.
 * While it loads, or when the server has no funnel set to build it from, the plain insight
 * card stands in, so the widget is never blank.
 */
function FunnelExplorerBody({ slug, fullscreen, onExitFullscreen, fallback }: {
  slug: string;
  fullscreen: boolean;
  onExitFullscreen: () => void;
  fallback: ReactNode;
}) {
  const { locale } = useI18n();
  const lang = locale.toLowerCase().startsWith('tr') ? 'tr' : 'en';
  const shown = useLabExplorer(slug, lang);
  const card = shown.data?.board.cards[0] ?? null;
  const initialView = useMemo<CardView | undefined>(() => {
    const at = card ? lanesTab(card) : null;
    return at ? setTab(EMPTY_VIEW, at.path, at.tab) : undefined;
  }, [card]);
  if (!shown.data || !card) return <>{fallback}</>;
  return (
    <LabCardView
      // A new card shape (a dimension added upstream) starts a fresh view.
      key={card.blocks?.length ?? 0}
      response={shown.data}
      card={card}
      fullscreen={fullscreen}
      onExitFullscreen={onExitFullscreen}
      initialView={initialView}
    />
  );
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

/**
 * The Lab's line chart, filling the space left under the headline. LineChart measures its own
 * box in layout pixels (zoom-proof) and draws to it, so it is given no height: a fixed one would
 * be a pixel height, and any guess at it overflows the card or letterboxes it.
 */
function InsightChart({ detail }: { detail: InsightDetail }) {
  const tx = useWbText();
  return (
    <div className="wb-insight-chart">
      <LineChart
        series={detail.cache?.series ?? []}
        unit={detail.cache?.unit ?? detail.insight.unit ?? null}
        emptyHint={tx('whiteboard.insight.noData', 'No data yet.')}
      />
    </div>
  );
}
