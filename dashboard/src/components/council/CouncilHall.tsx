import { useMemo, useState } from 'react';
import type { DebateIndexEntry } from '../../hooks/useCouncil';
import { useI18n } from '../../context/I18nContext';
import { PersonaAvatar } from './PersonaAvatar';

interface Props {
  debates: DebateIndexEntry[];
  onOpen: (id: string) => void;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'synthesizing', label: 'Synthesizing' },
  { value: 'complete', label: 'Complete' },
  { value: 'promoted', label: 'Promoted' },
];

function matches(entry: DebateIndexEntry, query: string, statusFilter: string): boolean {
  if (statusFilter !== 'all') {
    if (statusFilter === 'in_progress' && !entry.status.endsWith('_running')) return false;
    if (statusFilter === 'synthesizing' && entry.status !== 'synthesizing') return false;
    if (statusFilter === 'complete' && entry.status !== 'complete') return false;
    if (statusFilter === 'promoted' && !entry.promoted_to_knowledge) return false;
  }
  if (!query.trim()) return true;
  const q = query.trim().toLowerCase();
  if ((entry.topic || '').toLowerCase().includes(q)) return true;
  if (entry.id.toLowerCase().includes(q)) return true;
  if (entry.personaSlugs?.some((s) => s.toLowerCase().includes(q))) return true;
  return false;
}

function statusTone(status: string): string {
  if (status === 'complete') return 'council-hall-status--complete';
  if (status === 'synthesizing') return 'council-hall-status--synth';
  if (status.endsWith('_running')) return 'council-hall-status--running';
  return 'council-hall-status--pending';
}

function statusLabel(status: string): string {
  if (status === 'complete') return 'Complete';
  if (status === 'synthesizing') return 'Synthesizing';
  if (status.endsWith('_running')) return 'In progress';
  return 'Pending';
}

export function CouncilHall({ debates, onOpen }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');

  const filtered = useMemo(
    () => debates.filter((d) => matches(d, query, status)),
    [debates, query, status],
  );

  return (
    <div className="council-hall">
      <div className="council-hall-bar">
        <label className="council-hall-search">
          <span aria-hidden>🔍</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('council.search.placeholder')}
          />
        </label>
        <select
          className="council-hall-filter"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label={t('council.filter.status')}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="council-hall-count">{filtered.length} / {debates.length}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="council-empty">{t('council.empty.list')}</div>
      ) : (
        <div className="council-hall-grid">
          {filtered.map((d) => (
            <button
              key={d.id}
              type="button"
              className="council-hall-card"
              onClick={() => onOpen(d.id)}
            >
              <div className="council-hall-card-head">
                <span className={`council-hall-status ${statusTone(d.status)}`}>
                  <span className="council-hall-status-dot" />
                  {statusLabel(d.status)}
                </span>
                <span className="council-hall-rounds">R{d.current_round}/{d.rounds_planned}</span>
              </div>
              <h3 className="council-hall-topic">{d.topic || d.id}</h3>
              <div className="council-hall-foot">
                {d.personaSlugs && d.personaSlugs.length > 0 && (
                  <div className="council-hall-avatars" aria-label={`${d.personaSlugs.length} personas`}>
                    {d.personaSlugs.slice(0, 6).map((s, i) => (
                      <span key={s} className="council-hall-avatar-wrap" style={{ zIndex: 10 - i }}>
                        <PersonaAvatar slug={s} size={20} />
                      </span>
                    ))}
                    {d.personaSlugs.length > 6 && (
                      <span className="council-hall-avatar-more">+{d.personaSlugs.length - 6}</span>
                    )}
                  </div>
                )}
                <span className="council-hall-date">
                  {d.updated_at || d.created_at}
                </span>
                {d.promoted_to_knowledge && <span className="council-hall-promoted" title="Promoted to knowledge">📜</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
