import { memo, useMemo, useRef, useState } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { agentFileUrl, type ApiClient } from '../../../api/client';
import { useApi, useVault } from '../../../context/VaultContext';
import {
  useCopyableCodeBlocks, useInlineMedia, useClickablePaths, estimateTokens,
  inlineMediaKind, splitUserMedia, revealPath,
} from './chatEntities';
import { parseChatActions, type ChatAction } from './chatActions';
import { ActionRow } from './ActionRow';
import { BoardEmbed } from './BoardEmbed';
import { ChatViews } from './ChatViews';
import { IconButton } from './atoms';
import { HoverActions, ConfirmPrompt, ThinkingPill } from './molecules';
import { ToolCard } from './ToolCard';
import type {
  ChatItem, ChatUserItem, ChatTextItem, ChatThinkingItem, ChatSession,
} from '../chatSession';

/**
 * ORGANISM — dispatcher + leaf renderers for one transcript entry (state 2/11 of the
 * redesign brief). Binds transcript data and session mutations to the presentational
 * molecules; every visual it shows is composed from `atoms.tsx`/`molecules.tsx`.
 *
 * Reused verbatim by the sub-agent drill-in (`SlideOver`'s `mode:'subagent'`) with
 * `readOnly` — the SAME components render a sidechain transcript, just with the hover
 * action bar reduced to Copy (no rewind/retry/quote, since a drill-in item has no live
 * `session` backing it and nothing to mutate). No avatar anywhere (hard rule 1):
 * `AssistantMessage` is a full-width block with no gutter, never a bubble-plus-icon row.
 */

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => { /* clipboard unavailable */ });
}

/** The user allowing ONE file outside the project root to be shown inline. Resolves false
 *  when the server refused (gone, or not a file), so the card can stay put and say so. A
 *  module function, not a component — the caller passes its own vault-bound client. */
function grantFile(api: ApiClient, path: string): Promise<boolean> {
  return api.post('/agent/grant', { path }).then(() => true, () => false);
}

// ─── User message ───────────────────────────────────────────────────────────────────

/**
 * One picture (or clip) the user attached, drawn above their message.
 *
 * The bytes reach the page the same way an answer's inline media does — `GET /api/agent/file`
 * (a filesystem path is not something a browser can load). A file that has since gone (the
 * drop dir prunes after ~7 days) degrades to a named chip that still opens, never a broken
 * image icon.
 */
function UserMediaItem({ path, onOpenFile }: { path: string; onOpenFile?: (path: string) => void }) {
  const { vault } = useVault();
  const api = useApi();
  const [failed, setFailed] = useState(false);
  // Why the OS opener refused, if it did. The chip promised "still opens" and used to break
  // that promise in silence — a refusal now shows next to it (owner report 07-28).
  const [revealError, setRevealError] = useState<string | null>(null);
  const kind = inlineMediaKind(path);
  const name = path.replace(/\/+$/, '').split('/').pop() || path;

  if (failed) {
    return (
      <span className="chat-msg-user-media-gone-row">
        <button
          type="button"
          className="chat-msg-user-media-gone"
          onClick={() => { setRevealError(null); void revealPath(api, path).then(setRevealError); }}
          title={path}
        >
          <span aria-hidden>{kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '🖼'}</span> {name}
        </button>
        {revealError && <span className="chat-msg-user-media-gone-note">{revealError}</span>}
      </span>
    );
  }
  if (kind === 'video' || kind === 'audio') {
    return (
      <video
        className="chat-msg-user-media-el"
        src={agentFileUrl(vault, path, { raw: true })}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <img
      className="chat-msg-user-media-el"
      src={agentFileUrl(vault, path, { raw: true })}
      alt={name}
      title={name}
      loading="lazy"
      decoding="async"
      onClick={() => onOpenFile?.(path)}
      onError={() => setFailed(true)}
    />
  );
}

function UserMessage({
  item, session, onQuote, onOpenFile, readOnly,
}: {
  item: ChatUserItem;
  session?: ChatSession;
  onQuote?: (text: string) => void;
  /** Open an attached image full-size (the same lightbox an answer's image uses). */
  onOpenFile?: (path: string) => void;
  readOnly: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  // What was attached is drawn; what was typed stays in the bubble. Copy/quote/rewind all
  // keep `item.text` — the real message, paths and all, is what was sent.
  const { text, media } = useMemo(() => splitUserMedia(item.text), [item.text]);
  return (
    <div className="chat-msg-user-row">
      {media.length > 0 && (
        <div className="chat-msg-user-media">
          {media.map((p) => <UserMediaItem key={p} path={p} onOpenFile={onOpenFile} />)}
        </div>
      )}
      {text && <div className="chat-msg-user-bubble">{text}</div>}
      {/* The one item whose position in the transcript runs ahead of the truth: a steered
          message appears the instant it goes on the wire, while the CLI only folds it in at
          its next tool boundary — so the tool calls rendered just below it were decided
          before it was read. Said once, quietly, rather than letting the gap read as the
          agent having ignored it. */}
      {item.steered && (
        <div className="chat-msg-steered" title="Sent into a turn that was already running — Claude picks it up at its next step">
          <span aria-hidden>⤵</span> sent mid-turn
        </div>
      )}
      {!readOnly && (
        <HoverActions>
          <IconButton label="Copy" onClick={() => copyText(item.text)}>⧉</IconButton>
          {session && (
            <IconButton label="Edit — rewind to before this message" onClick={() => setConfirming(true)}>✎</IconButton>
          )}
          {onQuote && <IconButton label="Quote-reply" onClick={() => onQuote(item.text)}>↩</IconButton>}
        </HoverActions>
      )}
      {confirming && session && (
        <ConfirmPrompt
          note={'Rewind the conversation to just before this message? Its text returns to the '
            + 'composer for re-editing. Files are NOT reverted — code changes made after this '
            + 'point stay (restore code from checkpoints in Terminal view).'}
          confirmLabel="Rewind"
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); void session.rewind(item.id); }}
        />
      )}
    </div>
  );
}

// ─── Assistant message (full-width, NO avatar) ─────────────────────────────────────

function AssistantMessage({
  item, session, onQuote, onOpenFile, onOpenBoard, onAction, conversationId, readOnly,
}: {
  item: ChatTextItem;
  session?: ChatSession;
  onQuote?: (text: string) => void;
  /** Click-through for an inline image the answer rendered — same lightbox a tool
   *  card's image reference opens. Also backs the clickable backticked paths. */
  onOpenFile?: (path: string) => void;
  /** Open a board's own full-height panel (the "bigger" affordance under an embed). */
  onOpenBoard?: (path: string) => void;
  /** Run one of the buttons the answer asked for — `ChatPane` decides what each does. */
  onAction?: (action: ChatAction) => void;
  /** This conversation's id — required by `ChatViews` (a checklist's Submit has to land
   *  somewhere). Omitted for a read-only drill-in (SlideOver's sub-agent transcript), which
   *  is why it's optional here rather than on `ChatViews` itself: `<ChatViews>` only ever
   *  renders under `{onAction && conversationId && …}`, so a drill-in — which passes no
   *  `onAction` either — renders no views, exactly like it renders no `ActionRow` today. */
  conversationId?: string;
  readOnly: boolean;
}) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // What the answer asked the view to render (buttons, boards, rendered HTML, insight
  // cards, checklists) versus what it asked it to READ. Re-derived per token while
  // streaming — parseChatActions is pure and cheap, and hides a half-written fence rather
  // than flashing raw markup.
  const { body, actions, boards, blocks, notices, pendingView } = useMemo(
    () => parseChatActions(item.text), [item.text],
  );

  // No dependency list on purpose: these decorate the HTML `MarkdownPreview` wrote, and that
  // subtree can be re-written out from under them by any commit. See the section header in
  // chatEntities.ts — keying them to the message's own text is what let a whole answer revert
  // to raw markdown, `<a href="…mp4">` and all, on somebody else's re-render.
  useCopyableCodeBlocks(bodyRef);
  useInlineMedia(bodyRef, { onOpen: onOpenFile, onReveal: (path) => revealPath(api, path), onGrant: (path) => grantFile(api, path) });
  useClickablePaths(bodyRef, (path) => onOpenFile?.(path));

  // Nothing left to show: an empty finished text block, or one that was ONLY a fence/board
  // reference/view whose rendering is handled below. A degraded block that produced only a
  // notice (no view survived validation) still counts as something to show — the
  // degradation contract requires every drop to stay visible, never silently vanish with
  // the rest of an otherwise-empty message.
  if (!item.text && item.done) return null;
  if (item.done && !body && !actions.length && !boards.length && !blocks.length && !notices.length && !pendingView) {
    return null;
  }

  return (
    <div className="chat-msg-assistant-row" data-done={item.done}>
      <div className="chat-msg-assistant-body" ref={bodyRef}>
        <MarkdownPreview content={body || (item.done ? '' : '…')} />
        {!item.done && <span className="chat-msg-caret" aria-hidden />}
      </div>
      {onAction && conversationId && (
        <ChatViews
          blocks={blocks}
          notices={notices}
          pendingView={pendingView}
          conversationId={conversationId}
        />
      )}
      {/* Drawn, not linked: the board the answer just made, in the conversation. Only once
          it has stopped streaming — a path still being typed points at nothing. */}
      {item.done && onOpenBoard && boards.map((path) => (
        <BoardEmbed key={path} path={path} onOpenBoard={onOpenBoard} />
      ))}
      {onAction && <ActionRow actions={actions} onAction={onAction} />}
      {!readOnly && (
        <HoverActions>
          <IconButton label="Copy" onClick={() => copyText(item.text)}>⧉</IconButton>
          {onQuote && <IconButton label="Quote-reply" onClick={() => onQuote(item.text)}>↩</IconButton>}
          {session && (
            <IconButton label="Retry — resend the preceding message" onClick={() => setConfirming(true)}>⟳</IconButton>
          )}
        </HoverActions>
      )}
      {confirming && session && (
        <ConfirmPrompt
          note={'Retry this turn? The conversation rewinds to just before your preceding message '
            + 'and resends it. Files are NOT reverted — code changes made after that point stay.'}
          confirmLabel="Retry"
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); void session.retry(item.id); }}
        />
      )}
    </div>
  );
}

// ─── Thinking ───────────────────────────────────────────────────────────────────────

function ThinkingBlock({ item }: { item: ChatThinkingItem }) {
  const [open, setOpen] = useState(false);
  if (!item.text) return null;
  return (
    <ThinkingPill
      streaming={!item.done}
      tokens={estimateTokens(item.text)}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      body={item.text}
    />
  );
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────────────

function ItemViewInner({
  item, session, onOpenFile, onOpenBoard, onAction, conversationId, onQuote, readOnly = false,
}: {
  item: ChatItem;
  /** The live session backing this item — omitted for a read-only drill-in transcript
   *  (SlideOver's `mode:'subagent'`), which has no session of its own to mutate. */
  session?: ChatSession;
  onOpenFile: (path: string) => void;
  /** Open a board's own panel. Omitted (the drill-in) means boards stay as plain text —
   *  a read-only sidechain has no pane to open one into. */
  onOpenBoard?: (path: string) => void;
  /** Run a `dream-actions` button. Omitted (the drill-in) means the row isn't offered. */
  onAction?: (action: ChatAction) => void;
  /** This conversation's id, for `ChatViews`' checklist card. Optional — the read-only
   *  drill-in passes neither this nor `onAction`, so it renders no views (plan §T6). */
  conversationId?: string;
  onQuote?: (text: string) => void;
  /** Suppresses the mutating hover actions (edit/retry/quote) — Copy always stays,
   *  since it never mutates anything. Used by the sub-agent drill-in. */
  readOnly?: boolean;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <UserMessage
          item={item}
          session={session}
          onQuote={onQuote}
          onOpenFile={onOpenFile}
          readOnly={readOnly}
        />
      );
    case 'text':
      return (
        <AssistantMessage
          item={item}
          session={session}
          onQuote={onQuote}
          onOpenFile={onOpenFile}
          onOpenBoard={onOpenBoard}
          onAction={onAction}
          conversationId={conversationId}
          readOnly={readOnly}
        />
      );
    case 'thinking':
      return <ThinkingBlock item={item} />;
    case 'tool':
      return <ToolCard item={item} onOpenFile={onOpenFile} />;
    default:
      return null;
  }
}

/**
 * MEMOIZED. A streamed token replaces exactly ONE entry in `ConversationModel.items` (the
 * reducer's `items.slice()` + replace-one-index keeps every other item's reference), so a
 * transcript of N items can re-render O(1) of them per frame instead of N — provided the
 * callbacks below stay referentially stable. `ChatPane` holds every one of them in a
 * `useCallback`; do not pass an inline arrow to this component.
 *
 * The decoration hooks inside `AssistantMessage` are unaffected: memo only skips renders in
 * which NOTHING about the item changed, and a skipped render leaves the DOM (and therefore
 * every decoration on it) exactly as it was. See chatEntities.ts's decorating section — the
 * hazard there is a re-render that REWRITES the markdown subtree, which is precisely what a
 * skipped render doesn't do.
 */
export const ItemView = memo(ItemViewInner);
