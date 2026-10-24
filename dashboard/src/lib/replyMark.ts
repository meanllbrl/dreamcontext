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
 * mark counts, the refs are their union in order, and none of them is ever shown. A mark naming
 * more than three, or written with commas or capitals, is still a mark: never shown either.
 *
 * STREAMING, the notch cue's rule (notchCue.ts): while the head could still become a mark it is
 * `pending`, nothing is drawn or spoken, and after REPLY_MARK_HEAD_MAX characters without a
 * closing `-->` it is plain text. A section mark still arriving at the end of the text is held
 * back from the body the same way.
 *
 * SECTIONS (owner 2026-10-24, pick A: inside one reply every part opens with the chip of the
 * message it answers): each line-start mark also starts a section at its offset in the body.
 * A mark inside a fence (``` or ~~~, any indent, still open at the end too) starts none, though
 * its refs stay in the union; marks with only whitespace between them merge into one section
 * naming all their refs; a last section with no words yet is left out, so a head never shows
 * before what it heads; text before the first mark is a preamble, no section. `refs` and `body`
 * are what they were before sections existed.
 */
import { REPLY_MARK_HEAD_MAX, REPLY_MARK_LINE_RE, REPLY_MARK_RE } from './superTypes';

export interface SplitReplyMark {
  /** The refs it names, or [] when the block has no mark. */
  refs: string[];
  /** The text without its mark line. Empty while `pending`. */
  body: string;
  /** The head may still turn out to be a mark: show nothing yet. */
  pending: boolean;
  /** Where each section starts in `body`, with the refs its mark named (may be []), in order. */
  sections: ReplySection[];
}

export interface ReplySection { at: number; refs: string[] }

const OPEN = '<!--';
const MSG_REF = /^[0-9a-z]{6}$/;
const WORD = 're:';

/** Could this (a line's start) still become a mark? */
function couldBeMark(fragment: string): boolean {
  const head = fragment.trimStart();
  if (head.length < OPEN.length) return OPEN.startsWith(head);
  const word = head.slice(OPEN.length).trimStart();
  // A mark is one line: a head that broke its line without closing is text.
  return head.startsWith(OPEN) && !head.includes('-->') && !head.includes('\n') && head.length <= REPLY_MARK_HEAD_MAX
    && (word.length <= WORD.length ? WORD.startsWith(word) : word.startsWith(WORD) && /^[0-9a-zA-Z,\s]*-{0,2}$/.test(word.slice(WORD.length)));
}

export function splitReplyMark(raw: string): SplitReplyMark {
  const text = raw ?? '';
  if (!REPLY_MARK_RE.test(text) && couldBeMark(text)) return { refs: [], body: '', pending: true, sections: [] };
  const refs: string[] = [];
  const fenced = fenceSpans(text);
  const marks: ReplySection[] = [];
  let body = '';
  let from = 0;
  for (const m of text.matchAll(REPLY_MARK_LINE_RE)) {
    const pre = m[1];
    const named: string[] = [];
    // Any `<!-- re:… -->` line is ours and goes; only well-formed refs count.
    for (const r of m[2].toLowerCase().split(/[\s,]+/)) {
      if (!MSG_REF.test(r)) continue;
      if (!refs.includes(r)) refs.push(r);
      if (!named.includes(r)) named.push(r);
    }
    body += text.slice(from, m.index) + pre;
    from = m.index! + m[0].length;
    const line = m.index! + pre.length;
    if (!fenced.some(([a, b]) => line > a && line < b)) marks.push({ at: body.length, refs: named });
  }
  body += text.slice(from);
  // A section mark still arriving: hold it back, never draw or speak half of it.
  const tail = /\n([ \t]*<[^\n]*)$/.exec(body);
  if (tail && couldBeMark(tail[1])) body = body.slice(0, tail.index + 1);
  return { refs, body, pending: false, sections: sectionsOf(marks, body) };
}

/** Marks with nothing but whitespace between them become one section; a last one with no words
 *  yet is dropped. */
function sectionsOf(marks: ReplySection[], body: string): ReplySection[] {
  const out: ReplySection[] = [];
  for (const mark of marks) {
    const at = Math.min(mark.at, body.length);
    const prev = out[out.length - 1];
    if (prev && !body.slice(prev.at, at).trim()) {
      out[out.length - 1] = { at, refs: [...prev.refs, ...mark.refs.filter((r) => !prev.refs.includes(r))] };
    } else {
      out.push({ at, refs: mark.refs });
    }
  }
  const last = out[out.length - 1];
  if (last && !body.slice(last.at).trim()) out.pop();
  return out;
}

/** The fences in `text` as [opening line start, closing line start] (an open one runs to the
 *  end): the grammar `chatActions.ts` reads, ``` or ~~~ under any indent, closed by the same. */
function fenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let open: { at: number; indent: string; fence: string } | null = null;
  let at = 0;
  for (const line of text.split('\n')) {
    if (!open) {
      const m = /^([ \t]*)(```|~~~)/.exec(line);
      if (m) open = { at, indent: m[1], fence: m[2] };
    } else if (new RegExp(`^${open.indent}${open.fence}[ \\t]*\\r?$`).test(line)) {
      spans.push([open.at, at]);
      open = null;
    }
    at += line.length + 1;
  }
  if (open) spans.push([open.at, Infinity]);
  return spans;
}

/** The text without its marks — for surfaces that only draw (a replayed transcript). */
export function stripReplyMark(raw: string): string {
  return (raw ?? '').replace(REPLY_MARK_LINE_RE, '$1');
}
