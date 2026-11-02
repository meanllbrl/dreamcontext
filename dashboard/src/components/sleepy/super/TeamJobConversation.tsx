import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { useReplyDelivery, useReplyToAgentThread } from '../../../hooks/useAutomations';
import { RunReport, RunView } from '../../aiteam/RunView';
import { teamStatusOf, type TeamCard } from './TeamTile';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { requestOpenAgents } from '../../../lib/openAgents';
import { ChildTranscript } from './ChildTranscript';
import { fetchSuperState } from './superApi';
import { memberSuperId } from './memberStageModel';
import { readSuperRecord } from './superRecordStore';

/**
 * The member's own Super session, for a job main gave it as a `request` (plan-r10 1b, Wave 3):
 * from this window's record store when it holds the member's record, else read once from the
 * member's record (`GET /api/super/state?superId=m:<slug>`). Null while unknown or never born.
 */
export function useMemberSuperSession(vault: string, member: string, enabled: boolean): string | null {
  const api = useApi();
  const held = enabled ? readSuperRecord(vault, memberSuperId(member))?.session ?? null : null;
  const q = useQuery({
    queryKey: ['super-member-session', vault, member],
    queryFn: async () => (await fetchSuperState(api, memberSuperId(member)))?.session ?? null,
    enabled: enabled && !held,
    staleTime: 10_000,
  });
  return held ?? q.data ?? null;
}

/**
 * A member's one card, large (plan-r10 1b): the root session's transcript, which holds every
 * resumed turn of the conversation (the Super Agent's follow-ups and the owner's), and below it the
 * one honest way to go on. While the job runs nothing can be typed into it. Once it ended, what the
 * owner writes continues THAT session through the run's own reply path, and the Super Agent hears
 * both his words and the answer (a follow-up job, `recordTeamFollowUp`). After a rotation (20
 * turns, or a conversation that could not be continued) a first line "önceki konuşma" opens the
 * previous run's transcript.
 */
export function TeamJobConversation({ card, vault = '' }: { card: TeamCard; vault?: string }) {
  const { t } = useI18n();
  // A request to the member's own Super (Wave 3): the card IS that member's one conversation, read
  // from its record's session, never an empty new chat. The owner talks to it on its stage.
  const isRequest = !!card.job.request;
  const memberSession = useMemberSuperSession(vault, card.job.member, isRequest);
  const name = useAgent(card.job.member).data?.agent?.title || card.job.member;
  const status = teamStatusOf(card);
  const running = status === 'running' || status === 'queued';
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState(false);
  const [previous, setPrevious] = useState(false);
  const prev = card.job.chain?.previous;
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
  if (isRequest) {
    return (
      <section className="super-team-job" data-testid="team-job-conversation" data-team-status={status} data-request={card.job.request}>
        <div className="super-team-job-body">
          {memberSession
            ? <ChildTranscript key={memberSession} claudeId={memberSession} live={running} foot="own" />
            : <p className="aiteam-stage-note">{running ? t('super.team.reply.starting') : card.lastLine}</p>}
        </div>
        <button type="button" className="aiteam-pill" data-testid="team-job-open-member" onClick={() => requestOpenAgents({ slug: card.job.member })}>
          {t('aiteam.manage.openChat')}
        </button>
      </section>
    );
  }
  return (
    <section className="super-team-job" data-testid="team-job-conversation" data-team-status={status}>
      {prev && (
        <button type="button" className="chat-feed-link super-team-job-previous" aria-expanded={previous} data-testid="team-job-previous" onClick={() => setPrevious((v) => !v)}>
          {t('superStage.team.previous')}
        </button>
      )}
      {prev && previous && (
        <div className="super-team-job-body super-team-job-body--previous" data-testid="team-job-previous-body">
          {prev.sessionId
            ? <RunView key={prev.sessionId} claudeId={prev.sessionId} live={false} />
            : <RunReport slug={card.job.member} runId={prev.runId} />}
        </div>
      )}
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
