import { computeStepRows } from './funnelModel';
import './FunnelBars.css';

/**
 * Compact funnel fallback — the v0-style vertical bar list. Used for legacy
 * `Series[]` payloads under `render: funnel` (no funnel-set in the cache) and
 * as the narrow-width fallback below the lane breakpoint. Pure display.
 */
export function FunnelBars({ steps, dense = false }: {
  steps: { key: string; label: string; users: number }[];
  dense?: boolean;
}) {
  const rows = computeStepRows(steps);
  if (rows.length === 0) {
    return <div className="funnel-bars-empty">No steps.</div>;
  }
  const max = Math.max(1, ...rows.map((r) => r.users));
  return (
    <div className={`funnel-bars${dense ? ' funnel-bars--dense' : ''}`}>
      {rows.map((row) => (
        <div key={row.key} className="funnel-bars-row" title={`${row.label}: ${row.users.toLocaleString('en-US')} users${row.ofTop !== null ? ` · ${row.ofTop.toFixed(1)}% of top` : ''}`}>
          <span className="funnel-bars-label">{row.label}</span>
          <span className="funnel-bars-track">
            <span className="funnel-bars-fill" style={{ width: `${(row.users / max) * 100}%` }} />
          </span>
          <span className="funnel-bars-value">
            {row.users.toLocaleString('en-US')}
            {row.ofTop !== null && <span className="funnel-bars-pct"> · {row.ofTop.toFixed(row.ofTop >= 10 ? 0 : 1)}%</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
