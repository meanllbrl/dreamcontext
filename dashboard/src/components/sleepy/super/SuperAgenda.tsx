import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { nextOwedReveal, type SuperState } from '../../../lib/superTypes';
import type { OwnerInboxRow } from '../../../hooks/useAgents';
import { tr } from '../../../lib/assignToAgent';
import { AGENDA_SECTIONS, superNotepad, superUnanswered, type AgendaRow, type JobLook } from './superHandover';
import { superApprovalSentence, type SuperApproval } from './superApprovals';
import { requestOpenAgents } from '../../../lib/openAgents';
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
 *
 * The notepad keeps itself true (owner 2026-10-27: "the agenda goes stale"): a Now line about a
 * job moves to Done by itself when that job finishes, marked "closed by itself"; a Now line with
 * no job behind it that has not changed for two hours is marked "unchanged". The owner moves a
 * note by hand with its own small button (Done / Put back): the server never moves it again.
 *
 * Above them, only when there is one, "Cevaplanmadı" (task super-hicbir-konuyu-kacirmaz): what the
 * Super left unanswered after two reminders, or what his Stop left open for ten minutes. Each row
 * has the same "Write about this" (it asks the Super again through the composer) and, where the
 * owner's own window is (`onDropOwed`), "Gerek yok". The phone only reads them.
 */
export function SuperAgenda({ state, look, variant = 'full', wide = false, canShowChild, onShowChild, onShowQuestion, onWriteAbout, onMoveNote, onDropOwed, taskRows = [], onOpenTask, approvals = [], onShowApproval, extra }: {
  /** The record (the stage), or the phone's digest of it (PhoneAgenda): only these read. */
  state: Pick<SuperState, 'queue' | 'pad' | 'owed'>;
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
  /** This machine's task-job rows waiting on the owner (M1, AI Team v2 C2): "I did it", stuck,
   *  stalled, a plan to approve. They need no Super session; each opens its task. */
  taskRows?: OwnerInboxRow[];
  onOpenTask?: (slug: string) => void;
  /** What waits for his approval on this Mac (AI Team members and routines, `superApprovals`),
   *  minus a member an open `approval` queue item already lists. Each brings its row of the
   *  Super's approval card into view (`onShowApproval`). */
  approvals?: SuperApproval[];
  onShowApproval?: (key: string) => void;
  /** The owner moves a note by hand (`POST /api/super/pad`); absent = the notes are only read. */
  onMoveNote?: (id: string, section: 'now' | 'done') => void;
  /** His "Gerek yok" on an unanswered line (`POST /api/super/owed/drop`); absent = read only (the phone). */
  onDropOwed?: (id: string) => void;
  /** Drawn after the sections in the full notepad: a member's "Görevleri" (plan-r10 1c). */
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const sections = superNotepad(state, look);
  // A parked line shows ten minutes after his Stop: one timer for the earliest, nothing polls.
  const [clock, setClock] = useState(() => Date.now());
  const reveal = nextOwedReveal(state.owed, clock);
  useEffect(() => {
    if (reveal === null) return undefined;
    const id = window.setTimeout(() => setClock(Date.now()), Math.max(0, reveal - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [reveal]);
  const unanswered = superUnanswered(state, Math.max(clock, Date.now()));
  // The tile has no room for a fourth count: an unanswered line counts as waiting on him there
  // (it needs his eye), so a small agenda never reads "0 waiting" while one is open.
  const tileCountOf = (sec: string) => countOf(sec) + (sec === 'waiting' ? unanswered.length : 0);
  // A folded Now line no longer counts as running; a Waiting one still waits on him, so it does.
  const countOf = (sec: string) => sections[sec as keyof typeof sections].filter((r) => sec !== 'now' || !r.stale).length + (sec === 'waiting' ? taskRows.length + approvals.length : 0);

  if (variant === 'tile') {
    return (
      <div className="super-agenda super-agenda--tile" data-testid="super-agenda" data-variant="tile" data-wide={wide ? 'true' : undefined}>
        {AGENDA_SECTIONS.map((sec) => (
          <div key={sec} className="super-agenda-tile-n" data-section={sec} data-on={tileCountOf(sec) > 0 ? 'true' : undefined} data-testid={`super-agenda-tile-${sec}`}>
            <span className="super-agenda-tile-v">{tileCountOf(sec)}</span>
            <span className="super-agenda-tile-l">{t(`super.agenda.tile.${sec}`)}</span>
          </div>
        ))}
      </div>
    );
  }

  // A question opens its card in the centre chat (where the band's Answer takes him too); a
  // child's permission, or a child waiting on something only he can do (`needsYou`), shows that
  // child beside the centre, its card in view (SuperSurface.showChild). A note is only read.
  // A child's own question (`direct`) opens that child: its card is in its chat.
  const showsChild = (r: AgendaRow) => !r.member && ( r.chip === 'permission' || r.chip === 'queued' || r.chip === 'needsYou' || !!r.direct);
  const press = (r: AgendaRow) => {
    if (!r.item) return;
    // An AI Team member waiting on him: its page, where its own card answers it.
    if (r.member) { requestOpenAgents({ slug: r.member }); return; }
    if (showsChild(r)) { if (r.sid && canShowChild(r.sid)) onShowChild(r.sid); return; }
    onShowQuestion(r.item);
  };
  const clickable = (r: AgendaRow) => !!r.item && (r.member ? true : showsChild(r) ? !!r.sid && canShowChild(r.sid) : true);

  const rowOf = (r: AgendaRow) => {
    const body = (
        <>
          <span className="super-agenda-dot" aria-hidden />
          <span className="super-agenda-name" title={r.text}>{r.text}</span>
          <span className="super-agenda-meta">
            {r.chip && <span className="super-agenda-chip" data-kind={r.chip}>{t(`super.jobs.chip.${r.chip}`)}</span>}
            {r.auto && <span className="super-agenda-chip" data-kind="auto" data-testid="super-agenda-auto">{t('super.agenda.auto')}</span>}
            {r.stale && <span className="super-agenda-chip" data-kind="stale" data-testid="super-agenda-stale" title={t('super.agenda.staleTitle')}>{t('super.agenda.stale')}</span>}
            {r.note && onMoveNote && (r.section !== 'waiting' || r.stale) && (
              <button
                type="button"
                className="super-agenda-move"
                data-testid="super-agenda-move"
                data-to={r.section === 'done' ? 'now' : 'done'}
                title={t(r.section === 'done' ? 'super.agenda.moveBackTitle' : 'super.agenda.moveDoneTitle')}
                aria-label={t(r.section === 'done' ? 'super.agenda.moveBackTitle' : 'super.agenda.moveDoneTitle')}
                onClick={() => onMoveNote(r.note as string, r.section === 'done' ? 'now' : 'done')}
              >
                {t(r.section === 'done' ? 'super.agenda.moveBack' : 'super.agenda.moveDone')}
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
          data-about={onWriteAbout ? 'true' : undefined}
          data-auto={r.auto ? 'true' : undefined}
          data-stale={r.stale ? 'true' : undefined}
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
  };

  const aboutButton = (r: AgendaRow) => onWriteAbout && (
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
  );

  return (
    <div className="super-agenda" data-testid="super-agenda" data-variant="full" role="region" aria-label={t('super.agenda.label')}>
      {unanswered.length > 0 && (
        <section className="super-agenda-sec super-agenda-sec--unanswered" data-section="unanswered" data-testid="super-agenda-section-unanswered">
          <h3 className="super-agenda-sec-h">
            <span>{tr(t, 'super.agenda.section.unanswered', 'Unanswered')}</span>
            <span className="super-agenda-n" data-testid="super-agenda-count-unanswered">{unanswered.length}</span>
          </h3>
          {unanswered.map((r) => (
            <div key={r.key} className="super-agenda-row" data-row={r.key} data-testid="super-agenda-row" data-state="unanswered" data-kind="owed" data-about={onWriteAbout ? 'true' : undefined}>
              <div className="super-agenda-row-btn">
                <span className="super-agenda-dot" aria-hidden />
                <span className="super-agenda-name" title={r.text}>{r.text}</span>
                <span className="super-agenda-meta">
                  <span className="super-agenda-chip" data-kind="owed">{tr(t, r.owedKind === 'result' ? 'super.agenda.owed.result' : 'super.agenda.owed.msg', r.owedKind === 'result' ? 'Result' : 'Your message')}</span>
                  {onDropOwed && (
                    <button
                      type="button"
                      className="super-agenda-move"
                      data-testid="super-agenda-owed-drop"
                      title={tr(t, 'super.agenda.owed.dropTitle', 'Not needed: take it off the list')}
                      aria-label={tr(t, 'super.agenda.owed.dropTitle', 'Not needed: take it off the list')}
                      onClick={() => onDropOwed(r.owed as string)}
                    >
                      {tr(t, 'super.agenda.owed.drop', 'Not needed')}
                    </button>
                  )}
                </span>
              </div>
              {aboutButton(r)}
            </div>
          ))}
        </section>
      )}
      {AGENDA_SECTIONS.map((sec) => {
        const rows = sections[sec];
        return (
          <section key={sec} className="super-agenda-sec" data-section={sec} data-testid={`super-agenda-section-${sec}`}>
            <h3 className="super-agenda-sec-h">
              <span>{t(`super.agenda.section.${sec}`)}</span>
              <span className="super-agenda-n" data-testid={`super-agenda-count-${sec}`}>{countOf(sec)}</span>
            </h3>
            {countOf(sec) === 0 && <div className="super-agenda-empty">{t(`super.agenda.empty.${sec}`)}</div>}
            {rows.filter((r) => !r.stale).map(rowOf)}
            {rows.some((r) => r.stale) && (
              // A line nothing keeps true rests folded: still here, still closable, never deleted.
              <details className="super-agenda-fold" data-testid="super-agenda-stale-fold">
                <summary>{tr(t, 'super.agenda.fold', 'Old lines')} · {rows.filter((r) => r.stale).length}</summary>
                {rows.filter((r) => r.stale).map(rowOf)}
              </details>
            )}
            {sec === 'waiting' && approvals.map((a) => (
              <div key={a.key} className="super-agenda-row" data-row={a.key} data-testid="super-agenda-row" data-state="waiting" data-kind="approval" data-chip="approval">
                <button type="button" className="super-agenda-row-btn" onClick={() => onShowApproval?.(a.key)} disabled={!onShowApproval}>
                  <span className="super-agenda-dot" aria-hidden />
                  <span className="super-agenda-name" title={a.title}>{a.title}</span>
                  <span className="super-agenda-meta">
                    <span className="super-agenda-chip" data-kind="approval">{t('super.jobs.chip.approval')}</span>
                  </span>
                  <span className="super-agenda-line" title={superApprovalSentence(a, t)}>{superApprovalSentence(a, t)}</span>
                </button>
              </div>
            ))}
            {sec === 'waiting' && taskRows.map((r) => (
              <div key={r.id} className="super-agenda-row" data-row={r.id} data-testid="super-agenda-row" data-state="waiting" data-kind="task" data-chip={r.kind}>
                <button type="button" className="super-agenda-row-btn" onClick={() => onOpenTask?.(r.ref)} title={tr(t, 'super.agenda.openTask', 'Open the task')}>
                  <span className="super-agenda-dot" aria-hidden />
                  <span className="super-agenda-name" title={r.title}>{r.title}</span>
                  <span className="super-agenda-meta">
                    <span className="super-agenda-chip" data-kind="task">{tr(t, 'super.agenda.chip.task', 'Task')}</span>
                  </span>
                  {r.detail && <span className="super-agenda-line" title={r.detail}>{r.detail}</span>}
                </button>
              </div>
            ))}
          </section>
        );
      })}
      {extra}
    </div>
  );
}
