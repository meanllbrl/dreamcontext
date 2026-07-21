import type { InsightCache } from '../../../hooks/useLab';
import { formatMetricValue, funnelPreviewRows, metricColumns } from './funnelModel';
import { FunnelBars } from './FunnelBars';
import './FunnelCardPreview.css';

/**
 * The Lab-board card body for a funnel insight — page 1's ENTRY, so it shows a
 * top-N mini-table (name + up to 3 leading metrics), never a blank. Legacy
 * `Series[]` payloads (no cache.funnel) fall back to the compact bar list.
 */
const PREVIEW_ROWS = 5;
const PREVIEW_COLS = 3;

export function FunnelCardPreview({ cache }: { cache: InsightCache | null | undefined }) {
  const entry = cache?.funnel;

  if (!entry) {
    // Legacy payload: first synthesized/legacy series = the step list.
    const first = cache?.series?.[0];
    if (!first || first.points.length === 0) {
      return <div className="funnel-preview-empty">No funnel data yet — sync to fetch.</div>;
    }
    return <FunnelBars dense steps={first.points.map((p, i) => ({ key: `${i}`, label: p.t, users: p.v }))} />;
  }

  const cols = metricColumns(entry.set).slice(0, PREVIEW_COLS);
  const rows = funnelPreviewRows(entry.set, PREVIEW_ROWS);
  if (rows.length === 0) {
    return <div className="funnel-preview-empty">Funnel set is empty.</div>;
  }

  return (
    <table className="funnel-preview" aria-label="Top funnels preview">
      <thead>
        <tr>
          <th scope="col">Funnel</th>
          {cols.map((c) => <th key={c.key} scope="col">{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((funnel) => (
          <tr key={funnel.id}>
            <td className="funnel-preview-name" title={funnel.name}>{funnel.name}</td>
            {cols.map((c) => (
              <td key={c.key} className="funnel-preview-num">
                {formatMetricValue(funnel.metrics[c.key]?.v ?? null, c.format)}
              </td>
            ))}
          </tr>
        ))}
        {entry.set.funnels.length > rows.length && (
          <tr>
            <td className="funnel-preview-more" colSpan={cols.length + 1}>
              +{entry.set.funnels.length - rows.length} more — open to see all
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
