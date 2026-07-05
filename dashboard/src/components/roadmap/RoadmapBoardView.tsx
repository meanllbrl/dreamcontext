import { RM_STATUS, RM_RED, fmtMetricValue } from './chrome';
import type { RoadmapItem } from '../../hooks/useRoadmapItems';
import { fmtShort, type Forecast } from './roadmap-forecast';
import './RoadmapBoardView.css';

/**
 * RoadmapBoardView — the "Board" layout from Roadmap.dc.html: objectives grouped
 * into status columns as rich cards (progress, target vs. forecast, dependency
 * counts). Clicking a card opens the same detail panel as the timeline.
 */

interface Props {
  items: RoadmapItem[];
  forecasts: Map<string, Forecast>;
  onOpen: (slug: string) => void;
}

const COLS: Array<keyof typeof RM_STATUS> = ['not_started', 'active', 'review', 'done'];

export function RoadmapBoardView({ items, forecasts, onOpen }: Props) {
  return (
    <div className="rbd-scroll bd-scroll">
      <div className="rbd-cols">
        {COLS.map((st) => {
          const meta = RM_STATUS[st];
          const cards = items.filter((o) => o.status === st);
          return (
            <div className="rbd-col" key={st}>
              <div className="rbd-col-head">
                <span className="rbd-col-dot" style={{ background: meta.color }} />
                <span className="rbd-col-label">{meta.label}</span>
                <span className="rbd-col-count">{cards.length}</span>
                <div className="rbd-col-rule" />
              </div>
              <div className="rbd-col-cards">
                {cards.length === 0 && <div className="rbd-empty">None</div>}
                {cards.map((o) => {
                  const f = forecasts.get(o.slug)!;
                  const pct = o.progress.pct;
                  const blocks = f.dependents.length;
                  const deps = o.depends_on.length;
                  return (
                    <div key={o.slug} className="rbd-card" style={{ borderLeft: `3px solid ${f.slipping ? RM_RED : meta.color}` }} onClick={() => onOpen(o.slug)}>
                      <div className="rbd-card-top">
                        <div className="rbd-card-title">{o.title}</div>
                        {f.slipping && <span className="rbd-slip"><span className="rbd-slip-dot">●</span>SLIP</span>}
                      </div>
                      <div className="rbd-card-slug">{o.slug}</div>
                      {o.description && <div className="rbd-card-desc">{o.description}</div>}
                      {f.slipping && (
                        <div className="rbd-card-cause">
                          {o.slipDays != null ? `${o.slipDays}d late` : 'slipping'}
                          {' · '}
                          {o.slipUpstream.length > 0 ? `upstream: ${o.slipUpstream.join(', ')}` : 'own tasks'}
                        </div>
                      )}
                      <div className="rbd-card-prog">
                        <div className="rbd-card-track"><div className="rbd-card-fill" style={{ width: `${pct ?? 0}%`, background: meta.color }} /></div>
                        <span className="rbd-card-proglabel">{o.progress.source === 'metric' && o.progress.metric
                          ? `${fmtMetricValue(o.progress.metric.current, o.progress.metric.unit)}/${fmtMetricValue(o.progress.metric.target, o.progress.metric.unit)}`
                          : o.progress.total > 0 ? `${o.progress.done}/${o.progress.total}` : '—'}</span>
                      </div>
                      <div className="rbd-card-dates">
                        <div className="rbd-card-date">
                          <div className="rbd-card-date-cap">Target</div>
                          <div className="rbd-card-date-val">{f.target ? fmtShort(f.target) : '—'}</div>
                        </div>
                        <div className={`rbd-card-date ${f.slipping ? 'rbd-card-date--slip' : ''}`}>
                          <div className="rbd-card-date-cap">Forecast</div>
                          <div className="rbd-card-date-val" style={{ color: f.slipping ? RM_RED : f.forecastable ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)' }}>
                            {f.forecast_end ? fmtShort(f.forecast_end) : 'none'}
                          </div>
                        </div>
                      </div>
                      {(deps + blocks) > 0 && (
                        <div className="rbd-card-deps">
                          {deps > 0 && <span className="rbd-card-dep"><span className="rbd-card-dep-glyph">↳</span>depends on {deps}</span>}
                          {blocks > 0 && <span className="rbd-card-dep"><span className="rbd-card-dep-glyph">⇥</span>blocks {blocks}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
