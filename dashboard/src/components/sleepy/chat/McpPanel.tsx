import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../../context/VaultContext';
import './mcpPanel.css';

/**
 * The `/mcp` panel — what typing `/mcp` in this window opens.
 *
 * Before this existed, `/mcp` was the most frustrating kind of dead end: the headless engine
 * RECOGNISES the command and answers it, with "N MCP server(s): … Use `/mcp` in the terminal
 * for details." The user typed exactly the right thing and was told to go to another app —
 * while, on the machine this was built for, 11 of 24 servers sat unauthenticated, meaning the
 * tools the agent believed it had were dead and nothing here could say so.
 *
 * So the composer intercepts `/mcp` (never sending it, never spending a turn) and opens this.
 * Everything shown comes from `claude mcp …` through `GET /api/agent/mcp`; the buttons run
 * `claude mcp login|logout` for ONE server. No token is ever displayed, pasted or handled:
 * the CLI opens the browser, the CLI receives the callback, the CLI stores the credential.
 *
 * The account matters. A chat session runs under its account's config directory, so the panel
 * asks about THAT account — otherwise it would report on a Claude install this conversation
 * is not using.
 */

export interface McpServer {
  name: string;
  target: string;
  state: 'connected' | 'needs-auth' | 'pending-approval' | 'failed' | 'disabled' | 'unknown';
  /** What the CLI called this state. Shown verbatim when the state is not one we know. */
  label: string;
}

interface McpListResponse {
  servers: McpServer[];
  counts: { total: number; connected: number; needsAuth: number; other: number };
}

export interface McpPanelProps {
  mode: 'mcp';
  /** The account this conversation runs on. Empty means the default (account #0). */
  accountId: string;
  onClose: () => void;
}

/** Tone per state — meaning, not decoration. `unknown` stays neutral rather than guessing. */
const TONE: Record<McpServer['state'], string> = {
  connected: 'good',
  'needs-auth': 'warn',
  'pending-approval': 'warn',
  failed: 'bad',
  disabled: 'muted',
  unknown: 'muted',
};

/** The one-word state, in this surface's words. `unknown` defers to the CLI's own label. */
function stateText(server: McpServer): string {
  switch (server.state) {
    case 'connected': return 'Connected';
    case 'needs-auth': return 'Needs sign-in';
    case 'pending-approval': return 'Pending approval';
    case 'failed': return 'Failed';
    case 'disabled': return 'Disabled';
    default: return server.label || 'Unknown';
  }
}

export function McpPanel({ accountId, onClose }: McpPanelProps) {
  const api = useApi();
  const [data, setData] = useState<McpListResponse | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  /** The server a login/logout is currently running for — one at a time, by design: each one
   *  takes over the browser, and two OAuth tabs racing for the same callback is a lost login. */
  const [busy, setBusy] = useState<string>('');
  const [note, setNote] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = accountId ? `?account=${encodeURIComponent(accountId)}` : '';
      setData(await api.get<McpListResponse>(`/agent/mcp${q}`));
    } catch (err) {
      setError((err as Error).message || 'Could not read your MCP servers.');
    } finally {
      setLoading(false);
    }
  }, [api, accountId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Run one leg and fold its verdict back into the row.
   *
   * The server answers with the state it RE-PROBED after the child exited, never with the
   * exit code, so a sign-in abandoned in the browser leaves the row saying "Needs sign-in" —
   * which is the truth — instead of flipping to Connected and lying about which tools exist.
   */
  const act = useCallback(async (server: McpServer, leg: 'login' | 'logout') => {
    setBusy(server.name);
    setNote(leg === 'login'
      ? `Finish signing in to ${server.name} in your browser.`
      : `Signing out of ${server.name}…`);
    try {
      const next = await api.post<{ name: string; state: McpServer['state']; label: string }>(
        `/agent/mcp/${leg}`,
        { name: server.name, account: accountId },
      );
      setData((prev) => (prev ? {
        ...prev,
        servers: prev.servers.map((s) => (s.name === next.name
          ? { ...s, state: next.state, label: next.label }
          : s)),
        counts: prev.counts,
      } : prev));
      setNote(next.state === 'connected'
        ? `${server.name} is connected.`
        : `${server.name}: ${next.label || 'not connected'}.`);
    } catch (err) {
      setNote((err as Error).message || 'That did not go through.');
    } finally {
      setBusy('');
    }
  }, [api, accountId]);

  const counts = data?.counts;

  return (
    <>
      <div className="chat-slideover-head">
        <div className="chat-slideover-head-text">
          <span className="chat-slideover-name">MCP servers</span>
          <span className="chat-slideover-path">
            {counts
              ? `${counts.total} configured · ${counts.connected} connected${counts.needsAuth ? ` · ${counts.needsAuth} need sign-in` : ''}`
              : 'Checking server health…'}
          </span>
        </div>
        <button
          type="button"
          className="mcp-refresh"
          onClick={() => void load()}
          disabled={loading || !!busy}
        >
          Refresh
        </button>
        <button type="button" className="chat-slideover-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="chat-slideover-body">
        {note && <p className="mcp-note">{note}</p>}
        {loading && !data && (
          <p className="chat-slideover-status">
            Health-checking every configured server. This takes a few seconds.
          </p>
        )}
        {error && <p className="chat-slideover-status error">{error}</p>}
        {data && data.servers.length === 0 && !error && (
          <p className="chat-slideover-status">No MCP servers are configured for this account.</p>
        )}

        <div className="mcp-list">
          {data?.servers.map((server) => (
            <div className="mcp-row" key={server.name} data-tone={TONE[server.state]}>
              <div className="mcp-row-text">
                <span className="mcp-row-name">{server.name}</span>
                <span className="mcp-row-target">{server.target}</span>
              </div>
              <span className="mcp-state" data-tone={TONE[server.state]}>{stateText(server)}</span>
              {/* Only the two states a button can actually change. A pending-approval server is
                  approved by the project trust prompt, and a disabled one by config — offering
                  a sign-in there would be a button that does nothing. */}
              {(server.state === 'needs-auth' || server.state === 'failed') && (
                <button
                  type="button"
                  className="mcp-act"
                  disabled={!!busy}
                  onClick={() => void act(server, 'login')}
                >
                  {busy === server.name ? 'Signing in…' : 'Sign in'}
                </button>
              )}
              {server.state === 'connected' && (
                <button
                  type="button"
                  className="mcp-act mcp-act--quiet"
                  disabled={!!busy}
                  onClick={() => void act(server, 'logout')}
                >
                  {busy === server.name ? 'Working…' : 'Sign out'}
                </button>
              )}
            </div>
          ))}
        </div>

        {data && (
          <p className="mcp-foot">
            Signing in opens your browser. dreamcontext never sees or stores the credential —
            the Claude CLI completes the flow and keeps it in this account's own config.
          </p>
        )}
      </div>
    </>
  );
}
