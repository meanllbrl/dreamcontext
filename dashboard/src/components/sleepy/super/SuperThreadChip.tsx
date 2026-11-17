import { useI18n } from '../../../context/I18nContext';
import './SuperThreadChip.css';

/**
 * The strip at the Super chat's top while it shows one agenda row's thread (task ajanda-gunluk,
 * plan ajanda-filtre C4, approved frame b): "Yalnız: <row> · N mesaj · ×". One line, the row's
 * words cut to fit; × gives the full chat back where he left it. A polite live region says it.
 */
export function SuperThreadChip({ sessionId, label, count, onClear, onLabel }: {
  /** The Super session it filters (Esc in that chat ends it, AgentSurface). */
  sessionId: string;
  label: string;
  count: number;
  onClear: () => void;
  /** A: the line's name opens its detail in the agenda (agendaClick). Absent: plain words. */
  onLabel?: () => void;
}) {
  const { t } = useI18n();
  const only = t('super.thread.only');
  const n = (count === 1 ? t('super.thread.countOne') : t('super.thread.count')).replace('{n}', String(count));
  return (
    <div className="super-thread-chip" data-testid="super-thread-chip" data-session={sessionId} role="status" aria-live="polite">
      <span className="super-thread-chip-only">{only}</span>
      {onLabel
        ? <button type="button" className="super-thread-chip-label super-thread-chip-label--btn" data-testid="super-thread-label" title={t('super.thread.openDetail')} onClick={onLabel}>{label}</button>
        : <span className="super-thread-chip-label" title={label}>{label}</span>}
      <span className="super-thread-chip-count" data-testid="super-thread-count">{n}</span>
      <button type="button" className="super-thread-chip-x" data-testid="super-thread-clear" aria-label={t('super.thread.clear')} title={t('super.thread.clear')} onClick={onClear}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

/** A thread with nothing linked to it (D5, approved frame e). */
export function SuperThreadEmpty({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div className="super-thread-empty" data-testid="super-thread-empty">
      <p>{t('super.thread.empty')}</p>
      <button type="button" className="super-thread-empty-back" data-testid="super-thread-back" onClick={onBack}>{t('super.thread.backToAll')}</button>
    </div>
  );
}
