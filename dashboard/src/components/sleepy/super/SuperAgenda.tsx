import { useEffect, useReducer, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { getWindowActivity, pollMs } from '../../../lib/windowActivity';
import type { SuperStateView } from '../../../lib/superTypes';
import { DONE_SHOWN, JOB_SECTIONS, etaLabel, superAgenda, type JobLook, type JobRow } from './superHandover';
import { onOpenJobRow } from './superJobsStore';
import './SuperAgenda.css';

/** The agenda column's width (px): the stage plans for what is left of the surface. */
export const AGENDA_W = 272;
/** Folded to a rail (its four counts) when the full column would leave the stage under
 *  NARROW_STAGE_PX: the stage keeps floating its cards and side by side stays beside the centre. */
export const AGENDA_RAIL_W = 48;
/** The most rows one seen post carries (the route takes at most MAX_CONTAINERS). */
const SEEN_BATCH = 48;
/** How long a row an event line pointed at stays lit. */
const FOCUS_MS = 1800;

/**
 * The Super Agent's agenda (task super-agent-ajandasi-…, owner 2026-10-22: "basit şekilde ne
 * yapıyoruz şu an, madde madde"): an always-visible column left of the stage that reads like a
 * notebook. Four sections from the ONE record the super agent reads (`superAgenda`): what waits
 * on the owner, what runs now (with the super's estimate), what finished (new until he has seen
 * it), what is next (the pool). It replaces the job bar's counts and its list: one list.
 *
 * Nothing polls the server: the record is pushed. A slow clock (`pollMs`) only re-words the
 * estimates. A finished row is marked seen by the owner's own click (or "Mark N seen"), told to
 * the server with the finish key the row SHOWED; a failed post leaves it new (no optimistic flip).
 */
export function SuperAgenda({ state, look, compact = false, canShowChild, onShowChild, onShowQuestion, onSeen }: {
  state: SuperStateView;
  /** Folded to the rail; a click opens the full agenda over the stage's left edge. */
  compact?: boolean;
  look: JobLook;
  canShowChild: (sid: string) => boolean;
  onShowChild: (sid: string) => void;
  /** The super's own question (an `ask`) or an approval: bring its card into view. */
  onShowQuestion: (item: string) => void;
  onSeen: (rows: ReadonlyArray<{ id: string; at: number }>) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // Only re-words the estimates: nothing to re-word while the window is hidden.
    const reword = () => { if (!getWindowActivity().hidden) tick(); };
    const timer = window.setInterval(reword, pollMs(30_000));
    return () => window.clearInterval(timer);
  }, []);
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const railRef = useRef<HTMLButtonElement | null>(null);
  // Closing the overlay from inside it gives focus back to the rail (the focused row unmounts).
  const closePop = () => {
    const inside = !!ref.current && ref.current.contains(document.activeElement);
    setOpen(false);
    if (inside) railRef.current?.focus();
  };
  useEffect(() => { if (!compact) setOpen(false); }, [compact]);
  // The folded agenda's overlay closes on Esc or a press outside it.
  useEffect(() => {
    if (!compact || !open) return undefined;
    // Esc closes this layer only: not a group panel or a menu open on the stage too.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.stopPropagation(); closePop(); } };
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node | null)) setOpen(false); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [compact, open]);
  // An event line's job name (superJobsStore): scroll the agenda to that row and light it. A
  // second pointing at the same row lights it again (`n`).
  const [focus, setFocus] = useState<{ row: string; n: number } | null>(null);
  useEffect(() => onOpenJobRow((row) => { setFocus((f) => ({ row, n: (f?.n ?? 0) + 1 })); if (compact) setOpen(true); }), [compact]);
  useEffect(() => {
    if (!focus) return undefined;
    const el = ref.current?.querySelector<HTMLElement>('[data-focus="true"]');
    el?.scrollIntoView({ block: 'nearest' });
    const timer = window.setTimeout(() => setFocus(null), FOCUS_MS);
    return () => window.clearTimeout(timer);
  }, [focus]);
  // Each seen post stands alone (a row click while "Mark N seen" is in flight is not dropped); a
  // refused one leaves its rows new and says so in the console.
  const [posting, setPosting] = useState(false);
  const post = (rows: ReadonlyArray<{ id: string; at: number }>) => onSeen(rows.slice(0, SEEN_BATCH))
    .catch((err: unknown) => { console.warn('[super] the agenda could not mark results seen:', err); });
  const seenAll = (rows: ReadonlyArray<{ id: string; at: number }>) => {
    if (!rows.length || posting) return;
    setPosting(true);
    void post(rows).finally(() => setPosting(false));
  };

  const sections = superAgenda(state, look);
  // The row an event line pointed at: its own key, else (a child waiting on the owner is keyed by
  // its queue item) the first row about that child.
  const all = JOB_SECTIONS.flatMap((sec) => sections[sec]);
  const focusKey = !focus ? null
    : all.some((r) => r.key === focus.row) ? focus.row
      : focus.row.startsWith('c:') ? all.find((r) => r.sid === focus.row.slice(2))?.key ?? null : null;
  const now = Date.now();
  const fresh = sections.done.filter((r) => r.fresh);
  const doneShown = [...fresh, ...sections.done.filter((r) => !r.fresh).slice(0, Math.max(0, DONE_SHOWN - fresh.length))];
  const hidden = sections.done.length - doneShown.length;

  const meta = (r: JobRow) => {
    if (r.section === 'done') {
      if (r.fresh) return <span className="super-agenda-chip" data-kind="new">{t('super.agenda.new')}</span>;
      // A finished job whose chat went away says so; otherwise "seen".
      return <span className="super-agenda-when">{r.chip === 'gone' ? t('super.jobs.chip.gone') : t('super.agenda.seen')}</span>;
    }
    if (r.chip) return <span className="super-agenda-chip" data-kind={r.chip}>{t(`super.jobs.chip.${r.chip}`)}</span>;
    const eta = r.section === 'now' ? etaLabel(r.etaAt, now) : null;
    if (eta) {
      return (
        <span className="super-agenda-when" data-over={eta.over ? 'true' : undefined}>
          {eta.over ? t('super.agenda.eta.over') : t(`super.agenda.eta.${eta.unit}`).replace('{n}', String(eta.n))}
        </span>
      );
    }
    return null;
  };

  // A question waiting on the owner (the super's own, a child's it escalated) opens its card in the
  // centre chat, where the band's Answer takes him too: the child shown beside it is read-only.
  const isQuestion = (r: JobRow) => r.section === 'waiting' && !!r.item && r.chip !== 'permission' && r.chip !== 'queued';
  const press = (r: JobRow) => {
    if (r.section === 'next') return;
    if (isQuestion(r)) onShowQuestion(r.item as string);
    else if (r.sid && canShowChild(r.sid)) onShowChild(r.sid);
    else if (!r.sid && r.item) onShowQuestion(r.item);
    if (r.section === 'done' && r.fresh && r.sid && r.finishAt !== undefined) void post([{ id: r.sid, at: r.finishAt }]);
    if (compact) closePop();
  };
  const clickable = (r: JobRow) => r.section !== 'next' && (isQuestion(r) || (r.sid ? canShowChild(r.sid) || (r.section === 'done' && !!r.fresh) : !!r.item));

  const full = (
    <>
      <header className="super-agenda-head">
        <span className="super-agenda-title">{t('super.agenda.label')}</span>
        <span className="super-agenda-sub">{t('super.agenda.sub')}</span>
      </header>
      {JOB_SECTIONS.map((sec) => {
        const rows = sec === 'done' ? doneShown : sections[sec];
        const count = sections[sec].length;
        return (
          <section key={sec} className="super-agenda-sec" data-section={sec} data-testid={`super-agenda-section-${sec}`}>
            <h3 className="super-agenda-sec-h">
              <span>{t(`super.agenda.section.${sec}`)}</span>
              <span className="super-agenda-n" data-testid={`super-agenda-count-${sec}`}>{count}</span>
              {sec === 'done' && fresh.length > 0 && (
                <button
                  type="button"
                  className="super-agenda-mark"
                  data-testid="super-agenda-mark-seen"
                  disabled={posting}
                  onClick={() => seenAll(fresh.filter((r) => r.sid && r.finishAt !== undefined).map((r) => ({ id: r.sid as string, at: r.finishAt as number })))}
                >
                  {t('super.agenda.markSeen').replace('{n}', String(fresh.length))}
                </button>
              )}
            </h3>
            {count === 0 && <div className="super-agenda-empty">{t(`super.agenda.empty.${sec}`)}</div>}
            {rows.map((r) => {
              const live = clickable(r);
              const rowState = r.section === 'done' ? (r.fresh ? 'new' : 'seen') : r.section;
              const body = (
                <>
                  <span className="super-agenda-dot" aria-hidden />
                  <span className="super-agenda-name" title={r.title}>{r.title}</span>
                  <span className="super-agenda-meta">{meta(r)}</span>
                  {r.line && <span className="super-agenda-line" title={r.line}>{r.line}</span>}
                </>
              );
              return (
                <div
                  key={r.key}
                  className="super-agenda-row"
                  data-row={r.key}
                  data-testid="super-agenda-row"
                  data-state={rowState}
                  data-chip={r.chip ?? undefined}
                  data-super-tone={r.section === 'now' ? r.tone ?? undefined : undefined}
                  data-focus={r.key === focusKey ? 'true' : undefined}
                >
                  {live
                    ? <button type="button" className="super-agenda-row-btn" onClick={() => press(r)}>{body}</button>
                    : <div className="super-agenda-row-btn">{body}</div>}
                </div>
              );
            })}
            {sec === 'done' && hidden > 0 && (
              <div className="super-agenda-more">{t('super.group.more').replace('{n}', String(hidden))}</div>
            )}
          </section>
        );
      })}
    </>
  );

  if (!compact) {
    return (
      <aside ref={ref} className="super-agenda" data-testid="super-agenda" aria-label={t('super.agenda.label')} style={{ width: AGENDA_W }}>
        {full}
      </aside>
    );
  }
  // The rail: the four counts, one button; the full agenda opens over the stage's left edge.
  const railN: Record<(typeof JOB_SECTIONS)[number], number> = {
    waiting: sections.waiting.length, now: sections.now.length, done: fresh.length, next: sections.next.length,
  };
  return (
    <aside ref={ref} className="super-agenda super-agenda--rail" data-testid="super-agenda" data-compact="true" aria-label={t('super.agenda.label')} style={{ width: AGENDA_RAIL_W }}>
      <button
        ref={railRef}
        type="button"
        className="super-agenda-rail-btn"
        data-testid="super-agenda-rail"
        aria-expanded={open}
        aria-controls="super-agenda-pop"
        aria-label={`${t('super.agenda.label')}: ${JOB_SECTIONS.map((sec) => `${t(`super.agenda.section.${sec}`)} ${railN[sec]}`).join(', ')}`}
        title={t('super.agenda.label')}
        onClick={() => setOpen((o) => !o)}
      >
        {JOB_SECTIONS.map((sec) => (
          <span key={sec} className="super-agenda-rail-n" data-section={sec} data-on={railN[sec] > 0 ? 'true' : undefined} aria-hidden>
            {railN[sec]}
          </span>
        ))}
      </button>
      {open && (
        <div id="super-agenda-pop" className="super-agenda super-agenda-pop" data-testid="super-agenda-pop" style={{ left: AGENDA_RAIL_W, width: AGENDA_W }}>
          {full}
        </div>
      )}
    </aside>
  );
}
