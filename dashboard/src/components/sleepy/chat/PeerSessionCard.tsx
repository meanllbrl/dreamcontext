import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createChatSession, type ChatSession, type ChatItem } from '../chatSession';
import { useChrome } from '../../layout/WindowChrome';
import { useVault } from '../../../context/VaultContext';
import { peerLogoUrl } from '../../../api/client';
import { ItemView } from './TranscriptItem';
import { PermissionCard } from './PermissionCard';
import { Composer } from './Composer';
import { useJumpToLatest, JumpToLatest } from './SlideOver';
import type { ModelConfig, PeerMention } from '../../../lib/agentComposer';
import './peerSession.css';

/**
 * A LIVE SESSION IN ANOTHER PROJECT, reachable from this conversation.
 *
 * When a message is addressed to a peer (`@Tilki …`), it does not go to the local agent and
 * it does not go through the mailbox — it opens a real chat session rooted in the PEER's
 * directory (`/api/agent/chat?vault=<peer>`), the same socket the main pane uses. That is
 * what makes the peer answer with its own brain instead of this one guessing on its behalf.
 *
 * IT IS A CHAT, SO IT IS BUILT OUT OF THE CHAT. The panel renders `ItemView` for the
 * transcript, `PermissionCard` for a permission request, and the real `Composer` — the same
 * three components the main pane uses, on a different session object. Nothing here
 * re-implements a message bubble, an Allow/Deny pair, or a text box.
 *
 * That is not tidiness, it is the feature working. A hand-rolled composer means no `/`
 * menu, no attachments, no model/effort/mode triggers, no steer-into-the-running-turn, no
 * queue, no drafts — and a hand-rolled permission row means no command preview, no edit
 * diff, no "always allow". Every one of those would have to be rebuilt, worse, and would
 * drift the moment the real one changed. A peer session is a chat; it gets the chat.
 *
 * THE SHAPE, and why it is three components rather than one:
 *
 *   `PeerSessionHolder` owns the ChatSession and never unmounts while the session is alive.
 *   `PeerSessionRow`    is the MESSAGE — one compact docked line you click.
 *   `PeerSessionPanel`  is the side panel that opens on that click.
 *
 * The split is load-bearing. The session owns a WebSocket and a child process in another
 * project; if it lived inside the panel it would be DISPOSED every time the panel closed, so
 * closing the panel to glance at your own conversation would kill the peer's turn
 * mid-answer. The holder stays mounted and the panel is just a view of it.
 *
 * PERMISSIONS: opened with `bypass = false`, always. A peer session runs under `auto`, so
 * anything destructive stops and asks — and because the socket is two-way and the holder is
 * mounted, there is somebody here to ask. That is the difference between this and the CLI's
 * headless delivery, where a permission prompt has no one to answer it and the run reports
 * itself blocked instead.
 */

export interface PeerSessionChrome {
  modelConfig: ModelConfig;
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  onSignIn: () => void;
}

/** Assistant text, flattened — used only for the collapsed row's one-line preview. */
function answerText(items: ChatItem[]): string {
  return items
    .filter((i): i is Extract<ChatItem, { kind: 'text' }> => i.kind === 'text')
    .map((i) => i.text)
    .join('\n')
    .trim();
}

/** The tool the peer is running right now, for the one-line activity note. */
function currentTool(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'tool') return item.name ?? 'working';
  }
  return '';
}

/** The last line of the answer — what the collapsed row shows. */
function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export function PeerSessionHolder({
  peer,
  prompt,
  chrome,
  onClose,
}: {
  peer: PeerMention;
  /** The message that opens the session — submitted server-side at spawn. */
  prompt: string;
  /** The surrounding pane's model/effort wiring, so the peer's composer is a real one. */
  chrome: PeerSessionChrome;
  onClose: () => void;
}) {
  // Created ONCE and held in a ref: it owns a WebSocket and a child process on the other end,
  // so re-creating it on a re-render would silently spawn a second agent in the peer's
  // directory.
  const sessionRef = useRef<ChatSession | null>(null);
  const [, bump] = useState(0);
  const [open, setOpen] = useState(false);
  /** Sticky: a permission that arrived while the panel was shut must still be findable. */
  const [seenAsk, setSeenAsk] = useState(false);

  useEffect(() => {
    const notify = () => bump((n) => n + 1);
    const s = createChatSession(
      peer.vault,
      false, // never bypass — see the header note
      notify,
      newConversationId(),
      false,
      chrome.model,
      chrome.effort,
      prompt,
    );
    sessionRef.current = s;
    const unsub = s.subscribe(notify);
    return () => {
      unsub();
      s.dispose();
      sessionRef.current = null;
    };
    // Mount-only: `peer`/`prompt` identify this holder, and one whose peer changed is a
    // DIFFERENT holder (the caller gives it a new key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = sessionRef.current;
  const model = session?.getModel();
  const items = model?.items ?? [];
  const pending = model?.pending ?? [];
  const busy = session?.busy ?? false;

  useEffect(() => {
    if (pending.length > 0) setSeenAsk(true);
    else if (pending.length === 0 && open) setSeenAsk(false);
  }, [pending.length, open]);

  // WHERE the panel is mounted is not a detail. `.chat-slideover-scrim` is
  // `position: absolute; inset: 0`, so it fills its nearest POSITIONED ancestor — and the
  // only correct one is `.chat-pane`, which is what every other slide-over in this surface
  // resolves against. Rendered in place, the panel would resolve against the docked strip
  // this row lives in and collapse to a few pixels: still in the DOM, still ":visible", its
  // text still queryable — and invisible to the user. So the row stays here and the panel is
  // PORTALED to the pane. (Not `document.body`: that would cover the sidebar and window
  // chrome too, which is exactly what the pane-scoped scrim exists to avoid.)
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const paneEl = anchorRef.current?.closest('.chat-pane') ?? null;

  return (
    <div className="peer-holder" ref={anchorRef}>
      <PeerSessionRow
        peer={peer}
        prompt={prompt}
        busy={busy}
        tool={busy ? currentTool(items) : ''}
        preview={lastLine(answerText(items))}
        needsYou={pending.length > 0}
        unreadAsk={seenAsk && !open}
        onOpen={() => setOpen(true)}
        onClose={onClose}
      />
      {open && session && paneEl && createPortal(
        <PeerSessionPanel
          peer={peer}
          session={session}
          items={items}
          pending={pending}
          busy={busy}
          chrome={chrome}
          onClose={() => setOpen(false)}
        />,
        paneEl,
      )}
    </div>
  );
}

/**
 * THE MESSAGE. One line, docked above the composer, that you click to open the session.
 *
 * Docked rather than left in the transcript for the same reason the background-shells tray
 * is: a peer session can be sitting blocked on a permission, and a blocking thing that
 * scrolls out of view is a session that hangs for reasons the user cannot see. The row is
 * the only always-visible trace of it, so it has to carry the state that matters — busy,
 * answered, or waiting on you — in the collapsed form.
 */
function PeerSessionRow({
  peer, prompt, busy, tool, preview, needsYou, unreadAsk, onOpen, onClose,
}: {
  peer: PeerMention;
  prompt: string;
  busy: boolean;
  tool: string;
  preview: string;
  needsYou: boolean;
  unreadAsk: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const state = needsYou ? 'needs you' : busy ? (tool || 'thinking') : preview ? 'answered' : 'opening…';
  return (
    <div className={`peer-row${needsYou ? ' needs-you' : ''}`}>
      <button type="button" className="peer-row-main" onClick={onOpen}>
        <PeerMark peer={peer} className="peer-row-glyph" />
        <span className="peer-row-name">{peer.vault}</span>
        <span className={`peer-row-chip${needsYou ? ' is-ask' : busy ? ' is-busy' : ''}`}>{state}</span>
        {/* The preview is the ANSWER's last line when there is one, and what we asked when
            there is not — so the row says something real from the first frame, rather than
            sitting empty for the seconds before the peer's first token lands. */}
        <span className="peer-row-preview">{preview || prompt}</span>
        {unreadAsk && <span className="peer-row-dot" aria-label="waiting for you" />}
      </button>
      <button type="button" className="peer-row-x" onClick={onClose} aria-label={`End the ${peer.vault} session`}>
        ✕
      </button>
    </div>
  );
}

/**
 * The peer's face wherever the session names it: the vault's own logo when it ships one
 * (`assets/logo.*` in ITS tree), the `◈` federation glyph when it doesn't or the image
 * fails. This is the "which project am I talking to" mark, so it must never be an empty
 * box — the glyph is the floor, not a loading state.
 */
function PeerMark({ peer, className }: { peer: PeerMention; className: string }) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  if (!peer.logo || failed) return <span className={className} aria-hidden>◈</span>;
  return (
    <img
      className={`${className} peer-mark-logo`}
      src={peerLogoUrl(vault, peer.vault)}
      alt=""
      aria-hidden
      onError={() => setFailed(true)}
    />
  );
}

/**
 * THE PANEL. The live session, in the app's own side-panel shell (`chat-slideover-*`), with
 * the app's own transcript, permission card and composer inside it.
 */
function PeerSessionPanel({
  peer, session, items, pending, busy, chrome, onClose,
}: {
  peer: PeerMention;
  session: ChatSession;
  items: ChatItem[];
  pending: ReturnType<ChatSession['getModel']>['pending'];
  busy: boolean;
  chrome: PeerSessionChrome;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const windowChrome = useChrome();

  // Follow the stream, but only while already at the bottom — a panel that yanks itself down
  // while you read the top of a long answer is worse than one that does not scroll at all.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [items, pending.length]);

  // And for a reader parked ABOVE the stream, the way back down is one click, not a scroll
  // gesture through the whole answer — the same pill the drill-in panels carry.
  const { away, jump } = useJumpToLatest(bodyRef, [items.length, pending.length]);

  // Esc closes the PANEL, not the session — see the holder's header note. Capture phase and
  // stopped, so the surface's own Esc (collapse the overlay) does not fire in the same
  // keystroke. Skipped while a menu is open inside the composer, which owns its own Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const tool = busy ? currentTool(items) : '';

  return (
    <div className="chat-slideover-scrim" onClick={onClose}>
      <div className="chat-slideover-panel peer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-slideover-head">
          <div className="chat-slideover-head-text">
            <span className="chat-slideover-name">
              <PeerMark peer={peer} className="peer-panel-mark" /> {peer.vault}
            </span>
            <span className="chat-slideover-path">
              {busy ? (tool || 'thinking') : 'auto'} · a live session in that project
            </span>
          </div>
          {/* Hands the whole project to the window chrome as its own tab. Deliberately the
              PROJECT and not this conversation: a peer session is a scratch exchange, while
              "open it properly" means the other project with its own brain, tasks and chat —
              which is exactly what the user is reaching for when one answer is not enough. */}
          <button
            type="button"
            className="peer-panel-tab"
            onClick={() => { void windowChrome.addTab(peer.vault); }}
          >
            Open in new tab
          </button>
          <button type="button" className="chat-slideover-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="chat-slideover-body peer-panel-body" ref={bodyRef}>
          {peer.whatItIs && <div className="peer-panel-what">{peer.whatItIs}</div>}
          {/* The SAME transcript renderer the main pane uses, so the peer's markdown, tool
              cards, code fences and file chips all render as themselves. `readOnly` matches
              the sub-agent drill-in: rewind/quote belong to the conversation you own. */}
          <div className="chat-slideover-transcript">
            {items.map((item) => (
              <ItemView key={item.id} item={item} onOpenFile={() => {}} readOnly />
            ))}
          </div>
          {items.length === 0 && (
            <p className="chat-slideover-status">
              {busy ? `${peer.vault} is reading its own context…` : 'Opening a session there…'}
            </p>
          )}

          {/* The real permission card — command preview, edit diff, always-allow and all.
              `permissionMode` is hardcoded `auto` because that is what a peer session is
              spawned under, unconditionally (see the header note); there is no bypass here
              to report. */}
          {pending.map((p) => (
            p.kind === 'permission'
              ? <PermissionCard key={p.requestId} item={p} session={session} permissionMode="auto" />
              : (
                <div className="peer-session-ask-card" key={p.requestId}>
                  <div className="peer-session-ask-text">
                    {p.kind === 'question'
                      ? (p.questions?.[0]?.question ?? `${peer.vault} has a question`)
                      : `${peer.vault} proposed a plan`}
                  </div>
                  <div className="peer-session-ask-actions">
                    <button
                      type="button"
                      className="peer-session-btn is-primary"
                      onClick={() => session.answer(p.requestId, { behavior: 'allow' })}
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      className="peer-session-btn"
                      onClick={() => session.answer(p.requestId, { behavior: 'deny' })}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )
          ))}
          <JumpToLatest away={away} jump={jump} />
        </div>

        {/* THE REAL COMPOSER, on the peer's session. `/` menu, attachments, model + effort +
            mode triggers, steer-into-the-running-turn, the queue — all of it, because it is
            the same component, not a copy of it.

            `onPeerMessage` is deliberately NOT passed: an `@` inside a peer session would
            otherwise open a peer-of-a-peer, and one hop is the whole mental model. The
            mention picker still completes the name (it is just text here). */}
        <div className="peer-panel-composer">
          <Composer
            session={session}
            model={chrome.model}
            effort={chrome.effort}
            modelConfig={chrome.modelConfig}
            onModelChange={chrome.onModelChange}
            onEffortChange={chrome.onEffortChange}
            busy={busy}
            connected={session.status === 'open'}
            quote={null}
            onClearQuote={() => {}}
            onOpenTaskPicker={() => {}}
            permissionMode="auto"
            projectPermissionMode="auto"
            onPermissionModeChange={() => {}}
            onSignIn={chrome.onSignIn}
          />
        </div>
      </div>
    </div>
  );
}

/** A fresh conversation UUID for the peer session (mirrors AgentSurface's newClaudeId). */
function newConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
