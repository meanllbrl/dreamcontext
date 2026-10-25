import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { emitInstance, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgentStage, useBringAgentHere, type AgentSummary } from '../../hooks/useAgents';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { OPEN_SESSION_EVENT, type OpenSessionDetail } from '../../lib/openSession';
import { requestOpenAgents } from '../../lib/openAgents';
import { AgentAvatar } from '../agents/AgentAvatar';
import { CardChat } from '../whiteboard/widgets/AgentWidget';
import { AutonomyChip } from './AutonomyChip';
import { openStageSession, peekStageSession, stageSessionLevel, subscribeStageSession } from './stageSession';
import { pendingApprovals, routineCountLabel, type TeamRow } from './teamModel';
import { TeamApproval } from './TeamApproval';
import type { PanelTab } from './TeamPanel';
import { TeamIcon } from './TeamIcons';
import { isPhoneSurface } from '../../lib/phoneSurface';
import '../sleepy/ChatPane.css';
import '../sleepy/chat/composer.css';
import '../sleepy/chat/cards.css';
import './AgentStage.css';

/**
 * AN AGENT'S CONVERSATION on the AI Team page (AI Team v2; owner 2026-10-25: "the normal agent
 * interface and composer, nothing made up"): the page keeps its 0.34.5 shape, the team on the
 * left, the conversation in the middle, the existing panel on the right. The middle IS the Chat
 * screen's pane (`ChatPaneHost` on a session held outside React, `stageSession.ts`) at full size,
 * with the Chat composer, its model and effort pickers, attachments, voice, permission and
 * question cards. Only what a pane bound to one agent cannot take stays out: the mode menu and
 * the agent picker (it speaks as this agent) and the permission segment (the agent's autonomy,
 * the chip in the header, decides it). Above it, the conversation header the page always had.
 *
 * The conversation is the agent's HOME session on this machine; the server decides its
 * permission mode from the autonomy level at every spawn. When that conversation is open in a
 * Chat tab already, the page offers to bring that tab forward instead of opening a second
 * process on the same transcript. The routines' runs and posts stay one click away (Activity).
 */
export function AgentStage({
  row,
  agent,
  panelOpen,
  onBack,
  onPanel,
  onTogglePanel,
  onEdit,
  onActivity,
  onToast,
}: {
  row: TeamRow;
  agent: AgentSummary;
  panelOpen: boolean;
  onBack?: () => void;
  onPanel: (tab: PanelTab) => void;
  onTogglePanel: () => void;
  onEdit: (slug: string) => void;
  /** Open the agent's activity (its routines' runs and posts). */
  onActivity: () => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { vault, bus } = useVault();
  const stageQ = useAgentStage(agent.slug);
  const stage = stageQ.data ?? null;
  const autonomy = stage?.autonomy ?? agent.autonomy ?? 'balanced';
  // What waits for the owner's approval (the agent, a routine): approved here, in place.
  const pending = useMemo(() => pendingApprovals(agent, row.routines), [agent, row.routines]);
  // Someone else's agent is read-only here; the owner's other machine may be the one running it.
  const readOnly = agent.readOnly === true;
  const elsewhere = readOnly ? null : agent.runsElsewhere ?? null;
  const bring = useBringAgentHere();

  return (
    <section className="aiteam-convo aiteam-stage" data-stage={agent.slug}>
      <header className="aiteam-convo-head">
        {onBack && (
          <button type="button" className="aiteam-iconbtn aiteam-back" onClick={onBack} aria-label={t('aiteam.back')}>
            <TeamIcon name="back" size={16} />
          </button>
        )}
        <AgentAvatar of="agent" slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={36} face={agent.face} />
        <div className="aiteam-convo-id">
          <span className="aiteam-convo-name">
            <span className="aiteam-convo-name-text">{agent.title}</span>
            {agent.owner && (
              <span className="aiteam-tag aiteam-tag--muted" data-owner-chip>
                {readOnly ? t('aiteam.owner.of').replace('{owner}', agent.ownerLabel ?? agent.owner) : t('aiteam.owner.you')}
              </span>
            )}
          </span>
          {row.role && <span className="aiteam-convo-role">{row.role}</span>}
        </div>
        <span className="aiteam-spacer" />
        <AutonomyChip level={autonomy} onEdit={readOnly ? undefined : () => onEdit(agent.slug)} />
        <button type="button" className="aiteam-pill" onClick={onActivity} data-team-activity title={t('aiteam.stage.seeActivity')} aria-label={t('aiteam.stage.seeActivity')}>
          <TeamIcon name="list" size={14} />
          <span className="aiteam-pill-text">{t('aiteam.stage.seeActivity')}</span>
        </button>
        <button
          type="button"
          className={`aiteam-pill${panelOpen ? ' aiteam-pill--on' : ''}`}
          onClick={() => onPanel('routines')}
          data-team-routines={row.routines.length}
        >
          <TeamIcon name="clock" size={14} />
          <span className="aiteam-pill-text">{routineCountLabel(row.routines.length, t)}</span>
        </button>
        <button
          type="button"
          className="aiteam-iconbtn"
          onClick={onTogglePanel}
          aria-pressed={panelOpen}
          aria-label={t('aiteam.details')}
          title={t('aiteam.details')}
        >
          <TeamIcon name="panel" size={16} />
        </button>
      </header>

      {readOnly ? (
        <div className="aiteam-banner" role="note" data-readonly-banner>
          <TeamIcon name="lock" size={14} />
          <span>{t('aiteam.readonly.banner').replace('{owner}', agent.ownerLabel ?? agent.owner ?? '')}</span>
        </div>
      ) : elsewhere ? (
        <div className="aiteam-banner" role="note" data-elsewhere-banner>
          <span>{t('aiteam.elsewhere.banner').replace('{machine}', elsewhere.name)}</span>
          <span className="aiteam-spacer" />
          {/* Where an agent runs is decided at the machine that will run it, never from the phone. */}
          {!isPhoneSurface() && <button
            type="button"
            className="agp-btn agp-btn--primary"
            disabled={bring.isPending}
            onClick={() => bring.mutate(agent.slug, {
              onSuccess: () => onToast(t('aiteam.elsewhere.brought').replace('{name}', agent.title)),
              onError: (err) => onToast((err as Error).message),
            })}
            data-bring-here
          >
            {t('aiteam.elsewhere.bring')}
          </button>}
        </div>
      ) : (
        <TeamApproval agentTitle={agent.title} pending={pending} onToast={onToast} />
      )}

      {readOnly || elsewhere ? (
        <div className="aiteam-stage-note" data-stage-closed>
          <p>{readOnly
            ? t('aiteam.readonly.chat').replace('{owner}', agent.ownerLabel ?? agent.owner ?? '').replace('{name}', agent.title)
            : t('aiteam.elsewhere.chat').replace('{machine}', elsewhere?.name ?? '').replace('{name}', agent.title)}</p>
        </div>
      ) : (
        <StageChat agent={agent} level={autonomy} homeId={stage?.homeSessionId ?? null} homeLive={!!stage?.homeLive} ready={!!stage} vault={vault ?? ''} bus={bus} />
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
  // Held elsewhere = a live process has the home conversation and it is not this page's.
  const heldElsewhere = !session && homeLive;
  // Opened like a Chat tab: the conversation is there when its agent is.
  useEffect(() => {
    if (!session && ready && agent.approvedForChat && !heldElsewhere) open();
  }, [session, ready, agent.approvedForChat, heldElsewhere, open]);
  // The level changed (the Edit dialog): the server decides the permission mode only at a spawn,
  // so the same conversation is respawned at the new level, once the turn in flight has ended.
  const openedAt = session ? stageSessionLevel(vault, agent.slug) : null;
  useEffect(() => {
    if (!ready || !session || session.busy || openedAt === null || openedAt === level) return;
    open('resume');
  }, [ready, session, session?.busy, openedAt, level, open]);

  if (!agent.approvedForChat) {
    return (
      <div className="aiteam-stage-note">
        <p>{t('aiteam.stage.blocked').replace('{name}', agent.title)}</p>
        <button type="button" className="aiteam-pill" onClick={() => requestOpenAgents({ slug: agent.slug })}>{t('aiteam.stage.review')}</button>
      </div>
    );
  }
  if (heldElsewhere && homeId) {
    return (
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
    );
  }
  if (!session) return <div className="aiteam-stage-note"><p>{t('common.loading')}</p></div>;
  return (
    <CardChat
      session={session}
      reopen={() => open('resume')}
      placeholder={t('aiteam.stage.placeholder').replace('{name}', agent.title)}
      pane
    />
  );
}
