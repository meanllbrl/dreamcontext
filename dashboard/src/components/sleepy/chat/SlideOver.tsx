import { Component, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { agentFileUrl, peerLogoUrl } from '../../../api/client';
import { useApi, useVault } from '../../../context/VaultContext';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { ItemView } from './TranscriptItem';
import {
  inlineMediaKind, joinChildPath, formatEntrySize, dirTruncationNote,
  isHeadlessAgentShell,
  type Reference, type SubAgentRun,
} from './chatEntities';
import { peerForAgent, type PeerMention } from '../../../lib/agentComposer';
import { FileActions } from './FileActions';
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
  /** Open another path from inside this panel — a row of a folder's listing. Routed through
   *  the pane's own `handleOpenFile`, so a subfolder re-enters here and a file/image/board
   *  lands wherever that path would have landed from the transcript. */
  onOpenPath?: (path: string) => void;
}
export interface SlideOverSubAgentProps {
  mode: 'subagent';
  run: SubAgentRun;
  conversationId: string;
  /** Connected peers — a `peer-<vault>` envoy drill-in wears that vault's logo and name in
   *  its header instead of the raw generated agent slug. */
  peers?: PeerMention[];
  onClose: () => void;
  onNavApp: (page: 'tasks' | 'knowledge' | 'core', id: string) => void;
}
export interface SlideOverShellProps {
  mode: 'shell';
  run: SubAgentRun;
  conversationId: string;
  onStop: (run: SubAgentRun) => void;
  onClose: () => void;
  onNavApp: (page: 'tasks' | 'knowledge' | 'core', id: string) => void;
}
export type SlideOverProps = SlideOverFileProps | SlideOverSubAgentProps | SlideOverShellProps;

// ─── File mode ──────────────────────────────────────────────────────────────────────

/**
 * What `GET /api/agent/file` actually answers with. The `dir` arm is not an edge case: the
 * route has always answered a folder with its listing ("a folder named in the transcript is
 * something to look inside"), and this panel used to model only the text arms — so a folder
 * reached `NumberedText` with `content: undefined`, threw during render, and took the whole
 * chat view down with it (issue #236 — reported as a WebContent crash; it was an uncaught
 * render throw, which looks identical from the host side).
 */
interface DirEntry { name: string; kind: 'dir' | 'file'; size: number | null }
type FileContent =
  | { path: string; type: 'text' | 'markdown'; content: string }
  | { path: string; type: 'dir'; entries: DirEntry[]; truncated?: boolean; total?: number };

function NumberedText({ content }: { content: string }) {
  // Defensive on purpose: this component renders whatever a network payload said it was, and
  // a render throw here is not a broken preview, it is a blank conversation.
  if (typeof content !== 'string') return <p className="chat-slideover-status">Nothing to show.</p>;
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

/**
 * The file itself, playing or drawn, at the panel's full width. Bytes come from the raw
 * endpoint (range-streamed), so a clip seeks and a 40MB capture is never buffered whole.
 *
 * `onError` is the only honest failure story a media element gives us — no status code, no
 * reason — so the message names what to do next rather than guessing why. A file OUTSIDE
 * the project root is the common case and needs consent; the transcript's own inline card
 * is where that consent is asked, so this points back at it instead of duplicating it.
 */
function MediaPreview({ path, kind }: { path: string; kind: 'image' | 'video' | 'audio' }) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  const src = agentFileUrl(vault, path, { raw: true });
  if (failed) {
    return (
      <p className="chat-slideover-status error">
        Couldn't play this file — it may live outside the project (allow it from the card in
        the chat), or be in a format this window can't decode.
      </p>
    );
  }
  if (kind === 'video') {
    return <video className="chat-slideover-media" src={src} controls preload="metadata" onError={() => setFailed(true)} />;
  }
  if (kind === 'audio') {
    return <audio className="chat-slideover-media" src={src} controls preload="metadata" onError={() => setFailed(true)} />;
  }
  return <img className="chat-slideover-media" src={src} alt={path} onError={() => setFailed(true)} />;
}

/**
 * A folder, looked inside. Rows are the server's own order (folders first, then files by
 * name) and each one opens: a subfolder re-enters this panel on its listing, a file opens
 * exactly as a path chip in the transcript would. That is the whole point of clicking a
 * folder chip — the alternative was a dead end, and briefly a blank conversation.
 */
function DirListing({
  path, entries, truncated, total, onOpenPath,
}: {
  path: string;
  entries: DirEntry[];
  truncated?: boolean;
  total?: number;
  onOpenPath?: (path: string) => void;
}) {
  const rows = Array.isArray(entries) ? entries : [];
  const note = dirTruncationNote(rows.length, total, truncated);
  if (!rows.length) return <p className="chat-slideover-status">This folder is empty.</p>;
  return (
    <div className="chat-slideover-dir">
      {rows.map((e) => (
        <button
          type="button"
          key={e.name}
          className="chat-slideover-direntry"
          data-kind={e.kind}
          onClick={() => onOpenPath?.(joinChildPath(path, e.name))}
          title={joinChildPath(path, e.name)}
        >
          <span className="chat-slideover-dirglyph" aria-hidden>{e.kind === 'dir' ? '📁' : '📄'}</span>
          <span className="chat-slideover-dirname">{e.name}</span>
          <span className="chat-slideover-dirsize">{e.kind === 'dir' ? '' : formatEntrySize(e.size)}</span>
        </button>
      ))}
      {note && <p className="chat-slideover-status">{note}</p>}
    </div>
  );
}

function FileSlideOver({ path, reference, onClose, onNavApp, onOpenPath }: SlideOverFileProps) {
  const api = useApi();
  const [state, setState] = useState<{ loading: boolean; data: FileContent | null; error: string | null }>(
    { loading: true, data: null, error: null },
  );
  // A clip PLAYS here and a picture is SHOWN here. Asking the text endpoint for a 44-second
  // video answered "File exceeds the preview size cap" — technically true of the JSON text
  // preview, useless as an answer to "open the reel" (owner report 07-25). Media never goes
  // through that branch: it streams from the raw endpoint, with byte ranges, so it seeks.
  const mediaKind = inlineMediaKind(path);

  useEffect(() => {
    if (mediaKind) return;
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    api.get<FileContent>(`/agent/file?path=${encodeURIComponent(path)}`)
      .then((data) => { if (!cancelled) setState({ loading: false, data, error: null }); })
      .catch((err: Error) => { if (!cancelled) setState({ loading: false, data: null, error: err.message || 'Failed to load file.' }); });
    return () => { cancelled = true; };
  }, [api, path, mediaKind]);

  return (
    <>
      <div className="chat-slideover-head">
        <div className="chat-slideover-head-text">
          <span className="chat-slideover-name">{reference.label}</span>
          <span className="chat-slideover-path">{path}</span>
        </div>
        <button type="button" className="chat-slideover-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {/* Every file, not just a folder. The panel used to offer the OS only for a DIRECTORY,
          which left the common case — a file whose preview isn't enough, or that this window
          can't render at all — with the path in the header and no way to reach it. `FileActions`
          carries both doors (open in the default app / show me where it is) plus Copy path, and
          says so when the OS refuses instead of swallowing it (owner report 07-28). */}
      <FileActions
        path={path}
        className="chat-slideover-actions"
        extra={reference.appNav && (
          <button
            type="button"
            className="chat-btn"
            onClick={() => { onNavApp(reference.appNav!.page, reference.appNav!.id); onClose(); }}
          >Open in app <span aria-hidden>↗</span></button>
        )}
      />
      <div className="chat-slideover-body" data-media={mediaKind ?? undefined}>
        {mediaKind ? (
          <MediaPreview path={path} kind={mediaKind} />
        ) : (
          <>
            {state.loading && <p className="chat-slideover-status">Loading…</p>}
            {state.error && <p className="chat-slideover-status error">Couldn't load this file — {state.error}</p>}
            {state.data?.type === 'dir' && (
              <DirListing
                path={path}
                entries={state.data.entries}
                truncated={state.data.truncated}
                total={state.data.total}
                onOpenPath={onOpenPath}
              />
            )}
            {state.data?.type === 'markdown' && <MarkdownPreview content={state.data.content} />}
            {state.data?.type === 'text' && <NumberedText content={state.data.content} />}
          </>
        )}
      </div>
    </>
  );
}

// ─── Jump to latest (shared by the drill-in panels and the peer session panel) ──────

/**
 * Tracks whether a scrolling body has been left ABOVE its bottom edge, and hands back a
 * one-click way down. The panels open a transcript at its top (reading order), but what
 * the user is usually waiting on is at the END — so the way down must be atomic, not a
 * scroll gesture through twenty minutes of tool calls.
 *
 * `watch` re-measures when content lands or grows: a body that was "at the bottom" stops
 * being at the bottom the moment a streaming run appends below it, and only the content
 * arrays know when that happened.
 */
export function useJumpToLatest(
  ref: RefObject<HTMLDivElement | null>,
  watch: ReadonlyArray<unknown>,
): { away: boolean; jump: () => void } {
  const [away, setAway] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    return () => el.removeEventListener('scroll', measure);
    // `watch` spread: the caller names what makes the body grow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, measure, ...watch]);

  const jump = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [ref]);

  return { away, jump };
}

/**
 * The pill itself — the transcript's own "↓ Latest" affordance, inside a panel. Rendered as
 * the LAST child of the scrolling body and stuck to its visible bottom edge: sticky needs no
 * knowledge of what sits under the panel (the peer panel has a whole composer there), where
 * an absolutely-anchored pill would need a per-panel offset.
 */
export function JumpToLatest({ away, jump }: { away: boolean; jump: () => void }) {
  if (!away) return null;
  return (
    <button type="button" className="chat-slideover-jump" onClick={jump}>
      <span aria-hidden>↓</span> Latest
    </button>
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

function SubAgentSlideOver({ run, conversationId, peers = [], onClose }: SlideOverSubAgentProps) {
  const api = useApi();
  const { vault } = useVault();
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
  }, [api, conversationId, run.taskId, run.status, run.endedAt]);

  const usage = usageLine(run.usage);
  // The drill-in wears the PEER's identity when the run is an envoy: the vault's logo next
  // to the breadcrumb and its name on the badge, instead of the generated `peer-<slug>`.
  const peer = peerForAgent(run.subagentType, peers);
  const logoSrc = peer?.logo ? peerLogoUrl(vault, peer.vault) : null;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { away, jump } = useJumpToLatest(bodyRef, [state.items.length, state.loading]);

  return (
    <>
      <div className="chat-slideover-head">
        <div className="chat-slideover-head-text">
          <button type="button" className="chat-slideover-breadcrumb" onClick={onClose}>
            <span aria-hidden>←</span> Main chat <span aria-hidden>▸</span>
            {logoSrc && <img className="chat-slideover-peer-logo" src={logoSrc} alt="" aria-hidden />}
            {' '}{run.name}
          </button>
          <span className="chat-slideover-subagent-meta">
            {peer
              ? <span className="chat-slideover-subagent-badge" data-peer="1"><span aria-hidden>◈</span> {peer.vault}</span>
              : run.subagentType && <span className="chat-slideover-subagent-badge">{run.subagentType}</span>}
            <span className="chat-slideover-subagent-status" data-status={run.status}>{run.status}</span>
          </span>
        </div>
        <button type="button" className="chat-slideover-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="chat-slideover-body" ref={bodyRef}>
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
        <JumpToLatest away={away} jump={jump} />
      </div>
    </>
  );
}

// ─── Background-shell mode ──────────────────────────────────────────────────────────
//
// The live output of a `run_in_background` Bash, read straight off the CLI's own task-output
// file via `GET /api/agent/bg-output` (server-derived path). This is the whole point of the
// route: reading a background shell costs ZERO model tokens and works while the session is
// mid-turn, where asking the agent to run `TaskOutput` would cost a turn and have to wait.

/** Poll cadence while the shell is still running. Slow enough to be free (a tail-read of a
 *  local file), fast enough that `npm test` scrolling by feels live. */
const SHELL_POLL_MS = 1200;

function ShellSlideOver({ run, conversationId, onStop, onClose }: SlideOverShellProps) {
  const api = useApi();
  const [state, setState] = useState<{
    loading: boolean; content: string; truncated: boolean; exists: boolean; error: string | null;
  }>({ loading: true, content: '', truncated: false, exists: true, error: null });

  const isRunning = run.status === 'running';
  // Same panel, same route, different WORD: a headless `claude` run is a shell only in how it
  // was launched, and the user reached this panel from the agent card. Calling it a shell here
  // would contradict the row that opened it.
  const headless = isHeadlessAgentShell(run);
  const noun = headless ? 'run' : 'shell';

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { away, jump } = useJumpToLatest(bodyRef, [state.content.length, state.loading]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = () => {
      api.get<{ content: string; truncated: boolean; exists: boolean }>(
        `/agent/bg-output?claudeId=${encodeURIComponent(conversationId)}&taskId=${encodeURIComponent(run.taskId)}`,
      )
        .then((r) => {
          if (cancelled) return;
          setState({
            loading: false,
            content: typeof r?.content === 'string' ? r.content : '',
            truncated: !!r?.truncated,
            exists: r?.exists !== false,
            error: null,
          });
        })
        .catch((err: Error) => {
          if (!cancelled) {
            setState((s) => ({ ...s, loading: false, error: err.message || 'Failed to read output.' }));
          }
        })
        // Chain the next tick from the SETTLED request rather than an interval, so a slow read
        // can never stack overlapping polls. Keep polling for one extra beat after the run
        // ends is unnecessary — `run.status` is in the dep list, so the effect re-runs and
        // fetches the final tail exactly once when the status flips.
        .finally(() => {
          if (!cancelled && isRunning) timer = setTimeout(poll, SHELL_POLL_MS);
        });
    };
    poll();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [api, conversationId, run.taskId, isRunning, run.status]);

  return (
    <>
      <div className="chat-slideover-head">
        <div className="chat-slideover-head-text">
          <button type="button" className="chat-slideover-breadcrumb" onClick={onClose}>
            <span aria-hidden>←</span> Main chat <span aria-hidden>▸</span> {run.name}
          </button>
          <span className="chat-slideover-subagent-meta">
            <span className="chat-slideover-subagent-badge">{headless ? 'headless agent' : 'background shell'}</span>
            <span className="chat-slideover-subagent-status" data-status={run.status}>{run.status}</span>
          </span>
        </div>
        <button type="button" className="chat-slideover-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="chat-slideover-actions">
        {isRunning && (
          <button type="button" className="chat-btn danger" onClick={() => onStop(run)}>
            <span aria-hidden>■</span> Stop {noun}
          </button>
        )}
        <button
          type="button"
          className="chat-btn"
          onClick={() => { void navigator.clipboard?.writeText(state.content).catch(() => {}); }}
          disabled={!state.content}
        ><span aria-hidden>⧉</span> Copy output</button>
      </div>
      <div className="chat-slideover-body" ref={bodyRef}>
        {run.summary && <p className="chat-slideover-status">{run.summary}</p>}
        {state.truncated && (
          <p className="chat-slideover-status">Showing the tail of a large output — earlier lines are on disk.</p>
        )}
        {state.error && <p className="chat-slideover-status error">Couldn't read the output — {state.error}</p>}
        {state.loading && <p className="chat-slideover-status">Reading output…</p>}
        {!state.loading && !state.error && !state.content && (
          <p className="chat-slideover-status">
            {state.exists
              ? 'No output yet.'
              : isRunning
                ? `This ${noun} has not written anything yet.`
                : `This ${noun} produced no output.`}
          </p>
        )}
        {state.content && <pre className="chat-slideover-shellout">{state.content}</pre>}
        <JumpToLatest away={away} jump={jump} />
      </div>
    </>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────────────────

/**
 * A failure INSIDE the panel stays inside the panel.
 *
 * The class-lesson from issue #236: a preview render threw on a payload shape it didn't model
 * and, with no boundary between it and the conversation, React unmounted the tree — the whole
 * chat view went blank and looked to the reporter (reasonably) like a renderer crash. The
 * panel is a peripheral surface over a live conversation that may hold the only copy of an
 * hour's work; it may fail, but it may not take that with it. Closing is always offered,
 * because a stuck scrim over the transcript is its own dead end.
 */
class PanelBoundary extends Component<{ onClose: () => void; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  render() {
    if (this.state.error) {
      return (
        <>
          <div className="chat-slideover-head">
            <div className="chat-slideover-head-text">
              <span className="chat-slideover-name">Couldn't show this</span>
              <span className="chat-slideover-path">{this.state.error.message}</span>
            </div>
            <button type="button" className="chat-slideover-close" onClick={this.props.onClose} aria-label="Close">✕</button>
          </div>
          <div className="chat-slideover-body">
            <p className="chat-slideover-status error">
              The panel failed to render this. Your conversation is untouched — close this and carry on.
            </p>
          </div>
        </>
      );
    }
    return this.props.children;
  }
}

export function SlideOver(props: SlideOverProps) {
  return (
    <div className="chat-slideover-scrim" onClick={props.onClose}>
      <div className="chat-slideover-panel" onClick={(e) => e.stopPropagation()}>
        <PanelBoundary onClose={props.onClose}>
          {props.mode === 'file' && <FileSlideOver {...props} />}
          {props.mode === 'subagent' && <SubAgentSlideOver {...props} />}
          {props.mode === 'shell' && <ShellSlideOver {...props} />}
        </PanelBoundary>
      </div>
    </div>
  );
}
