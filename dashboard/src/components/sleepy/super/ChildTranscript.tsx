import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useAgentModelConfig } from '../../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../../lib/agentComposer';
import { ChatPaneHost, type ChatSurfaceActions } from '../ChatPaneHost';
import type { HistoryEntry } from '../chatSession';
import { createTranscriptSession } from '../transcriptSession';
import { useI18n } from '../../../context/I18nContext';

const noop = () => { /* a finished child: the pane offers nothing to act on */ };
const ACTIONS: ChatSurfaceActions = {
  changeModel: noop, changeEffort: noop, continueInTerminal: noop, resumeChat: noop,
  changePermissionMode: noop, changeMode: noop, changeAccount: noop, handoffToDevelop: noop,
  openAppPage: noop, signIn: async () => { /* nothing to sign in */ },
};

/** How often a running job's transcript is read again. */
const LIVE_REFRESH_MS = 4_000;

/** A child's saved transcript, re-read while it runs. One query, whoever reads it. */
export function useChildHistory(claudeId: string, live: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['super-child-transcript', claudeId],
    queryFn: async () => {
      const r = await api.get<{ items: HistoryEntry[] }>(`/agent/chat-history?claudeId=${encodeURIComponent(claudeId)}`);
      return Array.isArray(r?.items) ? r.items : [];
    },
    staleTime: live ? 0 : 15_000,
    refetchInterval: live ? LIVE_REFRESH_MS : false,
  });
}

/**
 * A shown child with no live chat in this window (it finished and exited; a relaunch keeps it as
 * a dormant tab): its saved transcript, read only, in the same ChatPane a live child's card shows.
 * Read from disk through `/agent/chat-history` (the server resolves the account's projects
 * folder); no `claude` is started for it. The live chat takes the slot back the moment the child
 * runs again (`super resume`), because the card then has a session and draws the slot instead.
 */
export function ChildTranscript({ claudeId, live = false, foot, prepare, parked = false }: {
  claudeId: string;
  /** The job still runs on the Mac (the phone reads it from here): the transcript keeps refreshing. */
  live?: boolean;
  /** What stands under the transcript instead of "finished" (a team job's own composer). */
  foot?: 'own';
  /** What of the saved transcript is drawn (a run's steps leave out the composed prompt). */
  prepare?: (items: HistoryEntry[]) => HistoryEntry[];
  /** Parked under machine load, not finished: it reads like a live child (the same read-only
   *  line), since parking is never shown (owner 2026-11-03). */
  parked?: boolean;
}) {
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [session] = useState(() => createTranscriptSession(claudeId));
  const hostRef = useRef<HTMLDivElement>(null);
  const history = useChildHistory(claudeId, live);
  useEffect(() => { if (history.data) session.load(prepare ? prepare(history.data) : history.data); }, [history.data, session, prepare]);
  // The job just ended: its last lines landed after the last refresh.
  const wasLive = useRef(live);
  const refetch = history.refetch;
  useEffect(() => {
    if (wasLive.current && !live) void refetch();
    wasLive.current = live;
  }, [live, refetch]);
  useEffect(() => () => session.dispose(), [session]);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el && session.container.parentElement !== el) el.appendChild(session.container);
    return () => { if (el && session.container.parentElement === el) el.removeChild(session.container); };
  }, [session]);
  const pane = useMemo(() => (
    <ChatPaneHost
      session={session}
      actions={ACTIONS}
      modelConfig={modelConfig}
      model={modelConfig.defaultModel}
      effort={modelConfig.defaultEffort}
      mode={session.mode}
      permissionMode="auto"
      canSignInInApp={false}
      signInCommand="claude auth login"
      // A run's steps are nobody's chat to write in, and whatever stands under them is the host's.
      readOnly={foot === 'own' ? 'silent' : live || parked ? true : 'finished'}
    />
  ), [session, modelConfig, live, foot, parked]);
  // A read-only transcript never draws a new chat's "Say something to start": until the history
  // is read the pane stays hidden behind a loading line, and an empty one says so (super-team.mjs T4).
  const { t } = useI18n();
  const loaded = !!history.data;
  const shown = prepare && history.data ? prepare(history.data) : history.data;
  const empty = loaded && (shown?.length ?? 0) === 0;
  return (
    <div className="super-slot" data-testid="super-child-transcript" data-loaded={loaded ? 'true' : 'false'}>
      {!loaded && <div className="run-view-note" data-transcript-loading>{t(history.isError ? 'aiteam.run.stepsFailed' : 'aiteam.history.loading')}</div>}
      {empty && <div className="run-view-note" data-transcript-empty>{t('aiteam.run.noSteps')}</div>}
      <div ref={hostRef} style={loaded && !empty ? { display: 'contents' } : { display: 'none' }}>
        {createPortal(pane, session.container)}
      </div>
    </div>
  );
}
