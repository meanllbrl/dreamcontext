import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { emitInstance, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgentStage, type AgentSummary } from '../../hooks/useAgents';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { OPEN_SESSION_EVENT, type OpenSessionDetail } from '../../lib/openSession';
import { requestOpenAgents } from '../../lib/openAgents';
import { AgentAvatar } from '../agents/AgentAvatar';
import { CardChat } from '../whiteboard/widgets/AgentWidget';
import { AutonomyChip } from './AutonomyChip';
import { DeliveryCards, ReportsCard, RoutinesCard, RunningCards } from './StageCards';
import { openStageSession, peekStageSession, stageSessionLevel, subscribeStageSession } from './stageSession';
import { pendingApprovals, type TeamRow } from './teamModel';
import { TeamApproval } from './TeamApproval';
import type { PanelTab } from './TeamPanel';
import { TeamIcon } from './TeamIcons';
import '../sleepy/ChatPane.css';
import '../sleepy/chat/composer.css';
import '../sleepy/chat/cards.css';
import '../whiteboard/widgets/agentWidget.css';
import './AgentStage.css';

/** How many deliveries the side column shows. */
const SIDE_FILES = 3;

/**
 * AN AGENT'S STAGE (AI Team v2, owner 2026-10-24): its live conversation as the main card, with
 * what it is doing, what it delivered, its routines and its latest reports as cards around it.
 *
 * The middle is the real Chat engine, mounted the way a whiteboard card mounts it (`CardChat` +
 * a session held outside React, `stageSession.ts`): streaming, tool rows, question cards and
 * interrupt all come with it. The conversation is the stage's HOME session on this machine; the
 * server decides its permission mode from the agent's autonomy level. When that conversation is
 * open in a Chat tab already, the stage offers to bring that tab forward instead of opening a
 * second process on the same transcript.
 *
 * Phone width: the chat fills the stage, the cards wait behind "Cards".
 */
export function AgentStage({
  row,
  agent,
  narrow,
  onBack,
  onPanel,
  onEdit,
  onOpenFile,
  onActivity,
  onToast,
}: {
  row: TeamRow;
  agent: AgentSummary;
  narrow: boolean;
  onBack?: () => void;
  onPanel: (tab: PanelTab) => void;
  onEdit: (slug: string) => void;
  onOpenFile: (path: string) => void;
  /** Open the agent's activity (its runs' thread), at one routine's newest message when given. */
  onActivity: (slug: string | null) => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { vault, bus } = useVault();
  const stageQ = useAgentStage(agent.slug);
  const stage = stageQ.data ?? null;
  const [show, setShow] = useState<'chat' | 'cards'>('chat');
  const autonomy = stage?.autonomy ?? agent.autonomy ?? 'balanced';
  // What waits for the owner's approval (the agent, a routine): approved here, in place.
  const pending = useMemo(() => pendingApprovals(agent, row.routines), [agent, row.routines]);

  return (
    <section className={`aiteam-stage${narrow ? ' aiteam-stage--narrow' : ''}`} data-stage={agent.slug} data-show={narrow ? show : 'all'}>
      <header className="aiteam-stage-head">
        {onBack && (
          <button type="button" className="aiteam-iconbtn" onClick={onBack} aria-label={t('aiteam.back')}>
            <TeamIcon name="back" />
          </button>
        )}
        <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={44} of="agent" face={agent.face} />
        <div className="aiteam-stage-id">
          <h2 className="aiteam-stage-name">{agent.title}</h2>
          {row.role && <p className="aiteam-stage-role">{row.role}</p>}
        </div>
        <AutonomyChip level={autonomy} onEdit={() => onEdit(agent.slug)} />
        {narrow ? (
          <button type="button" className="aiteam-pill" onClick={() => setShow((s) => (s === 'chat' ? 'cards' : 'chat'))} aria-pressed={show === 'cards'}>
            {show === 'chat' ? t('aiteam.stage.cards') : t('aiteam.stage.chat')}
          </button>
        ) : (
          <button type="button" className="aiteam-pill" onClick={() => onPanel('profile')}>{t('aiteam.stage.panel')}</button>
        )}
      </header>

      <TeamApproval agentTitle={agent.title} pending={pending} onToast={onToast} />

      <div className="aiteam-stage-body">
        <div className="aiteam-stage-main">
          <StageChat agent={agent} level={autonomy} homeId={stage?.homeSessionId ?? null} homeLive={!!stage?.homeLive} ready={!!stage} vault={vault ?? ''} bus={bus} />
        </div>
        <aside className="aiteam-stage-side" aria-label={t('aiteam.stage.cardsLabel')}>
          {stage && (
            <>
              <RunningCards stage={stage} onActivity={onActivity} />
              <DeliveryCards stage={stage} onOpenFile={onOpenFile} limit={SIDE_FILES} />
              <RoutinesCard stage={stage} onOpen={() => onPanel('routines')} />
              {narrow && <ReportsCard stage={stage} onActivity={onActivity} />}
              {narrow && <button type="button" className="aiteam-pill" onClick={() => onPanel('profile')}>{t('aiteam.stage.panel')}</button>}
            </>
          )}
        </aside>
      </div>

      {stage && !narrow && (
        <div className="aiteam-stage-foot">
          <ReportsCard stage={stage} onActivity={onActivity} />
        </div>
      )}
    </section>
  );
}

function useStageSession(vault: string, agent: AgentSummary, homeId: string | null, level: string) {
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  // Re-render on every change the session reports (opened, replaced, busy, asking): the session
  // object stays the same across those, so a snapshot of it alone would miss them.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeStageSession(vault, agent.slug, bump), [vault, agent.slug]);
  const session = peekStageSession(vault, agent.slug);
  const open = useCallback(
    (how: 'continue' | 'resume' = 'continue') => openStageSession({
      vault, agent: agent.slug, homeId, level,
      model: agent.model ?? modelConfig.defaultModel, effort: agent.effort ?? modelConfig.defaultEffort,
    }, how),
    [vault, agent.slug, agent.model, agent.effort, homeId, level, modelConfig.defaultModel, modelConfig.defaultEffort],
  );
  return { session, open };
}

function StageChat({ agent, level, homeId, homeLive, ready, vault, bus }: {
  agent: AgentSummary;
  level: string;
  homeId: string | null;
  homeLive: boolean;
  ready: boolean;
  vault: string;
  bus: EventTarget;
}) {
  const { t } = useI18n();
  const { session, open } = useStageSession(vault, agent, homeId, level);
  // Held elsewhere = a live process has the home conversation and it is not this stage's.
  const heldElsewhere = !session && homeLive;
  // Looking at a teammate starts nothing: the conversation's process starts when the owner turns
  // to it (a click on the card), exactly as a board's agent panel waits to be opened.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (armed && !session && ready && agent.approvedForChat && !heldElsewhere) open();
  }, [armed, session, ready, agent.approvedForChat, heldElsewhere, open]);
  // The level changed (the Edit dialog): the server decides the permission mode only at a spawn,
  // so the same conversation is respawned at the new level, once the turn in flight has ended.
  const openedAt = session ? stageSessionLevel(vault, agent.slug) : null;
  useEffect(() => {
    if (!session || session.busy || openedAt === null || openedAt === level) return;
    open('resume');
  }, [session, session?.busy, openedAt, level, open]);

  const label = t('aiteam.stage.chatWith').replace('{name}', agent.title);
  return (
    <div className="aiteam-stage-chat" aria-label={label}>
      <div className="aiteam-stage-chat-head">
        <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={22} of="agent" face={agent.face} />
        <span className="aiteam-stage-chat-title">{label}</span>
        {session && <span className={`aiteam-stage-live${session.busy ? ' is-busy' : ''}`}>{session.busy ? t('aiteam.stage.working') : t('aiteam.stage.live')}</span>}
      </div>
      {!agent.approvedForChat ? (
        <div className="aiteam-stage-note">
          <p>{t('aiteam.stage.blocked').replace('{name}', agent.title)}</p>
          <button type="button" className="aiteam-pill" onClick={() => requestOpenAgents({ slug: agent.slug })}>{t('aiteam.stage.review')}</button>
        </div>
      ) : heldElsewhere && homeId ? (
        <div className="aiteam-stage-note">
          <p>{t('aiteam.stage.held')}</p>
          <button
            type="button"
            className="aiteam-pill"
            onClick={() => { const detail: OpenSessionDetail = { claudeId: homeId }; emitInstance(bus, OPEN_SESSION_EVENT, detail); }}
          >
            {t('aiteam.stage.openTab')}
          </button>
        </div>
      ) : !session && !armed ? (
        <button type="button" className="aiteam-stage-start" onClick={() => setArmed(true)} data-stage-start>
          <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={56} of="agent" face={agent.face} />
          <span className="aiteam-stage-start-line">{homeId ? t('aiteam.stage.continue') : t('aiteam.stage.placeholder').replace('{name}', agent.title)}</span>
        </button>
      ) : !session ? (
        <div className="aiteam-stage-note"><p>{t('common.loading')}</p></div>
      ) : (
        <CardChat
          session={session}
          reopen={() => open('resume')}
          placeholder={t('aiteam.stage.placeholder').replace('{name}', agent.title)}
        />
      )}
    </div>
  );
}
