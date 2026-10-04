/**
 * The Assistant's NOTCH CUES: one invisible line at the head of each text block, saying how the
 * notch should show it. The Assistant decides (owner, 2026-10-04: "the agent decides … so that
 * the experience is seamless"); its briefing lists the three forms (src/server/chat-modes.ts):
 *
 *   <!-- notch:progress -->      an interim line: silent, a short peek that folds by itself
 *   <!-- notch:present -->       the answer: the notch opens, reads it aloud, folds after
 *   <!-- notch:present stay -->  the same, but stays open after speaking
 *
 * An HTML comment on purpose: anywhere the cue slips through unparsed (a renderer that never
 * heard of it, an old transcript) markdown draws nothing for it.
 *
 * STREAMING. A block arrives a few characters at a time, so a head like `<!-- no` is not yet
 * a cue and not yet text. While the head could still become a cue it is `pending` — nothing is
 * drawn or spoken — and after HEAD_MAX characters without a closing `-->` it is plain text.
 */

export type NotchCueKind = 'progress' | 'present';
export interface NotchCue { kind: NotchCueKind; stay: boolean }

export interface SplitCue {
  /** The cue, or null when the block has none (it is shown as an answer, the old behaviour). */
  cue: NotchCue | null;
  /** The text without its cue line. Empty while `pending`. */
  body: string;
  /** The head may still turn out to be a cue: show nothing yet. */
  pending: boolean;
}

const OPEN = '<!--';
/** Longer than any real cue line; a comment still open past this is not one of ours. */
const HEAD_MAX = 48;
const CUE_RE = /^\s*<!--\s*notch\s*:\s*(progress|present)(\s+stay)?\s*-->[ \t]*(?:\r?\n)?/i;

export function splitNotchCue(raw: string): SplitCue {
  const text = raw ?? '';
  const m = CUE_RE.exec(text);
  if (m) {
    return { cue: { kind: m[1].toLowerCase() as NotchCueKind, stay: !!m[2] }, body: text.slice(m[0].length), pending: false };
  }
  const head = text.trimStart();
  // Could this still become a cue? Only while it is a prefix of an open comment that has not
  // closed, is still short, and whose first word is (on its way to being) `notch`.
  let couldBe: boolean;
  if (head.length < OPEN.length) {
    couldBe = OPEN.startsWith(head);
  } else {
    const word = head.slice(OPEN.length).trimStart().toLowerCase();
    couldBe = head.startsWith(OPEN) && !head.includes('-->') && head.length <= HEAD_MAX
      && (word === '' || 'notch'.startsWith(word.slice(0, 5)) && (word.length <= 5 || word.startsWith('notch')));
  }
  if (couldBe) return { cue: null, body: '', pending: true };
  return { cue: null, body: text, pending: false };
}

/** The text with any leading cue removed — for surfaces that only draw (a replayed transcript). */
export function stripNotchCue(raw: string): string {
  const m = CUE_RE.exec(raw ?? '');
  return m ? raw.slice(m[0].length) : raw;
}

/**
 * How long an interim line or an unspoken answer stays up before the notch folds it: long
 * enough to read at a glance (about 15 characters a second), never a blink and never a wall.
 */
export function readingTimeMs(text: string, opts: { min?: number; max?: number } = {}): number {
  const min = opts.min ?? 3000;
  const max = opts.max ?? 14000;
  const chars = (text ?? '').replace(/\s+/g, ' ').trim().length;
  return Math.round(Math.min(max, Math.max(min, 1800 + chars * 65)));
}
