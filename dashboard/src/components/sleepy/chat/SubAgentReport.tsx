import { useCallback, useState } from 'react';
import { useApi, useVault } from '../../../context/VaultContext';
import { peerLogoUrl } from '../../../api/client';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { peerForAgent, type PeerMention } from '../../../lib/agentComposer';
import { AgentAvatar, TypeBadge } from './atoms';
import {
  runReportText, reportFromHistory, reportStandfirst,
  type ReportProbe, type SubAgentRun,
} from './chatEntities';

/**
 * ORGANISM — a finished sub-agent's REPORT, as an object in the transcript rather than as
 * prose the main agent re-typed.
 *
 * Owner report (09-02): a reviewer's whole report printed into the chat column as flat
 * prose. Neither half of that was the UI's doing — the spawning card is suppressed and the
 * group card collapses on the last landing — it was the main agent playing safe against the
 * Agent tool's "the agent's final report is not shown to the user". So this card makes that
 * sentence FALSE, and `chat-surface.ts` tells the model so: the report is named, summarised
 * in one line, and read in place.
 *
 * Collapsed is the resting state and costs three lines: whose report it is (face + name +
 * type badge), how it ended, and its own standfirst. Expanding fetches the report and
 * renders it as markdown — headings, lists and code as the agent wrote them, which is the
 * other half of the complaint (the wall was unreadable partly because it was flattened into
 * the surrounding conversation).
 *
 * Two carriers, preferred in this order, because a backgrounded dispatch has only the second:
 *   1. `run.resultContent` — the parent's own Agent-call `tool_result`. Free, already in
 *      memory, and for a SYNCHRONOUS dispatch it is the report itself.
 *   2. the sub-agent's sidechain transcript (`GET /api/agent/chat-history?subagent=`) — the
 *      same server-derived route the drill-in uses. A BACKGROUNDED agent (the Agent tool's
 *      default, and what every fan-out skill here dispatches) returns "started in the
 *      background" as its immediate tool_result, so the writing exists only here.
 *
 * The fetch is LAZY — nothing is requested until the user asks to read it. A ten-agent
 * fan-out that lands while the user is reading something else must not fire ten transcript
 * reads for cards nobody opened.
 */

/**
 * The state of the FETCH only — never of the report itself.
 *
 * Seeding this from the run was the first version's bug, caught live by
 * `scripts/verify/chat-subagent-report.mjs`: a synchronous dispatch's card mounts on its
 * `task_notification`, which arrives BEFORE the `tool_result` that carries its report, so the
 * seed captured "no report" once and a `useState` initial value never looks again. The card
 * then fetched a sidechain that doesn't exist for it and reported the transcript unflushed —
 * while the report sat on the run, one render later. The report is now read from the run on
 * EVERY render, and this only tracks the request the card may have to make instead.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; text: string }
  | { kind: 'empty' };

function statusNote(run: SubAgentRun): string {
  if (run.status === 'error') return 'ended with an error';
  if (run.status === 'stopped') return 'stopped';
  return 'finished';
}

export function SubAgentReport({ run, conversationId, peers = [], onOpenFull }: {
  run: SubAgentRun;
  /** The PARENT conversation's claude id — the sidechain route derives the sub-agent's
   *  transcript path from it server-side (the client never supplies a path). */
  conversationId: string;
  peers?: PeerMention[];
  /** Open the run's full drill-in — the whole sidechain, not just its closing report. */
  onOpenFull: (run: SubAgentRun) => void;
}) {
  const api = useApi();
  const { vault } = useVault();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // The report that came free with the run, if its dispatch mode carried one. Read on every
  // render, never seeded into state — see {@link Phase}.
  const inline = runReportText(run);
  const body = inline ?? (phase.kind === 'ready' ? phase.text : null);

  const peer = peerForAgent(run.subagentType, peers);
  const standfirst = reportStandfirst(run, inline);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    // Fetch on the FIRST open only, and never when the run already handed us its report.
    // `idle` is the only phase that has not tried: a second open of an `empty` card would
    // otherwise re-request a transcript that was not on disk a moment ago (the drill-in is
    // the surface that re-fetches on lifecycle change — this card is a record, not a live view).
    if (!next || inline || phase.kind !== 'idle') return;
    setPhase({ kind: 'loading' });
    api.get<{ items: ReportProbe[] }>(
      `/agent/chat-history?claudeId=${encodeURIComponent(conversationId)}&subagent=${encodeURIComponent(run.taskId)}`,
    )
      .then((r) => {
        const text = reportFromHistory(Array.isArray(r?.items) ? r.items : []);
        setPhase(text ? { kind: 'ready', text } : { kind: 'empty' });
      })
      .catch(() => setPhase({ kind: 'empty' }));
  }, [api, conversationId, inline, open, phase.kind, run.taskId]);

  return (
    <div className="chat-subreport" data-open={open || undefined} data-status={run.status}>
      <button
        type="button"
        className="chat-subreport-head"
        aria-expanded={open}
        onClick={toggle}
      >
        <AgentAvatar
          name={run.subagentType ?? run.name}
          src={peer?.logo ? peerLogoUrl(vault, peer.vault) : undefined}
          size={28}
        />
        <span className="chat-subreport-head-text">
          <span className="chat-subreport-title">
            <span className="chat-subreport-name">{run.name}</span>
            {peer
              ? <TypeBadge><span className="chat-subagents-peer-mark" aria-hidden>◈</span>{peer.vault}</TypeBadge>
              : run.subagentType && <TypeBadge>{run.subagentType}</TypeBadge>}
            <span className="chat-subreport-status" data-status={run.status}>{statusNote(run)}</span>
          </span>
          {/* The standfirst is the run's OWN words (its `task_notification.summary`, or its
              report's opening line) — never a description of the report written here. A run
              that reported nothing shows no standfirst rather than a manufactured one. */}
          {standfirst && <span className="chat-subreport-standfirst">{standfirst}</span>}
        </span>
        <span className="chat-subreport-cue" aria-hidden>
          {open ? 'hide report ▴' : 'read the full report ▾'}
        </span>
      </button>
      {open && (
        <div className="chat-subreport-body">
          {body ? (
            <div className="chat-subreport-prose">
              <MarkdownPreview content={body} />
            </div>
          ) : phase.kind === 'loading' ? (
            <p className="chat-subreport-note">Loading the report…</p>
          ) : (
            <p className="chat-subreport-note">
              This agent's transcript hasn't flushed to disk yet — its drill-in has whatever is known so far.
            </p>
          )}
          <button type="button" className="chat-subreport-open" onClick={() => onOpenFull(run)}>
            Open the whole run <span aria-hidden>→</span>
          </button>
        </div>
      )}
    </div>
  );
}
