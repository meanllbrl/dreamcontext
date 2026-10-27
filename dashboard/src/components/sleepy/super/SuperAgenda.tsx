import { useI18n } from '../../../context/I18nContext';
import type { SuperStateView } from '../../../lib/superTypes';
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
 * The notepad keeps itself true (owner 2026-10-27: "the agenda goes stale"): a Now line about a
 * job moves to Done by itself when that job finishes, marked "closed by itself"; a Now line with
 * no job behind it that has not changed for two hours is marked "unchanged". The owner moves a
 * note by hand with its own small button (Done / Put back): the server never moves it again.
 */
export function SuperAgenda({ state, look, variant = 'full', wide = false, canShowChild, onShowChild, onShowQuestion, onMoveNote }: {
  state: SuperStateView;
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
  /** The owner moves a note by hand (`POST /api/super/pad`); absent = the notes are only read. */
  onMoveNote?: (id: string, section: 'now' | 'done') => void;
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
                    {r.auto && <span className="super-agenda-chip" data-kind="auto" data-testid="super-agenda-auto">{t('super.agenda.auto')}</span>}
                    {r.stale && <span className="super-agenda-chip" data-kind="stale" data-testid="super-agenda-stale" title={t('super.agenda.staleTitle')}>{t('super.agenda.stale')}</span>}
                    {r.note && onMoveNote && (r.section === 'now' || r.section === 'done') && (
                      <button
                        type="button"
                        className="super-agenda-move"
                        data-testid="super-agenda-move"
                        data-to={r.section === 'now' ? 'done' : 'now'}
                        title={t(r.section === 'now' ? 'super.agenda.moveDoneTitle' : 'super.agenda.moveBackTitle')}
                        aria-label={t(r.section === 'now' ? 'super.agenda.moveDoneTitle' : 'super.agenda.moveBackTitle')}
                        onClick={() => onMoveNote(r.note as string, r.section === 'now' ? 'done' : 'now')}
                      >
                        {t(r.section === 'now' ? 'super.agenda.moveDone' : 'super.agenda.moveBack')}
                      </button>
                    )}
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
                  data-auto={r.auto ? 'true' : undefined}
                  data-stale={r.stale ? 'true' : undefined}
                >
                  {clickable(r)
                    ? <button type="button" className="super-agenda-row-btn" onClick={() => press(r)}>{body}</button>
                    : <div className="super-agenda-row-btn">{body}</div>}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
