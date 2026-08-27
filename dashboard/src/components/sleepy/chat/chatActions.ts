/**
 * What an assistant answer is ASKING the Chat view to render, extracted from its markdown.
 *
 * Four things a plain transcript can't express, all written as ordinary markdown so a
 * terminal or a raw transcript still reads fine:
 *
 *   • a fenced ```dream-actions block — a JSON array that becomes a row of real buttons
 *     under the message (and is removed from the prose, so nobody reads raw JSON);
 *   • a fenced ```dream-html block — HTML the agent WROTE, drawn in a network-less
 *     sandboxed iframe wearing dreamcontext's own CSS kit (`chat/chatHtmlKit.ts`). This is
 *     the surface's main expressive channel: it replaced the typed `chart`/`page` payloads
 *     on 2026-08-26, because a fixed widget vocabulary could only ever draw what we had
 *     already built;
 *   • a fenced ```dream-view block — a JSON object ({@link ChatViewSpec} from
 *     `lib/chatViewSpec.ts`, `type: 'insight' | 'checklist' | 'pin' | 'progress'`) for the
 *     four things HTML cannot be: a tracked metric's canonical rendering, an always-on-top
 *     OS window, and the two shelf rows docked to the composer;
 *   • a board reference — `![x](path.excalidraw.md)` / `[x](path.excalidraw)` — which
 *     becomes the DRAWN board rather than the broken `<img>` it would otherwise be.
 *
 * Pure and streaming-safe: called on every token of a still-streaming message, so a fence
 * that hasn't closed yet is HIDDEN rather than shown half-parsed, and nothing here touches
 * the DOM, the session, or the network. Validation of a `dream-view` payload itself (the
 * schema, the caps) lives in `lib/chatViewSpec.ts` — this file only finds the fence, hands
 * its body to that validator, and folds the result back into the prose split. A
 * `dream-html` body is NOT validated or sanitized anywhere: the iframe sandbox is the
 * boundary, not a filter (see `lib/sandboxHtml.ts` for the full argument).
 *
 * Kept in lockstep with `src/server/chat-surface.ts`, the briefing that tells the agent
 * these exist. A shape accepted here and not described there is unreachable; one described
 * there and not accepted here renders as a broken promise.
 */
import {
  parseViewBlock, MAX_VIEWS_PER_MESSAGE, type ChatViewSpec,
} from '../../../lib/chatViewSpec';
// The one markdown construct that cannot survive a document being split — see
// `buildSegments`. Imported rather than re-typed: the rule has one home.
import { LINK_DEF_RE } from '../../../lib/markdownBlocks';

export type ChatActionKind = 'task' | 'knowledge' | 'core' | 'file' | 'board' | 'reveal' | 'ask' | 'url' | 'develop';

const ACTION_KINDS = new Set<string>(['task', 'knowledge', 'core', 'file', 'board', 'reveal', 'ask', 'url', 'develop']);

export interface ChatAction {
  label: string;
  action: ChatActionKind;
  /** dreamcontext slug — `task` / `knowledge` / `core` / `develop`. */
  id?: string;
  /** Project-relative (or granted absolute) path — `file` / `board` / `reveal`. */
  path?: string;
  /** Text to load into the composer — `ask`. */
  text?: string;
  /** External URL to hand to the OS browser — `url`. `https:` only. */
  url?: string;
}

/** One rendered block, in the order the answer wrote it. */
export type ChatBlock =
  | { kind: 'view'; view: ChatViewSpec }
  | { kind: 'html'; html: string };

/**
 * One renderable RUN of an answer, in the order it was written — the unit the transcript
 * actually renders.
 *
 * This exists because `body` + `blocks` could not express what the surface briefing asks
 * the agent to write. Prose was merged into a single string and blocks handed back as a
 * separate list, so "here is the diagram, and here is what to notice about it" rendered as
 * both sentences THEN the diagram: the words that frame a card landed above it, and the
 * card read as an attachment rather than as part of the answer (owner report 2026-08-27 —
 * "kopuk bir şeymiş gibi hissettiriyor").
 *
 * `pending` is a segment too, and that is the whole reason it lives here instead of staying
 * a boolean: an open fence is always the LAST thing in the text, so a pending segment lands
 * exactly where the finished block will, and its placeholder can hold that slot instead of
 * sitting as a pill at the bottom of the message.
 */
export type ChatSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'view'; view: ChatViewSpec }
  | { kind: 'html'; html: string }
  /** A fence that hasn't closed yet. `partial` is the markup written so far — empty for a
   *  `view`, whose payload is JSON and has nothing legible to show mid-stream. */
  | { kind: 'pending'; fence: 'html' | 'view'; partial: string };

export interface ParsedAnswer {
  /**
   * Every prose run and block, interleaved in WRITTEN order — what the transcript renders.
   * Prefer this over `body` + `blocks`: those are the same content flattened, and a flat
   * body can no longer say where a block sat relative to the prose around it.
   */
  segments: ChatSegment[];
  /** The prose to render, with every fence and board reference removed — `segments`' prose
   *  runs joined back together. Kept for the consumers that only want text (and for the
   *  link-reference fallback, which renders exactly this). */
  body: string;
  actions: ChatAction[];
  /** Board paths, in the order the answer named them, de-duplicated. */
  boards: string[];
  /**
   * Every renderable block, interleaved in the order the answer wrote them. This is what
   * the transcript renders from; `views` below is the same data, filtered.
   */
  blocks: ChatBlock[];
  /** Validated `dream-view` payloads, in fence order — `blocks` without the html. Kept as
   *  its own field for the consumers that only ever want view specs (the composer shelf
   *  reads pins and progress straight off it, and never renders anything inline). */
  views: ChatViewSpec[];
  /** Human-readable degradation notices — a dropped widget, an unknown view type, a
   *  block that didn't parse. Additive to `body`, never a replacement for it: prose
   *  always survives a malformed block. */
  notices: string[];
  /** A `dream-view` or `dream-html` fence is open at the end of the text and hasn't closed
   *  yet. `segments` carries the same fact positionally (a trailing `pending` segment) plus
   *  the fence kind and the markup so far; this stays as the cheap boolean. */
  pendingView: boolean;
}

/** A row of buttons is a shortcut, not a menu — past this the answer should be prose. */
const MAX_ACTIONS = 6;
/** One HTML body's ceiling. Generous — this is a whole rendered explanation, sometimes a
 *  short deck — but bounded: an unbounded srcdoc is an unbounded string in the transcript's
 *  React tree, re-built on every streamed token of the message that follows it. */
export const MAX_HTML_BYTES = 256 * 1024;
/** How many HTML bodies one answer may draw. An answer that needs a sixth is an answer that
 *  should have been one page. */
export const MAX_HTMLS_PER_MESSAGE = 5;


/**
 * How a block's POSITION survives the replace pipeline.
 *
 * The fences are lifted out of the prose by `String.replace`, which knows where it is but
 * cannot report it. Rather than rewrite the pipeline into an offset-tracking scanner — and
 * re-derive every cap, every degradation notice and every ordering guarantee it already
 * gets right — each lifted fence leaves a marker naming its index, and the prose is split
 * back apart on those markers at the very end.
 *
 * NUL delimits them because NUL is stripped from the input first (see `parseChatActions`),
 * so an answer cannot forge one, and because it is not whitespace — a marker therefore
 * survives the blank-run collapse and the trim that follow it untouched.
 */
const blockSlot = (index: number) => `\n\u0000dcblock${index}\u0000\n`;
/** With a capture group, for `split` — yields [prose, index, prose, index, …]. */
const BLOCK_SLOT_RE = /\u0000dcblock(\d+)\u0000/;
/** Global and captureless, for flattening the markers back out of `body`. */
const BLOCK_SLOT_RE_G = /\u0000dcblock\d+\u0000/g;

/** Closed ```dream-actions fence. Tolerates ~~~ and a trailing language-line space. */
const ACTION_FENCE_RE = /^([ \t]*)(```|~~~)[ \t]*dream-actions[ \t]*\r?\n([\s\S]*?)\r?\n?\1\2[ \t]*$/gim;
/**
 * Closed ```dream-view AND ```dream-html fences, in ONE alternation.
 *
 * One regex rather than two passes because the fences are rendered in the order they were
 * written: an answer that draws a chart, explains it, then draws another must not come back
 * with both drawings above both explanations. Two sequential `.replace()` calls would lose
 * exactly that — every view before every html, whatever the author intended.
 */
const BLOCK_FENCE_RE = /^([ \t]*)(```|~~~)[ \t]*dream-(view|html)[ \t]*\r?\n([\s\S]*?)\r?\n?\1\2[ \t]*$/gim;
/** Any fence still streaming — opened, never closed. Only ever the LAST thing in the text.
 *  One alternation covers all three names so a still-writing `dream-view` or `dream-html`
 *  (either can run 10-20KB before it closes) is hidden exactly like a still-writing
 *  `dream-actions` always has been — half-written markup must never flash on screen. */
const OPEN_FENCE_RE = /^[ \t]*(```|~~~)[ \t]*dream-(actions|view|html)[ \t]*(\r?\n[\s\S]*)?$/im;
/** `![alt](x.excalidraw.md)` or `[alt](x.excalidraw)` — the board form. */
const BOARD_REF_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+\.excalidraw(?:\.md)?)>?\s*\)/gi;

/** `url` action target — `https:` only. This is the client-side gate; `openExternalUrl`
 *  layers a second, Rust-side scheme check (`plugin:shell|open`'s scope validator), so
 *  this is defense-in-depth, not the sole gate. */
function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A dreamcontext slug, as `develop` carries it. Bounded to 64 characters so a runaway string
 * can't ride into a prompt.
 *
 * HONEST LIMIT: this character class also matches `..`, so it is NOT a traversal guarantee
 * and must not be reused for anything that builds a path. It is safe HERE only because a
 * `develop` slug never becomes one on this side — it is interpolated into a prompt string
 * (`developKickoffPrompt`), which needs no escaping. The two places that DO resolve a slug
 * to a file resolve it themselves: the server's task routes gate on `isSafeTaskSlug`
 * (`src/lib/task-backend/local.ts`), and the spawned agent reads the task through the CLI.
 */
const SAFE_SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** One entry of a `dream-actions` array, or null if it can't be honoured as written. */
export function toAction(raw: unknown): ChatAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action.toLowerCase() : '';
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (!label || label.length > 80 || !ACTION_KINDS.has(action)) return null;

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const path = typeof o.path === 'string' ? o.path.trim() : '';
  const text = typeof o.text === 'string' ? o.text : '';
  const url = typeof o.url === 'string' ? o.url.trim() : '';

  // Each kind has exactly one payload it can act on. A button with nothing behind it is a
  // dead end the user still clicks, so it is dropped rather than rendered inert.
  switch (action as ChatActionKind) {
    case 'task': case 'knowledge': case 'core':
      return id ? { label, action: action as ChatActionKind, id } : null;
    // The Plan → Develop handoff: `id` is the task slug the planning half just created, and
    // clicking it opens a NEW chat in Develop mode carrying that slug (ChatPane routes it).
    // Stricter than the three above because this slug is the whole payload of a session
    // hand-off — a malformed one would seed an agent with a brief pointing nowhere.
    case 'develop':
      return SAFE_SLUG_RE.test(id) ? { label, action: 'develop', id } : null;
    case 'file': case 'board': case 'reveal':
      return path ? { label, action: action as ChatActionKind, path } : null;
    case 'ask':
      return text.trim() ? { label, action: 'ask', text } : null;
    case 'url':
      return isHttpsUrl(url) ? { label, action: 'url', url } : null;
    default:
      return null;
  }
}

/** The actions in one fence body, or `[]` for anything that isn't a usable JSON array. */
export function parseActionBlock(json: string): ChatAction[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(toAction).filter((a): a is ChatAction => a !== null);
}

/**
 * Split an assistant message into what to READ, what to CLICK, what to DRAW, and what to
 * RENDER as a chart/page/checklist.
 *
 * `body` always comes back safe to render: every action/view fence and board reference is
 * gone from it, including a fence still mid-stream (which would otherwise flash raw JSON at
 * the user for as long as it takes to write). A malformed `dream-view` block never blanks
 * the message — it is dropped and reported via `notices`, and the surrounding prose survives
 * untouched.
 */
export function parseChatActions(raw: string): ParsedAnswer {
  if (!raw) {
    return { segments: [], body: '', actions: [], boards: [], blocks: [], views: [], notices: [], pendingView: false };
  }

  // NUL goes first, before any marker can be planted: block positions ride through the
  // pipeline as NUL-delimited slot markers (`blockSlot`), so a NUL arriving in the answer
  // itself is the one way to forge one. Nothing legitimate in a message contains it.
  const text = raw.replace(/\u0000/g, '');

  const actions: ChatAction[] = [];
  const blocks: ChatBlock[] = [];
  const notices: string[] = [];
  let viewCount = 0;
  let htmlCount = 0;

  let body = text.replace(ACTION_FENCE_RE, (_m, _indent, _fence, json: string) => {
    actions.push(...parseActionBlock(json));
    return '';
  });

  // The two block fences share one pass so `blocks` comes out in WRITTEN order. The caps
  // are counted per kind, because they bound different things: how many objects the app is
  // asked to build, and how many sandboxes it is asked to mount.
  body = body.replace(BLOCK_FENCE_RE, (_m, _indent, _fence, name: string, payload: string) => {
    if (name.toLowerCase() === 'view') {
      if (viewCount >= MAX_VIEWS_PER_MESSAGE) {
        notices.push(`An answer asked for more than ${MAX_VIEWS_PER_MESSAGE} views — the extra ones were dropped.`);
        return '';
      }
      viewCount++;
      const { view, notices: blockNotices } = parseViewBlock(payload);
      notices.push(...blockNotices);
      // A block that survived validation leaves a slot marking where it was written; one
      // that didn't leaves nothing, exactly as before — a dropped block has no position.
      if (!view) return '';
      blocks.push({ kind: 'view', view });
      return blockSlot(blocks.length - 1);
    }

    if (htmlCount >= MAX_HTMLS_PER_MESSAGE) {
      notices.push(`An answer asked for more than ${MAX_HTMLS_PER_MESSAGE} HTML blocks — the extra ones were dropped.`);
      return '';
    }
    htmlCount++;
    const bytes = new TextEncoder().encode(payload).length;
    if (bytes > MAX_HTML_BYTES) {
      notices.push(`An HTML block was skipped — it is ${bytes} bytes, over the ${MAX_HTML_BYTES / 1024}KB limit.`);
      return '';
    }
    if (!payload.trim()) return '';
    blocks.push({ kind: 'html', html: payload });
    return blockSlot(blocks.length - 1);
  });

  // Still being written: hide it until it closes, so the JSON never renders as prose. Only
  // a trailing open fence qualifies — an unclosed one earlier in the text would mean the
  // markdown is malformed anyway, and cutting from there would eat the real answer. Read
  // BEFORE stripping, because two things are needed out of it: which fence name was left
  // open (`dream-actions` has never shown a placeholder), and for a `dream-html`, the
  // markup written so far — the placeholder reads the titles already in it, which is what
  // makes it look like something is being DRAWN there rather than stalled.
  const openMatch = OPEN_FENCE_RE.exec(body);
  const openName = openMatch?.[2]?.toLowerCase();
  const pendingFence: 'html' | 'view' | null =
    openName === 'html' ? 'html' : openName === 'view' ? 'view' : null;
  const pendingPartial = pendingFence === 'html' ? (openMatch?.[3] ?? '') : '';
  body = body.replace(OPEN_FENCE_RE, '');

  const boards: string[] = [];
  body = body.replace(BOARD_REF_RE, (_m, path: string) => {
    if (!boards.includes(path)) boards.push(path);
    return '';
  });

  // Collapse the blank runs the removals left behind, so the prose doesn't gain a hole
  // where a fence used to be. Applied to the slotted string and the flattened one alike:
  // a slot marker is not whitespace, so it survives both untouched.
  const slotted = tidyProse(body);
  const flatBody = tidyProse(body.replace(BLOCK_SLOT_RE_G, ''));

  const views = blocks.flatMap((b) => (b.kind === 'view' ? [b.view] : []));
  return {
    segments: buildSegments(slotted, flatBody, blocks, pendingFence, pendingPartial),
    body: flatBody,
    actions: actions.slice(0, MAX_ACTIONS),
    boards,
    blocks,
    views,
    notices,
    pendingView: pendingFence !== null,
  };
}

/** One prose run, with the holes the lifted fences left in it closed up. */
function tidyProse(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The slotted prose split back apart into segments — prose runs and blocks, interleaved in
 * the order they were written.
 *
 * ONE bail-out, and it is inherited rather than invented: a link reference definition
 * (`[id]: https://…`) is document state the markdown lexer resolves against the WHOLE text
 * (see `lib/markdownBlocks.ts`, which bails out of block-level rendering for the same
 * reason). Split the prose and a definition written on one side of a block no longer reaches
 * a use on the other — `[text][id]` renders as literal brackets. A message containing one
 * therefore falls back to the pre-2026-08-27 layout: all the prose, then the blocks. A worse
 * ORDER, never a broken link.
 */
function buildSegments(
  slotted: string,
  flatBody: string,
  blocks: ChatBlock[],
  pendingFence: 'html' | 'view' | null,
  pendingPartial: string,
): ChatSegment[] {
  const segments: ChatSegment[] = [];

  if (LINK_DEF_RE.test(flatBody)) {
    if (flatBody) segments.push({ kind: 'prose', text: flatBody });
    segments.push(...blocks);
  } else {
    // `split` with a capture group yields [prose, index, prose, index, …] — the odd
    // positions are a slot's block index, the even ones the prose around it.
    slotted.split(BLOCK_SLOT_RE).forEach((part, i) => {
      if (i % 2 === 1) {
        const block = blocks[Number(part)];
        if (block) segments.push(block);
        return;
      }
      const prose = tidyProse(part);
      if (prose) segments.push({ kind: 'prose', text: prose });
    });
  }

  // Always last, because an open fence is by definition the last thing in the text.
  if (pendingFence) segments.push({ kind: 'pending', fence: pendingFence, partial: pendingPartial });
  return segments;
}
