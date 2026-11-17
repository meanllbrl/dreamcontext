import type { ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { PadStatus } from '../../../lib/superTypes';
import type { AgendaEntry, HoverAction, RowActions } from './agendaGroups';

/** A line's status as a 16px circle (owner 14 Nov: five statuses, the Günlük app's marks). */
export function StatusGlyph({ status }: { status: PadStatus }) {
  return (
    <svg className="agenda-glyph" data-status={status} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {status === 'not-started' && <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {status === 'in-progress' && (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
        </>
      )}
      {status === 'almost-done' && (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 3.5A4.5 4.5 0 1 1 3.5 8H8z" fill="currentColor" />
        </>
      )}
      {status === 'waiting' && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M6.25 5.25v5.5M9.75 5.25v5.5" stroke="var(--color-bg-elevated)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
      {status === 'done' && <CheckDisc />}
    </svg>
  );
}

function CheckDisc() {
  return (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="m5 8.2 2 2 4-4.4" fill="none" stroke="var(--color-bg-elevated)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

/** The mark of a row that is not an agenda line: a question, or a plain dot for everything else. */
export function KindGlyph({ entry }: { entry: AgendaEntry }) {
  const question = entry.kind === 'question' || entry.kind === 'approval';
  if (entry.kind === 'line') {
    return <svg className="agenda-glyph" data-status="archived" width="16" height="16" viewBox="0 0 16 16" aria-hidden><CheckDisc /></svg>;
  }
  return (
    <svg className="agenda-glyph" data-kind={entry.kind} data-chip={entry.row?.chip} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      {question
        ? <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4M8 11.4v.1" fill="none" stroke="var(--color-bg-elevated)" strokeWidth="1.5" strokeLinecap="round" />
        : <path d="M8 4.6v4.2M8 11.2v.1" fill="none" stroke="var(--color-bg-elevated)" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

export function AskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export type AgendaSize = 'small' | 'medium' | 'large' | 'wide' | 'full';

/**
 * One agenda row at any size. Everything it may do comes from `actions` (rowActions, C8): it
 * decides nothing itself. The mark, the row's press and the hover actions are siblings, never
 * nested buttons. Hover shows Ask over the time (small, medium: a round icon button with a
 * tooltip; large up: labelled); Done and the rest live in the row's detail (owner 2026-11-17).
 */
export function AgendaRowView({ entry, actions, size, label, line, chips, time, selected, threadOn, onPress, onMenu, onHover, testId }: {
  entry: AgendaEntry;
  actions: RowActions;
  size: AgendaSize;
  /** The row's words. */
  label: string;
  /** A second line (a question's own words, an allowed-and-waiting note). */
  line?: ReactNode;
  chips?: ReactNode;
  /** The row's time, already formatted ('' = none). */
  time: string;
  selected?: boolean;
  /** The Super chat shows this row's thread (ajanda-filtre C5): the row stays highlighted. */
  threadOn?: boolean;
  /** Absent = the row is not pressable (drawn as plain text). */
  onPress?: () => void;
  /** The status circle (only when `actions.menu`). */
  onMenu?: (anchor: HTMLElement) => void;
  /** One hover action; absent handler = that action is not drawn. */
  onHover: Partial<Record<HoverAction, () => void>>;
  testId?: string;
}) {
  const { t } = useI18n();
  const r = entry.row;
  const status = r?.status;
  const hover = actions.hover.filter((a) => !!onHover[a]);
  // Small and medium draw the round icon buttons (their names on hover): the medium list column
  // is too narrow for worded buttons and the line's name (measured on the stage, 15 Nov).
  const compact = size === 'small' || size === 'medium';
  const body = (
    <>
      <span className="super-agenda-name" title={label}>{label}</span>
      {chips && size !== 'small' && size !== 'medium' && <span className="super-agenda-meta">{chips}</span>}
      {time && size !== 'small' && <span className="agenda-time">{time}</span>}
      {line && size !== 'small' && size !== 'medium' && <span className="super-agenda-line">{line}</span>}
    </>
  );
  const word = (a: HoverAction) => (a === 'ask' ? t('super.agenda.ask') : t('super.agenda.owed.drop'));
  const title = (a: HoverAction) => (a === 'ask' ? t('super.agenda.askTitle') : t('super.agenda.owed.dropTitle'));
  return (
    <div
      className="super-agenda-row"
      data-row={entry.key}
      data-testid={testId ?? 'super-agenda-row'}
      data-state={r?.section ?? 'waiting'}
      data-kind={entry.kind === 'line' ? 'note' : entry.kind}
      data-group={entry.group}
      data-live={entry.kind === 'line' ? (entry.live ? 'true' : 'false') : undefined}
      data-status={status}
      data-chip={r?.chip ?? undefined}
      data-auto={r?.auto ? 'true' : undefined}
      data-stale={r?.stale ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-thread={threadOn ? 'on' : undefined}
      data-hover={hover.length ? hover.join(' ') : undefined}
    >
      {actions.mark === 'status' && status && actions.menu && onMenu
        ? (
          <button
            type="button"
            className="agenda-mark"
            data-testid="super-agenda-status"
            data-status={status}
            aria-haspopup="menu"
            aria-label={`${t('super.agenda.statusTitle')}: ${t(`super.agenda.status.${status}`)}`}
            title={t(`super.agenda.status.${status}`)}
            onClick={(e) => onMenu(e.currentTarget)}
          >
            <StatusGlyph status={status} />
          </button>
        )
        : (
          <span className="agenda-mark" data-static="true" title={status && actions.mark === 'status' ? t(`super.agenda.status.${status}`) : undefined}>
            {actions.mark === 'status' && status ? <StatusGlyph status={status} /> : <KindGlyph entry={entry} />}
          </span>
        )}
      {onPress
        ? <button type="button" className="super-agenda-row-btn" onClick={onPress} aria-expanded={actions.press === 'detail' ? !!selected : undefined} aria-pressed={actions.press === 'thread' ? !!threadOn : undefined}>{body}</button>
        : <div className="super-agenda-row-btn">{body}</div>}
      {hover.length > 0 && (
        <span className="agenda-hover" data-compact={compact ? 'true' : undefined}>
          {hover.map((a) => (
            <button
              key={a}
              type="button"
              className="agenda-hover-btn"
              data-action={a}
              data-testid={a === 'ask' ? 'super-agenda-about' : 'super-agenda-owed-drop'}
              title={title(a)}
              aria-label={title(a)}
              onClick={onHover[a]}
            >
              {a === 'ask' && <AskIcon />}
              {(!compact || a === 'notNeeded') && <span>{word(a)}</span>}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
