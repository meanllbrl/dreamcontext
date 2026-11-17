import { useI18n } from '../../../context/I18nContext';
import { tr } from '../../../lib/assignToAgent';
import type { AgendaEntry, RowActions } from './agendaGroups';
import { StatusGlyph } from './AgendaRow';

/** What the detail knows of the job a line follows (plan build notes): its mode, its line, its task. */
export interface DetailJob { mode?: string; line?: string; task?: string; canOpen: boolean }

/**
 * One agenda line's detail (approved drawing son-boyutlar, son-tam): its words, status, job chip
 * and last update; "The job right now"; who wrote it and when; then Open chat, Open task, Ask,
 * Done (and Remove on his own open line). What it offers is `actions` (rowActions, C8): an
 * archived line is read-only (its words, its day, a "from Mon" chip), never a status or Remove.
 */
export function AgendaDetail({ entry, actions, group, job, fmtTime, fmtDay, onClose, onAsk, onDone, onRemove, onOpenChat, onOpenTask, onShowInChat, inChat = false, error }: {
  entry: AgendaEntry;
  actions: RowActions;
  /** The group's name, as the list heads it. */
  group: string;
  job?: DetailJob | null;
  fmtTime: (ms: number) => string;
  fmtDay: (day: string) => string;
  onClose: () => void;
  onAsk?: () => void;
  onDone?: () => void;
  onRemove?: () => void;
  onOpenChat?: () => void;
  onOpenTask?: () => void;
  /** B (agendaClick): filter the Super chat to this line's thread; again, the whole chat. */
  onShowInChat?: () => void;
  /** The Super chat shows this line's thread now. */
  inChat?: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const r = entry.row;
  if (!r) return null;
  const readOnly = actions.detail === 'readonly';
  const mine = r.author === 'owner';
  const born = r.bornAt ?? r.at;
  const open = r.section !== 'done';
  const jobNow = job?.line?.trim();
  return (
    <div className="agenda-detail-in" data-testid="super-agenda-detail" data-mode={actions.detail} data-row={entry.key}>
      <div className="agenda-detail-head">
        <span className="agenda-detail-eyebrow">
          {group}
          {!readOnly && <> · {mine ? t('super.agenda.detail.yourLine') : t('super.agenda.detail.superLine')}</>}
        </span>
        <button type="button" className="agenda-detail-x" data-testid="super-agenda-detail-close" aria-label={t('super.agenda.detail.close')} title={t('super.agenda.detail.close')} onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>
      <h3 className="agenda-detail-title">{r.text}</h3>
      <div className="agenda-detail-chips">
        {!readOnly && r.status && (
          <span className="agenda-detail-chip" data-status={r.status}><StatusGlyph status={r.status} />{t(`super.agenda.status.${r.status}`)}</span>
        )}
        {readOnly && <span className="agenda-detail-chip">{fmtDay(localDayOf(r.at))}</span>}
        {entry.fromDay && <span className="agenda-detail-chip" data-kind="from">{tr(t, 'super.agenda.detail.fromDay', 'from {day}', { day: fmtDay(entry.fromDay) })}</span>}
        {!readOnly && job?.mode && <span className="agenda-detail-chip">{tr(t, 'super.agenda.detail.job', 'job · {mode}', { mode: job.mode })}</span>}
        {!readOnly && entry.at !== null && <span className="agenda-detail-chip">{tr(t, 'super.agenda.detail.updated', 'updated {time}', { time: fmtTime(entry.at) })}</span>}
      </div>
      {readOnly && <p className="agenda-detail-note">{t('super.agenda.detail.archived')}</p>}
      {!readOnly && jobNow && (
        <section className="agenda-detail-sec">
          <h4>{t('super.agenda.detail.jobNow')}</h4>
          <p>{jobNow}</p>
        </section>
      )}
      {!readOnly && (
        <section className="agenda-detail-sec">
          <h4>{t('super.agenda.detail.who')}</h4>
          <p>
            {tr(t, mine ? 'super.agenda.detail.writtenByYou' : 'super.agenda.detail.writtenBySuper', '{time}', { time: fmtTime(born) })}
            {entry.at !== null && <> · {tr(t, 'super.agenda.detail.lastUpdate', 'last update {time}', { time: fmtTime(entry.at) })}</>}
          </p>
        </section>
      )}
      {error && <p className="agenda-detail-error" role="alert" data-testid="super-agenda-detail-error">{error}</p>}
      <div className="agenda-detail-actions">
        {!readOnly && job?.canOpen && onOpenChat && <button type="button" className="agenda-btn" data-primary="true" data-testid="super-agenda-open-chat" onClick={onOpenChat}>{t('super.agenda.detail.openChat')}</button>}
        {!readOnly && job?.task && onOpenTask && <button type="button" className="agenda-btn" data-testid="super-agenda-open-task" onClick={onOpenTask}>{t('super.agenda.detail.openTask')}</button>}
        {onShowInChat && <button type="button" className="agenda-btn" data-primary={inChat || (job?.canOpen && onOpenChat) ? undefined : 'true'} aria-pressed={inChat} data-testid="super-agenda-show-in-chat" onClick={onShowInChat}>{inChat ? t('super.thread.backToAll') : t('super.agenda.detail.showInChat')}</button>}
        {onAsk && <button type="button" className="agenda-btn" data-testid="super-agenda-detail-ask" title={t('super.agenda.askTitle')} onClick={onAsk}>{t('super.agenda.ask')}</button>}
        {!readOnly && open && onDone && <button type="button" className="agenda-btn" data-testid="super-agenda-detail-done" onClick={onDone}>{t('super.agenda.done')}</button>}
        {actions.remove && onRemove && <button type="button" className="agenda-btn" data-tone="quiet" data-testid="super-agenda-remove" onClick={onRemove}>{t('super.agenda.detail.remove')}</button>}
      </div>
    </div>
  );
}

function localDayOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
