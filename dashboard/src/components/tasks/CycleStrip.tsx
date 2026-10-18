import { useCycles } from '../../hooks/useCycles';
import { useI18n } from '../../context/I18nContext';
import './CycleStrip.css';

/**
 * The active cycle above the board: its number, dates, goal, done/total leaves and the days
 * left, with a way to Planning. With no active cycle it offers to plan one.
 */
export function CycleStrip({ onOpenPlanning }: { onOpenPlanning?: () => void }) {
  const { t } = useI18n();
  const { data } = useCycles();
  if (!data) return null;
  const active = data.cycles.find((c) => c.id === data.active) ?? null;

  if (!active) {
    return (
      <div className="cycle-strip" data-cycle-strip="none">
        <span className="cycle-strip-text">{t('board.cycle.none')}</span>
        {onOpenPlanning && (
          <button type="button" className="cycle-strip-btn" onClick={onOpenPlanning}>{t('board.cycle.plan')}</button>
        )}
      </div>
    );
  }

  return (
    <div className="cycle-strip" data-cycle-strip={active.id}>
      <span className="cycle-strip-title">{t('taskPage.header.cycleN').replace('{n}', String(active.number))}</span>
      <span className="cycle-strip-text">{`${active.start} – ${active.end}`}</span>
      {active.goal && <span className="cycle-strip-goal" lang="und">{active.goal}</span>}
      <span className="cycle-strip-text">
        {t('board.cycle.progress').replace('{done}', String(active.progress.done)).replace('{total}', String(active.progress.total))}
      </span>
      <span className="cycle-strip-text">{t('board.cycle.daysLeft').replace('{n}', String(Math.max(0, active.daysLeft)))}</span>
      {onOpenPlanning && (
        <button type="button" className="cycle-strip-btn" onClick={onOpenPlanning}>{t('board.cycle.open')}</button>
      )}
    </div>
  );
}
