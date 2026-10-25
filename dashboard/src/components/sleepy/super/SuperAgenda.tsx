import { useI18n } from '../../../context/I18nContext';
import type { SuperState } from '../../../lib/superTypes';
import { AGENDA_SECTIONS, superNotepad, type AgendaRow, type JobLook } from './superHandover';
import './SuperAgenda.css';

/**
 * The owner's agenda (owner 2026-10-22: "a card, not a column"; 19:15: "like a person's sticky
 * notepad: what is being done now, what finished, for this session or today; the agent knows
 * when to reset it"). The super agent WRITES it (`super note add|done|drop|clear`) in plain,
 * high-level lines; it is never a mirror of the children (the owner sees those in ten places).
 * Three sections from the one record (`superNotepad`): Waiting on you (its open questions to
 * the owner, then what it noted it needs from him), Now, Done.
 *
 * Drawn inside the `agenda` stage card, which floats, sizes, stacks into Others and goes side
 * by side like every card: `tile` (small or medium) is the three counts at a glance; `full`
 * (large, wide, side by side) is the notepad itself. An open question's row is live even on a
 * floating card: it brings its card in the centre into view (a child's permission shows that
 * child beside the centre). Nothing polls: the record is pushed.
 *
 * Every full row also has a faint "Write about this" button at its right edge (owner
 * 2026-10-23, pick A): it stages the line as an About chip in the centre's composer
 * (`onWriteAbout`). A sibling of the row's own control, never inside it; the tile has none.
 */
export function SuperAgenda({ state, look, variant = 'full', wide = false, canShowChild, onShowChild, onShowQuestion, onWriteAbout }: {
  /** The record (the stage), or the phone's digest of it (PhoneAgenda): only these two read. */
  state: Pick<SuperState, 'queue' | 'pad'>;
  /** `tile`: the three counts (a small or medium card); `full`: the notepad. */
  variant?: 'tile' | 'full';
  /** A medium (2x1) tile: the counts in one row. */
  wide?: boolean;
  look: JobLook;
  canShowChild: (sid: string) => boolean;
  onShowChild: (sid: string) => void;
  /** A question waiting on the owner (the super's own `ask`, a child's it escalated, an approval):
   *  bring its card into view. */
  onShowQuestion: (item: string) => void;
  /** "Write about this" on a row. Absent: no icon (the super chat is not there to write in). */
  onWriteAbout?: (row: AgendaRow) => void;
}) {
  const { t } = useI18n();
  const sections = superNotepad(state, look);

  if (variant === 'tile') {
    return (
      <div className="super-agenda super-agenda--tile" data-testid="super-agenda" data-variant="tile" data-wide={wide ? 'true' : undefined}>
        {AGENDA_SECTIONS.map((sec) => (
          <div key={sec} className="super-agenda-tile-n" data-section={sec} data-on={sections[sec].length > 0 ? 'true' : undefined} data-testid={`super-agenda-tile-${sec}`}>
            <span className="super-agenda-tile-v">{sections[sec].length}</span>
            <span className="super-agenda-tile-l">{t(`super.agenda.tile.${sec}`)}</span>
          </div>
        ))}
      </div>
    );
  }

  // A question opens its card in the centre chat (where the band's Answer takes him too); a
  // child's permission, or a child waiting on something only he can do (`needsYou`), shows that
  // child beside the centre, its card in view (SuperSurface.showChild). A note is only read.
  const showsChild = (r: AgendaRow) => r.chip === 'permission' || r.chip === 'queued' || r.chip === 'needsYou';
  const press = (r: AgendaRow) => {
    if (!r.item) return;
    if (showsChild(r)) { if (r.sid && canShowChild(r.sid)) onShowChild(r.sid); return; }
    onShowQuestion(r.item);
  };
  const clickable = (r: AgendaRow) => !!r.item && (showsChild(r) ? !!r.sid && canShowChild(r.sid) : true);

  return (
    <div className="super-agenda" data-testid="super-agenda" data-variant="full" role="region" aria-label={t('super.agenda.label')}>
      {AGENDA_SECTIONS.map((sec) => {
        const rows = sections[sec];
        return (
          <section key={sec} className="super-agenda-sec" data-section={sec} data-testid={`super-agenda-section-${sec}`}>
            <h3 className="super-agenda-sec-h">
              <span>{t(`super.agenda.section.${sec}`)}</span>
              <span className="super-agenda-n" data-testid={`super-agenda-count-${sec}`}>{rows.length}</span>
            </h3>
            {rows.length === 0 && <div className="super-agenda-empty">{t(`super.agenda.empty.${sec}`)}</div>}
            {rows.map((r) => {
              const body = (
                <>
                  <span className="super-agenda-dot" aria-hidden />
                  <span className="super-agenda-name" title={r.text}>{r.text}</span>
                  <span className="super-agenda-meta">
                    {r.chip && <span className="super-agenda-chip" data-kind={r.chip}>{t(`super.jobs.chip.${r.chip}`)}</span>}
                  </span>
                  {r.line && <span className="super-agenda-line" title={r.line}>{r.line}</span>}
                </>
              );
              return (
                <div
                  key={r.key}
                  className="super-agenda-row"
                  data-row={r.key}
                  data-testid="super-agenda-row"
                  data-state={r.section}
                  data-kind={r.note ? 'note' : 'question'}
                  data-chip={r.chip ?? undefined}
                  data-about={onWriteAbout ? 'true' : undefined}
                >
                  {clickable(r)
                    ? <button type="button" className="super-agenda-row-btn" onClick={() => press(r)}>{body}</button>
                    : <div className="super-agenda-row-btn">{body}</div>}
                  {onWriteAbout && (
                    <button
                      type="button"
                      className="super-agenda-about"
                      data-testid="super-agenda-about"
                      aria-label={t('super.agenda.writeAbout')}
                      title={t('super.agenda.writeAbout')}
                      onClick={() => onWriteAbout(r)}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                        <path d="M6.5 4 2.5 8l4 4M3 8h6.5a4 4 0 0 1 4 4v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
