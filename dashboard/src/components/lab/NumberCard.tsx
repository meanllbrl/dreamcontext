import type { Series } from '../../hooks/useLab';

/** Second-to-last / last point delta, for a small up/down indicator. */
function computeDelta(series: Series[]): number | null {
  const points = series[0]?.points ?? [];
  if (points.length < 2) return null;
  const prev = points[points.length - 2].v;
  const curr = points[points.length - 1].v;
  return curr - prev;
}

/** A `number` render: latest value + unit + a delta-vs-previous indicator. */
export function NumberCard({ latest, unit, series }: { latest: number | null; unit: string | null; series: Series[] }) {
  const delta = computeDelta(series);
  const deltaColor = delta === null ? 'var(--color-text-tertiary)' : delta > 0 ? 'var(--color-success)' : delta < 0 ? 'var(--color-error)' : 'var(--color-text-tertiary)';
  const deltaSign = delta !== null && delta > 0 ? '+' : '';

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
    </div>
  );
}
