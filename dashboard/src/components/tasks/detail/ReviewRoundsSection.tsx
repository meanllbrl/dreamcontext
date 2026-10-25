import type { AgentJobDetail, StatusHistoryRow } from '../../../hooks/useTasks';
import { findAgent, useAgents } from '../../../hooks/useAgents';
import { useI18n } from '../../../context/I18nContext';
import { tr } from '../../../lib/assignToAgent';
import { reviewRounds, shortWhen, type RoundResult } from '../../../lib/taskAgentJob';
import { Section } from './BodySections';

const TONE: Record<RoundResult, string> = { passed: 'good', 'sent-back': 'warn', reviewing: 'accent', owner: 'neutral' };

/** One row per delivered round and what came of it (AI Team v2 C2). Shown only once a reviewer
 *  agent is on the task: with the owner reviewing, Deliveries already says it all. */
export function ReviewRoundsSection({ job, history }: { job: AgentJobDetail; history: readonly StatusHistoryRow[] }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const rows = reviewRounds(job, job.deliveries, history);
  if (!job.reviewer || rows.length === 0) return null;
  const reviewer = findAgent(agents, job.reviewer)?.title ?? job.reviewer;
  const word = (r: RoundResult) => ({
    passed: tr(t, 'tasks.reviewPassed', 'Passed'),
    'sent-back': tr(t, 'tasks.reviewSentBack', 'Sent back'),
    reviewing: tr(t, 'tasks.reviewInReview', 'In review'),
    owner: tr(t, 'tasks.reviewWaiting', 'Waiting'),
  })[r];
  return (
    <Section k="review-rounds" title={tr(t, 'tasks.reviewRounds', 'Review rounds')} count={`${job.round}/${job.cap}`}>
      <p className="drev-by">{tr(t, 'tasks.reviewBy', 'Reviewed by {name}', { name: reviewer })}</p>
      <ol className="drev-list">
        {rows.map((r) => (
          <li key={r.round} className="drev-row">
            <span className="drev-round">{tr(t, 'tasks.deliveryRound', 'Round {round}', { round: String(r.round) })}</span>
            <span className={`job-chip job-chip--${TONE[r.result]}`} data-round={r.result}><span className="job-chip-dot" aria-hidden />{word(r.result)}</span>
            <span className="drev-when">{shortWhen(r.deliveredAt)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
