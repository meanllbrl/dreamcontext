import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useApi } from '../../../context/VaultContext';
import { fetchAgentHistory } from '../../../hooks/useAgents';
import { useAgentFeed, useAutomations } from '../../../hooks/useAutomations';
import { phoneAllows } from '../../../lib/phoneSurface';
import { toFeedItems } from '../../aiteam/agentHistory';
import { RunFoot } from '../../aiteam/RunFoot';
import { conversationSlugs, dayRuleLabel } from '../../aiteam/teamModel';
import { runFootOf, stepsOpen, type ChatFeed, type FeedLabels, type FeedMeta } from '../chat/chatFeed';
import {
  EMPTY_RUN_FEED, RUN_FEED_POLL_MS, RUN_FEED_POLL_RUNNING_MS, anyRunning, landFirst, landFresh, landOlder,
  memberFeedSignature, withPinned, withSeen, type RunFeedState,
} from './memberRunFeed';

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function flip(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  if (set.has(key) === on) return set;
  const next = new Set(set);
  if (on) next.add(key); else next.delete(key);
  return next;
}

const FIRST_READ_RETRIES = [2000, 5000];

/**
 * A member's routine runs as the Chat pane's feed, interleaved with that member's Super chat
 * (memberRunFeed.ts says why). `member` empty: no feed (every other chat). Desktop only, like the
 * history route.
 */
export function useMemberRunFeed(member: string): ChatFeed | undefined {
  const { t } = useI18n();
  const api = useApi();
  const enabled = !!member && phoneAllows('GET', `/api/agents/${encodeURIComponent(member)}/history`);
  const [state, setState] = useState<RunFeedState>(EMPTY_RUN_FEED);
  const stateRef = useRef(state);
  stateRef.current = state;
  // A read answered after the member changed (or the pane went) is dropped.
  const gen = useRef(0);

  const readFirst = useCallback((attempt: number) => {
    const g = gen.current;
    fetchAgentHistory(api, member, { runsOnly: true }).then(
      (page) => { if (gen.current === g) setState((s) => landFirst(s, page)); },
      () => {
        if (gen.current !== g) return;
        const delay = FIRST_READ_RETRIES[attempt];
        if (delay === undefined) { setState((s) => ({ ...s, failed: true })); return; }
        setTimeout(() => { if (gen.current === g) readFirst(attempt + 1); }, delay);
      },
    );
  }, [api, member]);

  const refresh = useCallback(() => {
    const g = gen.current;
    if (!stateRef.current.loaded) return;
    fetchAgentHistory(api, member, { runsOnly: true }).then(
      (page) => { if (gen.current === g) setState((s) => landFresh(s, page)); },
      () => { /* a failed live re-read changes nothing; the next one tries again */ },
    );
  }, [api, member]);

  useEffect(() => {
    gen.current += 1;
    setState(EMPTY_RUN_FEED);
    if (enabled) readFirst(0);
    return () => { gen.current += 1; };
  }, [enabled, readFirst]);

  // The Agents channel's poll (fast while any agent works) says when this member's routines moved.
  const { data: channel } = useAgentFeed();
  const { data: automations } = useAutomations({ enabled });
  const signature = useMemo(() => {
    if (!enabled) return '';
    const slugs = conversationSlugs(member, automations ?? []);
    const busy = [...Object.keys(channel?.runSlots ?? {}), ...Object.keys(channel?.working ?? {})];
    return memberFeedSignature(slugs, channel?.messages ?? [], busy, member);
  }, [enabled, member, automations, channel]);
  const lastSig = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (lastSig.current !== null && lastSig.current !== signature) refresh();
    lastSig.current = signature;
  }, [enabled, signature, refresh]);

  const running = anyRunning(state);
  useEffect(() => {
    if (!enabled || !state.loaded) return;
    const timer = setInterval(refresh, running ? RUN_FEED_POLL_RUNNING_MS : RUN_FEED_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, state.loaded, running, refresh]);

  const loadOlder = useCallback(() => {
    const s = stateRef.current;
    if (!s.loaded || s.olderLoading || !s.nextBefore) return;
    const g = gen.current;
    setState((x) => ({ ...x, olderLoading: true }));
    fetchAgentHistory(api, member, { runsOnly: true, before: s.nextBefore }).then(
      (page) => { if (gen.current === g) setState((x) => landOlder(x, page)); },
      () => { if (gen.current === g) setState((x) => ({ ...x, olderLoading: false })); },
    );
  }, [api, member]);

  const sent = useRef(new Map<string, string>());
  const onSeen = useCallback((meta: FeedMeta) => {
    if (meta.sessionKind !== 'run' || !meta.unread || !meta.newestId) return;
    const had = sent.current.get(meta.source);
    if (had !== undefined && had >= meta.newestId) return;
    sent.current.set(meta.source, meta.newestId);
    setState((s) => withSeen(s, meta));
    void api.post('/automations/threads/read', { slug: meta.source, upToId: meta.newestId }).catch(() => {
      if (sent.current.get(meta.source) === meta.newestId) {
        if (had === undefined) sent.current.delete(meta.source); else sent.current.set(meta.source, had);
      }
    });
  }, [api]);

  // The day words move at midnight.
  const [dayTick, setDayTick] = useState(() => new Date().toDateString());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setDayTick(new Date().toDateString()), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  const labels = useMemo<FeedLabels>(() => {
    const now = new Date();
    const boundary = (m: FeedMeta): string => {
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
    return {
      day: (iso) => dayRuleLabel(iso, now, t),
      boundary,
      divider: (count, more) => t(more ? 'aiteam.history.unreadMore' : 'aiteam.history.unread').replace('{count}', String(count)),
      // The member's Super chat keeps its own "resumed" line: no "New conversation" line here.
      live: '',
      working: t('aiteam.working.label'),
      note: (m) => {
        if (m.origin !== 'note') return null;
        if (m.status === 'waiting') return t('aiteam.history.noteWaiting');
        if (m.status === 'stopped') return t('aiteam.history.noteStopped');
        return null;
      },
      end: '',
      loading: t('aiteam.history.loading'),
      error: t('aiteam.history.failedRead'),
      retry: t('aiteam.history.retry'),
      missing: t('aiteam.history.missing'),
      truncated: t('aiteam.history.truncated'),
      loadingOlder: t('aiteam.history.loadingOlder'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, dayTick]);

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

  const items = useMemo(() => toFeedItems(state.sessions), [state.sessions]);
  return useMemo<ChatFeed | undefined>(() => {
    if (!enabled) return undefined;
    return {
      items,
      hasMore: state.nextBefore !== null,
      // A member with no runs yet draws nothing at all: no loading row over its chat.
      loading: false,
      failed: state.failed && !state.loaded,
      olderLoading: state.olderLoading,
      divider: null,
      scrollToDivider: false,
      labels,
      interleave: true,
      onLoadOlder: loadOlder,
      onRetry: () => { setState((s) => ({ ...s, failed: false })); readFirst(0); },
      onSeen,
      // A run opens where it stands: its steps, else its document.
      onBoundary: (meta) => {
        const foot = runFootOf(meta);
        if (foot.steps) toggleSteps(meta);
        else if (foot.report) toggleReport(meta.sessionKey);
      },
      runFoot: (meta, ctx) => (
        <RunFoot
          meta={meta}
          steps={stepsOpen(meta, stepsShown, stepsHidden)}
          report={reports.has(meta.sessionKey)}
          onSteps={() => toggleSteps(meta)}
          onReport={() => toggleReport(meta.sessionKey)}
          onOpenFile={ctx?.openFile}
        />
      ),
      onDividerScrolled: () => {},
      onPinned: (pinned) => setState((s) => withPinned(s, pinned)),
    };
  }, [enabled, items, state.nextBefore, state.failed, state.loaded, state.olderLoading, labels, loadOlder, readFirst, onSeen, toggleSteps, toggleReport, stepsShown, stepsHidden, reports]);
}
