import { memo, useMemo, useRef, useState } from 'react';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { agentFileUrl, type ApiClient } from '../../../api/client';
import { useApi, useVault } from '../../../context/VaultContext';
import {
  useCopyableCodeBlocks, useInlineMedia, useClickablePaths, estimateTokens,
  inlineMediaKind, splitUserBoardRefs, splitUserMedia, revealPath,
} from './chatEntities';
import { parseChatActions, type ChatAction, type ChatSegment } from './chatActions';
import type { ReplyHead } from './replyLinks';
import { ActionRow } from './ActionRow';
import { BoardEmbed } from './BoardEmbed';
import { MediaEmbed } from './MediaEmbed';
import { ChatBlockSegment, ChatViewNotices } from './ChatViews';
import { Caret, IconButton } from './atoms';
import { Notice, NoticeRow, TokenDrop, ContextShrink, Glyph } from './Notice';
import { HoverActions, ConfirmPrompt, ThinkingPill } from './molecules';
import { ToolCard } from './ToolCard';
import { useSpokenHighlight } from './useSpokenHighlight';
import { splitAbout, splitAboutParts, type MessagePart } from '../super/superHandover';
import { AgendaAboutStrip, RefChip, ReplySectionHead, ReplyStrip } from './AgendaAboutStrip';
import { useI18n } from '../../../context/I18nContext';
import type { AgentRoleId } from '../../../lib/agentRoles';
import type {
  ChatItem, ChatUserItem, ChatTextItem, ChatThinkingItem, ChatCompactItem, ChatSession,
} from '../chatSession';

/**
 * ORGANISM — dispatcher + leaf renderers for one transcript entry (state 2/11 of the
 * redesign brief). Binds transcript data and session mutations to the presentational
 * molecules; every visual it shows is composed from `atoms.tsx`/`molecules.tsx`.
 *
 * Reused verbatim by the sub-agent drill-in (`SlideOver`'s `mode:'subagent'`) with
 * `readOnly` — the SAME components render a sidechain transcript, just with the hover
 * action bar reduced to Copy (no rewind/retry/quote, since a drill-in item has no live
 * `session` backing it and nothing to mutate). No avatar on a MESSAGE (hard rule 1):
 * `AssistantMessage` is a full-width block with no gutter, never a bubble-plus-icon row. Step
 * lines (tool rows, thinking) are the team log, and the lead of each stretch wears the
 * speaker's 16px face.
 */

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => { /* clipboard unavailable */ });
}

/** The user allowing ONE file outside the project root to be shown inline. Resolves false
 *  when the server refused (gone, or not a file), so the card can stay put and say so. A
 *  module function, not a component — the caller passes its own vault-bound client. */
function grantFile(api: ApiClient, path: string): Promise<boolean> {
  // The hands-free phone grants itself one file, for this device only (its own route); the
  // desktop's grant is the owner's consent for the Mac's own screen and is laptop-only.
  return api.post(isMacPhoneSurface() ? '/agent/phone-grant' : '/agent/grant', { path }).then(() => true, () => false);
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
      <MediaEmbed
        kind={kind}
        className="chat-msg-user-media-el"
        src={agentFileUrl(vault, path, { raw: true })}
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
  item, session, onQuote, onOpenFile, readOnly, onReplyJump,
}: {
  item: ChatUserItem;
  session?: ChatSession;
  onQuote?: (item: ChatUserItem | ChatTextItem) => void;
  /** His reply's strip was clicked: scroll to the message it names (a Super view only). */
  onReplyJump?: (ref: string, from: 'super' | 'owner', beforeId: string) => void;
  /** Open an attached image full-size (the same lightbox an answer's image uses). */
  onOpenFile?: (path: string) => void;
  readOnly: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const { t } = useI18n();
  const superView = !!session && (session.mode === 'super' || session.superMirror);
  // What was attached is drawn; what was typed stays in the bubble. Copy/quote/rewind all
  // keep `item.text` — the real message, paths and all, is what was sent.
  const { text, media, refs, about, parts } = useMemo(() => {
    // Several references in one message (owner 2026-10-24, the Super view only): his words
    // with each part's chip inline where he put it; the files at the top are the preamble's.
    const multi = superView ? splitAboutParts(item.text) : null;
    if (multi && multi.parts.length >= 2) {
      const board = splitUserBoardRefs(multi.preamble);
      return { ...splitUserMedia(board.text), refs: board.refs, about: null, parts: multi.parts };
    }
    // A message written about an agenda line, or replying to one message (owner 2026-10-23),
    // opens with its block: drawn as a strip above the bubble, the bubble keeps only his words.
    const split = splitAbout(item.text);
    const board = splitUserBoardRefs(split.text);
    return { ...splitUserMedia(board.text), refs: board.refs, about: split.about, parts: null };
  }, [item.text, superView]);
  return (
    <div className="chat-msg-user-row" data-item-id={item.id} tabIndex={-1}>
      {about?.kind === 'reply'
        ? (
          <ReplyStrip
            label={t(about.from === 'super' ? 'super.reply.toSuper' : 'super.reply.toOwn')}
            quotes={[about.quote]}
            onJump={onReplyJump ? () => onReplyJump(about.ref, about.from, item.id) : undefined}
          />
        )
        : about && <AgendaAboutStrip about={about} superSid={session && (session.mode === 'super' || session.superMirror) ? session.claudeId : null} />}
      {media.length > 0 && (
        <div className="chat-msg-user-media">
          {media.map((p) => <UserMediaItem key={p} path={p} onOpenFile={onOpenFile} />)}
        </div>
      )}
      {refs > 0 && (
        <div className="chat-msg-user-media">
          {Array.from({ length: refs }, (_, i) => (
            <span key={i} className="chat-msg-user-ref">Board element</span>
          ))}
        </div>
      )}
      {parts
        ? <PartsBubble preamble={text} parts={parts} itemId={item.id} superSid={superView && session ? session.claudeId : null} onReplyJump={onReplyJump} />
        : text && <div className="chat-msg-user-bubble">{text}</div>}
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
          {onQuote && <IconButton label="Quote-reply" onClick={() => onQuote(item)}>↩</IconButton>}
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

/**
 * A sent message with several references (owner 2026-10-24): one bubble, his words in his order,
 * each part's chip inline where he put it, in its slot. Chips are in the flow, so they wrap with
 * the text. A reply chip lands on its message; an agenda chip opens its whole line under it.
 * No header text ever reaches the DOM: the chip is drawn from the parsed part.
 */
function PartsBubble({ preamble, parts, itemId, superSid, onReplyJump }: {
  preamble: string;
  parts: MessagePart[];
  itemId: string;
  superSid: string | null;
  onReplyJump?: (ref: string, from: 'super' | 'owner', beforeId: string) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = open != null ? parts[open]?.about : null;
  return (
    <div className="chat-msg-user-bubble chat-msg-user-bubble--parts" data-testid="chat-msg-parts">
      {preamble && <span className="chat-msg-part-words">{preamble} </span>}
      {parts.map((p, i) => {
        const a = p.about;
        const onClick = a.kind === 'reply'
          ? (onReplyJump ? () => onReplyJump(a.ref, a.from, itemId) : undefined)
          // A question's chip already reads whose question it is; a note's opens its whole line.
          : a.kind === 'note' ? () => setOpen((cur) => (cur === i ? null : i)) : undefined;
        return (
          // eslint-disable-next-line react/no-array-index-key -- parts are positional in one sent text
          <span key={i} className="chat-msg-part">
            <RefChip about={a} slot={i + 1} part={i + 1} superSid={superSid} onClick={onClick} pressed={open === i} />
            {p.words && <span className="chat-msg-part-words"> {p.words} </span>}
          </span>
        );
      })}
      {shown?.kind === 'note' && <span className="chat-msg-part-line" data-testid="chat-msg-part-line">{shown.line}</span>}
    </div>
  );
}

/**
 * ONE prose run of an assistant answer — the grey bubble, and the three decorating passes
 * that make its markdown clickable.
 *
 * A component per run, rather than one container for the whole message, because the runs are
 * no longer contiguous: a card can sit between two of them. Each instance therefore owns its
 * own ref, which NARROWS what the decorators walk to exactly the prose they are for — a
 * single message-wide root would also have swept the block cards rendered between the runs,
 * and `useInlineMedia` rewriting an `<a>` inside a view card is not a hazard worth carrying
 * for a refactor that was about order.
 *
 * The three hooks keep their missing dependency lists, deliberately: they decorate the HTML
 * `MarkdownPreview` wrote into the DOM, and that subtree can be re-written out from under
 * them by any commit. See the section header in chatEntities.ts — keying them to the text is
 * what once let a whole answer revert to raw markdown, `<a href="…mp4">` and all, on
 * somebody else's re-render.
 */
/** Exported for the `#agents` channel, which renders an agent's answer with THIS — the
 *  chat's own card, markdown, leading and clickable paths — rather than a second, plainer
 *  paragraph that reads like a different product. */
export function ProseSegment({ text, parts, superSid = null, onReplyTarget, onOpenFile, caret, session, itemId }: {
  text: string;
  /** A sectioned Super reply (owner 2026-10-24, pick A): its parts inside this ONE body, each
   *  opening with its head, a dashed rule before every section after the first thing. */
  parts?: ProsePart[];
  superSid?: string | null;
  onReplyTarget?: (targetId: string, part?: number) => void;
  onOpenFile?: (path: string) => void;
  /** The blinking cursor. Only the run that is currently being typed gets one. */
  caret?: boolean;
  /** Assistant mode's spoken-sentence marker needs both: the session to subscribe to, and
   *  the item to compare the spoken chunk against. Absent everywhere else — a read-only
   *  drill-in has no session, and no session ever speaks. */
  session?: ChatSession;
  itemId?: string;
}) {
  const api = useApi();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useCopyableCodeBlocks(bodyRef);
  useInlineMedia(bodyRef, { onOpen: onOpenFile, onReveal: (path) => revealPath(api, path, 'auto', session?.claudeId), onGrant: (path) => grantFile(api, path), session: session?.claudeId });
  useClickablePaths(bodyRef, (path) => onOpenFile?.(path));
  useSpokenHighlight(bodyRef, itemId ?? '', itemId ? session : undefined);

  return (
    <div className="chat-msg-assistant-body" ref={bodyRef}>
      {parts
        ? parts.map((p, i) => (
          <div key={i} className={p.divider ? 'chat-reply-part chat-reply-part--divider' : 'chat-reply-part'}>
            {p.head && <ReplySectionHead head={p.head} superSid={superSid} onReplyTarget={onReplyTarget} />}
            <MarkdownPreview content={p.text} />
          </div>
        ))
        : <MarkdownPreview content={text} />}
      {caret && <span className="chat-msg-caret" aria-hidden />}
    </div>
  );
}

// ─── Assistant message (full-width, NO avatar) ─────────────────────────────────────

/** One part of a sectioned reply's prose. */
interface ProsePart { head?: ReplyHead; text: string; divider: boolean }
/** What the row draws, in written order: a prose body (its parts), a section's head alone (its
 *  section opens with a block), or a block. `at` is the segment index the caret rule reads. */
type Unit =
  | { kind: 'prose'; parts: ProsePart[]; at: number }
  | { kind: 'head'; head?: ReplyHead; divider: boolean }
  | { kind: 'block'; segment: Exclude<ChatSegment, { kind: 'prose' } | { kind: 'section' }> };

/**
 * A sectioned reply's segments as units: prose separated only by section markers merges into
 * ONE body with parts (one container, owner pick A); a section that opens with a block gets its
 * head as a row of its own right before it, and so does a section with nothing drawn in it (its
 * first line became a `dream-actions` fence, whose buttons sit under the message): a head once
 * shown never goes when its words turn out to be a fence. Without section markers: one unit per
 * segment.
 */
function unitsOf(segments: ChatSegment[], heads: readonly ReplyHead[] | undefined, sectionAt: readonly number[] | undefined): Unit[] {
  const units: Unit[] = [];
  let open: number | null = null;
  const headOf = (i: number) => heads?.find((h) => h.at === sectionAt?.[i]);
  /** A section that drew nothing: its head alone. */
  const headAlone = () => {
    if (open === null) return;
    const head = headOf(open);
    units.push({ kind: 'head', ...(head ? { head } : {}), divider: units.length > 0 });
    open = null;
  };
  segments.forEach((seg, i) => {
    if (seg.kind === 'section') { headAlone(); open = seg.index; return; }
    const starts = open !== null;
    const divider = starts && units.length > 0;
    const head = starts ? headOf(open!) : undefined;
    open = null;
    if (seg.kind === 'prose') {
      const last = units[units.length - 1];
      const part = { ...(head ? { head } : {}), text: seg.text, divider };
      if (starts && last?.kind === 'prose') { last.parts.push(part); last.at = i; } else units.push({ kind: 'prose', parts: [part], at: i });
      return;
    }
    if (starts) units.push({ kind: 'head', ...(head ? { head } : {}), divider });
    units.push({ kind: 'block', segment: seg });
  });
  headAlone();
  return units;
}

function AssistantMessage({
  item, session, onQuote, onOpenFile, onOpenBoard, onAction, conversationId, readOnly, replyGroup, replyHeads, onReplyTarget,
}: {
  item: ChatTextItem;
  /** A SECTIONED Super reply's heads (ChatPane's replyHeadsById): present, the answer is parsed
   *  with its section starts and every part opens with the chip of the message it answers. */
  replyHeads?: ReplyHead[];
  onReplyTarget?: (targetId: string, part?: number) => void;
  session?: ChatSession;
  onQuote?: (item: ChatUserItem | ChatTextItem) => void;
  /** The Super answer group this row belongs to (ChatPane's replyGroups): the thin line beside it. */
  replyGroup?: string;
  /** Click-through for an inline image the answer rendered — same lightbox a tool
   *  card's image reference opens. Also backs the clickable backticked paths. */
  onOpenFile?: (path: string) => void;
  /** Open a board's own full-height panel (the "bigger" affordance under an embed). Absent
   *  means the board is NOTICED rather than drawn — reading one needs a project. */
  onOpenBoard?: (path: string) => void;
  /** Run one of the buttons the answer asked for — `ChatPane` decides what each does. Absent
   *  means the buttons are NOTICED rather than offered; it no longer gates `dream-html`. */
  onAction?: (action: ChatAction) => void;
  /**
   * This conversation's id — what a `dream-view` needs and nothing else does: a checklist's
   * Submit has to land somewhere, and an insight has to resolve against a project.
   *
   * Absent on a host that has no conversation, such as the read-only drill-in (SlideOver's
   * sub-agent transcript). It still renders the agent's `dream-html`,
   * which asks the host for nothing — see `viewsAllowed` below for why that stopped being one
   * gate with `onAction`.
   */
  conversationId?: string;
  readOnly: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  // What the answer asked the view to render (buttons, boards, rendered HTML, insight
  // cards, checklists) versus what it asked it to READ. Re-derived per token while
  // streaming — parseChatActions is pure and cheap, and hides a half-written fence rather
  // than flashing raw markup.
  const sectionAt = replyHeads && item.replySections && item.replySections.length >= 2 ? item.replySections.map((x) => x.at) : undefined;
  const sectionKey = sectionAt?.join(',') ?? '';
  const { segments, actions, boards, notices } = useMemo(
    () => parseChatActions(item.text, sectionAt ? { sectionAt } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sectionKey is sectionAt's content
    [item.text, sectionKey],
  );
  const units = useMemo(() => unitsOf(segments, replyHeads, sectionAt), [segments, replyHeads, sectionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const superSid = session && (session.mode === 'super' || session.superMirror) ? session.claudeId : null;

  // ONE GATE WAS TWO CAPABILITIES, and conflating them cost the surface its main expressive
  // channel on any host without a conversation.
  //
  //   `dream-html` asks NOTHING of the host. It is a sandboxed, network-less render: no
  //   callback to fire, nothing to submit, no path to resolve. It needs a screen.
  //   `dream-view` asks for two real things — a conversation for a checklist's Submit to land
  //   in, and a project for an insight to resolve against.
  //
  // The old `blocksAllowed = !!onAction && !!conversationId` charged HTML for both. A host
  // with neither (a machine-wide store, a window that holds no project) had an agent's drawn
  // block DROPPED — and dropped in silence, because the notices below rode the same gate. That is the one failure this
  // surface documents that it must never have.
  const viewsAllowed = !!conversationId;

  // What this host could not draw, said out loud. The degradation contract is that a dropped
  // block stays VISIBLE — and a capability the host lacks is as much a drop as a payload that
  // failed validation, so it earns the same strip rather than a silent `null`.
  const hostNotices = useMemo(() => {
    const out: string[] = [];
    if (!viewsAllowed) {
      for (const seg of segments) {
        if (seg.kind !== 'view') continue;
        out.push(`A "${seg.view.type}" card was written here but not drawn — this surface has no project or conversation to resolve it against.`);
      }
    }
    if (!onAction && actions.length > 0) {
      out.push(actions.length === 1
        ? 'A button was written here but not offered — this surface has nothing to run it against.'
        : `${actions.length} buttons were written here but not offered — this surface has nothing to run them against.`);
    }
    if (!onOpenBoard && boards.length > 0) {
      out.push('A board was referenced here but not drawn — this surface has no project to read it from.');
    }
    return out;
  }, [viewsAllowed, segments, onAction, actions.length, onOpenBoard, boards.length]);

  // The blinking caret belongs to the LAST prose run, and only when that run is the last
  // thing in the message. A message currently ending in a block (or in the slot one is
  // about to fill) shows no caret: its own placeholder is the liveness signal, and a caret
  // stranded in the paragraph above a card is exactly the "the stream went somewhere else"
  // reading this refactor exists to remove.
  const lastProse = segments.reduce((acc, seg, i) => (seg.kind === 'prose' ? i : acc), -1);
  const caretAt = !item.done && lastProse === segments.length - 1 ? lastProse : -1;
  // Section markers are not rows: the caret's unit is the prose unit holding that segment.

  // Nothing left to show: an empty finished text block, or one that was ONLY a fence/board
  // reference/view whose rendering is handled below. A degraded block that produced only a
  // notice (no view survived validation) still counts as something to show — the
  // degradation contract requires every drop to stay visible, never silently vanish with
  // the rest of an otherwise-empty message.
  if (!item.text && item.done) return null;
  if (item.done && !segments.length && !actions.length && !boards.length && !notices.length) {
    return null;
  }

  return (
    <div className="chat-msg-assistant-row" data-done={item.done} data-item-id={item.id} data-reply-grp={replyGroup} tabIndex={-1}>
      {/* WRITTEN ORDER. Prose runs and blocks are siblings in the row's own flex column, so
          a card sits between the paragraph that introduces it and the one that says what to
          notice — which is how the answer was written and, before 2026-08-27, not how it
          was drawn. The row's tight gap is what keeps several bubbles reading as one
          message rather than as several. */}
      {segments.length === 0 && !item.done && <ProseSegment text="…" onOpenFile={onOpenFile} caret />}
      {units.map((unit, i) => (
        unit.kind === 'prose'
          ? (
            <ProseSegment
              key={i}
              text={unit.parts.map((p) => p.text).join('\n\n')}
              parts={sectionAt ? unit.parts : undefined}
              superSid={superSid}
              onReplyTarget={onReplyTarget}
              onOpenFile={onOpenFile}
              caret={unit.at === caretAt}
              session={session}
              itemId={item.id}
            />
          )
          : unit.kind === 'head'
            ? (
              <div key={i} className={unit.divider ? 'chat-reply-part chat-reply-part--divider' : 'chat-reply-part'}>
                {unit.head && <ReplySectionHead head={unit.head} superSid={superSid} onReplyTarget={onReplyTarget} />}
              </div>
            )
            // A `view` this host cannot resolve renders nothing HERE and a notice below — see
            // `hostNotices`. Everything else (html and the pending slot for either fence) is
            // drawn wherever it was written.
            : unit.segment.kind === 'view' && !viewsAllowed
              ? null
              : <ChatBlockSegment key={i} segment={unit.segment} conversationId={conversationId} session={session} />
      ))}
      {/* UNGATED, on purpose: the strip is what makes a drop honest, so it cannot itself be
          conditional on the capability that caused the drop. */}
      <ChatViewNotices notices={[...notices, ...hostNotices]} />
      {/* Drawn, not linked: the board the answer just made, in the conversation. Only once
          it has stopped streaming — a path still being typed points at nothing. */}
      {item.done && onOpenBoard && boards.map((path) => (
        <BoardEmbed key={path} path={path} onOpenBoard={onOpenBoard} />
      ))}
      {onAction && <ActionRow actions={actions} onAction={onAction} />}
      {!readOnly && (
        <HoverActions>
          <IconButton label="Copy" onClick={() => copyText(item.text)}>⧉</IconButton>
          {onQuote && <IconButton label="Quote-reply" onClick={() => onQuote(item)}>↩</IconButton>}
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

function ThinkingBlock({ item, stretch, replyGroup }: { item: ChatThinkingItem; stretch: StepStretch; replyGroup?: string }) {
  // Open by default: the reasoning is worth reading in place; a click folds it away.
  const [open, setOpen] = useState(true);
  if (!item.text) return null;
  return (
    <ThinkingPill
      streaming={!item.done}
      tokens={estimateTokens(item.text)}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      body={<MarkdownPreview content={item.text} />}
      replyGroup={replyGroup}
      {...stretch}
    />
  );
}

// ─── Compaction ─────────────────────────────────────────────────────────────────────

/**
 * The line where the model's memory of this conversation turns into a summary, drawn in the
 * shared notice language (Notice.tsx): the drop is the big number and a before/after bar, not
 * a sentence. The summary is what the agent now works from, and the CLI never shows it to a
 * person, so it opens here.
 */
function CompactDivider({ item }: { item: ChatCompactItem }) {
  const [open, setOpen] = useState(false);
  const summary = item.summary;
  const measured = item.preTokens !== undefined && item.postTokens !== undefined;
  const auto = item.trigger === 'auto';
  if (item.status === 'error') {
    return (
      <div className="chat-m-compact" data-status={item.status}>
        <Notice tone="bad" slim icon={<Glyph.stack />} title="Compaction failed" />
      </div>
    );
  }
  const running = item.status === 'running';
  const drop = measured ? Math.round((1 - item.postTokens! / Math.max(1, item.preTokens!)) * 100) : null;
  return (
    <div className="chat-m-compact" data-status={item.status}>
      <Notice
        hero={running}
        icon={<Glyph.stack />}
        title={running
          ? <span className="chat-notice-live">Compacting conversation…</span>
          : auto ? 'Context auto-compacted' : 'Context compacted'}
        meta={measured ? <TokenDrop from={item.preTokens!} to={item.postTokens} /> : undefined}
      >
        {measured && (
          <ContextShrink
            from={item.preTokens!}
            to={item.postTokens}
            left={auto ? 'auto' : 'manual'}
            right={drop !== null && drop > 0 ? `−${drop}%` : undefined}
          />
        )}
        {summary && (
          <NoticeRow>
            <button type="button" className="chat-notice-btn chat-m-compact-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? 'Hide summary' : 'Show summary'} <Caret open={open} />
            </button>
          </NoticeRow>
        )}
        {open && summary && (
          <div className="chat-m-compact-body">
            <MarkdownPreview content={summary} />
          </div>
        )}
      </Notice>
    </div>
  );
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────────────

/** Where a step line sits in its speaker's stretch — see `stepStretches` (toolAction.ts). */
interface StepStretch {
  /** Who took the step. Absent reads as the lead. */
  actor?: AgentRoleId;
  /** Opens the stretch (shows the avatar) or follows it (keeps the column, hides the face). */
  stretch?: 'lead' | 'follow';
  /** A step in the stretch is running: the lead's avatar works. */
  stretchRunning?: boolean;
}

function ItemViewInner({
  item, session, onOpenFile, onOpenBoard, onAction, conversationId, onQuote, readOnly = false,
  actor, stretch, stretchRunning, replyGroup, onReplyJump, replyHeads, onReplyTarget,
}: StepStretch & {
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
  onQuote?: (item: ChatUserItem | ChatTextItem) => void;
  /** A Super view: the answer group this row belongs to (a thin line beside it). */
  replyGroup?: string;
  /** A Super view: his reply's strip scrolls to the message it names. */
  onReplyJump?: (ref: string, from: 'super' | 'owner', beforeId: string) => void;
  /** A Super view: a SECTIONED answer's heads (stable arrays, ChatPane's replyHeadsById). */
  replyHeads?: ReplyHead[];
  /** A Super view: a head's click lands on the message it names (one stable callback). */
  onReplyTarget?: (targetId: string, part?: number) => void;
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
          onReplyJump={onReplyJump}
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
          replyGroup={replyGroup}
          replyHeads={replyHeads}
          onReplyTarget={onReplyTarget}
        />
      );
    // Step lines: where they sit in their speaker's stretch is decided by the transcript
    // (ChatPane, the drill-in), which is the only place that can see the neighbours.
    case 'thinking':
      return <ThinkingBlock item={item} stretch={{ actor, stretch, stretchRunning }} replyGroup={replyGroup} />;
    case 'tool':
      return (
        <ToolCard
          item={item}
          onOpenFile={onOpenFile}
          actor={actor}
          stretch={stretch}
          stretchRunning={stretchRunning}
          replyGroup={replyGroup}
        />
      );
    case 'compact':
      return <CompactDivider item={item} />;
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
