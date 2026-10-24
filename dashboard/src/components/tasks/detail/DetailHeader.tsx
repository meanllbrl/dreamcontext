import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../hooks/useTasks';
import { useApproveFiling, useObjectToTask, useStatusModel } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';
import { canApprove, canObject, filingView, objectionResultLine, shortDate } from '../../../lib/taskObjection';
import { GiveToAgentMenu } from './GiveToAgentMenu';
import { ObjectionDialog } from './ObjectionDialog';
import './ObjectionDialog.css';

/**
 * Why the task was opened (approved draft 1): who opened it, when, and on what basis, with
 * "Object to this task" beside it. Nothing for the owner's own tasks; "Reason not recorded"
 * (with the button) for tasks older than the field, so old noise can train sleep too.
 */
function FilingRow({ task, onObject, buttonRef }: { task: Task; onObject: () => void; buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  const { t, locale } = useI18n();
  const sm = useStatusModel();
  const approve = useApproveFiling();
  const [showBasis, setShowBasis] = useState(false);
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLSpanElement>(null);
  // The ⋯ menu closes on a click outside it and on Escape.
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); } };
    moreRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [menu]);
  const view = filingView(task, t, locale);
  if (!view) return null;
  const basis = view.line !== null
    ? <span className={view.tone === 'unknown' ? 'filing-muted' : undefined}>{view.line}</span>
    : (
      <>
        <span>{view.label}</span>
        <span className={`filing-quote ${view.italic ? 'filing-quote--defect' : ''}`}>«{view.quote}»</span>
      </>
    );
  // Approved (owner, 2026-10-24): the row folds into one line of chips. The status never changed;
  // the request is one click away and Object is still in the menu.
  if (task.filing_approved && !task.objection?.applied) {
    return (
      <div className="filing-chips" data-testid="filing-approved">
        <span className={`filing-chip filing-chip--${view.tone}`}>{view.chip}</span>
        <span className="filing-chip filing-chip--approved">{[t('tasks.approve.approved'), shortDate(task.filing_approved.at, locale)].filter(Boolean).join(' · ')}</span>
        <button type="button" className="filing-chip-btn" aria-expanded={showBasis} onClick={() => setShowBasis((v) => !v)}>
          {t('tasks.approve.request')} <span aria-hidden="true">{showBasis ? '▾' : '▸'}</span>
        </button>
        {canObject(task, sm.isCancelled) && (
          <span className="filing-more" ref={moreRef}>
            <button ref={buttonRef} type="button" className="filing-chip-btn" aria-haspopup="menu" aria-expanded={menu} aria-label={t('tasks.approve.more')} onClick={() => setMenu((v) => !v)}>⋯</button>
            {menu && (
              <span className="filing-more-menu" role="menu">
                <button type="button" role="menuitem" className="filing-more-item" data-testid="object-btn" onClick={() => { setMenu(false); onObject(); }}>
                  {t('tasks.objection.button')}
                </button>
              </span>
            )}
          </span>
        )}
        {showBasis && <div className="filing-text filing-text--folded">{basis}</div>}
      </div>
    );
  }
  return (
    <div className="filing-row" data-testid="filing-row">
      <div className="filing-text">
        <span className={`filing-chip filing-chip--${view.tone}`}>{view.chip}</span>
        {basis}
      </div>
      {canApprove(task, sm.isCancelled) && (
        <button
          type="button"
          className="filing-approve-btn"
          data-testid="approve-btn"
          disabled={approve.isPending}
          onClick={() => approve.mutate({ slug: task.slug })}
        >
          {t('tasks.approve.button')}
        </button>
      )}
      {approve.error && <span className="filing-error" role="alert">{approve.error.message}</span>}
      {canObject(task, sm.isCancelled) && (
        <button ref={buttonRef} type="button" className="filing-object-btn" data-testid="object-btn" onClick={onObject}>
          {t('tasks.objection.button')}
        </button>
      )}
    </div>
  );
}

/**
 * The objection on this task (approved draft 3): the owner's note, what it did, and the rule
 * sleep learned from it. An unfinished one offers "Finish", the same request again, on a
 * cancelled task too (cancelling is the LAST step, so a run that stopped after it still needs it).
 */
function ObjectionBox({ task }: { task: Task }) {
  const { t, locale } = useI18n();
  const finish = useObjectToTask();
  const [error, setError] = useState<string | null>(null);
  const o = task.objection;
  if (!o) return null;
  return (
    <div className="objection-box" data-testid="objection-box">
      <p>
        <span className="objection-box-label">{[t('tasks.objection.you'), shortDate(o.at, locale)].filter(Boolean).join(' · ')}:</span> «{o.note}»
        <br />
        {objectionResultLine(t, o.as, o.targetName || o.target)}
      </p>
      {o.rule && (
        <p data-testid="objection-learned">
          <span className="objection-box-label">{t('tasks.objection.learned')} · {o.rule.id}:</span> {o.rule.dont} → {o.rule.do}
        </p>
      )}
      {o.pending && (
        <div className="objection-box-pending">
          <span className="objection-box-label">{t('tasks.objection.pending')}</span>
          {(error ?? o.error) && <span className="objection-box-error">{error ?? o.error}</span>}
          <button
            type="button"
            className="filing-object-btn"
            data-testid="objection-finish"
            disabled={finish.isPending}
            onClick={() => {
              setError(null);
              finish.mutate({ slug: task.slug, as: o.as, target: o.target, note: o.note }, { onError: (err) => setError(err.message) });
            }}
          >
            {finish.isPending ? t('tasks.objection.saving') : t('tasks.objection.finish')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The drawer's header: a crumb (the feature, or for a subtask "↑ parent · n/m", which opens the
 * parent), the title (editable in place: Enter or blur saves, Esc reverts), why the task was
 * opened with "Object to this task", the objection box, "Give to agent", fullscreen and close.
 */
export function DetailHeader({
  task, allTasks, featureName, parent, parentProgress, fullScreen, onToggleFullScreen, onClose, onOpenTask, onRename, onError,
}: {
  task: Task;
  /** The board's task list: the objection dialog picks its target from it. */
  allTasks: Task[];
  featureName: string | null;
  parent: Task | null;
  parentProgress: { done: number; total: number } | null;
  fullScreen: boolean;
  onToggleFullScreen: () => void;
  onClose: () => void;
  onOpenTask: (slug: string) => void;
  onRename: (name: string) => void;
  onError: (msg: string) => void;
}) {
  const [objecting, setObjecting] = useState(false);
  const objectRef = useRef<HTMLButtonElement | null>(null);
  // Focus goes back to the button that opened the dialog (it is gone once the objection applied).
  const closeDialog = () => { setObjecting(false); requestAnimationFrame(() => objectRef.current?.focus()); };
  return (
    <div className="detail-header">
      <div className="detail-head-main">
        <div className="detail-crumb">
          {parent ? (
            <button type="button" className="detail-crumb-parent" data-testid="crumb-parent" onClick={() => onOpenTask(parent.slug)} title={`Open ${parent.name}`}>
              ↑ <span className="detail-crumb-parent-name">{parent.name || parent.slug}</span>
              {parentProgress && <span className="detail-crumb-count">{parentProgress.done}/{parentProgress.total}</span>}
            </button>
          ) : (
            <span className="detail-crumb-feature">{featureName ?? 'No feature'}</span>
          )}
          <span className="detail-crumb-sep" aria-hidden>›</span>
          <span>{parent ? 'Subtask' : 'Task'}</span>
        </div>
        <h2
          className="detail-title"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          role="textbox"
          aria-label="Task title"
          key={`${task.slug}-${task.name}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).textContent = task.name; (e.currentTarget as HTMLElement).blur(); }
          }}
          onBlur={(e) => {
            const next = (e.currentTarget.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!next) { e.currentTarget.textContent = task.name; return; }
            if (next !== task.name) onRename(next);
          }}
        >
          {task.name}
        </h2>
      </div>
      <div className="detail-header-actions">
        <GiveToAgentMenu task={task} onError={onError} />
        <button
          type="button"
          className="detail-icon-btn"
          onClick={onToggleFullScreen}
          title={fullScreen ? 'Exit full-page view' : 'Open in full page'}
          aria-label={fullScreen ? 'Exit full-page view' : 'Open in full page'}
        >
          {fullScreen ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" /></svg>
          )}
        </button>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      {/* Its own full-width line under the title row, so a narrow drawer never squeezes it
          beside the header's buttons. */}
      <div className="detail-filing">
        <FilingRow task={task} onObject={() => setObjecting(true)} buttonRef={objectRef} />
        <ObjectionBox task={task} />
      </div>
      {objecting && <ObjectionDialog task={task} allTasks={allTasks} onClose={closeDialog} />}
    </div>
  );
}
