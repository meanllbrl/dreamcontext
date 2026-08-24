/**
 * What an assistant answer is ASKING the Chat view to render, extracted from its markdown.
 *
 * Three things a plain transcript can't express, all written as ordinary markdown so a
 * terminal or a raw transcript still reads fine:
 *
 *   • a fenced ```dream-actions block — a JSON array that becomes a row of real buttons
 *     under the message (and is removed from the prose, so nobody reads raw JSON);
 *   • a fenced ```dream-view block — a JSON object ({@link ChatViewSpec} from
 *     `lib/chatViewSpec.ts`, `type: 'chart' | 'page' | 'checklist' | 'pin' | 'progress'`)
 *     that becomes a chart, a widget page, a pinned checklist card, or — for the last two —
 *     a row on the shelf docked to the composer rather than anything in the transcript;
 *   • a board reference — `![x](path.excalidraw.md)` / `[x](path.excalidraw)` — which
 *     becomes the DRAWN board rather than the broken `<img>` it would otherwise be.
 *
 * Pure and streaming-safe: called on every token of a still-streaming message, so a fence
 * that hasn't closed yet is HIDDEN rather than shown half-parsed, and nothing here touches
 * the DOM, the session, or the network. Validation of a `dream-view` payload itself (the
 * schema, the caps, the nesting rules) lives in `lib/chatViewSpec.ts` — this file only
 * finds the fence, hands its body to that validator, and folds the result back into the
 * prose split. `toAction` is exported so `parseViewBlock` can validate a card's `actions`
 * with the SAME rules a `dream-actions` button follows, without this module depending on
 * the spec module for anything but types.
 *
 * Kept in lockstep with `src/server/chat-surface.ts`, the briefing that tells the agent
 * these exist. A shape accepted here and not described there is unreachable; one described
 * there and not accepted here renders as a broken promise.
 */
import {
  parseViewBlock, MAX_VIEWS_PER_MESSAGE, type ChatViewSpec,
} from '../../../lib/chatViewSpec';

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

export interface ParsedAnswer {
  /** The prose to render, with action/view fences and board references removed. */
  body: string;
  actions: ChatAction[];
  /** Board paths, in the order the answer named them, de-duplicated. */
  boards: string[];
  /** Validated `dream-view` payloads, in fence order. */
  views: ChatViewSpec[];
  /** Human-readable degradation notices — a dropped widget, an unknown view type, a
   *  block that didn't parse. Additive to `body`, never a replacement for it: prose
   *  always survives a malformed block. */
  notices: string[];
  /** A `dream-view` fence is open at the end of the text and hasn't closed yet — render
   *  a "Building a view…" placeholder instead of nothing. */
  pendingView: boolean;
}

/** A row of buttons is a shortcut, not a menu — past this the answer should be prose. */
const MAX_ACTIONS = 6;

/** Closed ```dream-actions fence. Tolerates ~~~ and a trailing language-line space. */
const ACTION_FENCE_RE = /^([ \t]*)(```|~~~)[ \t]*dream-actions[ \t]*\r?\n([\s\S]*?)\r?\n?\1\2[ \t]*$/gim;
/** Closed ```dream-view fence — same shape as the actions fence, one JSON OBJECT instead
 *  of an array (the payload always carries its own `type` discriminator). */
const VIEW_FENCE_RE = /^([ \t]*)(```|~~~)[ \t]*dream-view[ \t]*\r?\n([\s\S]*?)\r?\n?\1\2[ \t]*$/gim;
/** Either fence still streaming — opened, never closed. Only ever the LAST thing in the
 *  text. One alternation covers both fence names so a still-writing `dream-view` (which
 *  can run 10-20KB before it closes) is hidden exactly like a still-writing `dream-actions`
 *  always has been — half-written JSON must never flash on screen either way. */
const OPEN_FENCE_RE = /^[ \t]*(```|~~~)[ \t]*dream-(?:actions|view)[ \t]*(\r?\n[\s\S]*)?$/im;
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

/** One entry of a `dream-actions` array (or a `card.actions` entry inside a `dream-view`
 *  page), or null if it can't be honoured as written. Exported so `parseViewBlock` can
 *  validate a card's buttons with the identical rules a `dream-actions` button follows —
 *  a button inside a page can never reach further than one in the action row already can. */
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
export function parseChatActions(text: string): ParsedAnswer {
  if (!text) return { body: '', actions: [], boards: [], views: [], notices: [], pendingView: false };

  const actions: ChatAction[] = [];
  const views: ChatViewSpec[] = [];
  const notices: string[] = [];

  let body = text.replace(ACTION_FENCE_RE, (_m, _indent, _fence, json: string) => {
    actions.push(...parseActionBlock(json));
    return '';
  });

  body = body.replace(VIEW_FENCE_RE, (_m, _indent, _fence, json: string) => {
    if (views.length >= MAX_VIEWS_PER_MESSAGE) {
      notices.push(`An answer asked for more than ${MAX_VIEWS_PER_MESSAGE} views — the extra ones were dropped.`);
      return '';
    }
    const { view, notices: blockNotices } = parseViewBlock(json, toAction);
    notices.push(...blockNotices);
    if (view) views.push(view);
    return '';
  });

  // Still being written: hide it until it closes, so the JSON never renders as prose. Only
  // a trailing open fence qualifies — an unclosed one earlier in the text would mean the
  // markdown is malformed anyway, and cutting from there would eat the real answer. Read
  // BEFORE stripping so we can tell which fence name was left open (only a `dream-view`
  // gets the "Building a view…" placeholder — `dream-actions` has never shown one).
  const openMatch = OPEN_FENCE_RE.exec(body);
  const pendingView = !!openMatch && /dream-view/i.test(openMatch[0]);
  body = body.replace(OPEN_FENCE_RE, '');

  const boards: string[] = [];
  body = body.replace(BOARD_REF_RE, (_m, path: string) => {
    if (!boards.includes(path)) boards.push(path);
    return '';
  });

  // Collapse the blank runs the removals left behind, so the prose doesn't gain a hole
  // where a fence used to be.
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  return { body, actions: actions.slice(0, MAX_ACTIONS), boards, views, notices, pendingView };
}
