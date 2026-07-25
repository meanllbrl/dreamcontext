/**
 * What an assistant answer is ASKING the Chat view to render, extracted from its markdown.
 *
 * Two things a plain transcript can't express, both written as ordinary markdown so a
 * terminal or a raw transcript still reads fine:
 *
 *   • a fenced ```dream-actions block — a JSON array that becomes a row of real buttons
 *     under the message (and is removed from the prose, so nobody reads raw JSON);
 *   • a board reference — `![x](path.excalidraw.md)` / `[x](path.excalidraw)` — which
 *     becomes the DRAWN board rather than the broken `<img>` it would otherwise be.
 *
 * Pure and streaming-safe: called on every token of a still-streaming message, so a fence
 * that hasn't closed yet is HIDDEN rather than shown half-parsed, and nothing here touches
 * the DOM, the session, or the network.
 *
 * Kept in lockstep with `src/server/chat-surface.ts`, the briefing that tells the agent
 * these exist. A shape accepted here and not described there is unreachable; one described
 * there and not accepted here renders as a broken promise.
 */

export type ChatActionKind = 'task' | 'knowledge' | 'core' | 'file' | 'board' | 'reveal' | 'ask';

const ACTION_KINDS = new Set<string>(['task', 'knowledge', 'core', 'file', 'board', 'reveal', 'ask']);

export interface ChatAction {
  label: string;
  action: ChatActionKind;
  /** dreamcontext slug — `task` / `knowledge` / `core`. */
  id?: string;
  /** Project-relative (or granted absolute) path — `file` / `board` / `reveal`. */
  path?: string;
  /** Text to load into the composer — `ask`. */
  text?: string;
}

export interface ParsedAnswer {
  /** The prose to render, with action fences and board references removed. */
  body: string;
  actions: ChatAction[];
  /** Board paths, in the order the answer named them, de-duplicated. */
  boards: string[];
}

/** A row of buttons is a shortcut, not a menu — past this the answer should be prose. */
const MAX_ACTIONS = 6;

/** Closed ```dream-actions fence. Tolerates ~~~ and a trailing language-line space. */
const ACTION_FENCE_RE = /^([ \t]*)(```|~~~)[ \t]*dream-actions[ \t]*\r?\n([\s\S]*?)\r?\n?\1\2[ \t]*$/gim;
/** The same fence still streaming — opened, never closed. Only ever the LAST thing in the text. */
const OPEN_ACTION_FENCE_RE = /^[ \t]*(```|~~~)[ \t]*dream-actions[ \t]*(\r?\n[\s\S]*)?$/im;
/** `![alt](x.excalidraw.md)` or `[alt](x.excalidraw)` — the board form. */
const BOARD_REF_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+\.excalidraw(?:\.md)?)>?\s*\)/gi;

/** One entry of a `dream-actions` array, or null if it can't be honoured as written. */
function toAction(raw: unknown): ChatAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action.toLowerCase() : '';
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (!label || label.length > 80 || !ACTION_KINDS.has(action)) return null;

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const path = typeof o.path === 'string' ? o.path.trim() : '';
  const text = typeof o.text === 'string' ? o.text : '';

  // Each kind has exactly one payload it can act on. A button with nothing behind it is a
  // dead end the user still clicks, so it is dropped rather than rendered inert.
  switch (action as ChatActionKind) {
    case 'task': case 'knowledge': case 'core':
      return id ? { label, action: action as ChatActionKind, id } : null;
    case 'file': case 'board': case 'reveal':
      return path ? { label, action: action as ChatActionKind, path } : null;
    case 'ask':
      return text.trim() ? { label, action: 'ask', text } : null;
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
 * Split an assistant message into what to READ, what to CLICK, and what to DRAW.
 *
 * `body` always comes back safe to render: every action fence and board reference is gone
 * from it, including a fence still mid-stream (which would otherwise flash raw JSON at the
 * user for as long as it takes to write).
 */
export function parseChatActions(text: string): ParsedAnswer {
  if (!text) return { body: '', actions: [], boards: [] };

  const actions: ChatAction[] = [];
  let body = text.replace(ACTION_FENCE_RE, (_m, _indent, _fence, json: string) => {
    actions.push(...parseActionBlock(json));
    return '';
  });

  // Still being written: hide it until it closes, so the JSON never renders as prose. Only
  // a trailing open fence qualifies — an unclosed one earlier in the text would mean the
  // markdown is malformed anyway, and cutting from there would eat the real answer.
  body = body.replace(OPEN_ACTION_FENCE_RE, '');

  const boards: string[] = [];
  body = body.replace(BOARD_REF_RE, (_m, path: string) => {
    if (!boards.includes(path)) boards.push(path);
    return '';
  });

  // Collapse the blank runs the removals left behind, so the prose doesn't gain a hole
  // where a fence used to be.
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  return { body, actions: actions.slice(0, MAX_ACTIONS), boards };
}
