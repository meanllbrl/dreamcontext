import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { emitInstance, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgent, useAgentStage, useBringAgentHere, type AgentSummary } from '../../hooks/useAgents';
import { useAgentFeed, useAutomationDispatcher, useAutomations, useInstallDispatcher, useReplyToAgentThread } from '../../hooks/useAutomations';
import { THREAD_REPLY_MAX_CHARS } from '../agents/AgentMessage';
import { fitRunReport } from '../sleepy/chat/runReport';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { OPEN_SESSION_EVENT, type OpenSessionDetail } from '../../lib/openSession';
import { requestOpenAgents } from '../../lib/openAgents';
import { AgentAvatar } from '../agents/AgentAvatar';
import { CardChat } from '../whiteboard/widgets/AgentWidget';
import { AutonomyChip } from './AutonomyChip';
import {
  beginStageOpen, deselectStage, loadOlderStageFeed, markStageDividerScrolled, markStageSeen, openStageSession, peekStageSession, refreshStageFeed,
  remountStageFeed, retryStageFeed, setStageFeedPinned, stageFeed, stageSessionLevel, stageWatched, subscribeStageSession,
} from './stageSession';
import { dayRuleLabel, messagesOf, pendingApprovals, routineCountLabel, talkBlocked, type TeamRow } from './teamModel';
import { feedHasRunning, runFootOf, stepsOpen, type ChatFeed, type FeedLabels, type FeedMeta } from '../sleepy/chat/chatFeed';
import { TeamAmendments } from './TeamAmendments';
import { TeamApproval } from './TeamApproval';
import type { PanelTab } from './TeamPanel';
import { TeamIcon } from './TeamIcons';
import { isPhoneSurface } from '../../lib/phoneSurface';
import { RunFoot, RunPinLine, StageQuestions, type RunPin } from './RunFoot';
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
 * (`stageSession.ts`'s feed, drawn by the Chat pane's own rows). A run opens HERE: its steps and
 * its full report under its own bubble (`RunFoot`). The box stays a new conversation; "Continue" on
 * a run pins that run above the box, and only the owner's press moves it (owner decision K1).
 */
export function AgentStage({
  row,
  agent,
  panelOpen,
  onBack,
  onPanel,
  onTogglePanel,
  onEdit,
  onToast,
  onOpenFile,
  feedNewestId = null,
  noRuns = false,
}: {
  row: TeamRow;
  agent: AgentSummary;
  panelOpen: boolean;
  onBack?: () => void;
  onPanel: (tab: PanelTab) => void;
  onTogglePanel: () => void;
  onEdit: (slug: string) => void;
  onToast: (msg: string) => void;
  /** A path in a run's full report. */
  onOpenFile?: (path: string) => void;
  /** The roster feed's newest entry id for this agent: a change re-reads the history's page 1. */
  feedNewestId?: string | null;
  /** It has run nothing yet: where the scheduler being off is worth saying. */
  noRuns?: boolean;
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
  const { data: dispatcher } = useAutomationDispatcher();
  const install = useInstallDispatcher();

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
      {!readOnly && <TeamAmendments slug={agent.slug} onToast={onToast} />}
      {!readOnly && !elsewhere && !talkBlocked(pending) && noRuns && dispatcher && !dispatcher.installed && (
        <div className="aiteam-banner" data-stage-scheduler>
          <span className="auto-dispatch-pill"><span className="auto-dispatch-dot" aria-hidden="true" /><span className="auto-dispatch-pill-label">{t('aiteam.scheduler.off')}</span></span>
          <span><b>{t('aiteam.scheduler.lede')}</b> {t('aiteam.scheduler.sub')}</span>
          <span className="aiteam-spacer" />
          {/* What runs on the Mac is turned on at the Mac. */}
          {!isPhoneSurface() && (
            <button type="button" className="agent-btn" disabled={install.isPending} onClick={() => install.mutate({}, { onError: (err) => onToast((err as Error).message) })}>
              {t('aiteam.scheduler.turnOn')}
            </button>
          )}
        </div>
      )}

      {readOnly || elsewhere ? (
        <div className="aiteam-stage-note" data-stage-closed>
          <p>{readOnly
            ? t('aiteam.readonly.chat').replace('{owner}', agent.ownerLabel ?? agent.owner ?? '').replace('{name}', agent.title)
            : t('aiteam.elsewhere.chat').replace('{machine}', elsewhere?.name ?? '').replace('{name}', agent.title)}</p>
        </div>
      ) : (
        <StageChat agent={agent} level={autonomy} ready={!!stage} stageFailed={stageQ.isError && !stage} onRetryStage={() => { void stageQ.refetch(); }} vault={vault ?? ''} bus={bus} feedNewestId={feedNewestId} onToast={onToast} onOpenFile={onOpenFile} />
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
/** While one of its routine runs is in flight: its posts and its end land within seconds. */
const HISTORY_POLL_RUNNING_MS = 5_000;

function hhmm(iso: string | number): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function StageChat({ agent, level, ready, stageFailed, onRetryStage, vault, bus, feedNewestId, onToast, onOpenFile }: {
  agent: AgentSummary;
  level: string;
  ready: boolean;
  /** The agent's stage could not be read: said here with a Retry, or this waits for ever. */
  stageFailed: boolean;
  onRetryStage: () => void;
  vault: string;
  bus: EventTarget;
  feedNewestId: string | null;
  onToast: (msg: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const { session, open } = useStageSession(vault, agent, level);
  // A card in a run's row (a command the owner ran) reports into THAT run: a reply in its thread,
  // the Agents page's own hand-back, which resumes the run's session — its answer then lands
  // under the run here. A refusal (the run still working, a newer run took the thread) is told.
  const { mutate: replyToRun } = useReplyToAgentThread();
  const onToastRef = useLatest(onToast);
  // Opened like a Chat tab: the conversation is there when its agent is — once the page has
  // OPENED the agent (its feed exists), so the open decides new-or-continuing before a session
  // exists (the page's open effect runs after this stage mounts).
  const opened = stageFeed(vault, agent.slug) !== null;
  useEffect(() => {
    if (!session && ready && opened && agent.approvedForChat) open();
  }, [session, ready, opened, agent.approvedForChat, open]);
  // Back on a teammate whose open ended while it was off screen (a Super card closed over it): the
  // pick did not change, so the page opens nothing. Asked after every effect of this commit, so a
  // real open from the page still comes first and decides.
  const newestRef = useLatest(feedNewestId);
  useEffect(() => {
    if (opened) return;
    let alive = true;
    queueMicrotask(() => { if (alive && stageFeed(vault, agent.slug) === null) beginStageOpen(vault, agent.slug, newestRef.current); });
    return () => { alive = false; };
  }, [opened, vault, agent.slug, newestRef]);
  // The level changed (the Edit dialog): the server decides the permission mode only at a spawn,
  // so the same conversation is respawned at the new level, once the turn in flight has ended.
  const openedAt = session ? stageSessionLevel(vault, agent.slug) : null;
  useEffect(() => {
    if (!ready || !session || session.busy || openedAt === null || openedAt === level) return;
    open('resume');
  }, [ready, session, session?.busy, openedAt, level, open]);

  // The history: kept within this open across remounts, re-read when the roster's newest id moves
  // and once a minute while the pane is open.
  useEffect(() => { remountStageFeed(vault, agent.slug, newestRef.current); }, [vault, agent.slug, newestRef]);
  useEffect(() => {
    if (feedNewestId === null) return;
    void refreshStageFeed(vault, agent.slug, feedNewestId);
  }, [vault, agent.slug, feedNewestId]);
  const snap = stageFeed(vault, agent.slug);
  // A card's report resumed a run: its answer is on the way, so the fast re-read holds until that
  // run has something newer than the report (or two minutes passed).
  const [awaiting, setAwaiting] = useState<{ key: string; afterId: string; until: number } | null>(null);
  const answered = !!awaiting && (Date.now() > awaiting.until
    || !!snap?.items.some((it) => it.feed.sessionKey === awaiting.key && (it.feed.newestId ?? '') > awaiting.afterId));
  useEffect(() => { if (answered) setAwaiting(null); }, [answered]);
  const running = !!snap && (feedHasRunning(snap.items) || (!!awaiting && !answered));
  useEffect(() => {
    const every = running ? HISTORY_POLL_RUNNING_MS : HISTORY_POLL_MS;
    const timer = setInterval(() => { void refreshStageFeed(vault, agent.slug, newestRef.current); }, every);
    return () => clearInterval(timer);
  }, [vault, agent.slug, newestRef, running]);
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
      else if (m.status === 'waiting') parts.push(t('aiteam.history.statusWaiting'));
      else if (m.status === 'stopped') parts.push(t('aiteam.history.statusStopped'));
      return parts.join(' · ');
    };
    const note = (m: FeedMeta): string | null => {
      if (m.origin !== 'note') return null;
      if (m.status === 'waiting') return t('aiteam.history.noteWaiting');
      if (m.status === 'stopped') return t('aiteam.history.noteStopped');
      return null;
    };
    return {
      day: (iso) => dayRuleLabel(iso, now, t),
      boundary,
      divider: (count, more) => t(more ? 'aiteam.history.unreadMore' : 'aiteam.history.unread').replace('{count}', String(count)),
      live: liveKind === 'continuing'
        ? t('aiteam.history.continuing').replace('{time}', hhmm(liveStarted))
        : t('aiteam.history.new'),
      working: t('aiteam.working.label'),
      note,
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
  // What is open under each run. Steps the owner closed stay closed while the run works on.
  const [stepsShown, setStepsShown] = useState<ReadonlySet<string>>(() => new Set());
  const [stepsHidden, setStepsHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [reports, setReports] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSteps = useCallback((meta: FeedMeta) => {
    const open = stepsOpen(meta, stepsShown, stepsHidden);
    setStepsShown((s) => flip(s, meta.sessionKey, !open));
    setStepsHidden((s) => flip(s, meta.sessionKey, open));
  }, [stepsShown, stepsHidden]);
  const toggleReport = useCallback((key: string) => setReports((s) => flip(s, key, !s.has(key))), []);
  // The run the box writes to. Only the owner's press sets it: a routine firing moves nothing, and
  // the send carries this captured run through the reply route and its gates.
  const [pin, setPin] = useState<RunPin | null>(null);
  const [pinNote, setPinNote] = useState<string | null>(null);
  const pinRef = useLatest(pin);
  const sessionRef = useLatest(session);
  const sendVia = useCallback((message: string): boolean => {
    const target = pinRef.current;
    if (!target) return false;
    setPinNote(null);
    replyToRun(
      { slug: target.slug, runId: target.runId, text: message },
      {
        onSuccess: ({ entry }) => {
          setAwaiting({ key: `${target.slug}::${target.runId}`, afterId: entry.id, until: Date.now() + 120_000 });
          void refreshStageFeed(vault, agent.slug, null);
        },
        // The server's own sentence, and the words go back in the box.
        onError: (err) => {
          setPinNote((err as Error).message);
          sessionRef.current?.sendText(message);
        },
      },
    );
    return true;
  }, [pinRef, sessionRef, replyToRun, vault, agent.slug]);
  const closePin = useCallback(() => { setPin(null); setPinNote(null); }, []);
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
        // A run opens where it stands: its steps, else its document.
        const foot = runFootOf(meta);
        if (foot.steps) toggleSteps(meta);
        else if (foot.report) toggleReport(meta.sessionKey);
      },
      runFoot: (meta) => (
        <RunFoot
          meta={meta}
          steps={stepsOpen(meta, stepsShown, stepsHidden)}
          report={reports.has(meta.sessionKey)}
          onSteps={() => toggleSteps(meta)}
          onReport={() => toggleReport(meta.sessionKey)}
          onContinue={() => {
            if (!meta.runId) return;
            setPinNote(null);
            setPin({ slug: meta.source, runId: meta.runId, title: meta.title, startedAt: meta.startedAt, running: meta.status === 'running' });
          }}
          onOpenFile={onOpenFile}
        />
      ),
      onRunReport: (meta, text) => {
        if (!meta.runId) return;
        replyToRun(
          { slug: meta.source, runId: meta.runId, text: fitRunReport(text, THREAD_REPLY_MAX_CHARS) },
          {
            onSuccess: ({ entry }) => {
              setAwaiting({ key: meta.sessionKey, afterId: entry.id, until: Date.now() + 120_000 });
              void refreshStageFeed(vault, agent.slug, null);
            },
            onError: (err) => onToastRef.current((err as Error).message),
          },
        );
      },
      onDividerScrolled: () => markStageDividerScrolled(vault, agent.slug),
      onPinned: (pinned) => setStageFeedPinned(vault, agent.slug, pinned),
    };
  }, [snap, labels, vault, agent.slug, bus, replyToRun, onToastRef, stepsShown, stepsHidden, reports, toggleSteps, toggleReport, onOpenFile]);
  const above = useMemo(() => (
    <>
      <StageQuestions agent={agent.slug} onToast={onToast} />
      {pin && <RunPinLine pin={pin} note={pinNote} onClose={closePin} />}
    </>
  ), [agent.slug, onToast, pin, pinNote, closePin]);

  if (!agent.approvedForChat) {
    return (
      <div className="aiteam-stage-note">
        <p>{t('aiteam.stage.blocked').replace('{name}', agent.title)}</p>
        <button type="button" className="aiteam-pill" onClick={() => requestOpenAgents({ slug: agent.slug })}>{t('aiteam.stage.review')}</button>
      </div>
    );
  }
  if (!session) {
    return stageFailed
      ? (
        <div className="aiteam-stage-note" data-stage-failed>
          <p>{t('aiteam.stage.failedRead')}</p>
          <button type="button" className="aiteam-pill" onClick={onRetryStage}>{t('aiteam.history.retry')}</button>
        </div>
      )
      : <div className="aiteam-stage-note"><p>{t('common.loading')}</p></div>;
  }
  // Writing here starts the stage's OWN conversation, never a run's: while it has nothing yet,
  // the composer says so (the live line under the history waits for its first turn).
  const conv = session.getModel();
  const fresh = !session.busy && conv.history.length === 0 && conv.items.length === 0 && conv.pending.length === 0;
  return (
    <CardChat
      session={session}
      reopen={() => open('resume')}
      placeholder={(pin ? t('aiteam.run.placeholder') : fresh ? t('aiteam.stage.placeholderNew') : t('aiteam.stage.placeholder')).replace('{name}', agent.title)}
      pane
      feed={feed}
      aboveComposer={above}
      sendVia={pin ? sendVia : undefined}
    />
  );
}

/**
 * An agent's conversation OUTSIDE the AI Team page (the Super stage's team card, owner
 * 2026-10-30: "it should open like a normal session on the Super screen, not send me to AI
 * Team"): the same pane as the page's middle, opened and closed the way the page opens and
 * deselects a teammate. A run opens under its own bubble, as on the page.
 */
export function AgentConversation({ slug }: { slug: string }) {
  const { vault, bus } = useVault();
  const v = vault ?? '';
  const { t } = useI18n();
  const agentQ = useAgent(slug);
  const agent = agentQ.data?.agent ?? null;
  const stageQ = useAgentStage(slug);
  const stage = stageQ.data ?? null;
  const automations = useAutomations().data;
  const { data: feed } = useAgentFeed();
  const feedNewestId = useMemo(() => {
    let max: string | null = null;
    for (const m of messagesOf(slug, automations ?? [], feed?.messages ?? [])) if (m.newestId && (max === null || m.newestId > max)) max = m.newestId;
    return max;
  }, [slug, automations, feed]);
  const newestRef = useLatest(feedNewestId);
  // An OPEN of the agent while mounted (the AI Team page, kept alive, may hold it open already);
  // its page deselecting or leaving drops the feed, and this one opens again. Unmounted, its idle
  // session ends like a deselected teammate's, unless a pane still shows it (once every unmount
  // of this commit has run).
  useEffect(() => {
    const reopen = () => { if (stageFeed(v, slug) === null) beginStageOpen(v, slug, newestRef.current); };
    const off = subscribeStageSession(v, slug, reopen);
    reopen();
    return () => { off(); queueMicrotask(() => { if (!stageWatched(v, slug)) deselectStage(v, slug); }); };
  }, [v, slug, newestRef]);
  const onReview = useCallback(() => requestOpenAgents({ slug }), [slug]);
  // No page toast out here: a failed reply shows as a line under the conversation.
  const [note, setNote] = useState<string | null>(null);
  // Never a blank: it is coming, or it is gone and the way to the team is said.
  if (!agent) {
    return (
      <section className="aiteam-convo aiteam-stage" data-stage={slug} data-testid="agent-conversation">
        {agentQ.isError
          ? <div className="aiteam-stage-note"><p>{t('aiteam.stage.unavailable')}</p><button type="button" className="aiteam-pill" onClick={onReview}>{t('aiteam.stage.review')}</button></div>
          : <div className="aiteam-stage-note"><p>{t('common.loading')}</p></div>}
      </section>
    );
  }
  return (
    <section className="aiteam-convo aiteam-stage" data-stage={slug} data-testid="agent-conversation">
      <StageChat agent={agent} level={stage?.autonomy ?? agent.autonomy ?? 'balanced'} ready={!!stage} stageFailed={stageQ.isError && !stage} onRetryStage={() => { void stageQ.refetch(); }} vault={v} bus={bus}
        feedNewestId={feedNewestId} onToast={setNote} />
      {note && <p role="status" className="aiteam-stage-note">{note}</p>}
    </section>
  );
}

/** `set` with `key` in it, or out of it. */
function flip(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  if (set.has(key) === on) return set;
  const next = new Set(set);
  if (on) next.add(key); else next.delete(key);
  return next;
}

/** A ref that always holds the latest value (stable identity, for effects and callbacks). */
function useLatest<T>(value: T): { readonly current: T } {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}
