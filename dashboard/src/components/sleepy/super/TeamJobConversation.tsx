import { useCallback, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { useReplyDelivery, useReplyToAgentThread } from '../../../hooks/useAutomations';
import { RunReport } from '../../aiteam/RunView';
import { runViewItems } from '../../aiteam/agentHistory';
import { RunDocumentTileFor } from '../../aiteam/RunDocumentTile';
import { chatFilePath } from '../chat/chatFeed';
import { teamStatusOf, type TeamCard } from './TeamTile';
import { useMemberHelpers, useMemberSuperRecord } from './useMemberRecord';
import type { MemberHelper } from '../../../lib/superTypes';
import { TeamHelpers } from './TeamHelpers';
import { ChildTranscript, useChildHistory } from './ChildTranscript';
import { superRequestOf } from './superHandover';
import { SuperRequestBlock } from './MemberStage';

/**
 * A member's one card, large (plan-r10 1b): the root session's transcript, which holds every
 * resumed turn of the conversation (the Super Agent's follow-ups and the owner's), and below it the
 * one honest way to go on. While the job runs nothing can be typed into it. Once it ended, what the
 * owner writes continues THAT session through the run's own reply path, and the Super Agent hears
 * both his words and the answer (a follow-up job, `recordTeamFollowUp`). After a rotation (20
 * turns, or a conversation that could not be continued) a first line "önceki konuşma" opens the
 * previous run's transcript.
 *
 * Every route draws its transcript the same way: the chat pane itself, filling the card, never a
 * fixed-height bordered box inside it (owner 2026-11-14, learned rule h7tjatns3j: a member's chat
 * looks like a normal chat). A run route leaves out the prompt the runner composed.
 */
/** The record's copy of main's request, shown at the END of the flow only until the member's
 *  transcript holds a request turn with the same item id (plan r4 E1'). Never two copies. */
function RequestFallback({ session, running, itemId, text }: { session: string | null; running: boolean; itemId: string; text: string }) {
  // No session yet: nothing to read, the record's copy stands.
  if (!session) return <RequestWaiting itemId={itemId} text={text} />;
  return <RequestUntilInFlow session={session} running={running} itemId={itemId} text={text} />;
}

function RequestUntilInFlow({ session, running, itemId, text }: { session: string; running: boolean; itemId: string; text: string }) {
  const history = useChildHistory(session, running);
  const inFlow = (history.data ?? []).some((e) => e.kind === 'user' && superRequestOf(e.text)?.itemId === itemId);
  return inFlow ? null : <RequestWaiting itemId={itemId} text={text} />;
}

function RequestWaiting({ itemId, text }: { itemId: string; text: string }) {
  const { t } = useI18n();
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
  // The card is the member's ONE conversation, keyed by its first job (the chain root); the request
  // that can still be waiting is the NEWEST one (2026-11-11, kitup Turing: the root's 6 Nov brief
  // stood under the 11 Nov exchange as "waiting").
  const requestId = card.job.chain?.newest.request ?? card.job.request ?? null;
  const memberRec = useMemberSuperRecord(vault, card.job.member, isRequest, requestId);
  const memberSession = memberRec.session;
  // The helpers the member's Super started for THIS card's requests (owner 2026-11-15, option A).
  const helpers = useMemberHelpers(memberRec.record, card);
  const [held, setHeld] = useState<MemberHelper | null>(null);
  // The open helper, fresh from the record; while the record is unknown for a moment (the store
  // and the read hand over) its last view stays, so the card never jumps back and forth.
  const picked = held ? helpers.find((h) => h.id === held.id && h.row !== 'pooled') ?? (memberRec.record ? null : held) : null;
  const setPicked = (id: string | null) => setHeld(id ? helpers.find((h) => h.id === id) ?? null : null);
  const stripRef = useRef<HTMLDivElement>(null);
  const back = () => {
    const id = picked?.id;
    setHeld(null);
    // Focus returns to the chip that opened it (the back button unmounts on its own click).
    requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>(`[data-helper="${CSS.escape(id ?? '')}"]`)?.focus());
  };
  const name = useAgent(card.job.member).data?.agent?.title || card.job.member;
  const status = teamStatusOf(card);
  const running = status === 'running' || status === 'queued';
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState(false);
  const prev = card.job.chain?.previous;
  // The run's published document: a tile at the end of its steps, opening in the pane's side file
  // panel (owner 2026-11-08, replaces the "Full report" link). A stable function, the pane memoizes on it.
  const member = card.job.member;
  const runId = card.job.runId;
  const docTile = useCallback(
    (ctx: { openFile: (path: string) => void }) => <RunDocumentTileFor slug={member} runId={runId} onOpenFile={(p) => ctx.openFile(chatFilePath(p))} />,
    [member, runId],
  );
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
        <div ref={stripRef} className="super-team-helpers-wrap"><TeamHelpers helpers={helpers} picked={picked?.id ?? null} onPick={setPicked} member={name} /></div>
        {picked ? (
          <>
            <div className="super-team-helper-crumb" data-testid="team-helper-crumb">
              <button type="button" className="super-team-helper-back" data-testid="team-helper-back" onClick={back}>
                {t('superStage.team.backTo').replace('{name}', name)}
              </button>
              <span className="super-team-helper-crumb-now" title={picked.brief}>/ {picked.brief}</span>
            </div>
            <div className="super-team-job-body" data-testid="team-helper-body">
              <ChildTranscript key={picked.id} claudeId={picked.id} live={picked.live} foot="own" />
            </div>
          </>
        ) : (
          /* Nothing pinned above the conversation (plan r4 E1): the request shows ONCE, in the
             flow where it arrived. Only while the transcript has not loaded that turn yet (T4) the
             record's copy stands at the end, waiting, and goes the moment the turn is there. */
          <div className="super-team-job-body">
            {memberSession
              ? <ChildTranscript key={memberSession} claudeId={memberSession} live={running} foot="own" />
              : <p className="aiteam-stage-note">{running ? t('super.team.reply.starting') : card.lastLine}</p>}
            {/* Only a request that has not reached the member's session yet: one it took or closed is
                in the transcript it was delivered to (a batched turn, or a session before a rotation,
                is not this card's to redraw at the end). */}
            {memberRec.request?.undelivered && requestId && (
              <RequestFallback session={memberSession} running={running} itemId={requestId} text={memberRec.request.text} />
            )}
          </div>
        )}
        {/* "Open stage" is in the card's head now (SuperContainer): the foot bar is gone. */}
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
            ? <ChildTranscript key={prev.sessionId} claudeId={prev.sessionId} foot="own" prepare={runViewItems} />
            : <RunReport slug={card.job.member} runId={prev.runId} />}
        </div>
      )}
      <div className="super-team-job-body">
        {card.sessionId
          ? <ChildTranscript key={card.sessionId} claudeId={card.sessionId} live={running} foot="own" prepare={runViewItems} endSlot={running ? undefined : docTile} />
          : <p className="aiteam-stage-note">{running ? t('super.team.reply.starting') : card.lastLine}</p>}
      </div>
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

