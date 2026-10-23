/**
 * The Super Agent's REPLY MARK (owner 2026-10-23: which answer is to which of his messages): one
 * invisible line at the head of a text block naming the owner messages it answers,
 *
 *   <!-- re:k3f9q0 -->            one message
 *   <!-- re:k3f9q0 a1b2c3 -->     several (at most three)
 *
 * Every owner message reaches the super with `<owner-msg ref="…"/>` (the server's block), and
 * the ref is `msgRef` of his words. An HTML comment on purpose: anywhere the mark slips through
 * unparsed markdown draws nothing for it.
 *
 * A block that answers several messages may instead open a SECTION per message, each with its
 * own mark on its own line (what the real model does, measured 2026-10-23): every line-start
 * mark counts, the refs are their union in order, and none of them is ever shown.
 *
 * STREAMING, the notch cue's rule (notchCue.ts): while the head could still become a mark it is
 * `pending`, nothing is drawn or spoken, and after REPLY_MARK_HEAD_MAX characters without a
 * closing `-->` it is plain text. A section mark still arriving at the end of the text is held
 * back from the body the same way.
 */
import { REPLY_MARK_HEAD_MAX, REPLY_MARK_LINE_RE, REPLY_MARK_RE } from './superTypes';

export interface SplitReplyMark {
  /** The refs it names, or [] when the block has no mark. */
  refs: string[];
  /** The text without its mark line. Empty while `pending`. */
  body: string;
  /** The head may still turn out to be a mark: show nothing yet. */
  pending: boolean;
}

const OPEN = '<!--';
const WORD = 're:';

/** Could this (a line's start) still become a mark? */
function couldBeMark(fragment: string): boolean {
  const head = fragment.trimStart();
  if (head.length < OPEN.length) return OPEN.startsWith(head);
  const word = head.slice(OPEN.length).trimStart();
  return head.startsWith(OPEN) && !head.includes('-->') && head.length <= REPLY_MARK_HEAD_MAX
    && (word.length <= WORD.length ? WORD.startsWith(word) : word.startsWith(WORD) && /^[0-9a-z\s]*-{0,2}$/.test(word.slice(WORD.length)));
}

export function splitReplyMark(raw: string): SplitReplyMark {
  const text = raw ?? '';
  if (!REPLY_MARK_RE.test(text) && couldBeMark(text)) return { refs: [], body: '', pending: true };
  const refs: string[] = [];
  let body = text.replace(REPLY_MARK_LINE_RE, (_m, pre: string, named: string) => {
    for (const r of named.trim().split(/\s+/)) if (!refs.includes(r)) refs.push(r);
    return pre;
  });
  // A section mark still arriving: hold it back, never draw or speak half of it.
  const tail = /\n([ \t]*<[^\n]*)$/.exec(body);
  if (tail && couldBeMark(tail[1])) body = body.slice(0, tail.index + 1);
  return { refs, body, pending: false };
}

/** The text without its marks — for surfaces that only draw (a replayed transcript). */
export function stripReplyMark(raw: string): string {
  return (raw ?? '').replace(REPLY_MARK_LINE_RE, '$1');
}
