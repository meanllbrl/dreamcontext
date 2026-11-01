import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { openExternalUrl } from '../../lib/desktop';
import type {
  McpOverview, McpOverviewAccount, McpOverviewCell, McpOverviewServer, McpHome, CodexMcpList, CodexMcpRow, CodexMcpLeftReason,
} from '../../lib/mcpWire';
import { McpServerForm, type McpFormInitial } from './McpServerForm';
import './McpServers.css';

/**
 * Settings → MCP servers: the matrix (task mcp-management, owner pick "B").
 *
 * Rows are servers grouped by where they live — this computer (every account), this project
 * (on this computer only, never in the repo), the team's `.mcp.json`, claude.ai connectors, and
 * servers Claude Code has that dreamcontext did not import. Columns are the Claude accounts on
 * this Mac. Each cell is what THAT account's live session last reported (a probe: a transient
 * `claude` that answers `mcp_status`), with the time it was checked.
 *
 * Nothing here ever holds a value: the overview carries names, hosts, key names and statuses.
 * The edit form sends new values and never receives old ones (a blank field keeps the stored
 * value). A sign-in runs one account at a time, naming the account, through the CLI's own
 * OAuth (`mcp_authenticate`) in the browser.
 */

const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';
const STALE_MS = 10 * 60_000;
/** The sign-in ticket of a Codex server (codex-mcp.ts). */
const CODEX_ACCOUNT = 'codex';

interface ConnectTicketWire {
  id: string;
  accountId: string;
  name: string;
  state: 'opening' | 'waiting' | 'connected' | 'timeout' | 'failed';
  url?: string;
  host?: string;
}

const GROUPS: Array<{ home: McpHome; title: string; sub: string }> = [
  { home: 'computer', title: 'This computer', sub: 'every account' },
  { home: 'project', title: 'This project', sub: 'on this computer only, never in the repo' },
  { home: 'team', title: 'Team (.mcp.json)', sub: 'shared through the repo' },
  { home: 'claudeai', title: 'claude.ai connectors', sub: 'per account' },
  { home: 'outside', title: 'Found outside dreamcontext', sub: 'in Claude Code, not imported' },
];

const HOME_CHIP: Record<McpHome, string> = {
  computer: 'computer', project: 'project · local', team: '.mcp.json · team', claudeai: 'claude.ai',
  plugin: 'plugin', outside: 'outside', app: 'app',
};

function ago(at?: number): string {
  if (!at) return 'never checked';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'checked just now';
  const m = Math.round(s / 60);
  if (m < 60) return `checked ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `checked ${h} h ago` : `checked ${Math.round(h / 24)} d ago`;
}

function cellLabel(c: McpOverviewCell | undefined): string {
  switch (c?.status) {
    case 'connected': return 'connected';
    case 'needs-auth': return 'needs sign-in';
    case 'failed': return c.errorKind === 'spawn' ? 'failed to start' : 'failed';
    case 'pending': return 'still connecting';
    case 'absent': return 'not on this account';
    case 'disabled': return 'turned off';
    default: return 'not checked yet';
  }
}

interface Row { key: string; name: string; home: McpHome; transport: string; server?: McpOverviewServer }

/**
 * `codex` (the Settings window): one read-only Codex column beside the Claude accounts, a
 * "Found in Codex" group for servers only Codex has, and an All / Claude / Codex filter. Every
 * Codex account shares one config and one MCP sign-in, so the column is one fact: what a live
 * Codex carrying the app's stores reports. A server needing sign-in gets Codex's own Connect.
 * Classic passes nothing and is unchanged.
 */
export function McpServers({ codex = false }: { codex?: boolean } = {}) {
  const api = useApi();
  const [data, setData] = useState<McpOverview | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [form, setForm] = useState<McpFormInitial | null>(null);
  const [ticket, setTicket] = useState<ConnectTicketWire | null>(null);
  const [fallback, setFallback] = useState<{ name: string; email: string } | null>(null);
  const openedUrl = useRef<string | null>(null);
  const autoChecked = useRef(false);
  const [codexList, setCodexList] = useState<CodexMcpList | null>(null);
  const [filter, setFilter] = useState<'all' | 'claude' | 'codex'>('all');
  const loadCodex = useCallback(async () => {
    if (!codex) return;
    try { setCodexList(await api.get<CodexMcpList>('/agent/mcp/codex')); }
    catch { setCodexList({ state: 'failed', servers: [], left: [] }); }
  }, [api, codex]);
  useEffect(() => { void loadCodex(); }, [loadCodex]);

  const load = useCallback(async () => {
    setError('');
    try { setData(await api.get<McpOverview>('/agent/mcp/overview')); }
    catch (e) { setError((e as Error).message || 'Could not read the MCP servers.'); }
  }, [api]);

  const check = useCallback(async (account?: string) => {
    setChecking(account ?? '*');
    setError('');
    try {
      const [next] = await Promise.all([api.post<McpOverview>('/agent/mcp/check', account ? { account } : {}), account ? null : loadCodex()]);
      setData(next);
    } catch (e) { setError((e as Error).message || 'The check did not finish.'); }
    finally { setChecking(null); }
  }, [api, loadCodex]);

  useEffect(() => { void load(); }, [load]);

  // Opened with an old reading (or none): check every account in the background, once.
  useEffect(() => {
    if (!data || autoChecked.current) return;
    autoChecked.current = true;
    // The OLDEST account decides: one never probed (or probed long ago) is checked with the rest.
    const oldest = Math.min(...data.accounts.map((a) => a.checkedAt ?? 0));
    if (Date.now() - oldest > STALE_MS) void check();
  }, [data, check]);

  // A sign-in in flight: follow its ticket, open the browser once at the CLI's own URL.
  useEffect(() => {
    if (!ticket || ticket.state === 'connected' || ticket.state === 'timeout' || ticket.state === 'failed') return undefined;
    const t = setInterval(() => {
      void api.get<ConnectTicketWire>(`/agent/mcp/connect/${ticket.id}`).then((next) => {
        if (next.url && openedUrl.current !== next.url) { openedUrl.current = next.url; void openExternalUrl(next.url); }
        setTicket(next);
        if (next.state === 'connected') { setNote(`${next.name} is connected on ${next.accountId === CODEX_ACCOUNT ? 'Codex' : emailOf(data?.accounts ?? [], next.accountId)}.`); void load(); void loadCodex(); }
        if (next.state === 'timeout' || next.state === 'failed') {
          const row = rowsOf(data).find((r) => r.name === next.name);
          if (row?.home === 'claudeai' && next.accountId !== CODEX_ACCOUNT) setFallback({ name: next.name, email: emailOf(data?.accounts ?? [], next.accountId) });
          else setError(`${next.name}: the sign-in didn't complete. Try again.`);
        }
      }).catch(() => { /* the next tick asks again */ });
    }, 1500);
    return () => clearInterval(t);
  }, [ticket, api, data, load, loadCodex]);

  const connect = async (account: string, name: string) => {
    setMenu(null);
    setError('');
    setFallback(null);
    openedUrl.current = null;
    try { setTicket(await api.post<ConnectTicketWire>('/agent/mcp/connect', { account, name })); }
    catch (e) { setError((e as Error).message || 'Could not start the sign-in.'); }
  };

  const connectCodex = async (name: string) => {
    setMenu(null);
    setError('');
    setFallback(null);
    openedUrl.current = null;
    try { setTicket(await api.post<ConnectTicketWire>('/agent/mcp/codex/connect', { name })); }
    catch (e) { setError((e as Error).message || 'Could not start the sign-in.'); }
  };

  const act = async (path: string, body: unknown, done: string) => {
    setMenu(null);
    setError('');
    try { await api.post(path, body); setNote(done); await load(); void loadCodex(); }
    catch (e) { setError((e as Error).message || 'That did not work.'); }
  };

  if (!data) {
    return error ? <p className="mcpm-error" role="alert">{error}</p> : <p className="mcpm-muted">Reading your MCP servers…</p>;
  }

  const rows = rowsOf(data);
  const showCodex = codex && filter !== 'claude';
  const accounts = codex && filter === 'codex' ? [] : data.accounts;
  const codexServers = codexList?.state === 'ok' ? codexList.servers : [];
  const codexOnly = showCodex ? codexServers.filter((c) => !rows.some((r) => r.name === c.name)) : [];
  const extraCols = showCodex ? 1 : 0;
  const codexDot = (c: CodexMcpRow) => (
    c.enabled
      ? <span className="mcpm-dot" data-codex={c.status} data-status={c.status === 'unknown' ? 'unchecked' : c.status} title={`Codex: ${codexLabel(c)}`} aria-label={`Codex: ${codexLabel(c)}`} />
      : <span className="mcpm-muted" data-codex="off">Off</span>
  );
  const codexCell = (r: Row) => {
    if (r.home === 'claudeai') return <span className="mcpm-muted" data-codex="claude-only" title="A claude.ai connector belongs to your claude.ai account, so Codex cannot use it.">Claude only</span>;
    if (codexList === null) return <span className="mcpm-muted">…</span>;
    if (codexList.state !== 'ok') return <span className="mcpm-muted" data-codex={codexList.state}>{codexList.state === 'not_installed' ? 'Codex not found' : 'No answer'}</span>;
    const hit = codexServers.find((c) => c.name === r.name);
    if (hit) return codexDot(hit);
    const left = codexList.left.find((l) => l.name === r.name);
    if (left) return <span className="mcpm-muted" data-codex="left" title={leftReason(left.why)}>Can&apos;t reach Codex</span>;
    return <span className="mcpm-muted" data-codex="absent" title={r.home === 'team' ? "A repo's .mcp.json is approved by Claude Code, so it does not reach Codex." : undefined}>Not in Codex</span>;
  };
  const codexConnect = (name: string) => (
    showCodex && codexServers.find((c) => c.name === name)?.status === 'needs-auth' && (
      <button type="button" className="btn btn--primary btn--sm" data-codex-connect={name} disabled={!!ticket && (ticket.state === 'opening' || ticket.state === 'waiting')} onClick={() => { void connectCodex(name); }}>Connect Codex</button>
    )
  );
  const newest = Math.max(0, ...accounts.map((a) => a.checkedAt ?? 0));

  return (
    <div className="mcpm">
      <p className="mcpm-lede">Every server, every account, side by side. Each dot is what that account&apos;s live session reports.</p>
      <div className="mcpm-toolbar">
        {codex && (
          <span className="sw-seg" role="radiogroup" aria-label="Show">
            {(['all', 'claude', 'codex'] as const).map((f) => (
              <button key={f} type="button" role="radio" aria-checked={filter === f} className={`sw-seg-btn${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)} data-mcp-filter={f}>
                {f === 'all' ? 'All' : f === 'claude' ? 'Claude Code' : 'Codex'}
              </button>
            ))}
          </span>
        )}
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setForm({ mode: 'add', scope: 'computer' })}>+ Add server</button>
        <button type="button" className="btn btn--secondary btn--sm" disabled={!!checking} onClick={() => { void check(); }}>
          {checking === '*' ? 'Checking every account…' : 'Check all accounts'}
        </button>
        <span className="mcpm-muted mcpm-toolbar-when">{checking ? 'checking…' : ago(newest || undefined)}</span>
      </div>

      {data.storeProblem.map((p) => (
        <p key={p.scope} className="mcpm-warn" role="alert">
          The {p.scope === 'computer' ? 'computer' : 'project'} MCP file is skipped: {p.reason}. Chats start without it until it is fixed.
        </p>
      ))}
      {error && <p className="mcpm-error" role="alert">{error}</p>}
      {note && <p className="mcpm-note" role="status">{note}</p>}
      {ticket && (ticket.state === 'opening' || ticket.state === 'waiting') && (
        <p className="mcpm-note" role="status">
          Signing in to <strong>{ticket.name}</strong> as <strong>{ticket.accountId === CODEX_ACCOUNT ? 'Codex' : emailOf(accounts, ticket.accountId)}</strong>
          {ticket.host ? <> — finish on {ticket.host} in your browser.</> : '…'}
          <button type="button" className="mcpm-link" onClick={() => { void api.del(`/agent/mcp/connect/${ticket.id}`); setTicket(null); }}>Cancel</button>
        </p>
      )}
      {fallback && (
        <div className="mcpm-fallback" role="alert">
          <strong>{fallback.name}: reconnect on claude.ai.</strong> This connector belongs to your claude.ai account.
          Sign in there as <strong>{fallback.email}</strong>, press Connect next to {fallback.name}, then check again.
          <span className="mcpm-fallback-actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => { void openExternalUrl(CLAUDE_AI_CONNECTORS_URL); }}>Open claude.ai connectors ↗</button>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => { setFallback(null); void check(); }}>I&apos;ve connected it, check again</button>
          </span>
        </div>
      )}

      {form && (
        <McpServerForm
          initial={form}
          onCancel={() => setForm(null)}
          onSaved={(next, message) => { setForm(null); setData(next); setNote(message); void loadCodex(); }}
        />
      )}

      <div className="mcpm-scroll">
        <table className="mcpm-table">
          <thead>
            <tr>
              <th scope="col">Server</th>
              <th scope="col">Lives in</th>
              {accounts.map((a) => <th scope="col" key={a.id} className="mcpm-acc" title={ago(a.checkedAt)}>{a.label}</th>)}
              {showCodex && <th scope="col" className="mcpm-acc" title="Every Codex account shares one MCP config.">Codex</th>}
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const groupRows = g.home === 'outside' ? [] : rows.filter((r) => r.home === g.home);
              const outside = g.home === 'outside' ? data.outside : [];
              if (!groupRows.length && !outside.length) return null;
              return (
                <Fragment key={g.home}>
                  <tr className="mcpm-group"><th colSpan={accounts.length + 3 + extraCols} scope="colgroup"><span className="mcpm-group-title">{g.title} <span>· {g.sub}</span></span></th></tr>
                  {groupRows.map((r) => {
                    const cells = data.cells[r.key] ?? {};
                    const needing = accounts.filter((a) => cells[a.id]?.status === 'needs-auth');
                    const failing = accounts.filter((a) => cells[a.id]?.status === 'failed');
                    return (
                      <tr key={r.key} className="mcpm-row">
                        <td>
                          <span className="mcpm-name">{r.name}</span>
                          <span className="mcpm-sub">{r.transport || 'stdio'}{r.server?.target ? ` · ${r.server.target}` : ''}</span>
                          {r.server?.differs && <span className="mcpm-flag">edited here · differs from Claude Code</span>}
                          {r.server?.removedAtSource && <span className="mcpm-flag">removed in Claude Code · kept here</span>}
                        </td>
                        <td><code className="mcpm-chip">{HOME_CHIP[r.home]}</code></td>
                        {accounts.map((a) => {
                          const c = cells[a.id];
                          return (
                            <td key={a.id} className="mcpm-cell">
                              {c?.status === 'absent'
                                ? <span className="mcpm-absent" title="not on this account">—</span>
                                : <span className="mcpm-dot" data-status={c?.status ?? 'unchecked'} title={`${a.label}: ${cellLabel(c)}${c?.at ? ` · ${ago(c.at)}` : ''}`} aria-label={`${a.label}: ${cellLabel(c)}`} />}
                            </td>
                          );
                        })}
                        {showCodex && <td className="mcpm-cell mcpm-cell--codex">{codexCell(r)}</td>}
                        <td className="mcpm-actions">
                          {r.home !== 'claudeai' && codexConnect(r.name)}
                          {needing.length > 0 && (
                            <span className="mcpm-menu-wrap">
                              <button
                                type="button"
                                className="btn btn--primary btn--sm"
                                disabled={!!ticket && (ticket.state === 'opening' || ticket.state === 'waiting')}
                                onClick={() => (needing.length === 1 ? void connect(needing[0].id, r.name) : setMenu(menu === `c:${r.key}` ? null : `c:${r.key}`))}
                              >
                                {r.home === 'claudeai' ? 'Reconnect' : `Connect${needing.length > 1 ? ` ${needing.length}` : ''}`}
                              </button>
                              {menu === `c:${r.key}` && (
                                <span className="mcpm-menu" role="menu">
                                  {needing.map((a) => (
                                    <button key={a.id} type="button" role="menuitem" onClick={() => { void connect(a.id, r.name); }}>Connect on {a.label}</button>
                                  ))}
                                </span>
                              )}
                            </span>
                          )}
                          {needing.length === 0 && failing.length > 0 && (
                            <button type="button" className="btn btn--secondary btn--sm" disabled={!!checking} onClick={() => { void Promise.all(failing.map((a) => check(a.id))); }}>Retry</button>
                          )}
                          <span className="mcpm-menu-wrap">
                            <button type="button" className="btn btn--ghost btn--sm mcpm-more" aria-label={`More for ${r.name}`} onClick={() => setMenu(menu === `m:${r.key}` ? null : `m:${r.key}`)}>⋯</button>
                            {menu === `m:${r.key}` && (
                              <span className="mcpm-menu" role="menu">
                                {r.home === 'claudeai' && (
                                  <button type="button" role="menuitem" onClick={() => { setMenu(null); void openExternalUrl(CLAUDE_AI_CONNECTORS_URL); }}>Manage on claude.ai ↗</button>
                                )}
                                {(r.home === 'computer' || r.home === 'project') && r.server && (
                                  <>
                                    <button type="button" role="menuitem" onClick={() => { setMenu(null); setForm({ mode: 'edit', scope: r.home as 'computer' | 'project', server: r.server! }); }}>Edit</button>
                                    <button type="button" role="menuitem" onClick={() => { void act('/agent/mcp/server/move', { name: r.name, from: r.home, to: r.home === 'computer' ? 'project' : 'computer' }, `${r.name} moved to ${r.home === 'computer' ? 'this project' : 'this computer'}.`); }}>
                                      Move to {r.home === 'computer' ? 'this project' : 'this computer'}
                                    </button>
                                    <button type="button" role="menuitem" onClick={() => { void act('/agent/mcp/project/adopt', { name: r.name }, `${r.name} is now in the team's .mcp.json (secrets as \${VAR} references).`); }}>Share with team</button>
                                    <button type="button" role="menuitem" className="mcpm-danger" onClick={() => {
                                      void act('/agent/mcp/server/remove', { scope: r.home, name: r.name }, r.server?.imported
                                        ? `${r.name} removed from dreamcontext. It stays in Claude Code's own config, so plain \`claude\` on the main account still has it.`
                                        : `${r.name} removed.`);
                                    }}>Remove</button>
                                  </>
                                )}
                                {r.home === 'team' && (
                                  <button type="button" role="menuitem" className="mcpm-danger" onClick={() => { void act('/agent/mcp/project/remove', { name: r.name }, `${r.name} removed from the team's .mcp.json.`); }}>Remove from team</button>
                                )}
                                {accounts.map((a) => (
                                  <button key={a.id} type="button" role="menuitem" disabled={!!checking} onClick={() => { setMenu(null); void check(a.id); }}>Check {a.label}</button>
                                ))}
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {outside.map((o) => (
                    <tr key={`${o.name}|${o.source}|${o.reason}`} className="mcpm-row mcpm-row--outside">
                      <td>
                        <span className="mcpm-name">{o.name}</span>
                        <span className="mcpm-sub">{sourceLabel(o.source)} · {outsideReason(o.reason)}</span>
                      </td>
                      <td><code className="mcpm-chip">outside</code></td>
                      {accounts.map((a) => <td key={a.id} className="mcpm-cell"><span className="mcpm-absent">—</span></td>)}
                      {showCodex && <td className="mcpm-cell"><span className="mcpm-absent">—</span></td>}
                      <td className="mcpm-actions">
                        {o.reason === 'removed-in-app' && <button type="button" className="btn btn--secondary btn--sm" onClick={() => { void act('/agent/mcp/import', { name: o.name, source: o.source }, `${o.name} is back.`); }}>Import again</button>}
                        {o.reason === 'differs' && <button type="button" className="btn btn--secondary btn--sm" onClick={() => { void act('/agent/mcp/import', { name: o.name, source: o.source }, `${o.name} now follows Claude Code again.`); }}>Use Claude Code&apos;s</button>}
                        {(o.reason === 'bad-name' || o.reason === 'conflict') && (
                          <button type="button" className="btn btn--secondary btn--sm" onClick={() => {
                            setForm({ mode: 'import', scope: o.source.startsWith('local:') ? 'project' : 'computer', importName: o.name, importSource: o.source });
                          }}>Rename to import</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {codexOnly.length > 0 && (
              <Fragment key="codex-only">
                <tr className="mcpm-group"><th colSpan={accounts.length + 3 + extraCols} scope="colgroup"><span className="mcpm-group-title">Found in Codex <span>· set up in Codex itself</span></span></th></tr>
                {codexOnly.map((c) => (
                  <tr key={`codex|${c.name}`} className="mcpm-row" data-codex-only={c.name}>
                    <td>
                      <span className="mcpm-name">{c.name}</span>
                      <span className="mcpm-sub">{c.transport}</span>
                    </td>
                    <td><code className="mcpm-chip">codex</code></td>
                    {accounts.map((a) => <td key={a.id} className="mcpm-cell"><span className="mcpm-absent" title="not on this account">—</span></td>)}
                    <td className="mcpm-cell mcpm-cell--codex">{codexDot(c)}</td>
                    <td className="mcpm-actions">{codexConnect(c.name)}</td>
                  </tr>
                ))}
              </Fragment>
            )}
          </tbody>
        </table>
      </div>
      <p className="mcpm-legend">
        <span><span className="mcpm-dot" data-status="connected" /> connected</span>
        <span><span className="mcpm-dot" data-status="needs-auth" /> needs sign-in</span>
        <span><span className="mcpm-dot" data-status="failed" /> failed</span>
        <span><span className="mcpm-dot" data-status="unchecked" /> not checked yet</span>
        <span><span className="mcpm-absent">—</span> not on this account</span>
      </p>
    </div>
  );
}

function rowsOf(data: McpOverview | null): Row[] {
  if (!data) return [];
  const rows: Row[] = data.servers.map((s) => ({ key: s.key, name: s.name, home: s.home, transport: s.transport, server: s }));
  for (const l of data.live) {
    if (rows.some((r) => r.name === l.name && r.home === l.home)) continue;
    if (l.home !== 'claudeai' && l.home !== 'team') continue;
    rows.push({ key: `${l.name}|${l.home}`, name: l.name, home: l.home, transport: l.transport });
  }
  return rows;
}

function codexLabel(c: CodexMcpRow): string {
  switch (c.status) {
    case 'connected': return `connected${c.toolCount ? ` · ${c.toolCount} tool${c.toolCount === 1 ? '' : 's'}` : ''}`;
    case 'needs-auth': return 'needs its own sign-in on Codex';
    case 'failed': return 'did not start, no tools';
    default: return 'Codex gave no answer';
  }
}

function leftReason(why: CodexMcpLeftReason): string {
  switch (why) {
    case 'variable': return 'It uses a ${VAR} reference, which only Claude Code fills in.';
    case 'transport': return 'Codex speaks stdio and streamable HTTP only.';
    default: return 'Codex cannot address a name with these characters.';
  }
}

function emailOf(accounts: McpOverviewAccount[], id: string): string {
  const a = accounts.find((x) => x.id === id);
  return a?.email || a?.label || 'this account';
}

function sourceLabel(source: string): string {
  if (source === 'user') return '~/.claude.json';
  if (source.startsWith('sandbox:')) return `account ${source.slice(8)}`;
  if (source.startsWith('local:')) return `this project in ${sourceLabel(source.slice(6))}`;
  return source;
}

function outsideReason(reason: string): string {
  switch (reason) {
    case 'bad-name': return 'its name has characters dreamcontext cannot use';
    case 'conflict': return 'another account has a different server by this name';
    case 'removed-in-app': return 'you removed it here';
    case 'differs': return 'differs from the copy you edited here';
    default: return reason;
  }
}
