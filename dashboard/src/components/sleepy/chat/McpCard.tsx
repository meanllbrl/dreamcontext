import { useEffect, useMemo, useRef, useState } from 'react';
import { openExternalUrl } from '../../../lib/desktop';
import type { McpViewSpec } from '../../../lib/chatViewSpec';
import type { McpLiveServer } from '../../../lib/mcpWire';
import type { ChatSession } from '../chatSession';
import { useChatAccountEmail, useMcpLive } from './useMcpLive';
import {
  CLAUDE_AI_CONNECTORS_URL, actionLabel, allConnected, connectLabel, findServer, homeLabel, mcpReport,
  nextCardReport, reportedKey, rowAction, statusLabel, type CardReportState,
} from './mcpRows';
import './mcpCard.css';

/**
 * ORGANISM — the `dream-view` MCP card (task mcp-management, owner pick "B — batch card").
 *
 * The agent sends it when its task needs a server this chat cannot use: one card, a row per
 * server, each with the one button that can bring it back (Connect / Reconnect / Restart). The
 * rows are the chat's OWN live status (`session.mcp`, pushed by the server from the CLI's
 * `mcp_status`), so a row turns green the moment the CLI says so, with no refresh.
 *
 * It reports back exactly ONCE: when every named server is connected (`MCP connected: …`), or
 * when the owner presses "Continue without" (`MCP skipped: …`). A reload never reports again
 * (remembered per conversation + card id), and a card that never saw a server broken does not
 * report on its own — that is a transcript being re-read, not an owner finishing a sign-in.
 *
 * A claude.ai connector may not complete from here (its sign-in belongs to claude.ai). After
 * the 5-minute window the row turns into the fallback: reconnect it on claude.ai as the
 * expected account, then "I've connected it, check again".
 */
export function McpCard({ spec, session, conversationId, report, placeKey }: {
  spec: McpViewSpec;
  session?: ChatSession;
  conversationId?: string;
  report?: (text: string) => void;
  /** This card's place in the transcript: its report is remembered there (a later card the
   *  agent sends with the same id is a new card). */
  placeKey?: string;
}) {
  const { status, auth } = useMcpLive(session);
  // The account this chat runs on, named because the browser may be signed in as another.
  const accountEmail = useChatAccountEmail(session);
  const servers: McpLiveServer[] = status?.servers ?? [];
  const key = reportedKey(conversationId, `${placeKey ?? ''}:${spec.id}`);
  const memory = useRef<CardReportState>({
    sawBroken: false,
    reported: (() => { try { return localStorage.getItem(key) as CardReportState['reported']; } catch { return null; } })(),
  });
  const [reported, setReported] = useState<CardReportState['reported']>(memory.current.reported);

  const rows = useMemo(() => spec.servers.map((name) => ({ name, live: findServer(name, servers) })), [spec.servers, servers]);
  const done = rows.filter((r) => r.live?.status === 'connected').length;
  const ready = allConnected(spec.servers, servers);

  const send = (kind: 'connected' | 'skipped') => {
    // Re-read: another copy of this same card (a second pane on the conversation) may have sent it.
    try { if (localStorage.getItem(key)) memory.current = { ...memory.current, reported: localStorage.getItem(key) as CardReportState['reported'] }; } catch { /* this mount's memory */ }
    if (memory.current.reported || !report) { setReported(memory.current.reported); return; }
    memory.current = { ...memory.current, reported: kind };
    try { localStorage.setItem(key, kind); } catch { /* remembered for this mount only */ }
    setReported(kind);
    report(mcpReport(kind, spec.servers, servers));
  };

  // Every reading goes through the one rule (mcpRows.ts `nextCardReport`): report once, and on
  // its own only after a named server was seen broken.
  useEffect(() => {
    if (!report) return;
    const next = nextCardReport(memory.current, spec.servers, servers);
    if (next.send) send(next.send);
    else memory.current = next.state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers, spec.servers]);

  const live = !!session && !!report;
  const fallbacks = rows.filter((r) => r.live?.home === 'claudeai' && auth[r.live.name]?.state === 'timeout');

  return (
    <div className="chat-viewcard chat-mcpcard" data-view-kind="mcp" data-view-id={spec.id} data-ready={ready || undefined}>
      <div className="chat-mcpcard-head">
        <span className="chat-mcpcard-glyph" aria-hidden>⚡</span>
        <span className="chat-mcpcard-title">
          {ready ? `${spec.servers.length === 1 ? 'Connection' : 'Connections'} ready`
            : `${spec.servers.length - done} connection${spec.servers.length - done === 1 ? '' : 's'} need${spec.servers.length - done === 1 ? 's' : ''} you`}
        </span>
        {accountEmail && <span className="chat-mcpcard-account">{accountEmail}</span>}
      </div>
      {spec.why && <p className="chat-mcpcard-why">{spec.why}</p>}

      <ul className="chat-mcpcard-rows">
        {rows.map(({ name, live: row }) => {
          const action = row ? rowAction(row) : null;
          const inFlight = row ? auth[row.name] : undefined;
          const flight = connectLabel(inFlight?.state, inFlight?.host);
          return (
            <li className="chat-mcpcard-row" key={name} data-status={row?.status ?? 'missing'}>
              <span className="chat-mcpcard-icon" aria-hidden>{row?.home === 'claudeai' ? '✉' : '◆'}</span>
              <span className="chat-mcpcard-text">
                <span className="chat-mcpcard-name">{row?.name ?? name}</span>
                <span className="chat-mcpcard-sub">
                  {row ? `${homeLabel(row.home)} · ${flight ?? statusLabel(row)}` : status ? 'not in this chat — add it in Settings → MCP' : 'reading this chat\'s servers…'}
                </span>
              </span>
              {row?.status === 'connected' ? (
                <span className="chat-mcpcard-pill" data-tone="good"><span className="chat-mcpcard-dot" />Connected</span>
              ) : (
                <span className="chat-mcpcard-actions">
                  {row?.home === 'claudeai' && (
                    <button type="button" className="chat-btn pill" onClick={() => { void openExternalUrl(CLAUDE_AI_CONNECTORS_URL); }}>
                      Settings on claude.ai ↗
                    </button>
                  )}
                  {action && live && (
                    <button
                      type="button"
                      className="chat-btn pill primary"
                      disabled={inFlight?.state === 'opening' || inFlight?.state === 'waiting'}
                      onClick={() => (action === 'restart' ? session!.mcpReconnect(row!.name) : session!.mcpConnect(row!.name))}
                    >
                      {actionLabel(action)}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="chat-mcpcard-foot">
        <span className="chat-mcpcard-progress">
          {reported === 'skipped' ? 'Continued without them.'
            : reported ? 'All connected — the agent was told.'
              : `${done} of ${spec.servers.length} done · the agent continues on its own when ${spec.servers.length === 1 ? 'it is' : 'all are'} green`}
        </span>
        {!reported && live && (
          ready && !memory.current.sawBroken
            ? <button type="button" className="chat-btn pill primary" onClick={() => send('connected')}>Tell the agent</button>
            : <button type="button" className="chat-btn pill" onClick={() => send('skipped')}>Continue without</button>
        )}
      </div>

      {fallbacks.map(({ live: row }) => (
        <div className="chat-mcpcard-fallback" key={row!.name}>
          <div className="chat-mcpcard-head">
            <span className="chat-mcpcard-glyph" aria-hidden>✉</span>
            <span className="chat-mcpcard-title">{row!.name}: reconnect on claude.ai</span>
            <span className="chat-mcpcard-pill" data-tone="bad"><span className="chat-mcpcard-dot" />Sign-in didn&apos;t complete</span>
          </div>
          <p className="chat-mcpcard-why">
            This connector belongs to your claude.ai account, so it can only be reconnected there.
            {accountEmail ? <> Sign in to claude.ai as <strong>{accountEmail}</strong>,</> : ' Open it,'} press <strong>Connect</strong> next to {row!.name}, then come back here.
          </p>
          <div className="chat-mcpcard-foot chat-mcpcard-foot--end">
            <button type="button" className="chat-btn pill" onClick={() => { void openExternalUrl(CLAUDE_AI_CONNECTORS_URL); }}>Open claude.ai connectors ↗</button>
            {live && <button type="button" className="chat-btn pill primary" onClick={() => session!.mcpRefresh()}>I&apos;ve connected it, check again</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
