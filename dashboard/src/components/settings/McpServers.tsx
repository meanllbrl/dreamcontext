import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../context/VaultContext';
import './McpServers.css';

/**
 * Settings → MCP servers, the TEAM scope.
 *
 * ── The problem this screen solves ──────────────────────────────────────────────────────
 * Owner, 2026-09-20: a colleague opens dreamcontext and cannot reach the MCP servers. They
 * never could. A server in your `~/.claude.json` is yours alone, and a claude.ai connector
 * belongs to your account — neither travels. The repo's `.mcp.json` is the one scope that
 * does: measured on CLI 2.1.276, an account that had never opened the repo before saw the
 * server `connected` on its first run, with no approval step. Clone the repo, get the server.
 *
 * ── Why this screen refuses things ─────────────────────────────────────────────────────
 * `.mcp.json` is committed, and on this product a brain repo is synced across a team, so a
 * literal API key written here is a key handed to everyone and to the remote's history, where
 * deleting it later does not unpublish it. Sharing a server therefore rewrites its
 * `env`/`headers` into `${VAR}` references and tells you which variables to set; a server
 * whose URL IS its token is refused outright, because only you can decide how to split that.
 * Values are never shown here either — key names and masked targets only.
 */

interface SharedServer {
  name: string;
  kind: string;
  target: string;
  envKeys: string[];
  headerKeys: string[];
  requires: string[];
}

interface Candidate {
  name: string;
  kind: string;
  target: string;
  wouldRequire: string[];
  urlCarriedSecret: boolean;
}

interface ProjectMcpResponse {
  path: string;
  broken: boolean;
  servers: SharedServer[];
  candidates: Candidate[];
  adopted?: string;
  requires?: string[];
}

export function McpServers() {
  const api = useApi();
  const [data, setData] = useState<ProjectMcpResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await api.get<ProjectMcpResponse>('/agent/mcp/project'));
    } catch (err) {
      setError((err as Error).message || 'Could not read this project\'s MCP file.');
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (name: string, leg: 'adopt' | 'remove') => {
    setBusy(name);
    setNote('');
    setError('');
    try {
      const next = await api.post<ProjectMcpResponse>(`/agent/mcp/project/${leg}`, { name });
      setData(next);
      if (leg === 'adopt') {
        setNote(next.requires?.length
          ? `${name} is now shared with the repo. Set ${next.requires.join(', ')} in your environment — and tell your teammates to set them too.`
          : `${name} is now shared with the repo. Everyone who clones it gets this server.`);
      } else {
        setNote(`${name} is no longer shared.`);
      }
    } catch (err) {
      setError((err as Error).message || 'That did not go through.');
    } finally {
      setBusy('');
    }
  }, [api]);

  if (!data && !error) return <p className="settings-field-hint">Reading this project…</p>;

  return (
    <div className="mcpset">
      <p className="settings-field-hint">
        Servers defined here live in this repo, so everyone who clones it gets them — including
        your teammates' own Claude accounts. Servers that only exist on your machine reach your
        own chats and nobody else's.
      </p>

      {error && <p className="mcpset-error">{error}</p>}
      {note && <p className="mcpset-note">{note}</p>}
      {data?.broken && (
        <p className="mcpset-error">
          This project's <code>.mcp.json</code> is not valid JSON, so nothing in it is loading.
          Fix the file at <code>{data.path}</code>.
        </p>
      )}

      <div className="mcpset-group">
        <h4 className="mcpset-title">Shared with the repo</h4>
        {data && data.servers.length === 0 && (
          <p className="settings-field-hint">
            Nothing yet. Anything you share below is written to <code>{data.path}</code>.
          </p>
        )}
        {data?.servers.map((server) => (
          <div className="mcpset-row" key={server.name}>
            <div className="mcpset-row-text">
              <span className="mcpset-name">{server.name} <span className="mcpset-kind">{server.kind}</span></span>
              <span className="mcpset-target">{server.target}</span>
              {server.requires.length > 0 && (
                <span className="mcpset-requires">
                  needs {server.requires.join(', ')} in the environment
                </span>
              )}
            </div>
            <button
              type="button"
              className="mcpset-btn mcpset-btn--quiet"
              disabled={!!busy}
              onClick={() => void act(server.name, 'remove')}
            >
              {busy === server.name ? 'Working…' : 'Stop sharing'}
            </button>
          </div>
        ))}
      </div>

      {data && data.candidates.length > 0 && (
        <div className="mcpset-group">
          <h4 className="mcpset-title">On this machine only</h4>
          <p className="settings-field-hint">
            These reach your own chats but nobody else's. Sharing one writes its definition into
            the repo — any key it carries becomes a <code>${'{'}VAR{'}'}</code> reference, never
            the key itself.
          </p>
          {data.candidates.map((candidate) => (
            <div className="mcpset-row" key={candidate.name}>
              <div className="mcpset-row-text">
                <span className="mcpset-name">
                  {candidate.name} <span className="mcpset-kind">{candidate.kind}</span>
                </span>
                <span className="mcpset-target">{candidate.target}</span>
                {candidate.urlCarriedSecret ? (
                  <span className="mcpset-blocked">
                    its URL contains its own access token — sharing it would publish that token
                  </span>
                ) : candidate.wouldRequire.length > 0 && (
                  <span className="mcpset-requires">
                    would need {candidate.wouldRequire.join(', ')} set by everyone
                  </span>
                )}
              </div>
              <button
                type="button"
                className="mcpset-btn"
                disabled={!!busy || candidate.urlCarriedSecret}
                onClick={() => void act(candidate.name, 'adopt')}
              >
                {busy === candidate.name ? 'Sharing…' : 'Share with the repo'}
              </button>
            </div>
          ))}
        </div>
      )}

      {data && (
        <p className="settings-field-hint mcpset-foot">
          Each person still signs in to a server that uses OAuth, once, from the chat's
          <code>/mcp</code> panel — a credential belongs to one person and is never shared.
        </p>
      )}
    </div>
  );
}
