import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { useReplyDelivery, useReplyToAgentThread } from '../../../hooks/useAutomations';
import { RunReport, RunView } from '../../aiteam/RunView';
import { teamStatusOf, type TeamCard } from './TeamTile';

/**
 * A team job's card, large: the job's own session, the transcript a child's card shows, and
 * below it the one honest way to go on. While the job runs nothing can be typed into it. Once it
 * ended, what the owner writes continues THAT session through the run's own reply path, and the
 * Super Agent hears both his words and the answer (a follow-up job, `recordTeamFollowUp`).
 */
export function TeamJobConversation({ card }: { card: TeamCard }) {
  const { t } = useI18n();
  const name = useAgent(card.job.member).data?.agent?.title || card.job.member;
  const status = teamStatusOf(card);
  const running = status === 'running' || status === 'queued';
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState(false);
  const { mutate, isPending } = useReplyToAgentThread();
  // A reply the server took can still be refused at the resume: said here, never silent.
  const delivery = useReplyDelivery(card.job.member, card.job.runId).data;
  const undelivered = delivery && delivery.status !== 'ok' && delivery.status !== 'running'
    ? delivery.reason ?? t('agents.thread.unknown') : null;
  const send = () => {
    const body = text.trim();
    if (!body || isPending) return;
    setError(null);
    mutate({ slug: card.job.member, runId: card.job.runId, text: body }, {
      onSuccess: () => setText(''),
      onError: (err) => setError((err as Error).message),
    });
  };
  const closed = running ? t('super.team.reply.working').replace('{name}', name)
    : !card.resumable ? t('super.team.reply.noSession') : null;
  return (
    <section className="super-team-job" data-testid="team-job-conversation" data-team-status={status}>
      <div className="super-team-job-body">
        {card.sessionId
          ? <RunView key={card.sessionId} claudeId={card.sessionId} live={running} />
          : <p className="aiteam-stage-note">{running ? t('super.team.reply.starting') : card.lastLine}</p>}
      </div>
      {report && <div className="super-team-job-report"><RunReport slug={card.job.member} runId={card.job.runId} /></div>}
      {!running && (
        <button type="button" className="chat-feed-link super-team-job-reportbtn" aria-expanded={report} data-testid="team-job-report" onClick={() => setReport((v) => !v)}>
          {t(report ? 'aiteam.run.hideReport' : 'aiteam.history.fullReport')}
        </button>
      )}
      {closed
        ? <p role="status" className="super-team-job-closed" data-testid="team-job-closed">{closed}</p>
        : (
          <form className="super-team-job-reply" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea
              data-testid="team-job-reply" rows={2} value={text} disabled={isPending}
              placeholder={t('super.team.reply.placeholder').replace('{name}', name)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            />
            <button type="submit" className="aiteam-pill" disabled={isPending || !text.trim()}>{t('super.team.reply.send')}</button>
          </form>
        )}
      {(error ?? undelivered) && <p role="alert" className="super-team-job-closed">{error ?? undelivered}</p>}
    </section>
  );
}
