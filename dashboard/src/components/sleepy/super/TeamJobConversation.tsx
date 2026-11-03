import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { useReplyDelivery, useReplyToAgentThread } from '../../../hooks/useAutomations';
import { RunReport, RunView } from '../../aiteam/RunView';
import { teamStatusOf, type TeamCard } from './TeamTile';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { requestOpenAgents } from '../../../lib/openAgents';
import { ChildTranscript, useChildHistory } from './ChildTranscript';
import { superRequestOf } from './superHandover';
import { fetchSuperState } from './superApi';
import { memberSuperId } from './memberStageModel';
import { readSuperRecord } from './superRecordStore';
import { SuperRequestBlock } from './MemberStage';

/**
 * The member's own Super session, for a job main gave it as a `request` (plan-r10 1b, Wave 3):
 * from this window's record store when it holds the member's record, else read once from the
 * member's record (`GET /api/super/state?superId=m:<slug>`). Null while unknown or never born.
 */
export function useMemberSuperSession(vault: string, member: string, enabled: boolean): string | null {
  return useMemberSuperRecord(vault, member, enabled, null).session;
}

/** What the card shows of the request from the member's own record: main's text and, once the
 *  member closed it (`super team done`), its result. */
export interface MemberRequestView { text: string; result: string | null }

/**
 * The member's record for its card (super-team.mjs T4): its Super session and the request item
 * this job is, from this window's record store, else read from the member's record (and again
 * while the job runs, so the result lands). The request and the answer show from the record at
 * once, whatever the transcript's read does.
 */
export function useMemberSuperRecord(vault: string, member: string, enabled: boolean, requestId: string | null): { session: string | null; request: MemberRequestView | null } {
  const api = useApi();
  const held = enabled ? readSuperRecord(vault, memberSuperId(member)) : null;
  const q = useQuery({
    queryKey: ['super-member-record', vault, member],
    queryFn: async () => fetchSuperState(api, memberSuperId(member)),
    enabled: enabled && !held,
    staleTime: 5_000,
    refetchInterval: enabled && !held ? 5_000 : false,
  });
  const rec = held ?? q.data ?? null;
  const item = requestId ? rec?.queue.find((x) => x.id === requestId && x.kind === 'request') : undefined;
  return {
    session: rec?.session ?? null,
    request: item && item.text ? { text: item.text, result: typeof item.result === 'string' && item.result ? item.result : null } : null,
  };
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
/** The record's copy of main's request, shown at the END of the flow only until the member's
 *  transcript holds a request turn with the same item id (plan r4 E1'). Never two copies. */
function RequestFallback({ session, running, itemId, text }: { session: string | null; running: boolean; itemId: string; text: string }) {
  const { t } = useI18n();
  const history = useChildHistory(session ?? '', running && !!session);
  const inFlow = (history.data ?? []).some((e) => e.kind === 'user' && superRequestOf(e.text)?.itemId === itemId);
  if (inFlow) return null;
  return (
    <div className="super-team-job-waiting" data-testid="team-job-request-fallback">
      <SuperRequestBlock turn={{ kind: 'request', itemId, text }} itemId={`req-${itemId}`} />
      <p className="super-request-waiting">{t('superStage.member.waiting')}</p>
    </div>
  );
}

export function TeamJobConversation({ card, vault = '' }: { card: TeamCard; vault?: string }) {
  const { t } = useI18n();
  // A request to the member's own Super (Wave 3): the card IS that member's one conversation, read
  // from its record's session, never an empty new chat. The owner talks to it on its stage.
  const isRequest = !!card.job.request;
  const memberRec = useMemberSuperRecord(vault, card.job.member, isRequest, card.job.request ?? null);
  const memberSession = memberRec.session;
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
        {/* Nothing pinned above the conversation (plan r4 E1): the request shows ONCE, in the
            flow where it arrived. Only while the transcript has not loaded that turn yet (T4) the
            record's copy stands at the end, waiting, and goes the moment the turn is there. */}
        <div className="super-team-job-body">
          {memberSession
            ? <ChildTranscript key={memberSession} claudeId={memberSession} live={running} foot="own" />
            : <p className="aiteam-stage-note">{running ? t('super.team.reply.starting') : card.lastLine}</p>}
          {memberRec.request && (
            <RequestFallback session={memberSession} running={running} itemId={card.job.request ?? ''} text={memberRec.request.text} />
          )}
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
