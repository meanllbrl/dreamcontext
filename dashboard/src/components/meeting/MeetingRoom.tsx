import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useMeetingRoom,
  type MeetingMessage,
  type MeetingParticipant,
  type MeetingThread,
} from '../../hooks/useMeetingRoom';
import { MarkdownPreview } from '../core/MarkdownPreview';
import './meetingRoom.css';

/**
 * THE MEETING ROOM — the hidden all-agents surface behind the launcher's core
 * logo. One Slack-like thread at a time: the user posts an announcement, every
 * project's agent wakes headless in its own directory and replies or PASSes,
 * and agents may pull each other in with an @mention (bounded server-side).
 *
 * Deliberately a THIN feed + composer, not the chat's Composer/ItemView: those
 * mount on a live ChatSession, and the room has no session — a post is a store
 * write and replies arrive by polling (see the task's Constraints). What IS
 * reused: the chat markdown pipeline (`MarkdownPreview`, over markdownBlocks)
 * for every message body, and the design tokens for every color and measure.
 */

interface Props {
  onClose: () => void;
}

/** Sentinel selection: the composer starts a NEW announcement. */
const NEW_THREAD = '__new__';

export function MeetingRoom({ onClose }: Props) {
  const { state, error, busy, post, reply, fetchThread } = useMeetingRoom(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archived, setArchived] = useState<MeetingThread | null>(null);
  const [draft, setDraft] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);

  const active = state?.active ?? null;
  // Default selection: the active thread, else the newest archived one. The
  // sentinel NEW_THREAD is the composer's "start fresh" mode — no thread shown,
  // posting archives the active one (the store's invariant does the archiving).
  const composingNew = selectedId === NEW_THREAD;
  const effectiveId = composingNew ? null : selectedId ?? active?.id ?? state?.threads[0]?.id ?? null;
  const viewingActive = active !== null && effectiveId === active.id;
  const thread: MeetingThread | null = viewingActive ? active : archived;

  // An archived selection is fetched once; the active thread rides the poll.
  useEffect(() => {
    if (viewingActive || !effectiveId) {
      setArchived(null);
      return;
    }
    let stale = false;
    void fetchThread(effectiveId).then((t) => { if (!stale) setArchived(t); });
    return () => { stale = true; };
  }, [effectiveId, viewingActive, fetchThread]);

  // Keep the feed pinned to the latest message as replies land.
  const messageCount = thread?.messages.length ?? 0;
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, effectiveId]);

  const send = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    if (viewingActive) {
      await reply(body);
    } else {
      const t = await post(body);
      if (t) setSelectedId(t.id);
    }
    setDraft('');
  };

  return (
    <div className="meeting-overlay" data-no-drag>
      <div className="meeting-room" role="dialog" aria-label="Meeting room">
        <aside className="meeting-rail">
          <div className="meeting-rail-head">
            <span className="meeting-rail-title">Meeting Room</span>
            <span className="meeting-rail-sub">every agent, one thread</span>
          </div>
          <button
            type="button"
            className="meeting-rail-new"
            onClick={() => setSelectedId(NEW_THREAD)}
          >
            + New announcement
          </button>
          <div className="meeting-rail-list">
            {(state?.threads ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`meeting-rail-item${t.id === effectiveId ? ' is-selected' : ''}${t.closedAt === null ? ' is-active' : ''}`}
                onClick={() => setSelectedId(t.id)}
              >
                <span className="meeting-rail-item-title">{t.title || 'Untitled'}</span>
                <span className="meeting-rail-item-date">
                  {t.closedAt === null ? 'active' : formatDate(t.createdAt)}
                </span>
              </button>
            ))}
            {(state?.threads ?? []).length === 0 && (
              <div className="meeting-rail-empty">No meetings yet.</div>
            )}
          </div>
        </aside>

        <section className="meeting-main">
          <header className="meeting-head">
            <div className="meeting-head-title">
              {thread ? thread.title || 'Untitled' : 'Convene your agents'}
            </div>
            <button type="button" className="meeting-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </header>

          {thread && <PresenceStrip participants={thread.participants} />}

          <div className="meeting-feed" ref={feedRef}>
            {!thread && (
              <div className="meeting-empty">
                Post an announcement below — every project's agent wakes up in its own
                directory, answers from its own brain, or passes.
              </div>
            )}
            {thread?.messages.map((m) => <Message key={m.id} message={m} />)}
          </div>

          {error && <div className="meeting-error">{error}</div>}

          <Composer
            key={viewingActive ? 'reply' : 'post'}
            roster={(state?.roster ?? []).map((r) => r.name)}
            draft={draft}
            setDraft={setDraft}
            disabled={busy}
            placeholder={
              viewingActive
                ? 'Reply — @Name to address one agent'
                : 'New announcement — this archives the previous thread'
            }
            onSend={() => void send()}
          />
        </section>
      </div>
    </div>
  );
}

// ─── Presence ─────────────────────────────────────────────────────────────────

function PresenceStrip({ participants }: { participants: MeetingParticipant[] }) {
  return (
    <div className="meeting-presence">
      {participants.map((p) => (
        <span
          key={p.name}
          className={`meeting-presence-chip state-${p.state}`}
          title={p.state === 'error' ? `${p.name}: ${p.error ?? 'failed'}` : p.whatItIs || p.name}
        >
          <span className="meeting-presence-dot" aria-hidden="true" />
          <span className="meeting-presence-name">{p.name}</span>
          <span className="meeting-presence-state">{stateLabel(p.state)}</span>
        </span>
      ))}
    </div>
  );
}

function stateLabel(state: MeetingParticipant['state']): string {
  switch (state) {
    case 'thinking': return 'thinking…';
    case 'replied': return 'replied';
    case 'passed': return 'passed';
    case 'error': return 'error';
    default: return '';
  }
}

// ─── Messages ─────────────────────────────────────────────────────────────────

function Message({ message }: { message: MeetingMessage }) {
  if (message.authorKind === 'system') {
    return <div className="meeting-msg-system">{message.body}</div>;
  }
  const label = message.authorKind === 'user' ? 'you' : message.author;
  return (
    <div className={`meeting-msg${message.root ? ' is-root' : ''} kind-${message.authorKind}`}>
      <div className="meeting-msg-head">
        <span className="meeting-msg-author">{label}</span>
        <span className="meeting-msg-time">{formatTime(message.createdAt)}</span>
      </div>
      <div className="meeting-msg-body">
        <MarkdownPreview content={message.body} />
      </div>
    </div>
  );
}

// ─── Composer (thin, with the roster-driven @ menu) ───────────────────────────

interface ComposerProps {
  roster: string[];
  draft: string;
  setDraft: (v: string) => void;
  disabled: boolean;
  placeholder: string;
  onSend: () => void;
}

/** The active `@token` under the caret, or null. Opens on `@` at a word start. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const at = text.lastIndexOf('@', caret - 1);
  if (at === -1) return null;
  if (at > 0 && /[\p{L}\p{N}_]/u.test(text[at - 1])) return null; // glued: an email
  const between = text.slice(at + 1, caret);
  if (between.includes('\n')) return null;
  return { start: at, query: between };
}

function Composer({ roster, draft, setDraft, disabled, placeholder, onSend }: ComposerProps) {
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Caret to apply after a mention insert — in the SAME commit the new value
   *  lands, not a frame later: an rAF loses the race against fast typing and
   *  splices the next keystrokes into the middle of the inserted name. */
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    const el = inputRef.current;
    if (pos === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [draft]);

  const mention = menuClosed ? null : mentionQuery(draft, caret);
  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return roster.filter((n) => n.toLowerCase().startsWith(q));
  }, [mention, roster]);
  const menuOpen = mention !== null && matches.length > 0;

  const insertMention = (name: string) => {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    const next = `${before}@${name} ${after}`;
    setDraft(next);
    setMenuClosed(true);
    pendingCaret.current = before.length + name.length + 2;
  };

  return (
    <div className="meeting-composer">
      {menuOpen && (
        <div className="meeting-mention-menu" role="listbox">
          {matches.map((name, i) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={i === menuIndex}
              className={`meeting-mention-item${i === menuIndex ? ' is-focused' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); insertMention(name); }}
            >
              @{name}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="meeting-input"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setMenuClosed(false);
          setMenuIndex(0);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (menuOpen) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIndex((i) => (i + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIndex((i) => (i + matches.length - 1) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(matches[menuIndex]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setMenuClosed(true); return; }
          }
          // Enter posts; Shift+Enter is a newline (announcements are multiline).
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        }}
      />
      <button
        type="button"
        className="meeting-send"
        disabled={disabled || !draft.trim()}
        onClick={onSend}
      >
        Post
      </button>
    </div>
  );
}

// ─── Small formatters ─────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
