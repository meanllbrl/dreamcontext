import { useEffect, useMemo, useRef, useState } from 'react';
import { emitInstance, useVault } from '../../../context/VaultContext';
import { openExternalUrl } from '../../../lib/desktop';
import type { McpLiveServer } from '../../../lib/mcpWire';
import { useChatAccountEmail, useMcpLive, type McpHost } from './useMcpLive';
import {
  CLAUDE_AI_CONNECTORS_URL, actionLabel, connectLabel, homeLabel, needsYou, nextIndex, rowAction, sortNeedsYouFirst, statusLabel,
} from './mcpRows';
import './mcpPicker.css';

/**
 * `/mcp` in Chat — a popover above the composer (task mcp-management, owner pick "A").
 *
 * It draws the chat's OWN live statuses at once (the last `mcp_status` the server pushed, so it
 * opens instantly) and asks the server for a fresh reading in the background. "Need you" comes
 * first. ↑/↓ move, ↵ runs the row's one action, esc closes: the slash menu's idiom, with its
 * keys taken in the capture phase so ↵ never sends the draft.
 *
 * The actions go through the CHAT's own process (`mcp_authenticate` / `mcp_reconnect` over its
 * control channel), which is the only process that can sign a `--mcp-config` server in. A
 * failed server offers Restart, never Sign in.
 */
export function McpPicker({ session, onClose }: {
  session: McpHost;
  onClose: () => void;
}) {
  const { bus } = useVault();
  const accountEmail = useChatAccountEmail(session);
  const { status, auth } = useMcpLive(session);
  const servers = useMemo(() => sortNeedsYouFirst(status?.servers ?? []), [status]);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // A fresh reading every time it opens; the last one is drawn meanwhile.
  useEffect(() => { session.mcpRefresh(); }, [session]);

  const act = (s: McpLiveServer | undefined) => {
    if (!s) return;
    const a = rowAction(s);
    if (a === 'restart') session.mcpReconnect(s.name);
    else if (a) session.mcpConnect(s.name);
  };

  const manage = () => {
    emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: 'mcp' });
    onClose();
  };

  // Keys in the CAPTURE phase: the composer's own ↵ (send) and ↑/↓ (history) never see them.
  const stateRef = useRef({ servers, index, act, onClose });
  stateRef.current = { servers, index, act, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { servers: list, index: i, act: run, onClose: close } = stateRef.current;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setIndex(nextIndex(i, list.length, e.key));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault(); e.stopPropagation();
        run(list[i]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const need = servers.filter(needsYou);
  const connecting = servers.filter((s) => s.status === 'pending');
  const rest = servers.filter((s) => !needsYou(s) && s.status !== 'pending');
  const connected = servers.filter((s) => s.status === 'connected').length;
  let flat = 0;

  const row = (s: McpLiveServer) => {
    const i = flat++;
    const a = rowAction(s);
    const flight = auth[s.name];
    const flightText = connectLabel(flight?.state, flight?.host);
    return (
      <div
        key={s.name}
        role="option"
        aria-selected={i === index}
        data-active={i === index}
        data-status={s.status}
        className="mcp-picker-row"
        onMouseEnter={() => setIndex(i)}
      >
        <span className="mcp-picker-dot" data-status={s.status} aria-hidden />
        <span className="mcp-picker-text">
          <span className="mcp-picker-name">{s.name}</span>
          <span className="mcp-picker-sub">{homeLabel(s.home)} · {flightText ?? statusLabel(s)}</span>
        </span>
        <span className="mcp-picker-actions">
          {a && (
            <button
              type="button"
              className={`chat-btn pill${i === index && a !== 'restart' ? ' primary' : ''}`}
              disabled={flight?.state === 'opening' || flight?.state === 'waiting'}
              onMouseDown={(e) => { e.preventDefault(); act(s); }}
            >
              {actionLabel(a)}
            </button>
          )}
          {s.home === 'claudeai' && (
            <button
              type="button"
              className="chat-btn pill mcp-picker-icon"
              aria-label="Manage on claude.ai"
              title="Manage on claude.ai"
              onMouseDown={(e) => { e.preventDefault(); void openExternalUrl(CLAUDE_AI_CONNECTORS_URL); }}
            >
              ↗
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="mcp-picker" role="dialog" aria-label="MCP servers in this chat">
      <div className="mcp-picker-head">
        <span><strong>MCP</strong> · this chat{accountEmail ? ` · ${accountEmail}` : ''}</span>
        <span className="mcp-picker-count">
          {status ? `${connected} connected${need.length ? ` · ${need.length} need you` : ''}` : 'reading…'}
        </span>
      </div>
      <div className="mcp-picker-list" role="listbox" ref={listRef}>
        {!status && <p className="mcp-picker-empty">Reading this chat&apos;s servers…</p>}
        {status && servers.length === 0 && <p className="mcp-picker-empty">This chat has no MCP servers. Add one in Settings.</p>}
        {need.length > 0 && <div className="mcp-picker-group">Need you</div>}
        {need.map(row)}
        {connecting.length > 0 && <div className="mcp-picker-group">Connecting</div>}
        {connecting.map(row)}
        {rest.length > 0 && <div className="mcp-picker-group">Connected</div>}
        {rest.map(row)}
      </div>
      <div className="mcp-picker-foot">
        <span className="mcp-picker-keys">
          <kbd>↑↓</kbd> move <kbd>↵</kbd> connect <kbd>esc</kbd> close
        </span>
        <button type="button" className="mcp-picker-link" onMouseDown={(e) => { e.preventDefault(); manage(); }}>
          Manage in Settings
        </button>
      </div>
    </div>
  );
}
