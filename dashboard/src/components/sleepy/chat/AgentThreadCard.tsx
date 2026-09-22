import { useMemo, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useVault } from '../../../context/VaultContext';
import {
  useAgentFeed,
  useAgentThread,
  useAutomationSession,
  useReplyDelivery,
  useReplyToAgentThread,
  type FeedMessage,
  type ThreadEntry,
} from '../../../hooks/useAutomations';
import { openAutomationRunChat, runChatUnavailableReason } from '../../../lib/automationRunChat';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { CardHeader } from './molecules';
import type { AgentThreadViewSpec } from '../../../lib/chatViewSpec';
import './AgentThreadCard.css';

/**
 * ORGANISM — the `dream-view` AGENT-THREAD card: one agent's run thread, drawn from disk.
 *
 * DERIVED, NEVER AUTHORED, which is the whole reason this type exists rather than letting an
 * agent describe a thread in prose. The channel is an append-only synced file with a
 * per-machine read watermark on top of it; a retyped exchange would fork that, and the
 * "unread" it implied would be about nothing. `validateAgentThread` drops every content key
 * for the same reason `validateProgress` drops a supplied percent, and this component asks
 * the same two endpoints the Agents page asks.
 *
 * ── Why a Reply CONTROL and not a mounted `<Composer>` ─────────────────────────────────
 * A deliberate, stated deviation from `component-reuse-over-reimplementation`. The pattern's
 * rule is "mount the real component on the new data", and the thread PANEL does exactly that
 * (`AgentThreadPanel`, the chat's real Composer through `useAgentThreadHost`). This is a
 * ~200px summary sitting INSIDE a transcript that already has a composer docked beneath it:
 * a second one would bring its own attachment scratch, slash menu and focus registration to
 * compete with the pane's, and the reuse rule's own exception is about the surface being
 * wrong for the component, not the component being wrong. So the card carries the smallest
 * control that delivers the message, and the conversation happens where a conversation goes.
 *
 * ── What it will not offer ────────────────────────────────────────────────────────────
 * Reply and Open session are drawn ONLY for an agent's NEWEST run. That is not a shortcut,
 * it is the server's own rule made visible: the reply route answers `stale_run` for anything
 * else (a reply resolves through `latestBoundSession`, so an older run id would file the
 * words under a run the session never belonged to). A card pinned to an older run is a
 * READING of that run, and says so instead of offering two buttons that would be refused.
 */

/** Trailing entries drawn when the block names no `limit`. Three is what fits under a
 *  message without the card becoming the transcript it is summarising. */
const DEFAULT_ENTRY_COUNT = 3;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One row. A system entry keeps the runner's own words — re-phrasing them here would put
 *  the same event in two vocabularies, one of which goes stale. */
function EntryRow({ entry, title }: { entry: ThreadEntry; title: string }) {
  const who = entry.kind === 'system' ? null : entry.kind === 'user' ? 'You' : title;
  return (
    <li className="chat-agentthread-entry" data-kind={entry.kind}>
      <span className="chat-agentthread-entry-time">{hhmm(entry.at)}</span>
      {who && <span className="chat-agentthread-entry-who">{who}</span>}
      <span className="chat-agentthread-entry-text">{entry.text}</span>
    </li>
  );
}

export function AgentThreadCard({ spec }: { spec: AgentThreadViewSpec }) {
  const { t } = useI18n();
  const { bus } = useVault();
  const { data: feed, isLoading: feedLoading } = useAgentFeed();

  /** The run this card is about, and whether it is the agent's newest. */
  const { message, isNewest, agentTitle, hasPhoto } = useMemo(() => {
    const mine = (feed?.messages ?? []).filter((m) => m.slug === spec.slug);
    // `buildFeed` returns oldest-first, so the newest of this agent's runs is the last one.
    const newest: FeedMessage | null = mine.length > 0 ? mine[mine.length - 1] : null;
    const picked = spec.run ? mine.find((m) => m.runId === spec.run) ?? null : newest;
    // An agent with no runs at all still has a name in the roster — the empty state names
    // the agent rather than the slug the block happened to spell.
    const roster = (feed?.agents ?? []).find((a) => a.slug === spec.slug) ?? null;
    return {
      message: picked,
      isNewest: !!picked && !!newest && picked.runId === newest.runId,
      agentTitle: picked?.title ?? roster?.title ?? spec.slug,
      hasPhoto: picked?.hasPhoto ?? roster?.hasPhoto ?? false,
    };
  }, [feed, spec.slug, spec.run]);

  const runId = message?.runId ?? null;
  const { data: thread } = useAgentThread(spec.slug, runId);
  const entries = thread?.entries ?? [];
  const shown = entries.slice(-(spec.limit ?? DEFAULT_ENTRY_COUNT));

  // ── Reply ──────────────────────────────────────────────────────────────────────────
  const reply = useReplyToAgentThread();
  const { data: delivery } = useReplyDelivery(spec.slug, runId);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);

  const send = () => {
    const text = draft.trim();
    if (!text || !runId || reply.isPending) return;
    setReplyError(null);
    reply.mutate({ slug: spec.slug, runId, text }, {
      onSuccess: () => { setDraft(''); setReplying(false); },
      // The SERVER'S OWN SENTENCE, never a generic "failed" — every refusal on that route
      // (`reply_disabled`, `reply_unapproved`, `stale_run`, `not_bound`, `question_pending`,
      // `busy`) is already written for a human to read.
      onError: (err) => setReplyError(err.message),
    });
  };

  // ── Open session ───────────────────────────────────────────────────────────────────
  // Addressed by run NUMBER (1 = most recent), which is the only index this route takes —
  // and the only one derivable here, which is the second reason the card offers this for the
  // newest run alone.
  const { data: runSession } = useAutomationSession(isNewest ? spec.slug : null, isNewest ? 1 : null);
  const [openError, setOpenError] = useState<string | null>(null);

  const openSession = () => {
    setOpenError(null);
    if (!runSession) { setOpenError(t('agents.openSessionFailed')); return; }
    const reason = runChatUnavailableReason(runSession);
    if (reason) { setOpenError(reason); return; }
    const accepted = openAutomationRunChat(bus, {
      slug: spec.slug,
      automationTitle: agentTitle,
      runNumber: runSession.runNumber,
      sessionId: runSession.sessionId!,
      firedAt: runSession.firedAt,
      status: runSession.status,
      costUsd: runSession.costUsd,
      numTurns: runSession.numTurns,
      durationMs: message?.durationMs ?? null,
      outputPath: runSession.outputPath,
    });
    // The ACK is the whole reason this is a function and not an emit: a button that silently
    // does nothing is the failure it exists to make impossible.
    if (!accepted) setOpenError(t('agents.openSessionFailed'));
  };

  const deliveryNote = delivery?.status === 'running'
    ? t('agents.thread.working')
    : delivery?.status === 'ok'
      ? t('agents.thread.finished')
      : delivery?.status === 'unknown'
        ? t('agents.thread.unknown')
        : delivery?.reason ?? null;

  const unreadCount = feed?.unreadBySlug?.[spec.slug] ?? 0;

  return (
    <div className="chat-viewcard chat-agentthread">
      <CardHeader
        glyph={<AgentAvatar slug={spec.slug} title={agentTitle} hasPhoto={hasPhoto} size={22} version={runId ?? undefined} />}
        title={agentTitle}
        aside={
          message?.needsYou
            ? <span className="chat-agentthread-needs">{t('agents.needsYou')}</span>
            : unreadCount > 0
              ? <span className="chat-agentthread-unread">{unreadCount}</span>
              : undefined
        }
      />

      {!message ? (
        // K31 — the empty state answers the question the reader came with. `feedLoading`
        // keeps a freshly-mounted card from accusing an agent of never having run.
        <p className="chat-agentthread-note">
          {feedLoading ? t('agents.thread.working') : t('agents.thread.empty')}
        </p>
      ) : (
        <>
          <ul className="chat-agentthread-entries">
            {shown.map((e) => <EntryRow key={e.id} entry={e} title={agentTitle} />)}
            {shown.length === 0 && (
              <li className="chat-agentthread-entry" data-kind="system">
                <span className="chat-agentthread-entry-text">{t('agents.thread.working')}</span>
              </li>
            )}
          </ul>

          {!isNewest && <p className="chat-agentthread-note">{t('agents.thread.stale')}</p>}

          {isNewest && (
            <div className="chat-agentthread-actions">
              {replying ? (
                <div className="chat-agentthread-reply">
                  <input
                    className="chat-agentthread-input"
                    value={draft}
                    autoFocus
                    placeholder={t('agents.thread.reply')}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); send(); }
                      if (e.key === 'Escape') { setReplying(false); setDraft(''); }
                    }}
                  />
                  <button
                    type="button"
                    className="chat-agentthread-btn is-primary"
                    disabled={!draft.trim() || reply.isPending}
                    onClick={send}
                  >
                    {reply.isPending ? t('agents.thread.working') : t('agents.thread.reply')}
                  </button>
                </div>
              ) : (
                <button type="button" className="chat-agentthread-btn" onClick={() => setReplying(true)}>
                  {t('agents.thread.reply')}
                </button>
              )}
              <button type="button" className="chat-agentthread-btn" onClick={openSession}>
                {t('agents.openSession')}
              </button>
            </div>
          )}

          {replyError && <p className="chat-agentthread-note is-bad">{replyError}</p>}
          {openError && <p className="chat-agentthread-note is-bad">{openError}</p>}
          {!replyError && deliveryNote && <p className="chat-agentthread-note">{deliveryNote}</p>}
        </>
      )}
    </div>
  );
}
