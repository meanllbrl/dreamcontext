/**
 * ⌘F inside the Chat view — the pure half: which keystroke opens the bar, and where a query
 * lands in a run of text nodes.
 *
 * The desktop app is a WKWebView, which has no find-in-page of its own: ⌘F did nothing, and a
 * long conversation could only be searched by scrolling. The bar (`ChatFindBar`) walks the
 * transcript's text nodes and hands their strings here; what comes back is node/offset pairs
 * it can turn into DOM Ranges and paint with the Custom Highlight API — nothing is inserted
 * into a DOM React owns and re-renders on every streamed token.
 *
 * Matching runs over the JOINED text, so a phrase split across nodes (`foo **bar**` renders as
 * two text nodes) is still one match.
 */

export interface FindKeyStroke {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌘F on macOS, Ctrl+F elsewhere. Alt is left alone (⌥⌘F is the system's replace chord). */
export function isFindChord(e: FindKeyStroke): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f';
}

/** ⌘G / ⇧⌘G — the platform's "find next / previous", honoured while the bar is open. */
export function findStepOf(e: FindKeyStroke): 1 | -1 | 0 {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'g') return 0;
  return e.shiftKey ? -1 : 1;
}

/**
 * Fold ONE character for comparison, always to exactly one character — offsets into the
 * folded string must stay offsets into the source. `'İ'.toLowerCase()` is two code units
 * (i + combining dot), which would shift every match after it, so a fold that changes length
 * keeps the original. The Turkish i family (I ı İ i) folds together: the owner types Turkish
 * on an English keyboard as often as not, and "sıfır" must find "sifir".
 */
function foldChar(ch: string): string {
  if (ch === 'I' || ch === 'ı' || ch === 'İ') return 'i';
  const l = ch.toLowerCase();
  return l.length === 1 ? l : ch;
}

export function foldText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
  return out;
}

/** A position in the node list: the node's index and the offset inside its text. */
export type TextPoint = [node: number, offset: number];
export interface TextMatch { start: TextPoint; end: TextPoint }

/** Past this many hits the bar stops counting — painting 10k ranges on a one-letter query
 *  freezes the pane for nothing a reader can use. */
export const MAX_MATCHES = 1000;

export function locateMatches(texts: readonly string[], query: string, max = MAX_MATCHES): TextMatch[] {
  const needle = foldText(query.trim());
  if (!needle) return [];
  const starts: number[] = [];
  let joined = '';
  for (const t of texts) { starts.push(joined.length); joined += t; }
  const hay = foldText(joined);

  /** The node an absolute offset falls in. `end` points ride on the node they close, so a
   *  match ending exactly at a node boundary does not spill into the next node at offset 0. */
  const pointAt = (abs: number, isEnd: boolean): TextPoint => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const s = starts[mid];
      if (s < abs || (!isEnd && s === abs)) lo = mid; else hi = mid - 1;
    }
    // Skip empty nodes a start offset would otherwise land on.
    while (!isEnd && lo < texts.length - 1 && texts[lo].length === abs - starts[lo]) lo++;
    return [lo, abs - starts[lo]];
  };

  const out: TextMatch[] = [];
  let from = 0;
  while (out.length < max) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    out.push({ start: pointAt(at, false), end: pointAt(at + needle.length, true) });
    from = at + needle.length;
  }
  return out;
}
