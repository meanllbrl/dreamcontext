import { useRef, useState } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { api } from '../../../api/client';
import { useCopyableCodeBlocks, useInlineMedia, estimateTokens } from './chatEntities';
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

/** Hand an image the transcript can't draw to the OS viewer (`POST /agent/reveal` — image
 *  extensions only, see the route). Best-effort: a failure leaves the chip as it was. */
function revealFile(path: string): void {
  void api.post('/agent/reveal', { path }).catch(() => { /* not desktop, or gone */ });
}

/** The user allowing ONE file outside the project root to be shown inline. Resolves false
 *  when the server refused (gone, or not a file), so the card can stay put and say so. */
function grantFile(path: string): Promise<boolean> {
  return api.post('/agent/grant', { path }).then(() => true, () => false);
}

// ─── User message ───────────────────────────────────────────────────────────────────

function UserMessage({
  item, session, onQuote, readOnly,
}: {
  item: ChatUserItem;
  session?: ChatSession;
  onQuote?: (text: string) => void;
  readOnly: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="chat-msg-user-row">
      <div className="chat-msg-user-bubble">{item.text}</div>
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
  item, session, onQuote, onOpenFile, readOnly,
}: {
  item: ChatTextItem;
  session?: ChatSession;
  onQuote?: (text: string) => void;
  /** Click-through for an inline image the answer rendered — same lightbox a tool
   *  card's image reference opens. */
  onOpenFile?: (path: string) => void;
  readOnly: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useCopyableCodeBlocks(bodyRef, [item.text, item.done]);
  useInlineMedia(bodyRef, [item.text, item.done], { onOpen: onOpenFile, onReveal: revealFile, onGrant: grantFile });

  if (!item.text && item.done) return null; // an empty finished text block carries nothing to show

  return (
    <div className="chat-msg-assistant-row" data-done={item.done}>
      <div className="chat-msg-assistant-body" ref={bodyRef}>
        <MarkdownPreview content={item.text || '…'} />
        {!item.done && <span className="chat-msg-caret" aria-hidden />}
      </div>
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

export function ItemView({
  item, session, onOpenFile, onQuote, readOnly = false,
}: {
  item: ChatItem;
  /** The live session backing this item — omitted for a read-only drill-in transcript
   *  (SlideOver's `mode:'subagent'`), which has no session of its own to mutate. */
  session?: ChatSession;
  onOpenFile: (path: string) => void;
  onQuote?: (text: string) => void;
  /** Suppresses the mutating hover actions (edit/retry/quote) — Copy always stays,
   *  since it never mutates anything. Used by the sub-agent drill-in. */
  readOnly?: boolean;
}) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} session={session} onQuote={onQuote} readOnly={readOnly} />;
    case 'text':
      return <AssistantMessage item={item} session={session} onQuote={onQuote} onOpenFile={onOpenFile} readOnly={readOnly} />;
    case 'thinking':
      return <ThinkingBlock item={item} />;
    case 'tool':
      return <ToolCard item={item} onOpenFile={onOpenFile} />;
    default:
      return null;
  }
}
