import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
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
import {
  loadOlderStageFeed, markStageDividerScrolled, markStageSeen, openStageSession, peekStageSession, refreshStageFeed,
  remountStageFeed, retryStageFeed, setStageFeedPinned, stageFeed, stageSessionLevel, subscribeStageSession,
} from './stageSession';
import { dayRuleLabel, pendingApprovals, routineCountLabel, type TeamRow } from './teamModel';
import type { ChatFeed, FeedLabels, FeedMeta } from '../sleepy/chat/chatFeed';
import { TeamApproval } from './TeamApproval';
import type { PanelTab } from './TeamPanel';
import { TeamIcon } from './TeamIcons';
import { isPhoneSurface } from '../../lib/phoneSurface';
import { ApiClient } from '../../api/client';
import type { AutomationDetail, AutomationSession } from '../../hooks/useAutomations';
import { openAutomationRunChat, runChatUnavailableReason } from '../../lib/automationRunChat';
import '../sleepy/ChatPane.css';
import '../sleepy/chat/composer.css';
import '../sleepy/chat/cards.css';
import '../agents/AgentsFeed.css';
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
 * Every OPEN of the agent is a NEW Claude session (or the held one, continued); the server
 * decides its permission mode from the autonomy level at every spawn. Above it, the agent's whole
 * history as ONE flow: its routines' runs and its earlier talks, paged as the owner scrolls up
 * (`stageSession.ts`'s feed, drawn by the Chat pane's own rows). The routines' full runs stay one
 * click away (a run's boundary, or Activity).
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
  feedNewestId = null,
  inActivity,
}: {
  row: TeamRow;
  agent: AgentSummary;
  panelOpen: boolean;
  onBack?: () => void;
  onPanel: (tab: PanelTab) => void;
  onTogglePanel: () => void;
  onEdit: (slug: string) => void;
  /** Open the agent's activity (its routines' runs and posts), at one run when given. */
  onActivity: (at?: { slug: string; runId: string | null }) => void;
  onToast: (msg: string) => void;
  /** The roster feed's newest entry id for this agent: a change re-reads the history's page 1. */
  feedNewestId?: string | null;
  /** Is this run (`<slug>::<runId>`) in the activity view's window? Outside it, a boundary click
   *  opens the run's own session instead. */
  inActivity?: (key: string) => boolean;
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
            {agent.scope === 'global' && (
              <span className="aiteam-tag aiteam-tag--accent" data-global-chip title={t('aiteam.tag.globalHint')}>{t('aiteam.tag.global')}</span>
            )}
          </span>
          {row.role && <span className="aiteam-convo-role">{row.role}</span>}
        </div>
        <span className="aiteam-spacer" />
        <AutonomyChip level={autonomy} onEdit={readOnly ? undefined : () => onEdit(agent.slug)} />
        <button type="button" className="aiteam-pill" onClick={() => onActivity()} data-team-activity title={t('aiteam.stage.seeActivity')} aria-label={t('aiteam.stage.seeActivity')}>
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
        <StageChat agent={agent} level={autonomy} ready={!!stage} vault={vault ?? ''} bus={bus} feedNewestId={feedNewestId} onActivity={onActivity} inActivity={inActivity} />
      )}
    </section>
  );
}

function useStageSession(vault: string, agent: AgentSummary, level: string) {
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  // Re-render on every change the session reports (opened, replaced, busy, asking, its feed): the
  // session object stays the same across those, so a snapshot of it alone would miss them.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeStageSession(vault, agent.slug, bump), [vault, agent.slug]);
  const session = peekStageSession(vault, agent.slug);
  const open = useCallback(
    (how: 'continue' | 'resume' = 'continue') => openStageSession({
      vault, agent: agent.slug, level,
      model: agent.model ?? modelConfig.defaultModel, effort: agent.effort ?? modelConfig.defaultEffort,
    }, how),
    [vault, agent.slug, agent.model, agent.effort, level, modelConfig.defaultModel, modelConfig.defaultEffort],
  );
  return { session, open };
}

/** How often the open stage re-reads its history's page 1 (a talk held in a Chat tab that ended
 *  joins the flow). */
const HISTORY_POLL_MS = 60_000;

function hhmm(iso: string | number): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A run older than the activity view's window: open its own recorded session in a Chat tab, as
 * the activity's "Open session" does. False when the run has no session to open.
 */
async function openRunSession(vault: string, bus: EventTarget, meta: FeedMeta): Promise<boolean> {
  if (!meta.runId) return false;
  try {
    const api = new ApiClient(vault || null);
    const slug = encodeURIComponent(meta.source);
    const detail = await api.get<AutomationDetail>(`/automations/${slug}`);
    const idx = (detail.cache?.history ?? []).findIndex((e) => e.firedAt === meta.runId);
    if (idx < 0) return false;
    const { session } = await api.get<{ session: AutomationSession | null }>(`/automations/${slug}/session?run=${idx + 1}`);
    if (!session || runChatUnavailableReason(session)) return false;
    return openAutomationRunChat(bus, {
      slug: meta.source,
      automationTitle: meta.title,
      runNumber: session.runNumber,
      sessionId: session.sessionId as string,
      firedAt: session.firedAt,
      status: session.status,
      costUsd: session.costUsd,
      numTurns: session.numTurns,
      durationMs: meta.durationMs,
      outputPath: session.outputPath,
    });
  } catch {
    return false;
  }
}

function StageChat({ agent, level, ready, vault, bus, feedNewestId, onActivity, inActivity }: {
  agent: AgentSummary;
  level: string;
  ready: boolean;
  vault: string;
  bus: EventTarget;
  feedNewestId: string | null;
  onActivity: (at?: { slug: string; runId: string | null }) => void;
  inActivity?: (key: string) => boolean;
}) {
  const { t } = useI18n();
  const { session, open } = useStageSession(vault, agent, level);
  // Opened like a Chat tab: the conversation is there when its agent is — once the page has
  // OPENED the agent (its feed exists), so the open decides new-or-continuing before a session
  // exists (the page's open effect runs after this stage mounts).
  const opened = stageFeed(vault, agent.slug) !== null;
  useEffect(() => {
    if (!session && ready && opened && agent.approvedForChat) open();
  }, [session, ready, opened, agent.approvedForChat, open]);
  // The level changed (the Edit dialog): the server decides the permission mode only at a spawn,
  // so the same conversation is respawned at the new level, once the turn in flight has ended.
  const openedAt = session ? stageSessionLevel(vault, agent.slug) : null;
  useEffect(() => {
    if (!ready || !session || session.busy || openedAt === null || openedAt === level) return;
    open('resume');
  }, [ready, session, session?.busy, openedAt, level, open]);

  // The history: kept within this open across remounts, re-read when the roster's newest id moves
  // and once a minute while the pane is open.
  const newestRef = useLatest(feedNewestId);
  useEffect(() => { remountStageFeed(vault, agent.slug, newestRef.current); }, [vault, agent.slug, newestRef]);
  useEffect(() => {
    if (feedNewestId === null) return;
    void refreshStageFeed(vault, agent.slug, feedNewestId);
  }, [vault, agent.slug, feedNewestId]);
  useEffect(() => {
    const timer = setInterval(() => { void refreshStageFeed(vault, agent.slug, newestRef.current); }, HISTORY_POLL_MS);
    return () => clearInterval(timer);
  }, [vault, agent.slug, newestRef]);

  const snap = stageFeed(vault, agent.slug);
  // The day words move at midnight: a tick re-derives the labels.
  const [dayTick, setDayTick] = useState(() => new Date().toDateString());
  useEffect(() => {
    const timer = setInterval(() => setDayTick(new Date().toDateString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const liveKind = snap?.live.kind ?? 'new';
  const liveStarted = snap?.live.startedAt ?? 0;
  const labels = useMemo<FeedLabels>(() => {
    const now = new Date();
    const boundary = (m: FeedMeta): string => {
      if (m.sessionKind === 'talk') return t('aiteam.history.talk').replace('{time}', hhmm(m.startedAt));
      const parts = [t('aiteam.history.ran').replace('{routine}', m.title).replace('{time}', hhmm(m.startedAt))];
      if (m.durationMs !== null && m.durationMs > 0) {
        parts.push(m.durationMs < 60_000
          ? t('aiteam.history.durationSec').replace('{sec}', String(Math.max(1, Math.round(m.durationMs / 1000))))
          : t('aiteam.history.duration').replace('{min}', String(Math.round(m.durationMs / 60_000))));
      }
      if (m.status === 'failed') parts.push(t('aiteam.history.statusFailed'));
      else if (m.status === 'skipped') parts.push(t('aiteam.history.skipped'));
      else if (m.status === 'running') parts.push(t('aiteam.history.running'));
      return parts.join(' · ');
    };
    return {
      day: (iso) => dayRuleLabel(iso, now, t),
      boundary,
      divider: (count, more) => t(more ? 'aiteam.history.unreadMore' : 'aiteam.history.unread').replace('{count}', String(count)),
      live: liveKind === 'continuing'
        ? t('aiteam.history.continuing').replace('{time}', hhmm(liveStarted))
        : t('aiteam.history.new'),
      end: t('aiteam.history.start').replace('{name}', agent.title),
      loading: t('aiteam.history.loading'),
      error: t('aiteam.history.failedRead'),
      retry: t('aiteam.history.retry'),
      missing: t('aiteam.history.missing'),
      truncated: t('aiteam.history.truncated'),
      loadingOlder: t('aiteam.history.loadingOlder'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, agent.title, liveKind, liveStarted, dayTick]);
  const onActivityRef = useLatest(onActivity);
  const inActivityRef = useLatest(inActivity);
  const feed = useMemo<ChatFeed | undefined>(() => {
    if (!snap) return undefined;
    return {
      items: snap.items,
      hasMore: snap.hasMore,
      loading: snap.loading,
      failed: snap.failed,
      olderLoading: snap.olderLoading,
      divider: snap.divider,
      scrollToDivider: snap.scrollToDivider,
      labels,
      onLoadOlder: () => { void loadOlderStageFeed(vault, agent.slug); },
      onRetry: () => retryStageFeed(vault, agent.slug),
      onSeen: (meta) => markStageSeen(vault, agent.slug, meta),
      onBoundary: (meta) => {
        if (meta.sessionKind === 'talk') {
          const claudeId = meta.sessionKey.slice('talk::'.length);
          const detail: OpenSessionDetail = { claudeId };
          emitInstance(bus, OPEN_SESSION_EVENT, detail);
          return;
        }
        const at = { slug: meta.source, runId: meta.runId };
        if (!inActivityRef.current || inActivityRef.current(meta.sessionKey)) { onActivityRef.current(at); return; }
        // Outside the activity's window: the run's own session, else the routine's newest message.
        void openRunSession(vault, bus, meta).then((opened) => { if (!opened) onActivityRef.current(at); });
      },
      onDividerScrolled: () => markStageDividerScrolled(vault, agent.slug),
      onPinned: (pinned) => setStageFeedPinned(vault, agent.slug, pinned),
    };
  }, [snap, labels, vault, agent.slug, bus, onActivityRef, inActivityRef]);

  if (!agent.approvedForChat) {
    return (
      <div className="aiteam-stage-note">
        <p>{t('aiteam.stage.blocked').replace('{name}', agent.title)}</p>
        <button type="button" className="aiteam-pill" onClick={() => requestOpenAgents({ slug: agent.slug })}>{t('aiteam.stage.review')}</button>
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
      feed={feed}
    />
  );
}

/** A ref that always holds the latest value (stable identity, for effects and callbacks). */
function useLatest<T>(value: T): { readonly current: T } {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}
