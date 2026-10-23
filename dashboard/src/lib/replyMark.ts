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
 * STREAMING, the notch cue's rule (notchCue.ts): while the head could still become a mark it is
 * `pending`, nothing is drawn or spoken, and after REPLY_MARK_HEAD_MAX characters without a
 * closing `-->` it is plain text.
 */
import { REPLY_MARK_HEAD_MAX, REPLY_MARK_RE } from './superTypes';

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

export function splitReplyMark(raw: string): SplitReplyMark {
  const text = raw ?? '';
  const m = REPLY_MARK_RE.exec(text);
  if (m) return { refs: m[1].trim().split(/\s+/), body: text.slice(m[0].length), pending: false };
  const head = text.trimStart();
  let couldBe: boolean;
  if (head.length < OPEN.length) {
    couldBe = OPEN.startsWith(head);
  } else {
    const word = head.slice(OPEN.length).trimStart();
    couldBe = head.startsWith(OPEN) && !head.includes('-->') && head.length <= REPLY_MARK_HEAD_MAX
      && (word.length <= WORD.length ? WORD.startsWith(word) : word.startsWith(WORD) && /^[0-9a-z\s]*-{0,2}$/.test(word.slice(WORD.length)));
  }
  if (couldBe) return { refs: [], body: '', pending: true };
  return { refs: [], body: text, pending: false };
}

/** The text with any leading mark removed — for surfaces that only draw (a replayed transcript). */
export function stripReplyMark(raw: string): string {
  const m = REPLY_MARK_RE.exec(raw ?? '');
  return m ? raw.slice(m[0].length) : raw;
}
