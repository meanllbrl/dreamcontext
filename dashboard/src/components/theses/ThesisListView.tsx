import { useMemo } from 'react';
import type { ThesisView } from '../../hooks/useTheses';
import { ConfidenceBar } from './ConfidenceBar';
import { STATUS_META, daysSince, confidenceInkVar, type ThesisListFilter } from './thesis-chrome';
import { needsAttention, type ThesisDelta } from './thesis-seen';
import './theses.css';
import './ThesisBoard.css';

/**
 * Activity-list rendering of the Hypotheses board (view mode "list" — option A
 * of the 08-08 design session). One wide row per thesis: unread dot → status
 * word → verdict % + split bar → claim (one line) with a "what changed" /
 * recency subline → last-activity stamp. Unread rows sort first; within each
 * group the board's active sort order (already applied upstream) is kept.
 */

const FILTER_TABS: { key: ThesisListFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'attention', label: 'Needs attention' },
];

interface ThesisListViewProps {
  /** Filtered + sorted pool from the board (toolbar filters/sort already applied). */
  theses: ThesisView[];
  deltas: Map<string, ThesisDelta>;
  filter: ThesisListFilter;
  setFilter: (f: ThesisListFilter) => void;
  onOpen: (slug: string) => void;
}

export function ThesisListView({ theses, deltas, filter, setFilter, onOpen }: ThesisListViewProps) {
  const delta = (t: ThesisView): ThesisDelta => deltas.get(t.slug) ?? { unread: false, summary: null };

  const counts = useMemo(() => ({
    all: theses.length,
    unread: theses.filter((t) => delta(t).unread).length,
    attention: theses.filter(needsAttention).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [theses, deltas]);

  const rows = useMemo(() => {
    const pool = theses.filter((t) => {
      if (filter === 'unread') return delta(t).unread;
      if (filter === 'attention') return needsAttention(t);
      return true;
    });
    const unread = pool.filter((t) => delta(t).unread);
    const read = pool.filter((t) => !delta(t).unread);
    return [...unread, ...read];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theses, deltas, filter]);

  return (
    <div className="thl">
      <div className="thl-tabs" role="tablist" aria-label="List scope">
        {FILTER_TABS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={`thl-tab${filter === f.key ? ' thl-tab--on' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className="thl-tab-count">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="thl-empty">
          {filter === 'unread' ? 'Nothing unread — you are caught up.' : filter === 'attention' ? 'Nothing needs your attention right now.' : 'No hypotheses here.'}
        </div>
      ) : (
        <div className="thl-rows">
          {rows.map((t) => <ListRow key={t.slug} thesis={t} delta={delta(t)} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

function ListRow({ thesis: t, delta, onOpen }: { thesis: ThesisView; delta: ThesisDelta; onOpen: (slug: string) => void }) {
  const statusMeta = STATUS_META[t.status] ?? STATUS_META.draft;
  const cb = t.confidenceBreakdown;
  const hasEvidence = t.evidence.length > 0 || cb.ws + cb.wc > 0;
  const pct = Math.round(Math.max(0, Math.min(1, t.confidence)) * 100);

  const metaParts: string[] = [
    `${t.cycles_checked} cycle${t.cycles_checked === 1 ? '' : 's'}`,
    t.checked_at ? `checked ${daysSince(t.checked_at)}d ago` : 'never checked',
  ];
  if (t.blocked_on_instrumentation) metaParts.push('needs metric');

  const ageDays = daysSince(t.updated_at);
  const open = () => onOpen(t.slug);

  return (
    <div
      className={`thl-row${delta.unread ? ' thl-row--unread' : ''}`}
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      <span className="thl-dot">{delta.unread && <span className="thc-unread" aria-label="Changed since you last looked" />}</span>
      <span className={`thc-status thc-status--${t.status} thl-status`}>{statusMeta.label}</span>
      <span
        className="thl-pct"
        style={{ color: hasEvidence ? confidenceInkVar(pct) : 'var(--color-text-tertiary)' }}
      >
        {hasEvidence ? `${pct}%` : '—'}
      </span>
      <span className="thl-bar">
        {hasEvidence ? (
          <ConfidenceBar confidence={t.confidence} ws={cb.ws} wc={cb.wc} variant="mini" hideLabel />
        ) : (
          <div className="thc-bar-empty" aria-hidden="true" />
        )}
      </span>
      <span className="thl-main">
        <span className="thl-claim">{t.claim}</span>
        <span className={`thl-sub${delta.unread && delta.summary ? ' thl-sub--change' : ''}`}>
          {delta.unread && delta.summary ? delta.summary : metaParts.join(' · ')}
        </span>
      </span>
      <span className="thl-when" title={`Last activity ${t.updated_at}`}>
        {ageDays === 0 ? 'today' : `${ageDays}d ago`}
      </span>
    </div>
  );
}
