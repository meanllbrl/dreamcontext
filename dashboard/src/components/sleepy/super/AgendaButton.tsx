import { useI18n } from '../../../context/I18nContext';
import type { SuperStateView } from '../../../lib/superTypes';
import { superNotepad, type JobLook } from './superHandover';

/**
 * "Agenda" in the centre's head, drawn only while the agenda card is off the stage (the owner
 * closed it or put it in Others; owner 2026-10-22: the agenda is a card he can close and bring
 * back). One press asks the server for the card (`POST /api/super/layout {agenda:'open'}`).
 * Its badge counts what waits on him (his open questions and what the super noted it needs).
 */
export function AgendaButton({ state, look, onOpen }: { state: SuperStateView; look: JobLook; onOpen: () => void }) {
  const { t } = useI18n();
  const waiting = superNotepad(state, look).waiting.length;
  const label = waiting > 0 ? `${t('super.agenda.open')}: ${t('super.agenda.section.waiting')} ${waiting}` : t('super.agenda.open');
  return (
    <button type="button" className="super-fresh-btn super-agenda-open" data-testid="super-agenda-open" aria-label={label} title={t('super.agenda.openTitle')} onClick={onOpen}>
      <svg className="super-fresh-glyph" width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="super-fresh-btn-label">{t('super.agenda.label')}</span>
      {waiting > 0 && <span className="super-agenda-open-n" data-kind="waiting" aria-hidden>{waiting}</span>}
    </button>
  );
}
