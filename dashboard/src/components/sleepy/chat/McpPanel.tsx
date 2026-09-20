import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../../context/VaultContext';
import './mcpPanel.css';

/**
 * The `/mcp` panel — what typing `/mcp` in this window opens.
 *
 * Before this existed, `/mcp` was the most frustrating kind of dead end: the headless engine
 * RECOGNISES the command and answers it, with "N MCP server(s): … Use `/mcp` in the terminal
 * for details." The user typed exactly the right thing and was told to go to another app.
 *
 * ── What this panel shows, and why that took three attempts ─────────────────────────────
 * It shows what THIS CONVERSATION has — read from the session's own `system/init` frame,
 * which is the engine's answer about the engine's own tools. Two earlier cuts asked
 * `claude mcp list` instead, which describes a config DIRECTORY, and the two answers
 * disagreed about 26 of 32 servers on the machine this was built for: local servers missing
 * entirely, and a dozen connectors reported "Connected" that the session could not use.
 *
 * A row therefore never claims a tool the agent does not have, which is the whole point of
 * the panel — the servers that need attention are exactly the ones the agent is quietly
 * missing.
 */

export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown';
export type McpSource = 'project' | 'claudeai' | 'plugin' | 'dynamic' | 'user' | 'unknown';

export interface McpServer {
  name: string;
  status: McpStatus;
  /** The engine's own word, shown verbatim when the status is not one we recognise. */
  statusLabel: string;
  source: McpSource;
  sourceLabel: string;
  /** False when no button here could sign this server in — see the `dynamic` note below. */
  signInAvailable: boolean;
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

/** Tone per status — meaning, not decoration. `unknown` stays neutral rather than guessing. */
const TONE: Record<McpStatus, string> = {
  connected: 'good',
  'needs-auth': 'warn',
  pending: 'warn',
  failed: 'bad',
  unknown: 'muted',
};

/** The status in this surface's words. `unknown` defers to whatever the engine called it. */
function statusText(server: McpServer): string {
  switch (server.status) {
    case 'connected': return 'Connected';
    case 'needs-auth': return 'Needs sign-in';
    case 'pending': return 'Pending approval';
    case 'failed': return 'Failed';
    default: return server.statusLabel || 'Unknown';
  }
}

/**
 * Where the server comes from, named the way it matters to the reader.
 *
 * `project` is the one worth calling out in every row: it means the definition lives in the
 * repo, so everyone who clones it gets the server too. The others are this machine's or this
 * account's, and shared with nobody.
 */
function scopeText(server: McpServer): string {
  switch (server.source) {
    case 'project': return 'shared with the repo';
    case 'claudeai': return 'your Claude account';
    case 'plugin': return 'plugin';
    case 'dynamic': return 'this machine';
    case 'user': return 'this machine';
    default: return server.sourceLabel || '';
  }
}

export function McpPanel({ accountId, onClose }: McpPanelProps) {
  const api = useApi();
  const [data, setData] = useState<McpListResponse | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  /** The server an action is running for — one at a time, by design: a sign-in takes over the
   *  browser, and two OAuth tabs racing for the same callback is a lost login. */
  const [busy, setBusy] = useState<string>('');
  const [note, setNote] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = accountId ? `?account=${encodeURIComponent(accountId)}` : '';
      setData(await api.get<McpListResponse>(`/agent/mcp${q}`));
    } catch (err) {
      setError((err as Error).message || 'Could not read this session\'s MCP servers.');
    } finally {
      setLoading(false);
    }
  }, [api, accountId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Run one leg and fold its verdict back into the row.
   *
   * The server answers with the status it RE-READ from the session after the child exited,
   * never with the exit code, so a sign-in abandoned in the browser leaves the row saying
   * "Needs sign-in" instead of flipping to Connected and lying about which tools exist.
   */
  const act = useCallback(async (server: McpServer, leg: 'login' | 'logout') => {
    setBusy(server.name);
    setNote(leg === 'login'
      ? `Finish signing in to ${server.name} in your browser.`
      : `Signing out of ${server.name}…`);
    try {
      const next = await api.post<{ name: string; status: McpStatus; statusLabel: string }>(
        `/agent/mcp/${leg}`,
        { name: server.name, account: accountId },
      );
      setData((prev) => (prev ? {
        ...prev,
        servers: prev.servers.map((s) => (s.name === next.name
          ? { ...s, status: next.status, statusLabel: next.statusLabel }
          : s)),
      } : prev));
      setNote(next.status === 'connected'
        ? `${server.name} is connected.`
        : `${server.name}: ${next.statusLabel || 'still not connected'}.`);
    } catch (err) {
      setNote((err as Error).message || 'That did not go through.');
    } finally {
      setBusy('');
    }
  }, [api, accountId]);

  const counts = data?.counts;
  /** Servers this account cannot sign into from here — the panel owes them an explanation. */
  const stranded = (data?.servers ?? []).filter((s) => s.status === 'needs-auth' && !s.signInAvailable);

  return (
    <>
      <div className="chat-slideover-head">
        <div className="chat-slideover-head-text">
          <span className="chat-slideover-name">MCP servers</span>
          <span className="chat-slideover-path">
            {counts
              ? `${counts.total} in this chat · ${counts.connected} live${counts.needsAuth ? ` · ${counts.needsAuth} need sign-in` : ''}`
              : 'Reading this session…'}
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
          <p className="chat-slideover-status">Asking this session which servers it has…</p>
        )}
        {error && <p className="chat-slideover-status error">{error}</p>}
        {data && data.servers.length === 0 && !error && (
          <p className="chat-slideover-status">This chat has no MCP servers.</p>
        )}

        <div className="mcp-list">
          {data?.servers.map((server) => (
            <div className="mcp-row" key={server.name} data-tone={TONE[server.status]}>
              <div className="mcp-row-text">
                <span className="mcp-row-name">{server.name}</span>
                <span className="mcp-row-target">{scopeText(server)}</span>
              </div>
              <span className="mcp-state" data-tone={TONE[server.status]}>{statusText(server)}</span>
              {/* A button only where one can do something. A server handed to this account by
                  reference is invisible to `claude mcp login`, so offering a sign-in there
                  would be offering a failure — the note under the list says what fixes it. */}
              {server.signInAvailable && (
                <button
                  type="button"
                  className="mcp-act"
                  disabled={!!busy}
                  onClick={() => void act(server, 'login')}
                >
                  {busy === server.name ? 'Signing in…' : 'Sign in'}
                </button>
              )}
              {server.status === 'connected' && server.source !== 'dynamic' && (
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

        {stranded.length > 0 && (
          <p className="mcp-foot mcp-foot--warn">
            {stranded.length === 1 ? '1 server needs' : `${stranded.length} servers need`} a sign-in
            that cannot be done from this account: {stranded.map((s) => s.name).join(', ')}. They
            reach this chat from your machine's own config, which the sign-in command cannot see.
            Moving them into this project's <code>.mcp.json</code> fixes it for good — and gives
            them to everyone who clones the repo. Settings → MCP servers does that.
          </p>
        )}

        {data && (
          <p className="mcp-foot">
            This is what the conversation actually has, read from the session itself. Signing in
            opens your browser; dreamcontext never sees or stores the credential.
          </p>
        )}
      </div>
    </>
  );
}
