import { useI18n } from '../../../context/I18nContext';
import type { SuperStateView } from '../../../lib/superTypes';
import { superNotepad, type JobLook } from './superHandover';
import type { Rect } from './superLayout';

/** What waits on the owner: his open questions and what the super noted it needs from him. */
function useWaiting(state: SuperStateView, look: JobLook): { waiting: number; label: string } {
  const { t } = useI18n();
  const waiting = superNotepad(state, look).waiting.length;
  const label = waiting > 0 ? `${t('super.agenda.open')}: ${t('super.agenda.section.waiting')} ${waiting}` : t('super.agenda.open');
  return { waiting, label };
}

const Glyph = ({ className }: { className: string }) => (
  <svg className={className} width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * "Agenda" in the centre's head, drawn only while the agenda card is off the stage (minimised to
 * its pill, in Others, in a group, or hidden by a page side by side): a second way back beside
 * the pill (owner 2026-10-22 23:44). One press asks the server for the card
 * (`POST /api/super/layout {agenda:'open'}`). Its badge counts what waits on him.
 */
export function AgendaButton({ state, look, onOpen }: { state: SuperStateView; look: JobLook; onOpen: () => void }) {
  const { t } = useI18n();
  const { waiting, label } = useWaiting(state, look);
  return (
    <button type="button" className="super-fresh-btn super-agenda-open" data-testid="super-agenda-open" aria-label={label} title={t('super.agenda.openTitle')} onClick={onOpen}>
      <Glyph className="super-fresh-glyph" />
      <span className="super-fresh-btn-label">{t('super.agenda.label')}</span>
      {waiting > 0 && <span className="super-agenda-open-n" data-kind="waiting" aria-hidden>{waiting}</span>}
    </button>
  );
}

/**
 * The minimised agenda (owner 2026-10-22 23:44: "it closes to the bottom-left corner"): a pill
 * docked bottom-left, the mirror of the Others stack bottom-right. It shows the Waiting-on-you
 * count; a click restores the card where it stood.
 */
export function AgendaPill({ state, look, rect, onOpen }: { state: SuperStateView; look: JobLook; rect: Rect; onOpen: () => void }) {
  const { t } = useI18n();
  const { waiting, label } = useWaiting(state, look);
  return (
    <div className="super-others super-agenda-pill" data-testid="super-agenda-pill" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <button
        type="button"
        className="super-others-stack super-agenda-pill-btn"
        data-testid="super-agenda-pill-btn"
        data-asking={waiting > 0 ? 'true' : undefined}
        aria-label={label}
        title={t('super.agenda.restoreTitle')}
        onClick={onOpen}
      >
        <Glyph className="super-agenda-pill-glyph" />
        <span className="super-others-name">{t('super.agenda.label')}</span>
        <span className="super-others-count" data-testid="super-agenda-pill-n" aria-hidden>{waiting}</span>
      </button>
    </div>
  );
}
