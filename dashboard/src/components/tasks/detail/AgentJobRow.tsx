import { useEffect, useState } from 'react';
import type { AgentJobDetail, OwnerInboxRow, Task, TaskAgentAction } from '../../../hooks/useTasks';
import { useStatusModel, useTaskAgentAction, useUpdateTask } from '../../../hooks/useTasks';
import { findAgent, useAgents } from '../../../hooks/useAgents';
import { useAnswerQuestion, useAutomationQuestions } from '../../../hooks/useAutomations';
import { useI18n } from '../../../context/I18nContext';
import { tr, type Translate } from '../../../lib/assignToAgent';
import { requestOpenAgents } from '../../../lib/openAgents';
import { instantToLocalInput, jobChip, localInputToInstant, queuePosition, shortWhen } from '../../../lib/taskAgentJob';
import { TaskAgentFace } from '../AssignToAgentComposer';
import { JobChipView } from '../JobChipView';

/** Actions the drawer offers on its own (the rows' `open-task`/`dismiss` mean nothing here). */
const ROW_SKIP = new Set(['open-task', 'dismiss']);
/** Actions that take the owner's words (or, for reschedule, a time) before they go. */
const NEEDS_TEXT = new Set<TaskAgentAction>(['change-plan', 'send-back', 'reschedule']);

function actionLabel(a: TaskAgentAction | 'unassign', t: Translate): string {
  const labels: Record<string, [string, string]> = {
    'start-now': ['tasks.job.act.startNow', 'Start now'],
    reschedule: ['tasks.job.act.reschedule', 'Change time'],
    stop: ['tasks.job.act.stop', 'Stop'],
    'let-finish': ['tasks.job.act.letFinish', 'Let it finish'],
    continue: ['tasks.job.act.continue', 'Continue'],
    'take-over': ['tasks.job.act.takeOver', "I'll take it"],
    'approve-plan': ['tasks.job.act.approvePlan', 'Approve the plan'],
    'change-plan': ['tasks.job.act.changePlan', 'Ask for changes'],
    'one-more-round': ['tasks.job.act.oneMoreRound', 'One more round'],
    cancel: ['tasks.job.act.cancel', 'Cancel the task'],
    'send-back': ['tasks.job.act.sendBack', 'Send back'],
    complete: ['tasks.job.act.complete', 'Approve and complete'],
    unassign: ['tasks.job.act.unassign', 'Unassign'],
  };
  const [key, fallback] = labels[a] ?? [a, a];
  return tr(t, key, fallback);
}

/** The state line: who, doing what, in words. */
function stateLine(task: Task, job: AgentJobDetail, all: readonly Task[], t: Translate, nameOf: (s: string) => string): string {
  const name = nameOf(task.agent ?? '');
  const reviewer = job.reviewer ? nameOf(job.reviewer) : '';
  const round = String(job.round);
  switch (job.state) {
    case 'scheduled': return tr(t, 'tasks.job.line.scheduled', '{name} starts on this task at {when}.', { name, when: shortWhen(job.startAt) });
    case 'queued': {
      const pos = queuePosition(task, all);
      const at = pos ? tr(t, 'tasks.job.line.position', ' It is number {n} in line.', { n: String(pos) }) : '';
      if (job.step === 'review') return tr(t, 'tasks.job.line.reviewQueued', '{reviewer} reviews round {round} when it is free.', { reviewer, round }) + at;
      if (job.step === 'rework') return tr(t, 'tasks.job.line.reworkQueued', 'Round {round} was sent back. {name} picks it up when it is free.', { name, round }) + at;
      return tr(t, 'tasks.job.line.queued', '{name} is busy. This task waits its turn.', { name }) + at;
    }
    case 'starting':
    case 'running':
      return job.step === 'review'
        ? tr(t, 'tasks.job.line.reviewing', '{reviewer} is reviewing round {round}.', { reviewer, round })
        : job.step === 'plan'
          ? tr(t, 'tasks.job.line.planning', '{name} is writing a plan for you to approve.', { name })
          : tr(t, 'tasks.job.line.running', '{name} is working on this task.', { name });
    case 'waiting_owner': return tr(t, 'tasks.job.line.waiting', '{name} is waiting on you.', { name });
    case 'delivered':
      return job.reviewPassed
        ? tr(t, 'tasks.job.line.passed', '{reviewer} passed round {round}. Approve it to complete the task.', { reviewer, round })
        : tr(t, 'tasks.job.line.delivered', '{name} delivered round {round}. It is yours to review.', { name, round });
    case 'blocked': return tr(t, 'tasks.job.line.blocked', '{name} is blocked.', { name });
    case 'stopped': return tr(t, 'tasks.job.line.stopped', '{name} stopped without delivering.', { name });
    case 'stalled': return tr(t, 'tasks.job.line.stalled', '{name} went quiet and was stopped.', { name });
    case 'stuck': return tr(t, 'tasks.job.line.stuck', 'Still failing at review round {round}.', { round });
    default: return tr(t, 'tasks.job.line.assigned', 'Assigned to {name}.', { name });
  }
}

/**
 * The actions a state offers by itself, with no row (a row adds its own): the rows are this
 * machine's and may be missing (the job ran elsewhere, or the row was never raised), so every
 * state the owner must answer has its buttons here too.
 */
function stateActions(job: AgentJobDetail): Array<TaskAgentAction | 'unassign'> {
  switch (job.state) {
    case 'scheduled': return ['reschedule', 'start-now', 'unassign'];
    case 'queued': return ['reschedule', 'unassign'];
    case 'starting':
    case 'running': return ['stop'];
    case 'delivered': return ['complete', 'send-back'];
    case 'waiting_owner': return job.step === 'plan' ? ['approve-plan', 'change-plan', 'take-over'] : ['take-over', 'unassign'];
    case 'blocked':
    case 'stopped':
    case 'stalled': return ['continue', 'take-over', 'unassign'];
    case 'stuck': return ['one-more-round', 'take-over', 'cancel'];
    default: return ['unassign'];
  }
}

/**
 * The drawer's agent row (AI Team v2 C2): the agent's face, its job's chip and state in words,
 * and the owner's buttons. Buttons come from two places, deduped: what the state offers on its
 * own (Change / Start now / Unassign while it waits, Stop while it runs, Approve / Send back once
 * delivered) and this machine's owner-inbox rows about the task (Continue, I'll take it, One more
 * round…). Rows need no Super session: they render here whatever runs in the Super pane.
 */
export function AgentJobRow({ task, detail, allTasks }: { task: Task; detail: AgentJobDetail; allTasks: readonly Task[] }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const nameOf = (slug: string) => findAgent(agents, slug)?.title ?? slug;
  // A teammate's agent (or reviewer) is read-only here: its job is shown, never answered.
  const readOnly = [task.agent, detail.reviewer].some((s) => !!s && findAgent(agents, s)?.readOnly === true);
  // A closed task's job is history: nothing left to answer, whatever state it stopped in.
  const statusModel = useStatusModel();
  const closed = statusModel.isTerminal(task.status);
  const act = useTaskAgentAction();
  const update = useUpdateTask();
  const [asking, setAsking] = useState<TaskAgentAction | null>(null);
  const [text, setText] = useState('');
  const [when, setWhen] = useState(() => instantToLocalInput(detail.startAt ?? new Date(Date.now() + 3_600_000).toISOString()));
  const [error, setError] = useState<string | null>(null);
  const questions = useAutomationQuestions();
  const answer = useAnswerQuestion();
  const [reply, setReply] = useState('');
  // The job moved on (a poll, another tab): an open "Send back" or "Change time" no longer applies.
  useEffect(() => { setAsking(null); setText(''); }, [detail.state, detail.step]);

  const chip = jobChip(detail, t);
  const rows = readOnly || closed ? [] : detail.rows.filter((r) => r.actions.some((a) => !ROW_SKIP.has(a)));
  const own = readOnly || closed ? [] : stateActions(detail);
  const rowActions = new Set<string>(rows.flatMap((r) => r.actions));
  const busy = act.isPending || update.isPending || answer.isPending;
  // A question this task's live step asked: answered here, on the task (C1-14).
  const question = detail.sessionId && !readOnly && !closed
    ? (questions.data ?? []).find((q) => q.state === 'pending' && q.kind === 'flow-hitl' && q.sessionId === detail.sessionId) ?? null
    : null;

  const run = (action: TaskAgentAction | 'unassign', words?: string) => {
    setError(null);
    if (action === 'unassign') {
      update.mutate({ slug: task.slug, updates: { agent: null } }, { onError: (e) => setError(e.message) });
      return;
    }
    if (NEEDS_TEXT.has(action) && words === undefined) {
      // Change time opens on the job's current start, not the one the drawer first saw.
      if (action === 'reschedule') setWhen(instantToLocalInput(detail.startAt ?? new Date(Date.now() + 3_600_000).toISOString()));
      setAsking(action); setText(''); return;
    }
    act.mutate({ slug: task.slug, action, ...(words ? { text: words } : {}) }, {
      onSuccess: () => { setAsking(null); setText(''); },
      onError: (e) => setError(e.message),
    });
  };
  const sendAsked = () => {
    if (!asking) return;
    if (asking === 'reschedule') {
      const at = localInputToInstant(when);
      if (!at || Date.parse(at) <= Date.now()) { setError(tr(t, 'tasks.assignWhenPast', 'Pick a time in the future.')); return; }
      run('reschedule', at);
    } else if (text.trim()) run(asking, text.trim());
  };

  const button = (a: TaskAgentAction | 'unassign', key: string) => (
    <button
      key={key}
      type="button"
      className={`djob-btn${a === 'complete' || a === 'approve-plan' || a === 'continue' ? ' djob-btn--primary' : ''}${a === 'stop' || a === 'cancel' ? ' djob-btn--danger' : ''}`}
      onClick={() => run(a)}
      disabled={busy}
      aria-pressed={asking === a || undefined}
    >
      {actionLabel(a, t)}
    </button>
  );

  return (
    <section className="djob" data-state={detail.state ?? 'none'} aria-label={tr(t, 'tasks.job.title', 'Agent')}>
      <div className="djob-head">
        {task.agent && <TaskAgentFace slug={task.agent} size={32} />}
        <div className="djob-text">
          <div className="djob-line">
            {chip && <JobChipView chip={chip} />}
            {detail.claimedMachine && (detail.state === 'running' || detail.state === 'starting') && (
              <span className="djob-machine">{tr(t, 'tasks.job.onMachine', 'on {machine}', { machine: detail.claimedMachine })}</span>
            )}
          </div>
          <p className="djob-say">
            {!closed
              ? stateLine(task, detail, allTasks, t, nameOf)
              : statusModel.isCancelled(task.status)
                ? tr(t, 'tasks.job.line.cancelled', 'This task was cancelled.')
                : tr(t, 'tasks.job.line.done', '{name} worked on this task. It is completed.', { name: nameOf(task.agent ?? '') })}
          </p>
          {detail.reason && !closed && <p className="djob-reason">{detail.reason}</p>}
        </div>
        {task.agent && (
          <button type="button" className="djob-link" onClick={() => requestOpenAgents({ slug: task.agent ?? undefined })}>
            {tr(t, 'tasks.job.openStage', 'Open its stage')}
          </button>
        )}
      </div>

      {question && (
        <div className="djob-question">
          <p className="djob-question-text">{question.question}</p>
          <div className="djob-ask">
            <textarea
              className="field-textarea"
              rows={2}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={tr(t, 'tasks.job.replyPlaceholder', 'Your answer')}
              aria-label={tr(t, 'tasks.job.reply', 'Answer the agent')}
              disabled={busy}
            />
            <button
              type="button"
              className="djob-btn djob-btn--primary"
              disabled={busy || !reply.trim()}
              onClick={() => answer.mutate({ id: question.id, kind: 'flow-hitl', answer: reply.trim() }, {
                onSuccess: () => setReply(''),
                onError: (e) => setError(e instanceof Error ? e.message : String(e)),
              })}
            >
              {tr(t, 'tasks.job.send', 'Send')}
            </button>
          </div>
        </div>
      )}

      {rows.map((r: OwnerInboxRow) => (
        <div key={r.id} className="djob-row">
          <p className="djob-row-title">{r.title}</p>
          {r.detail && <p className="djob-row-detail">{r.detail}</p>}
          <div className="djob-actions">
            {r.actions.filter((a) => !ROW_SKIP.has(a)).map((a) => button(a as TaskAgentAction, `${r.id}-${a}`))}
          </div>
        </div>
      ))}

      {own.some((a) => !rowActions.has(a)) && (
        <div className="djob-actions">
          {own.filter((a) => !rowActions.has(a)).map((a) => button(a, a))}
        </div>
      )}

      {asking && (
        <div className="djob-ask">
          {asking === 'reschedule' ? (
            <input
              type="datetime-local"
              className="field-input"
              value={when}
              min={instantToLocalInput(new Date().toISOString())}
              onChange={(e) => setWhen(e.target.value)}
              aria-label={tr(t, 'tasks.assignWhenAt', 'Start at (your local time)')}
            />
          ) : (
            <textarea
              className="field-textarea"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={asking === 'send-back'
                ? tr(t, 'tasks.job.sendBackPlaceholder', 'What should change?')
                : tr(t, 'tasks.job.changePlanPlaceholder', 'What should the plan do differently?')}
              aria-label={actionLabel(asking, t)}
            />
          )}
          <button type="button" className="djob-btn djob-btn--primary" onClick={sendAsked} disabled={busy}>{actionLabel(asking, t)}</button>
          <button type="button" className="djob-btn" onClick={() => setAsking(null)} disabled={busy}>{tr(t, 'common.cancel', 'Cancel')}</button>
        </div>
      )}

      {error && <p className="prop-error" role="alert">{error}</p>}
    </section>
  );
}
