import { useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useStatusModel, useTask, useTaskAgentAction } from '../../../hooks/useTasks';
import { findAgent, useAgents } from '../../../hooks/useAgents';
import { jobChip } from '../../../lib/taskAgentJob';
import { tr } from '../../../lib/assignToAgent';
import { JobChipView } from '../../tasks/JobChipView';
import { roleIn, stripActions, stripRequest, stripRound, stripWait, type StripAction } from './memberStageModel';
import './TaskStrip.css';

const ACTION_LABEL: Record<StripAction, [string, string]> = {
  complete: ['tasks.job.act.complete', 'Approve and complete'],
  'send-back': ['tasks.job.act.sendBack', 'Send back'],
  'one-more-round': ['tasks.job.act.oneMoreRound', 'One more round'],
  'take-over': ['tasks.job.act.takeOver', "I'll take it"],
  cancel: ['tasks.job.act.cancel', 'Cancel the task'],
};

/**
 * The task strip on a member's stage (plan-r10 1c, mockup r8-08b): the task's title and status, the
 * member's role in it (yapan / inceleyici), round N/cap, who it waits on, "Görevi aç", and the
 * owner's buttons when they apply, sending the same actions as the task's own job row. While it is
 * up, the owner's messages on this stage carry `[About task <slug>]` (AgentSurface sets that on the
 * member's chat), so the member answers from the task.
 */
export function TaskStrip({ task: slug, member, onOpenTask, onClose }: {
  task: string;
  member: string;
  onOpenTask: (slug: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { data: task } = useTask(slug);
  const { data: agents } = useAgents();
  const statusModel = useStatusModel();
  const act = useTaskAgentAction();
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const job = task?.agent_job ?? null;
  // The job moved on: an open "Send back" no longer applies.
  useEffect(() => { setAsking(false); setText(''); }, [job?.state, job?.step]);

  if (!task) {
    return <div className="super-task-strip super-task-strip--loading" data-testid="super-task-strip" data-task={slug} aria-busy="true" />;
  }
  const closed = statusModel.isTerminal(task.status);
  const role = roleIn(task, member);
  const readOnly = [task.agent, job?.reviewer].some((s) => !!s && findAgent(agents, s)?.readOnly === true);
  const actions = stripActions(job, { closed, readOnly });
  const wait = stripWait(job, closed);
  const round = stripRound(job);
  const chip = jobChip(job, t);
  const reviewerName = job?.reviewer ? findAgent(agents, job.reviewer)?.title ?? job.reviewer : '';
  const run = (a: StripAction) => {
    setError(null);
    if (a === 'send-back' && !asking) { setAsking(true); setText(''); return; }
    const body = stripRequest(task.slug, a, a === 'send-back' ? text : undefined);
    if (!body) return;
    act.mutate(body, {
      onSuccess: () => { setAsking(false); setText(''); },
      onError: (e) => setError(e.message),
    });
  };
  return (
    <section className="super-task-strip" data-testid="super-task-strip" data-task={task.slug} data-wait={wait ?? undefined} aria-label={task.name}>
      <div className="super-task-strip-row">
        <span className="super-task-strip-title" title={task.name}>{task.name}</span>
        <span className="super-task-strip-status" style={{ color: statusModel.colorOf(task.status) }}>{statusModel.labelOf(task.status)}</span>
        {chip && <JobChipView chip={chip} />}
        {role && <span className="super-task-strip-role" data-role={role}>{t(`superStage.task.role.${role}`)}</span>}
        <span className="super-task-strip-facts">
          {[
            role === 'doer' && reviewerName ? t('superStage.task.reviewer').replace('{name}', reviewerName) : '',
            round ? t('superStage.task.round').replace('{n}', String(round.n)).replace('{cap}', String(round.cap)) : '',
          ].filter(Boolean).join(' · ')}
        </span>
        <button type="button" className="super-task-strip-link" data-testid="super-task-strip-open" onClick={() => onOpenTask(task.slug)}>
          {t('superStage.task.open')}
        </button>
        <button type="button" className="super-task-strip-close" aria-label={t('superStage.task.close')} title={t('superStage.task.close')} onClick={onClose}>×</button>
      </div>
      {wait && (
        <p className="super-task-strip-wait" data-testid="super-task-strip-wait" data-wait={wait}>{t(`superStage.task.waitsOn.${wait}`)}</p>
      )}
      {actions.length > 0 && (
        <div className="super-task-strip-actions">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className={`djob-btn${a === 'complete' ? ' djob-btn--primary' : ''}${a === 'cancel' ? ' djob-btn--danger' : ''}`}
              data-testid="super-task-strip-action"
              data-action={a}
              disabled={act.isPending}
              aria-pressed={a === 'send-back' && asking ? true : undefined}
              onClick={() => run(a)}
            >
              {tr(t, ACTION_LABEL[a][0], ACTION_LABEL[a][1])}
            </button>
          ))}
        </div>
      )}
      {asking && (
        <div className="super-task-strip-ask">
          <textarea
            className="field-textarea"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={tr(t, 'tasks.job.sendBackPlaceholder', 'What should change?')}
            aria-label={tr(t, ACTION_LABEL['send-back'][0], ACTION_LABEL['send-back'][1])}
          />
          <button type="button" className="djob-btn djob-btn--primary" disabled={act.isPending || !text.trim()} onClick={() => run('send-back')}>
            {tr(t, ACTION_LABEL['send-back'][0], ACTION_LABEL['send-back'][1])}
          </button>
          <button type="button" className="djob-btn" disabled={act.isPending} onClick={() => setAsking(false)}>{tr(t, 'common.cancel', 'Cancel')}</button>
        </div>
      )}
      {error && <p className="super-task-strip-error" role="alert">{error}</p>}
    </section>
  );
}
