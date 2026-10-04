import { useI18n } from '../../../context/I18nContext';
import type { InsightDetail } from '../../../hooks/useLab';
import { formatValue } from '../../lab/chartBody';
import { computeStepRows } from '../../lab/funnel/funnelModel';
import { pctText } from '../../lab/funnel/FunnelFlow';
import { useWbText } from '../whiteboardHost';
import { funnelHeadline } from './funnelWidgetModel';
import './labCardWidget.css';

/**
 * A funnel insight at S/M: the headline (users at the top step, and the share that reached the
 * last step) over a mini lane, one bar per step, its height the step's share of the top. M also
 * writes each step's conversion from the previous one under its bar; every bar's tooltip and
 * accessible name carry the step, its users, % of previous and % of top.
 *
 * Reads the primary funnel of the cached set (the set's `primary`, else the first): the same
 * numbers the Lab funnel pages show for the whole funnel, never a segment.
 */
export function FunnelMini({ detail, size }: { detail: InsightDetail; size: 's' | 'm' }) {
  const { locale } = useI18n();
  const tx = useWbText();
  const head = funnelHeadline(detail.cache?.funnel?.set);
  if (!head) {
    return <div className="wb-funnel-mini-empty">{tx('whiteboard.insight.noData', 'No data yet.')}</div>;
  }
  const rows = computeStepRows(head.steps);
  const last = rows[rows.length - 1];
  const ofPrevWord = tx('whiteboard.funnel.ofPrev', 'of previous');
  const ofTopWord = tx('whiteboard.funnel.ofTop', 'of top');
  return (
    <div className={`wb-funnel-mini wb-funnel-mini--${size}`} data-wb-funnel-mini={head.id}>
      <div className="wb-funnel-mini-head">
        <span className="wb-insight-value">{formatValue(rows[0].users, null)}</span>
        <span className="wb-funnel-mini-top" title={rows[0].label}>{rows[0].label}</span>
      </div>
      {rows.length > 1 && last.ofTop !== null && (
        <div className="wb-funnel-mini-conv" title={`${rows[0].label} → ${last.label}`}>
          <span className="wb-funnel-mini-conv-pct">→ {pctText(last.ofTop)}</span>
          <span className="wb-funnel-mini-conv-label">{last.label}</span>
          <span className="wb-funnel-mini-conv-n">{last.users.toLocaleString(locale)}</span>
        </div>
      )}
      <ol className="wb-funnel-lane" aria-label={head.name}>
        {rows.map((r) => {
          const tip = [
            `${r.label}: ${r.users.toLocaleString(locale)}`,
            r.ofPrev !== null ? `${pctText(r.ofPrev)} ${ofPrevWord}` : null,
            r.ofTop !== null ? `${pctText(r.ofTop)} ${ofTopWord}` : null,
          ].filter(Boolean).join(' · ');
          return (
            <li key={r.key} className="wb-funnel-lane-step" title={tip} aria-label={tip} data-step={r.key}>
              <span className="wb-funnel-lane-track">
                <span className="wb-funnel-lane-bar" style={{ height: `${Math.max(2, Math.min(100, r.ofTop ?? 0))}%` }} />
              </span>
              {size === 'm' && (
                <span className="wb-funnel-lane-pct">{r.ofPrev === null ? '100%' : pctText(r.ofPrev)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
