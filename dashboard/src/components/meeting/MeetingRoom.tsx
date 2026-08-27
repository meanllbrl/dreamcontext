import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useMeetingRoom,
  type MeetingMessage,
  type MeetingParticipant,
  type MeetingThread,
} from '../../hooks/useMeetingRoom';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import {
  initAgentSettingsFromServer, patchAgentSettings, readAgentSettings,
} from '../../lib/agentSettings';
import { startTitleBarDrag } from '../../lib/desktop';
import { ItemView } from '../sleepy/chat/TranscriptItem';
import { Composer } from '../sleepy/chat/Composer';
import { meetingChatItem, rosterMention, useMeetingComposerHost } from './meetingHost';
// The chat's own three stylesheets, in the order ChatPane imports them. `ChatPane.css` is
// here for its TOKENS, not its shell: `--chat-text`, `--chat-lh`, `--chat-line-width` and
// `--chat-card-width` are declared on `.chat-pane` and read by `cards.css`, so a transcript
// rendered without them would set its prose at the app's UI size instead of the chat's
// reading size. meetingRoom.css loads last and overrides the one shell rule that does not
// transfer (see `.meeting-main.chat-pane`).
import '../sleepy/ChatPane.css';
import '../sleepy/chat/cards.css';
import '../sleepy/chat/composer.css';
import './meetingRoom.css';

/**
 * THE MEETING ROOM — the machine-wide all-agents surface, in its OWN window.
 *
 * One thread at a time: the user posts an announcement, every project's agent wakes headless
 * in its own directory and replies or PASSes, and agents may pull each other in with an
 * @mention (bounded server-side, one answer per agent per round).
 *
 * ── IT IS A CHAT, SO IT IS BUILT OUT OF THE CHAT ────────────────────────────────────
 * The feed is `ItemView` and the composer is `Composer` — the same two components the chat
 * pane and the peer-session panel render. This REPLACED the room's own thin feed and its
 * textarea-plus-Post box, which is the version that shipped and the reason for the change:
 * a hand-rolled composer meant a second mention parser, a second keyboard handler, a second
 * caret-restore trick, no prompt history, no auto-grow, no drag handle, no model control —
 * every one of them a thing to get right twice and to drift the moment the real one moved.
 * `PeerSessionCard` had already made this argument for a session in another project; the
 * room is the case with no session at all, which is what `composerHost.ts` exists for.
 *
 * What the room still owns is what only the room has: the thread rail, the presence strip,
 * and the mapping from a polled thread to transcript items (`meetingHost.ts`).
 *
 * ── A WINDOW, NOT A MODAL ───────────────────────────────────────────────────────────
 * It was an overlay over the launcher. A modal is wrong for a surface you leave running for
 * ten minutes while N agents think: dismissing it to look at anything — including the very
 * projects it is talking to — was the only way to use the app. `openMeetingWindow` gives it
 * a real window, at a real size, with the app's header as its title bar.
 *
 * ── MODEL AND EFFORT ARE GLOBAL HERE, AND THAT IS THE HONEST SCOPE ──────────────────
 * The room has no session to scope a model to: one post wakes N projects. So the control
 * writes `chatDefaultModel` / `chatDefaultEffort` — the app-global blob every project window
 * already shares (`~/.dreamcontext/agent-ui.json`) — and the server reads it back per run
 * (`readAgentUiChatDefaults` → every `claude -p` the room spawns). One pick, every project.
 * That is why the model menu offers no "Set as default": the pick already IS the default.
 */

/** Sentinel selection: the composer starts a NEW announcement. */
const NEW_THREAD = '__new__';

export function MeetingRoom() {
  const { state, error, busy, post, reply, fetchThread } = useMeetingRoom(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archived, setArchived] = useState<MeetingThread | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const active = state?.active ?? null;
  // Default selection: the active thread, else the newest archived one. The sentinel
  // NEW_THREAD is the composer's "start fresh" mode — no thread shown, and posting archives
  // the active one (the store's one-active invariant does the archiving).
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

  // ── Model + effort: the app-global pick, seeded from the server ──────────────────
  // Seeded rather than read straight from localStorage because this window can be the FIRST
  // one opened on a fresh launch origin, where localStorage is empty and a bare read would
  // report "nothing pinned" over a model the user chose weeks ago.
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [model, setModel] = useState(() => readAgentSettings().chatDefaultModel);
  const [effort, setEffort] = useState(() => readAgentSettings().chatDefaultEffort);
  useEffect(() => {
    let alive = true;
    void initAgentSettingsFromServer().then((cfg) => {
      if (!alive) return;
      setModel(cfg.chatDefaultModel);
      setEffort(cfg.chatDefaultEffort);
    });
    return () => { alive = false; };
  }, []);

  // ── The composer's host ─────────────────────────────────────────────────────────
  const items = (thread?.messages ?? [])
    .map((m, i) => meetingChatItem(m, i))
    .filter((it): it is NonNullable<typeof it> => it !== null);

  // The text arrives ALREADY assembled by the composer — quote prefix, attachment paths and
  // all — so there is nothing to fold in here. Which thread it lands in is this window's only
  // decision: into the active one as a reply, or as a new announcement that archives it.
  const send = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setNotice(null);
    if (viewingActive) {
      await reply(text);
    } else {
      const t = await post(text);
      if (t) setSelectedId(t.id);
    }
  }, [viewingActive, reply, post]);

  const { host, focusComposer } = useMeetingComposerHost(items, (text) => { void send(text); });

  // Selecting a thread hands the caret back to the composer — the only reason this window
  // keeps the focus handle the composer registers.
  const selectThread = (id: string) => { setSelectedId(id); focusComposer(); };

  // `ItemView` is memoized on referentially-stable callbacks (see its header), so both of
  // these are `useCallback`ed even though one does nothing.
  const onQuote = useCallback((text: string) => setQuote(text), []);
  // The room has no project to resolve a path against — `/api/agent/file` and `/reveal` are
  // vault-scoped, and there is no vault here. So an agent's answer that names a file is text
  // in this window, deliberately: a click that 400s against a vault that does not exist would
  // be worse than one that does nothing.
  const onOpenFile = useCallback(() => {}, []);

  const roster = state?.roster ?? [];

  return (
    <div className="meeting-window">
      {/* No `data-tauri-drag-region` — this window is created with `dragDropEnabled: false`,
          which also disables Tauri's built-in drag handler, so the drag is the same manual
          4px-threshold gesture the vault Header and the checklist window use. */}
      <div className="meeting-titlebar" onMouseDown={startTitleBarDrag}>
        <span className="meeting-titlebar-title">Meeting Room</span>
        <span className="meeting-titlebar-sub">every agent, one thread</span>
      </div>

      <div className="meeting-body">
        <aside className="meeting-rail">
          <button
            type="button"
            className="meeting-rail-new"
            onClick={() => selectThread(NEW_THREAD)}
          >
            + New announcement
          </button>
          <div className="meeting-rail-list">
            {(state?.threads ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`meeting-rail-item${t.id === effectiveId ? ' is-selected' : ''}${t.closedAt === null ? ' is-active' : ''}`}
                onClick={() => selectThread(t.id)}
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

        {/* `chat-pane` is not decoration: `composerHeight.ts` finds the pane whose half-height
            is the auto-grow ceiling with `closest('.chat-pane')`, so this column wearing the
            class is what makes the composer grow to half the CONVERSATION rather than half the
            viewport. One class instead of a second sizing rule. */}
        <section className="meeting-main chat-pane">
          <header className="meeting-head">
            <div className="meeting-head-title">
              {thread ? thread.title || 'Untitled' : 'Convene your agents'}
            </div>
          </header>

          {thread && <PresenceStrip participants={thread.participants} />}

          <div className="meeting-feed" ref={feedRef}>
            {!thread && (
              <div className="meeting-empty">
                Post an announcement below — every project's agent wakes up in its own
                directory, answers from its own brain, or passes.
              </div>
            )}
            {thread?.messages.map((m, i) => (
              <MessageRow key={m.id} message={m} index={i} onQuote={onQuote} onOpenFile={onOpenFile} />
            ))}
          </div>

          {(error || notice) && <div className="meeting-error">{error ?? notice}</div>}

          <Composer
            session={host}
            model={model}
            effort={effort}
            modelConfig={modelConfig}
            // Written straight to the app-global blob, which is the room's whole scope — see
            // the header. Local state moves too so the trigger reads the new value at once
            // rather than waiting for a settings round-trip.
            onModelChange={(id) => { setModel(id); patchAgentSettings({ chatDefaultModel: id }); }}
            onEffortChange={(lvl) => { setEffort(lvl); patchAgentSettings({ chatDefaultEffort: lvl }); }}
            modelScope="global"
            // FALSE on purpose, even while agents think. `busy` means "a turn is running and ⏎
            // steers into it" — there is no turn here, and a reply posted while three agents
            // are thinking is a normal, useful act (it wakes the engaged set). Who is working
            // is the presence strip's job, which says it per agent instead of once for all.
            busy={false}
            // Until the first poll lands there is genuinely nothing to post into.
            connected={state !== null && !busy}
            quote={quote}
            onClearQuote={() => setQuote(null)}
            // Every registered project is addressable here — the room's roster, which no
            // per-vault peer endpoint can answer for. No `onPeerMessage`: `@Name` is TEXT in
            // this window and the server routes the delivery.
            mentions={roster.map(rosterMention)}
            idlePlaceholder={
              viewingActive
                ? 'Reply to the room…   ·   "@" to address one project'
                : 'New announcement — archives the previous thread   ·   "@" to address one project'
            }
            onSignIn={() => setNotice(
              'Signing in belongs to a project session — open a project window and run /login there.',
            )}
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

// ─── One message ──────────────────────────────────────────────────────────────

/**
 * The author line the chat has no need for, plus the chat's own renderer underneath.
 *
 * `AssistantMessage` is deliberately faceless in a two-party conversation (hard rule 1 of the
 * chat design: full-width, no avatar). In a room of eight projects, WHICH agent is speaking is
 * the single most load-bearing fact on screen — so the name goes above the block rather than
 * into it, and `ItemView` renders the body exactly as it does everywhere else.
 */
function MessageRow({
  message, index, onQuote, onOpenFile,
}: {
  message: MeetingMessage;
  index: number;
  onQuote: (text: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (message.authorKind === 'system') {
    return <div className="meeting-msg-system">{message.body}</div>;
  }
  const item = meetingChatItem(message, index);
  if (!item) return null;
  // `is-root` carries no styling of its own any more (the announcement is the first message,
  // and the rail already titles the thread after it) — it stays as the DOM marker, and as the
  // hook a later treatment would use.
  return (
    <div className={`meeting-msg${message.root ? ' is-root' : ''} kind-${message.authorKind}`}>
      {message.authorKind === 'agent' && (
        <div className="meeting-msg-head">
          <span className="meeting-msg-author">{message.author}</span>
          <span className="meeting-msg-time">{formatTime(message.createdAt)}</span>
        </div>
      )}
      {/* No `session`: nothing in this window can rewind or retry a headless run, so the
          hover bar reduces itself to Copy and Quote-reply — the two that mutate nothing. */}
      <ItemView item={item} onQuote={onQuote} onOpenFile={onOpenFile} />
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
