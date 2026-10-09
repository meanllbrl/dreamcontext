import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import {
  RANKING_DEFAULT_FLOOR,
  RANKING_FLOORS,
  rankableMetrics,
  rankingRows,
  selectionKey,
  type FunnelFrame,
  type RankingRow,
} from '../../../generated/frameOps';
import { fill, fmtCount, fmtMetric, fmtMetricDelta, formatRateOrKn, NO_VALUE, rateAttrs } from '../explorer/explorerFormat';
import '../explorer/explorer.css';
import { BlockEmpty, drawableFrame, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import { selectionLabel } from './BreakdownBlock';

/**
 * `ranking`: each funnel's best breakdown on one metric (rankingRows): the
 * reader picks the metric and ONE user floor (30, 100 or 300, default 300),
 * rows read best first. A path under the floor never competes, a duplicate
 * intersection never shows twice (the reference's weakness 7), a low-sample
 * row fades and a rate over a small denominator reads k/n (weakness 5).
 * Nothing is summed: a cells-mode set ranks nothing and says why.
 *
 * Clicking a funnel name opens that funnel on that path for the whole card
 * (`onFunnel` + `onSelection`), when the card gives the block those handles.
 */

/** The metric list the switch offers: the `metrics` pick (in its order, known ones only), else every rankable metric. */
export function rankingMetrics(frame: FunnelFrame, picked: readonly string[] | null): string[] {
  const all = rankableMetrics(frame);
  if (!picked) return all;
  return picked.filter((k, i) => all.includes(k) && picked.indexOf(k) === i);
}

/** The floor in force: a runtime choice from RANKING_FLOORS, else the default. */
export function rankingFloor(choice: number | null): number {
  return choice !== null && (RANKING_FLOORS as readonly number[]).includes(choice) ? choice : RANKING_DEFAULT_FLOOR;
}

export function RankingBlock({ frame, options, selection, onSelection, onFunnel }: BlockViewProps) {
  const { t, locale } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const [floorChoice, setFloorChoice] = useState<number | null>(null);
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <div className="lab-block-fill"><BlockEmpty reason={drawable.empty} /></div>;
  const f = drawable.frame;
  if (f.funnels.length === 0) return <BlockEmpty />;

  const density = options.density === 'comfortable' ? 'comfortable' : 'compact';
  const dimOrder = (f.dimensions ?? []).map((d) => d.key);
  const allLabel = t('lab.blocks.breakdown.all');

  if (f.segmentMode !== 'lookup') {
    return (
      <div className="lab-block-fill lab-rank" data-lab-ranking="">
        <div className="lab-x-empty" data-lab-empty="ranking">{t('lab.explorer.emptyRankingCells')}</div>
      </div>
    );
  }

  const metrics = rankingMetrics(f, stringListOption(options, 'metrics'));
  if (metrics.length === 0) {
    return (
      <div className="lab-block-fill lab-rank" data-lab-ranking="">
        <div className="lab-x-empty" data-lab-empty="ranking"><BlockEmpty /></div>
      </div>
    );
  }
  const metric = picked !== null && metrics.includes(picked) ? picked : metrics[0];
  const floor = rankingFloor(floorChoice);
  const view = rankingRows(f, metric, { minUsers: floor });
  const activeFunnel = stringOption(options, 'funnel') ?? f.funnels[0]?.id ?? null;
  const activeSel = selectionKey(selection ?? {});
  const canOpen = !!onFunnel || !!onSelection;
  const open = (row: RankingRow) => {
    onFunnel?.(row.funnelId);
    onSelection?.(row.selection);
  };
  const labelOfMetric = (k: string) => (k === view.metric ? view.label : rankingLabel(f, k));

  const controls = (
    <div className="lab-x-controls">
      {metrics.length > 1 && (
        <div className="lab-x-segmented" role="radiogroup" aria-label={t('lab.explorer.rankingMetric')} data-lab-ranking-switch="">
          {metrics.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              className="lab-x-segmented-option"
              data-lab-ranking-metric={k}
              aria-checked={k === metric}
              onClick={() => setPicked(k)}
            >
              {labelOfMetric(k)}
            </button>
          ))}
        </div>
      )}
      <select
        className="lab-x-select"
        data-lab-ranking-floor={floor}
        aria-label={t('lab.explorer.rankingUsers')}
        value={floor}
        onChange={(e) => setFloorChoice(Number(e.target.value))}
      >
        {RANKING_FLOORS.map((n) => (
          <option key={n} value={n}>{fill(t('lab.explorer.rankingMin'), { n: fmtCount(n, locale) })}</option>
        ))}
      </select>
    </div>
  );

  const dropped = view.dropped.length > 0 ? (
    <div className="lab-x-note" data-lab-ranking-dropped={view.dropped.length} title={view.dropped.map((d) => d.funnelName).join(', ')}>
      {fill(t('lab.explorer.rankingDropped'), { n: view.dropped.length, min: fmtCount(floor, locale) })}
    </div>
  ) : null;

  if (view.rows.length === 0) {
    return (
      <div className="lab-block-fill lab-rank" data-lab-ranking="" data-metric={metric}>
        {controls}
        <div className="lab-x-empty" data-lab-empty="ranking">
          {fill(t('lab.explorer.emptyRanking'), { n: fmtCount(floor, locale), metric: view.label })}
        </div>
        {dropped}
      </div>
    );
  }

  return (
    <div className="lab-block-fill lab-rank" data-lab-ranking="" data-metric={metric}>
      {controls}
      <div className="lab-x-table-wrap">
        <table className="lab-x-table" data-density={density}>
          <thead>
            <tr>
              <th scope="col" className="lab-rank-rank">#</th>
              <th scope="col">{t('lab.explorer.picker')}</th>
              <th scope="col">{t('lab.explorer.rankingBest')}</th>
              <th scope="col" className="lab-x-r">{view.label}</th>
              <th scope="col" className="lab-x-r" data-lab-ranking-delta-head="">{t('lab.explorer.rankingDelta')}</th>
              <th scope="col" className="lab-x-r">{t('lab.explorer.rankingUsers')}</th>
              <th scope="col" className="lab-x-r">{t('lab.explorer.rankingTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, i) => {
              const shown = formatRateOrKn(row.value, row.format, row.kn, locale, t);
              const delta = !shown.kn && row.prev !== null ? row.value - row.prev : null;
              const low = row.lowSample ? t('lab.explorer.lowSampleRow') : undefined;
              const active = row.funnelId === activeFunnel && selectionKey(row.selection) === activeSel;
              return (
                <tr
                  key={row.funnelId}
                  data-lab-ranking-row={row.funnelId}
                  data-selection={selectionKey(row.selection)}
                  data-value={row.value}
                  data-low-sample={row.lowSample ? 'true' : undefined}
                  data-active={active ? '' : undefined}
                  title={low}
                >
                  <td className="lab-rank-rank lab-x-num">{i + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="lab-rank-open"
                      data-lab-ranking-open={row.funnelId}
                      disabled={!canOpen}
                      title={row.funnelName}
                      onClick={() => open(row)}
                    >
                      {row.funnelName}
                    </button>
                  </td>
                  <td className="lab-rank-sel">{selectionLabel(row.selection, dimOrder) ?? allLabel}</td>
                  <td className="lab-x-r">
                    <span className="lab-rank-value">
                      <span className="lab-x-dot" data-tone={row.tone ?? undefined} aria-hidden="true" />
                      <span {...rateAttrs(shown)}>{shown.text}</span>
                    </span>
                  </td>
                  <td className="lab-x-r lab-x-num">
                    {delta !== null
                      ? (
                        <span
                          className="lab-x-delta"
                          data-lab-ranking-delta=""
                          data-sign={delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}
                          title={`${t('lab.explorer.rankingDelta')}: ${fmtMetricDelta(delta, row.format, locale)}`}
                        >
                          {fmtMetricDelta(delta, row.format, locale)}
                        </span>
                      )
                      : (
                        <span className="lab-x-unmeasured" data-lab-ranking-no-prev="" title={shown.kn ? shown.title ?? undefined : t('lab.explorer.rankingNoPrev')}>
                          {NO_VALUE}
                        </span>
                      )}
                  </td>
                  <td className="lab-x-r lab-x-num">{fmtCount(row.users, locale)}</td>
                  <td className="lab-x-r lab-x-num">
                    {row.total === null
                      ? <span className="lab-x-unmeasured">{t('lab.explorer.notMeasured')}</span>
                      : fmtMetric(row.total, row.format, locale)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dropped}
    </div>
  );
}

/** A metric's label from the frame's funnels (the first that carries it), else its key. */
function rankingLabel(frame: FunnelFrame, key: string): string {
  for (const f of frame.funnels) {
    const m = f.metrics?.[key] ?? f.segments?.find((s) => s.metrics?.[key])?.metrics?.[key];
    if (m) return m.label ?? key;
  }
  return key;
}
