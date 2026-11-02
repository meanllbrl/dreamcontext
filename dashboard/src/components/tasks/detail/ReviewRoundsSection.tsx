import type { AgentJobDetail, StatusHistoryRow } from '../../../hooks/useTasks';
import { findAgent, useAgents } from '../../../hooks/useAgents';
import { useI18n } from '../../../context/I18nContext';
import { tr } from '../../../lib/assignToAgent';
import { reviewRounds, shortWhen, type RoundResult } from '../../../lib/taskAgentJob';
import { Section } from './BodySections';
import { TaskFaceButton } from './AgentJobRow';

const TONE: Record<RoundResult, string> = {
  passed: 'good', 'sent-back': 'warn', 'owner-sent-back': 'warn', failed: 'bad', stuck: 'bad', reviewing: 'accent', owner: 'neutral',
};

/** One row per delivered round and what came of it (AI Team v2 C2). Shown only once a reviewer
 *  agent is on the task: with the owner reviewing, Deliveries already says it all. */
export function ReviewRoundsSection({ job, history, taskSlug }: {
  job: AgentJobDetail;
  history: readonly StatusHistoryRow[];
  /** The task these rounds are of: the reviewer's face opens its stage on it (plan-r10 1c). */
  taskSlug?: string;
}) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const rows = reviewRounds(job, job.deliveries, history);
  if (!job.reviewer || rows.length === 0) return null;
  const reviewer = findAgent(agents, job.reviewer)?.title ?? job.reviewer;
  const word = (r: RoundResult) => ({
    passed: tr(t, 'tasks.reviewPassed', 'Passed'),
    'sent-back': tr(t, 'tasks.reviewSentBack', 'Sent back'),
    'owner-sent-back': tr(t, 'tasks.reviewOwnerSentBack', 'You sent it back'),
    failed: tr(t, 'tasks.reviewFailed', 'Failed'),
    stuck: tr(t, 'tasks.reviewStuck', 'Stuck'),
    reviewing: tr(t, 'tasks.reviewInReview', 'In review'),
    owner: tr(t, 'tasks.reviewWaiting', 'Waiting'),
  })[r];
  return (
    <Section k="review-rounds" title={tr(t, 'tasks.reviewRounds', 'Review rounds')} count={`${job.round}/${job.cap}`}>
      <p className="drev-by" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {/* Without the task (an older caller) the face still opens the member, with no strip. */}
        <TaskFaceButton slug={job.reviewer} task={taskSlug ?? ''} role="reviewer" size={20} />
        {tr(t, 'tasks.reviewBy', 'Reviewed by {name}', { name: reviewer })}
      </p>
      <ol className="drev-list">
        {rows.map((r) => (
          <li key={r.round} className="drev-row" data-round-result={r.result} style={r.findings ? { flexWrap: 'wrap' } : undefined}>
            <span className="drev-round">{tr(t, 'tasks.deliveryRound', 'Round {round}', { round: String(r.round) })}</span>
            <span className={`job-chip job-chip--${TONE[r.result]}`} data-round={r.result}><span className="job-chip-dot" aria-hidden />{word(r.result)}</span>
            {r.who && <span className="drev-who" style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>{r.who}</span>}
            <span className="drev-when">{shortWhen(r.deliveredAt)}</span>
            {r.findings && (
              <p className="drev-findings" data-testid="review-findings" style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {r.findings}
              </p>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}
