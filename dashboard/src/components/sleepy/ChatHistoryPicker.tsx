import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { CommandModal, useListKeyboardNav } from '../search/CommandModal';
import './ChatHistoryPicker.css';

/**
 * "Past chats" — the picker that reopens a conversation you closed.
 *
 * Every Claude Code conversation this project has ever had is on disk and resumable
 * (`~/.claude/projects/<slug>/<id>.jsonl`), but until now the app could only reach the
 * ones still holding a tab: close a chat and it was gone. This lists them all, newest
 * first, searchable, and picking one is the resume path the surface already has — so a
 * chosen row comes back as a real tab with its transcript replayed above the composer.
 *
 * Search is SERVER-side (`GET /api/agent/chat-sessions?q=`), because the haystack it
 * matches — every prompt harvested from a session's head — is far too big to ship to the
 * client for a list view (see `lib/transcript-sessions.ts`). The index is memoized per
 * transcript, so the first open pays the scan and every keystroke after it is a filter
 * over warm memory.
 *
 * Rendered as a SIBLING of `.agent-surface`, never a child: the surface declares
 * `contain: layout paint`, which would make it the containing block for the modal's
 * `position: fixed` scrim and trap the popup inside the pane area.
 */

/** One past conversation, as `/api/agent/chat-sessions` returns it. */
export interface PastSession {
  id: string;
  title: string;
  preview: string;
  /** ms epoch — last write to the transcript. */
  updatedAt: number;
  startedAt: number | null;
  sizeBytes: number;
  gitBranch: string;
}

interface ChatHistoryResponse {
  sessions: PastSession[];
  total: number;
  /** Matching conversations the server withheld as machine-spawned agent runs. */
  agentRuns: number;
  truncated: boolean;
}

interface ChatHistoryPickerProps {
  open: boolean;
  onClose: () => void;
  /** Resume this conversation (or focus it, when it is one of `openIds`). */
  onPick: (session: PastSession) => void;
  /** Conversation UUIDs that already hold a tab — those rows say "open" and focus. */
  openIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows asked for in one listing — the route's own ceiling (`MAX_LIMIT`). Below it, a
 *  project with a few hundred conversations has rows that scrolling can never reach (only
 *  search); the list is plain buttons, so holding the lot costs nothing worth virtualizing.
 *  Anything beyond it is reported honestly by the footer's "N of M". */
const PAGE_LIMIT = 500;

/** The right-hand time label: precise while it still reads as "recent", a date after. */
function whenLabel(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The section a row falls under. Day-bucketed against LOCAL midnight rather than a
 * rolling 24h window, so a chat from 11pm last night reads as "Yesterday" at 8am and
 * not as "Today".
 */
function groupLabel(ms: number, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return 'Today';
  if (ms >= startOfToday - DAY_MS) return 'Yesterday';
  if (ms >= startOfToday - 7 * DAY_MS) return 'Previous 7 days';
  if (ms >= startOfToday - 30 * DAY_MS) return 'Previous 30 days';
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Transcript size as a rough "how long was this conversation" signal. */
function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ChatHistoryPicker({ open, onClose, onPick, openIds }: ChatHistoryPickerProps) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<ChatHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Show the sessions the app and the orchestration skills spawned for themselves (goal-skill
  // builders, the Sleep agent, scheduled automations, council personas). Off by default —
  // they outnumber real conversations several to one — and deliberately NOT remembered
  // across opens: the default view is the one worth landing on every time.
  const [showAgentRuns, setShowAgentRuns] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Monotonic request id — a slow response for an older query must never overwrite a
   *  newer one's results (typing fast outruns the fetches). */
  const reqRef = useRef(0);

  // One clock reading per open, so every row's "2h ago" is measured from the same
  // instant and no row re-renders just because the minute rolled over mid-scroll.
  const [now, setNow] = useState(() => Date.now());

  const openSet = useMemo(() => new Set(openIds), [openIds]);

  // Fetch on open and on every (debounced) query change. The debounce is short because
  // the server's index is memoized — after the first scan a query is a pass over memory.
  useEffect(() => {
    if (!open) return;
    const seq = ++reqRef.current;
    setLoading(true);
    const handle = setTimeout(() => {
      api.get<ChatHistoryResponse>(
        `/agent/chat-sessions?limit=${PAGE_LIMIT}&q=${encodeURIComponent(q.trim())}${showAgentRuns ? '&agentRuns=1' : ''}`,
      )
        .then((r) => {
          if (reqRef.current !== seq) return;
          setData(r);
          setFailed(false);
        })
        .catch(() => {
          if (reqRef.current !== seq) return;
          setFailed(true);
        })
        .finally(() => { if (reqRef.current === seq) setLoading(false); });
    }, q ? 140 : 0);
    return () => clearTimeout(handle);
  }, [open, q, showAgentRuns]);

  const sessions = data?.sessions ?? [];

  const activate = useCallback((i: number) => {
    const s = sessions[i];
    if (s) onPick(s);
  }, [sessions, onPick]);

  const { focused, setFocused, onKeyDown } = useListKeyboardNav({
    length: sessions.length,
    onEnter: activate,
  });

  // Keep the keyboard-focused row in view as ↑/↓ walk past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${focused}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  // Reset + focus on each open. The previous result set is dropped rather than shown
  // stale: a session that ran since the last open would otherwise sit under the wrong
  // day header with the wrong "ago".
  useEffect(() => {
    if (!open) return;
    setQ('');
    setFocused(0);
    setData(null);
    setFailed(false);
    setShowAgentRuns(false);
    setNow(Date.now());
    const raf = requestAnimationFrame(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } });
    return () => cancelAnimationFrame(raf);
  }, [open, setFocused]);

  const trimmed = q.trim();
  const hiddenRuns = data?.agentRuns ?? 0;

  return (
    <CommandModal id="chat-history" open={open} onClose={onClose} ariaLabel="Past chats" className="chp-modal">
      <div className="chp-input-row">
        <span className="chp-input-icon" aria-hidden="true">◷</span>
        <input
          ref={inputRef}
          className="chp-input"
          value={q}
          placeholder="Search past chats…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search past chats"
          onChange={(e) => { setQ(e.target.value); setFocused(0); }}
          onKeyDown={onKeyDown}
        />
        {loading && <span className="chp-spin" aria-hidden="true" />}
        <kbd className="chp-kbd">esc</kbd>
      </div>

      <div className="chp-list" role="listbox" aria-label="Past chats" ref={listRef}>
        {sessions.map((s, i) => {
          const isFocused = i === focused;
          const isOpen = openSet.has(s.id);
          // A group header is drawn only where the bucket CHANGES, and it is not a row —
          // list indices stay one-per-session so ↑/↓ never land on a heading.
          const label = groupLabel(s.updatedAt, now);
          const showHeader = i === 0 || groupLabel(sessions[i - 1].updatedAt, now) !== label;
          return (
            <div key={s.id} className="chp-group">
              {showHeader && <div className="chp-group-label">{label}</div>}
              <button
                type="button"
                role="option"
                aria-selected={isFocused}
                data-row-index={i}
                className={`chp-row${isFocused ? ' chp-row--focused' : ''}${isOpen ? ' chp-row--open' : ''}`}
                onClick={() => onPick(s)}
                onMouseEnter={() => setFocused(i)}
              >
                <span className="chp-row-glyph" aria-hidden="true">◆</span>
                <span className="chp-row-main">
                  <span className="chp-row-title">{s.title}</span>
                  {s.preview && <span className="chp-row-preview">{s.preview}</span>}
                </span>
                <span className="chp-row-meta">
                  <span className="chp-row-when">{whenLabel(s.updatedAt, now)}</span>
                  <span className="chp-row-facts">
                    {isOpen && <span className="chp-row-tag">open</span>}
                    {s.gitBranch && <span className="chp-row-branch" title={s.gitBranch}>{s.gitBranch}</span>}
                    <span className="chp-row-size">{sizeLabel(s.sizeBytes)}</span>
                  </span>
                </span>
              </button>
            </div>
          );
        })}

        {sessions.length === 0 && (
          <div className="chp-empty">
            {loading ? 'Reading your conversations…'
              : failed ? 'Could not read past chats.'
                : trimmed ? `No past chat matches “${trimmed}”.`
                  : showAgentRuns ? 'No past chats in this project yet.'
                    : hiddenRuns > 0
                      ? `Nothing here but ${hiddenRuns} agent run${hiddenRuns === 1 ? '' : 's'}.`
                      : 'No past chats in this project yet.'}
          </div>
        )}
      </div>

      <div className="chp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> resume</span>
        <span><kbd>esc</kbd> close</span>
        {/* What was filtered out is stated, never silently dropped — and it is one click to
            see it. The agent runs a project spawns for itself (goal-skill builders, the Sleep
            agent, scheduled automations, council personas) are not conversations anyone means
            to return to, but they ARE resumable, so hiding them can't be a one-way door. */}
        {(hiddenRuns > 0 || showAgentRuns) && (
          <button
            type="button"
            className="chp-foot-toggle"
            aria-pressed={showAgentRuns}
            onClick={() => { setShowAgentRuns((v) => !v); setFocused(0); }}
          >
            {showAgentRuns
              ? 'hide agent runs'
              : `${hiddenRuns} agent run${hiddenRuns === 1 ? '' : 's'} hidden — show`}
          </button>
        )}
        {data && data.total > 0 && (
          <span className="chp-foot-count">
            {data.sessions.length < data.total
              ? `${data.sessions.length} of ${data.total}`
              : `${data.total} conversation${data.total === 1 ? '' : 's'}`}
          </span>
        )}
      </div>
    </CommandModal>
  );
}
