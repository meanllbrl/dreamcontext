import { useState } from 'react';
import type { CycleListEntry } from '../../hooks/useCycles';
import { useStartCycle } from '../../hooks/useCycles';
import { useI18n } from '../../context/I18nContext';

/**
 * Every cycle, newest first: its number, goal, dates, status and progress. A planned cycle can
 * be started and picked for planning; the active one can be closed (the Close deck).
 */
export function CycleList({ cycles, active, selected, onSelect, onClose }: {
  cycles: CycleListEntry[];
  active: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const { t } = useI18n();
  const start = useStartCycle();
  const [error, setError] = useState<string | null>(null);
  if (cycles.length === 0) return <p className="pln-empty">{t('planning.cycles.empty')}</p>;
  const ordered = cycles.slice().sort((a, b) => b.number - a.number);
  return (
    <>
      <ul className="pln-cycles">
        {ordered.map((c) => (
          <li key={c.id} className="pln-cycle" data-cycle={c.id} data-status={c.status} aria-current={selected === c.id || undefined}>
            <div className="pln-cycle-head">
              <span className="pln-cycle-title">{t('taskPage.header.cycleN').replace('{n}', String(c.number))}</span>
              <span className="pln-tag">{t(`planning.status.${c.status}`)}</span>
              <span className="pln-meta">{`${c.start} – ${c.end}`}</span>
            </div>
            {c.goal && <p className="pln-text" lang="und">{c.goal}</p>}
            <p className="pln-meta">
              {c.status === 'closed' && c.result
                ? t('planning.cycles.result').replace('{done}', String(c.result.done)).replace('{total}', String(c.result.total))
                : t('board.cycle.progress').replace('{done}', String(c.progress.done)).replace('{total}', String(c.progress.total))}
              {c.id === active && ` · ${t('board.cycle.daysLeft').replace('{n}', String(Math.max(0, c.daysLeft)))}`}
            </p>
            <div className="pln-actions">
              {c.status !== 'closed' && (
                <button type="button" className="pln-btn" aria-pressed={selected === c.id} onClick={() => onSelect(c.id)}>{t('planning.cycles.plan')}</button>
              )}
              {c.status === 'planned' && !active && (
                <button
                  type="button"
                  className="pln-btn"
                  disabled={start.isPending}
                  onClick={() => { setError(null); start.mutate(c.id, { onError: (err: Error) => setError(err.message) }); }}
                >
                  {t('planning.cycles.start')}
                </button>
              )}
              {c.status === 'active' && (
                <button type="button" className="pln-btn" onClick={() => onClose(c.id)}>{t('planning.cycles.close')}</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="pln-error" role="alert">{error}</p>}
    </>
  );
}
