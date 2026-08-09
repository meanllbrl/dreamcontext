import type { Series } from '../../hooks/useLab';
import { LineChart } from './LineChart';
import { Sparkline } from './Sparkline';
import type { ChartBodyProps } from './chartBody';

/** Second-to-last / last point delta, for a small up/down indicator. */
function computeDelta(series: Series[]): number | null {
  const points = series[0]?.points ?? [];
  if (points.length < 2) return null;
  const prev = points[points.length - 2].v;
  const curr = points[points.length - 1].v;
  return curr - prev;
}

/** Trailing points of the bound series — the sparkline's whole input. */
const SPARK_POINTS = 24;

/** A `number` render: latest value + unit + a delta-vs-previous indicator, with
 *  an inline sparkline so the number carries its own trend (a single figure
 *  can't say whether it is climbing or falling). */
export function NumberCard({ latest, unit, series }: { latest: number | null; unit: string | null; series: Series[] }) {
  const delta = computeDelta(series);
  const deltaColor = delta === null ? 'var(--color-text-tertiary)' : delta > 0 ? 'var(--color-success)' : delta < 0 ? 'var(--color-error)' : 'var(--color-text-tertiary)';
  const deltaSign = delta !== null && delta > 0 ? '+' : '';
  const sparkPoints = (series[0]?.points ?? []).slice(-SPARK_POINTS);

  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 32, color: 'var(--color-text)', letterSpacing: '-0.02em' }}>
        {latest !== null ? latest.toLocaleString() : '—'}
      </span>
      {unit && <span style={{ fontSize: 14, color: 'var(--color-text-tertiary)' }}>{unit}</span>}
      {delta !== null && (
        <span style={{ fontSize: 13, fontWeight: 600, color: deltaColor }}>
          {deltaSign}{delta.toLocaleString()}
        </span>
      )}
      {sparkPoints.length > 1 && (
        <span
          style={{ alignSelf: 'center', marginLeft: 'auto', flexShrink: 0 }}
          title={`Last ${sparkPoints.length} points`}
        >
          <Sparkline points={sparkPoints} color={deltaColor} />
        </span>
      )}
    </div>
  );
}

/** Registry body (`number`) — the card's whole story is the figure itself. */
export function NumberBody({ summary, series }: ChartBodyProps) {
  return <NumberCard latest={summary.latest} unit={summary.unit} series={series} />;
}

/** Registry detail body (`number`): the panel has room for the real trend, so
 *  the glyph is joined by a full line chart whenever there is a series to draw. */
export function NumberDetailBody({ summary, series }: ChartBodyProps) {
  return (
    <>
      <NumberCard latest={summary.latest} unit={summary.unit} series={series} />
      {series.some((s) => s.points.length > 1) && (
        <div className="idp-chart-trend">
          <LineChart series={series} unit={summary.unit} height={280} />
        </div>
      )}
    </>
  );
}
