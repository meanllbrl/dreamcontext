import { useMemo } from 'react';
import {
  alignStepKeys,
  formatMetricValue,
  isLowSample,
  metricColumns,
  type FunnelSet,
} from './funnelModel';
import './FunnelCompareView.css';

/**
 * Compare view (A11) — 2-4 funnels as parallel step grids aligned by step KEY
 * (never index): one column per key in first-funnel order, unmatched steps
 * ghosted, per-step delta chips between adjacent lanes. Deep-linkable (?cmp=).
 */
const MAX_LANES = 4;

export function FunnelCompareView({ set, funnelIds, onClose, onOpenFunnel }: {
  set: FunnelSet;
  funnelIds: string[];
  onClose: () => void;
  onOpenFunnel: (id: string) => void;
}) {
  const funnels = useMemo(
    () => funnelIds.map((id) => set.funnels.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => !!f).slice(0, MAX_LANES),
    [set, funnelIds],
  );
  const keys = useMemo(() => alignStepKeys(funnels), [funnels]);
  const cols = useMemo(() => metricColumns(set).slice(0, 4), [set]);

  if (funnels.length < 2) {
    return (
      <div className="funnel-cmp">
        <div className="funnel-cmp-state">
          Fewer than two of the selected funnels are in the current set.
          <button className="funnel-cmp-close" onClick={onClose}>Back to the table</button>
        </div>
      </div>
    );
  }

  const missing = funnelIds.length - funnels.length;

  return (
    <div className="funnel-cmp">
      {missing > 0 && (
        <div className="funnel-cmp-note" role="note">⚠ {missing} selected funnel(s) are not in the current set and were skipped.</div>
      )}
      <div className="funnel-cmp-scroll">
        <table className="funnel-cmp-grid">
          <caption className="sr-only">Funnel comparison, steps aligned by key</caption>
          <thead>
            <tr>
              <th scope="col" className="funnel-cmp-head-funnel">Funnel</th>
              {cols.map((c) => <th key={c.key} scope="col" className="funnel-cmp-num">{c.label}</th>)}
              {keys.map((k) => <th key={k.key} scope="col" className="funnel-cmp-step" title={k.key}>{k.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {funnels.map((funnel, laneIdx) => {
              const byKey = new Map(funnel.steps.map((s) => [s.key, s.users]));
              const top = funnel.steps[0]?.users ?? 0;
              const low = isLowSample(funnel, set);
              const prevFunnel = laneIdx > 0 ? funnels[laneIdx - 1] : null;
              const prevByKey = prevFunnel ? new Map(prevFunnel.steps.map((s) => [s.key, s.users])) : null;
              const prevTop = prevFunnel?.steps[0]?.users ?? 0;
              return (
                <tr key={funnel.id} className={low ? 'funnel-cmp-row--low' : undefined}>
                  <th scope="row" className="funnel-cmp-name">
                    <button className="funnel-cmp-open" onClick={() => onOpenFunnel(funnel.id)} title="Open this funnel's detail page">
                      {funnel.name}
                    </button>
                    <span className="funnel-cmp-id">#{funnel.id}</span>
                    {low && <span className="funnel-ovw-lowchip">low sample</span>}
                  </th>
                  {cols.map((c) => (
                    <td key={c.key} className="funnel-cmp-num">
                      {formatMetricValue(funnel.metrics[c.key]?.v ?? null, c.format)}
                    </td>
                  ))}
                  {keys.map((k) => {
                    const users = byKey.get(k.key);
                    if (users === undefined) {
                      // Ghosted: this funnel has no such step — visibly absent, not zero.
                      return <td key={k.key} className="funnel-cmp-cell funnel-cmp-cell--ghost" aria-label={`${funnel.name} has no step ${k.label}`}>·</td>;
                    }
                    const ofTop = top > 0 ? (users / top) * 100 : null;
                    const prevOfTop = prevByKey?.has(k.key) && prevTop > 0 ? (prevByKey.get(k.key)! / prevTop) * 100 : null;
                    const deltaPp = ofTop !== null && prevOfTop !== null ? ofTop - prevOfTop : null;
                    return (
                      <td key={k.key} className="funnel-cmp-cell">
                        <span className="funnel-cmp-users">{users.toLocaleString('en-US')}</span>
                        <span className="funnel-cmp-oftop">{ofTop === null ? '—' : `${ofTop.toFixed(ofTop >= 10 ? 0 : 1)}%`}</span>
                        <span className="funnel-cmp-bar" aria-hidden>
                          <span className="funnel-cmp-barfill" style={{ width: `${Math.min(100, Math.max(2, ofTop ?? 0))}%` }} />
                        </span>
                        {deltaPp !== null && Math.abs(deltaPp) >= 0.05 && (
                          <span
                            className={`funnel-delta funnel-delta--${deltaPp > 0 ? 'up' : 'down'}`}
                            title={`${deltaPp > 0 ? '+' : ''}${deltaPp.toFixed(1)}pp of-top vs ${prevFunnel!.name}`}
                          >{deltaPp > 0 ? '▲' : '▼'}{Math.abs(deltaPp).toFixed(Math.abs(deltaPp) >= 10 ? 0 : 1)}pp</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="funnel-cmp-legendnote">
        Steps aligned by step <em>key</em> — “·” means the funnel has no such step. Δ chips compare each
        lane's %-of-top against the lane above it.
      </p>
    </div>
  );
}
