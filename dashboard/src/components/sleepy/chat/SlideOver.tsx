import { useEffect, useState } from 'react';
import { api } from '../../../api/client';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { ItemView } from './TranscriptItem';
import type { Reference, SubAgentRun } from './chatEntities';
import type { ChatItem } from '../chatSession';

/**
 * Right slide-over panel + scrim, states 3 and 9's drill-in. Two modes sharing one
 * shell: `file` (project file / dreamcontext entity preview, `GET /api/agent/file`)
 * and `subagent` (a sub-agent's REAL sidechain transcript, `GET /api/agent/chat-
 * history?claudeId=&subagent=` — plan rev.3's blocking-finding fix: the engine
 * DOES have a transcript channel for this, no static-only drill-in). Sub-agent mode
 * renders read-only via the SAME `TranscriptItem`/`ToolCard` components the main
 * transcript uses (readOnly=true, no composer) and degrades to the static run
 * summary (prompt + result/summary + usage) when the sidechain hasn't flushed yet.
 */

export interface SlideOverFileProps {
  mode: 'file';
  path: string;
  reference: Reference;
  onClose: () => void;
  onNavApp: (page: 'tasks' | 'knowledge' | 'core', id: string) => void;
}
export interface SlideOverSubAgentProps {
  mode: 'subagent';
  run: SubAgentRun;
  conversationId: string;
  onClose: () => void;
  onNavApp: (page: 'tasks' | 'knowledge' | 'core', id: string) => void;
}
export type SlideOverProps = SlideOverFileProps | SlideOverSubAgentProps;

// ─── File mode ──────────────────────────────────────────────────────────────────────

interface FileContent { path: string; type: 'text' | 'markdown'; content: string }

function NumberedText({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="chat-slideover-numbered">
      {lines.map((line, i) => (
        <div className="chat-slideover-line" key={i}>
          <span className="chat-slideover-lineno">{i + 1}</span>
          <span className="chat-slideover-linetext">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function FileSlideOver({ path, reference, onClose, onNavApp }: SlideOverFileProps) {
  const [state, setState] = useState<{ loading: boolean; data: FileContent | null; error: string | null }>(
    { loading: true, data: null, error: null },
  );

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    api.get<FileContent>(`/agent/file?path=${encodeURIComponent(path)}`)
      .then((data) => { if (!cancelled) setState({ loading: false, data, error: null }); })
      .catch((err: Error) => { if (!cancelled) setState({ loading: false, data: null, error: err.message || 'Failed to load file.' }); });
    return () => { cancelled = true; };
  }, [path]);

  const copyPath = () => { void navigator.clipboard?.writeText(path).catch(() => {}); };

  return (
    <>
      <div className="chat-slideover-head">
        <div className="chat-slideover-head-text">
          <span className="chat-slideover-name">{reference.label}</span>
          <span className="chat-slideover-path">{path}</span>
        </div>
        <button type="button" className="chat-slideover-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="chat-slideover-actions">
        {reference.appNav && (
          <button
            type="button"
            className="chat-btn"
            onClick={() => { onNavApp(reference.appNav!.page, reference.appNav!.id); onClose(); }}
          >Open in app <span aria-hidden>↗</span></button>
        )}
        <button type="button" className="chat-btn" onClick={copyPath}>
          <span aria-hidden>⧉</span> Copy path
        </button>
      </div>
      <div className="chat-slideover-body">
        {state.loading && <p className="chat-slideover-status">Loading…</p>}
        {state.error && <p className="chat-slideover-status error">Couldn't load this file — {state.error}</p>}
        {state.data && (
          state.data.type === 'markdown'
            ? <MarkdownPreview content={state.data.content} />
            : <NumberedText content={state.data.content} />
        )}
      </div>
    </>
  );
}

// ─── Sub-agent mode ─────────────────────────────────────────────────────────────────

interface DrillInHistoryEntry {
  kind: 'user' | 'text' | 'thinking' | 'tool';
  uuid?: string;
  text?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  status?: 'done' | 'error';
  result?: unknown;
}

function toChatItem(h: DrillInHistoryEntry, i: number): ChatItem | null {
  const id = `sub-${i}`;
  if (h.kind === 'user' && typeof h.text === 'string') {
    return { kind: 'user', id, text: h.text, ts: 0, uuid: h.uuid };
  }
  if (h.kind === 'text' && typeof h.text === 'string') {
    return { kind: 'text', id, index: -1, text: h.text, done: true, ts: 0 };
  }
  if (h.kind === 'thinking' && typeof h.text === 'string') {
    return { kind: 'thinking', id, index: -1, text: h.text, done: true, ts: 0 };
  }
  if (h.kind === 'tool' && typeof h.toolUseId === 'string') {
    return {
      kind: 'tool', id, toolUseId: h.toolUseId, name: h.name ?? '', input: h.input,
      status: h.status === 'error' ? 'error' : 'done', startedAt: 0, endedAt: 0, result: h.result,
    };
  }
  return null;
}

function usageLine(usage: SubAgentRun['usage']): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.totalTokens != null) parts.push(`${usage.totalTokens} tokens`);
  if (usage.toolUses != null) parts.push(`${usage.toolUses} tool uses`);
  if (usage.durationMs != null) parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  return parts.length ? parts.join(' · ') : null;
}

function SubAgentSlideOver({ run, conversationId, onClose }: SlideOverSubAgentProps) {
  const [state, setState] = useState<{ loading: boolean; items: ChatItem[] }>({ loading: true, items: [] });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, items: [] });
    api.get<{ items: DrillInHistoryEntry[] }>(
      `/agent/chat-history?claudeId=${encodeURIComponent(conversationId)}&subagent=${encodeURIComponent(run.taskId)}`,
    )
      .then((r) => {
        if (cancelled) return;
        const items = (Array.isArray(r?.items) ? r.items : []).map(toChatItem).filter((x): x is ChatItem => !!x);
        setState({ loading: false, items });
      })
      .catch(() => { if (!cancelled) setState({ loading: false, items: [] }); });
    return () => { cancelled = true; };
    // Refetch when the run's lifecycle advances (e.g. task-updated/task-notification
    // landed after the drill-in was already open) or a different run is opened.
  }, [conversationId, run.taskId, run.status, run.endedAt]);

  const usage = usageLine(run.usage);

  return (
    <>
      <div className="chat-slideover-head">
        <div className="chat-slideover-head-text">
          <button type="button" className="chat-slideover-breadcrumb" onClick={onClose}>
            <span aria-hidden>←</span> Main chat <span aria-hidden>▸</span> {run.name}
          </button>
          <span className="chat-slideover-subagent-meta">
            {run.subagentType && <span className="chat-slideover-subagent-badge">{run.subagentType}</span>}
            <span className="chat-slideover-subagent-status" data-status={run.status}>{run.status}</span>
          </span>
        </div>
        <button type="button" className="chat-slideover-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="chat-slideover-body">
        {state.loading && <p className="chat-slideover-status">Loading transcript…</p>}
        {!state.loading && state.items.length > 0 && (
          <div className="chat-slideover-transcript">
            {state.items.map((item) => (
              <ItemView key={item.id} item={item} onOpenFile={() => {}} readOnly />
            ))}
          </div>
        )}
        {!state.loading && state.items.length === 0 && (
          <div className="chat-slideover-fallback">
            <p className="chat-slideover-status">
              This sub-agent's transcript hasn't flushed to disk yet — showing what's known so far.
            </p>
            {run.prompt && (
              <div className="chat-toolcard-section">
                <span className="chat-toolcard-label">Prompt</span>
                <pre>{run.prompt}</pre>
              </div>
            )}
            {run.summary && (
              <div className="chat-toolcard-section">
                <span className="chat-toolcard-label">Summary</span>
                <pre>{run.summary}</pre>
              </div>
            )}
            {run.resultContent !== undefined && (
              <div className="chat-toolcard-section">
                <span className="chat-toolcard-label">Result</span>
                <pre>{(() => { try { return JSON.stringify(run.resultContent, null, 2); } catch { return String(run.resultContent); } })()}</pre>
              </div>
            )}
            {usage && <p className="chat-slideover-usage">{usage}</p>}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────────────────

export function SlideOver(props: SlideOverProps) {
  return (
    <div className="chat-slideover-scrim" onClick={props.onClose}>
      <div className="chat-slideover-panel" onClick={(e) => e.stopPropagation()}>
        {props.mode === 'file' ? <FileSlideOver {...props} /> : <SubAgentSlideOver {...props} />}
      </div>
    </div>
  );
}
