/**
 * Turn a chunk of the agent's written reply into something worth hearing.
 *
 * THIS IS THE LAST LINE OF DEFENCE, NOT THE FIRST. The client's chunker
 * (`dashboard/src/lib/voice/speechQueue.ts`) never hands this function a fenced block in the
 * first place, and it must not: by the time a `dream-html` block reached here it would
 * already have been carved into "sentences" at every `.` inside a CSS rule, and no amount of
 * stripping reassembles that. What this function is for is the residue — a bolded phrase, a
 * stray URL, an em dash — that survives ordinary prose.
 *
 * Every rule below exists because the string is about to be SPOKEN:
 *   • Markdown emphasis is read as asterisks by some voices and silently by others; neither
 *     is what the writer meant.
 *   • A URL is read character by character. One link can outlast the sentence around it.
 *   • A file path is worse: slashes, dots and extensions, each announced.
 *   • An em dash gets no pause from most engines, so the clause it separates runs on. A
 *     comma does get one, which is what the dash was standing in for.
 *
 * Pure and synchronous, so it is testable without a browser, a network or a clock.
 */

/** A fenced block, in any of the surface's flavours. Defence in depth: the chunker excludes
 *  these, and if one ever slips through, it is dropped here rather than read aloud. */
const FENCE_BLOCK = /```[\s\S]*?(?:```|$)/g;

/** Inline code. The BACKTICKS go; the text inside usually still reads fine aloud. */
const INLINE_CODE = /`([^`]*)`/g;

/** A markdown link — keep the label, drop the target. `[the handbook](docs/x.pdf)`. */
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** A bare URL. */
const BARE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * A path-shaped token: two or more slash-separated segments, or a leading `./` `../` `/` `~/`.
 * Deliberately narrow — "and/or" is not a path, and a sentence should not lose a word to
 * this rule. A single `foo/bar` with no extension is left alone for the same reason.
 */
const FILE_PATH = /(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)*|\b[\w.-]+\/[\w.-]+\/[\w./-]*\.\w{1,5}\b/g;

/** Markdown emphasis markers, heading hashes, list bullets, blockquote carets. */
const EMPHASIS = /(\*\*|__|\*|_|~~)/g;
const LINE_PREFIX = /^[ \t]*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+[.)]\s+)/gm;

/** The `==highlight==` pen and its coloured variants — surface syntax, not speech. */
const HIGHLIGHT = /==[+!]?([^=]*)==/g;

/**
 * Strip a written chunk down to what should be read aloud.
 *
 * Returns `''` when nothing speakable survives — a chunk that was ONLY a link, or only a
 * fence. The caller treats an empty result as "skip this chunk", never as "speak silence".
 */
export function speakable(input: string): string {
  if (!input) return '';
  let out = input;

  out = out.replace(FENCE_BLOCK, ' ');
  out = out.replace(MD_LINK, '$1');
  out = out.replace(HIGHLIGHT, '$1');
  out = out.replace(INLINE_CODE, '$1');
  out = out.replace(BARE_URL, ' ');
  out = out.replace(FILE_PATH, ' ');
  out = out.replace(LINE_PREFIX, '');
  out = out.replace(EMPHASIS, '');

  // Dashes → a comma, because a comma is the pause the dash was standing for. The trailing
  // space handling matters: "one — two" must become "one, two", not "one , two".
  out = out.replace(/\s*[—–]\s*/g, ', ');

  // Table pipes and rule lines are structure, not speech.
  out = out.replace(/^\s*\|.*\|\s*$/gm, ' ');
  out = out.replace(/^\s*([-*_]\s*){3,}$/gm, ' ');

  // Collapse whitespace last, so every substitution above can leave a space behind safely.
  out = out.replace(/\s+/g, ' ').trim();

  // A chunk that is now only punctuation says nothing. Speaking it wastes a call and a
  // second of the owner's time on a noise.
  if (!/[\p{L}\p{N}]/u.test(out)) return '';
  return out;
}
