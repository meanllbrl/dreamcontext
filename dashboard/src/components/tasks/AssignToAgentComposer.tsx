import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useAssignTaskToAgent } from '../../hooks/useTasks';
import { findAgent, useAgent, useAgents, useApproveAgent } from '../../hooks/useAgents';
import { useI18n } from '../../context/I18nContext';
import { requestOpenAgents } from '../../lib/openAgents';
import {
  ASSIGN_NOTE_MAX_CHARS, approvalReasonText, approveThenAssign, assignedMessage, initialAgentSlug,
  noteTooLong, offeredAgents, refusalView, tr,
} from '../../lib/assignToAgent';
import { AgentAvatar } from '../agents/AgentAvatar';
import { taskName } from './boardModel';
import './TaskCreateModal.css';
import './AssignToAgentComposer.css';

/**
 * A task's assigned agent, as its face with a ring: the task detail, the Kanban list row and the
 * board card all render this one component, so an agent reads the same everywhere. The name
 * comes from the roster; an agent no longer on it still shows, by its slug, rather than vanish
 * from a task that names it.
 */
export function TaskAgentFace({ slug, size = 20 }: { slug: string; size?: number }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const agent = findAgent(agents, slug);
  const name = agent?.title ?? slug;
  const label = tr(t, 'tasks.agentFace', 'Assigned to {name}', { name });
  return (
    <span
      className="task-agent-face"
      role="img"
      aria-label={label}
      title={label}
      style={{ borderRadius: Math.round(size / 3.5) }}
    >
      <AgentAvatar of="agent" slug={slug} title={name} hasPhoto={agent?.hasPhoto ?? false} size={size} />
    </span>
  );
}

interface AssignToAgentComposerProps {
  task: Task;
  onClose: () => void;
  /** Called once the run has started, with the confirmation line (a board can flash it). */
  onAssigned?: (message: string) => void;
  /** Start with this agent picked (the "Give to agent" menu names one). */
  initialAgent?: string;
}

/**
 * "Assign to agent": pick an agent, add an optional note, read what will happen, Assign.
 *
 * A refusal is answered IN PLACE, never by a toast or a browser dialog (both vanish or no-op in
 * the desktop app). `agent_not_approved_to_run` opens the agent's review right here, the exact
 * text an approval grants, with "Approve and assign"; every other refusal is one plain line. The
 * decisions themselves (who is offered, what a refusal says, approve-then-assign) live in
 * `lib/assignToAgent.ts`.
 */
export function AssignToAgentComposer({ task, onClose, onAssigned, initialAgent }: AssignToAgentComposerProps) {
  const { t } = useI18n();
  const { data: agents, isLoading } = useAgents();
  const offered = useMemo(() => offeredAgents(agents), [agents]);
  const [picked, setPicked] = useState<string | null>(null);
  const slug = picked ?? (initialAgent && offered.some((a) => a.slug === initialAgent) ? initialAgent : initialAgentSlug(offered, task.agent));
  const agent = findAgent(offered, slug);
  const name = agent?.title ?? slug ?? '';

  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const assign = useAssignTaskToAgent();
  const approve = useApproveAgent();
  const detail = useAgent(reviewing ? slug : null, { fresh: true });
  const busy = assign.isPending || approve.isPending;
  const tooLong = noteTooLong(note);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pick = (next: string) => { setPicked(next); setError(null); setReviewing(false); };

  const finish = (message: string) => { setDone(message); onAssigned?.(message); };

  const submit = () => {
    if (!slug || busy || tooLong) return;
    setError(null);
    assign.mutate(
      { slug: task.slug, agent: slug, note },
      {
        onSuccess: (result) => finish(assignedMessage(result, name, t)),
        onError: (err) => {
          const view = refusalView(err, name, t);
          if (view.kind === 'review') setReviewing(true);
          else setError(view.text);
        },
      },
    );
  };

  const approveAndAssign = async () => {
    if (!slug || busy) return;
    setError(null);
    const outcome = await approveThenAssign({
      approve: () => approve.mutateAsync(slug),
      assign: () => assign.mutateAsync({ slug: task.slug, agent: slug, note }),
    });
    if (outcome.ok) { setReviewing(false); finish(assignedMessage(outcome.result, name, t)); return; }
    if (outcome.stage === 'approve') {
      setError(tr(t, 'agents.approval.failed', "Couldn't approve {name}. {reason}", {
        name, reason: tr(t, 'tasks.assignTryAgain', 'Try again in a moment.'),
      }));
    } else if (outcome.stage === 'still-unapproved') {
      setError(approvalReasonText(outcome.reason, t) || tr(t, 'tasks.assignNotApproved',
        '{name} is not approved to run on this Mac. Review it, then approve and assign.', { name }));
    } else {
      const view = refusalView(outcome.error, name, t);
      if (view.kind === 'message') { setReviewing(false); setError(view.text); }
      else setError(tr(t, 'tasks.assignNotApproved',
        '{name} is not approved to run on this Mac. Review it, then approve and assign.', { name }));
    }
  };

  const openAgents = (focus: { slug?: string; create?: boolean }) => { requestOpenAgents(focus); onClose(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal ata"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ata-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" id="ata-title">{t('tasks.assignToAgent')}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('common.close')}>&times;</button>
        </div>

        <div className="modal-body">
          <p className="ata-task">{taskName(task)}</p>

          {done ? (
            <div className="ata-done" role="status">
              {slug && <TaskAgentFace slug={slug} size={32} />}
              <span>{done}</span>
            </div>
          ) : isLoading ? (
            <p className="ata-muted">{tr(t, 'tasks.assignLoading', 'Loading agents…')}</p>
          ) : offered.length === 0 ? (
            <div className="ata-empty">
              <p className="ata-muted">{t('tasks.assignNoAgents')}</p>
              <button type="button" className="btn btn--ghost" onClick={() => openAgents({ create: true })}>
                {tr(t, 'agents.page.new', 'New agent')}
              </button>
            </div>
          ) : (
            <>
              <div className="field">
                <span className="field-label" id="ata-pick">{t('tasks.assignPickAgent')}</span>
                <div className="ata-list" role="radiogroup" aria-labelledby="ata-pick">
                  {offered.map((a) => (
                    <button
                      key={a.slug}
                      type="button"
                      role="radio"
                      aria-checked={a.slug === slug}
                      className={`ata-option${a.slug === slug ? ' ata-option--on' : ''}`}
                      onClick={() => pick(a.slug)}
                      disabled={busy}
                    >
                      <AgentAvatar of="agent" slug={a.slug} title={a.title} hasPhoto={a.hasPhoto} size={28} />
                      <span className="ata-option-name">{a.title}</span>
                      {!a.approvedToRun && (
                        <span className="ata-option-hint">{tr(t, 'agents.roster.needsApproval', 'Needs approval')}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {reviewing && agent ? (
                <div className="ata-review" aria-live="polite">
                  <p className="ata-review-lead">
                    {tr(t, 'tasks.assignNotApproved',
                      '{name} is not approved to run on this Mac. Review it, then approve and assign.', { name })}
                  </p>
                  <p className="ata-muted">{tr(t, 'agents.approval.reviewLead',
                    'This is everything an approval grants on this Mac. Read it, then approve.')}</p>
                  {detail.data ? (
                    <pre className="ata-review-text">{detail.data.review}</pre>
                  ) : detail.isError ? (
                    <p className="ata-error">{tr(t, 'tasks.assignReviewFailed', "Couldn't load the review. Open the agent to approve it.")}</p>
                  ) : (
                    <p className="ata-muted">{tr(t, 'tasks.assignReviewLoading', 'Loading the review…')}</p>
                  )}
                  <button type="button" className="ata-link" onClick={() => openAgents({ slug: agent.slug })}>
                    {tr(t, 'automations.openAgent', 'Open {name}', { name })}
                  </button>
                </div>
              ) : (
                <label className="field">
                  <span className="field-label">{t('tasks.assignNote')}</span>
                  <textarea
                    className="field-textarea"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t('tasks.assignNotePlaceholder')}
                    rows={3}
                    disabled={busy}
                    aria-invalid={tooLong}
                  />
                  {tooLong && (
                    <span className="ata-error">
                      {t('tasks.assignNoteTooLong')} {note.trim().length}/{ASSIGN_NOTE_MAX_CHARS}
                    </span>
                  )}
                </label>
              )}

              <div className="ata-disclosure">
                <p>{tr(t, 'tasks.assignWhatHappens',
                  '{name} starts on this task now. A task that has not started moves to In progress. The result is logged on the task.',
                  { name: name || tr(t, 'tasks.agent', 'Agent') })}</p>
                <p>{t('tasks.assignDisclosure')}</p>
              </div>

              {error && <p className="ata-error" role="alert">{error}</p>}
            </>
          )}

          <div className="modal-actions">
            {done ? (
              <button type="button" className="btn btn--primary" onClick={onClose}>{t('common.close')}</button>
            ) : (
              <>
                <button type="button" className="btn btn--ghost" onClick={onClose}>{t('common.cancel')}</button>
                {offered.length > 0 && (reviewing ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={approveAndAssign}
                    disabled={busy || !detail.data}
                  >
                    {busy ? t('tasks.assigning') : t('tasks.approveAndAssign')}
                  </button>
                ) : (
                  <button type="button" className="btn btn--primary" onClick={submit} disabled={!slug || busy || tooLong}>
                    {busy ? t('tasks.assigning') : t('tasks.assignSubmit')}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
