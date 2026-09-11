/**
 * Mark the sentence J.A.R.V.I.S is SAYING, inside the message it is saying it from.
 *
 * The owner, 2026-09-12: "you could highlight whichever sentence it is reading, so people can
 * follow it." Speech and the transcript were two separate channels — the answer scrolls past
 * at writing speed while the voice is three sentences behind it, and there was nothing on
 * screen tying one to the other.
 *
 * ── WHY THE CSS CUSTOM HIGHLIGHT API AND NOT A <mark> ───────────────────────────────────
 * Wrapping text in an element means MUTATING a DOM that React owns and re-renders on every
 * streamed token. The wrapper would be torn out by the next render, and worse, an insertion
 * between two renders is exactly how a reconciler ends up removing the wrong node. The
 * Highlight API paints Ranges instead: nothing is inserted, nothing is moved, and a re-render
 * simply invalidates ranges we rebuild on the next chunk anyway.
 *
 * It is a PROGRESSIVE ENHANCEMENT by construction. Where `CSS.highlights` does not exist the
 * hook does nothing at all and the mode is exactly as it was — a marker is worth having and
 * is not worth breaking a transcript for.
 *
 * ── WHY THE MATCH IS FUZZY ──────────────────────────────────────────────────────────────
 * The spoken chunk is a slice of the RAW markdown ("**Bak**, ekrana koyuyorum.") while the
 * DOM holds the RENDERED text ("Bak, ekrana koyuyorum") with the emphasis markers gone and
 * whitespace collapsed. An exact search finds nothing on any sentence that carries formatting
 * — which, in this surface, is most of them. So both sides are reduced to letters, digits and
 * single spaces before the search, and the match is mapped back to real DOM offsets.
 */

import { useEffect, type RefObject } from 'react';
import type { SpokenChunk } from '../../../lib/voice/speechQueue';
import type { ChatSession } from '../chatSession';

/** The highlight's registry name. Matches the `::highlight()` rule in `cards.css`. */
export const SPOKEN_HIGHLIGHT = 'dc-spoken';

/** The Highlight API, as much of it as this file uses. Typed locally because `lib.dom` in the
 *  TypeScript version this project builds with does not declare it yet. */
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
interface HighlightCtor { new (...ranges: Range[]): unknown }

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && ctor ? css.highlights : null;
}

/**
 * Which message currently owns the registry entry.
 *
 * The registry is GLOBAL and there is exactly one spoken chunk at a time, so every mounted
 * message subscribes and all but one of them clear. Without an owner, the message that is NOT
 * speaking would delete the entry the speaking one just wrote, on the same event — the marker
 * would flicker or never appear at all, depending on subscription order.
 */
let owner: object | null = null;

/** Letters, digits and single spaces — the form both sides are compared in. Returns the
 *  normalised string plus, for each character in it, its index in the source. */
function normalize(source: string): { text: string; index: number[] } {
  let text = '';
  const index: number[] = [];
  let lastWasSpace = true;                        // leading whitespace is dropped outright
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      text += ' ';
      index.push(i);
      lastWasSpace = true;
      continue;
    }
    // Everything that is not a letter or a number is DROPPED rather than kept: it is exactly
    // the set that differs between the markdown and the render (asterisks, backticks, the
    // punctuation a renderer may turn into an entity).
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    text += ch.toLowerCase();
    index.push(i);
    lastWasSpace = false;
  }
  return { text, index };
}

/** The shortest chunk worth locating. Below this a match is as likely to be a coincidence
 *  somewhere else in the paragraph as it is to be the sentence being spoken. */
export const MIN_MATCH_CHARS = 3;

/**
 * Where `chunk` sits inside `all`, as offsets into `all` ITSELF — not into its normalised
 * form. `null` when it is not there.
 *
 * Pure, and separated from the DOM for exactly that reason: the arithmetic that maps a match
 * in the reduced string back to the original is the part that is easy to get subtly wrong,
 * and a highlight that lands half a word out is invisible until someone watches it.
 */
export function matchSpan(all: string, chunk: string): { from: number; to: number } | null {
  const wanted = normalize(chunk).text.trim();
  if (wanted.length < MIN_MATCH_CHARS) return null;
  const hay = normalize(all);
  const at = hay.text.indexOf(wanted);
  if (at < 0) return null;
  return {
    from: hay.index[at],
    // `+ 1`: the END of a match is one past its last character, and what the map holds is
    // that last character's own index in the source.
    to: hay.index[at + wanted.length - 1] + 1,
  };
}

/**
 * Turn an offset in the concatenated text into WHICH run holds it and how far in.
 *
 * Takes lengths rather than nodes so it can be tested without a DOM. `starts` is ascending,
 * so the last run that begins at or before `at` is the one.
 */
export function locate(
  starts: number[], lengths: number[], at: number,
): { index: number; offset: number } | null {
  for (let i = starts.length - 1; i >= 0; i--) {
    if (starts[i] <= at) return { index: i, offset: Math.min(at - starts[i], lengths[i]) };
  }
  return null;
}

/** Every text node under `root`, with where each one starts in the concatenated text. */
function textNodes(root: Node): { nodes: Text[]; starts: number[]; all: string } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    starts.push(all.length);
    nodes.push(node);
    all += node.data;
  }
  return { nodes, starts, all };
}

/** Build the Range covering `chunk` inside `root`, or null when it is not there. */
export function rangeFor(root: Element, chunk: string): Range | null {
  const { nodes, starts, all } = textNodes(root);
  if (nodes.length === 0) return null;
  const span = matchSpan(all, chunk);
  if (!span) return null;
  const lengths = nodes.map((n) => n.data.length);
  const from = locate(starts, lengths, span.from);
  const to = locate(starts, lengths, span.to);
  if (!from || !to) return null;
  const range = document.createRange();
  try {
    range.setStart(nodes[from.index], from.offset);
    range.setEnd(nodes[to.index], to.offset);
  } catch {
    return null;                                  // the DOM moved under us mid-stream
  }
  return range;
}

/**
 * Paint the spoken chunk inside `ref`, for as long as it belongs to `itemId`.
 *
 * A no-op outside J.A.R.V.I.S mode (nothing is ever spoken), on a session that does not offer
 * the subscription, and on an engine without the Highlight API.
 */
export function useSpokenHighlight(
  ref: RefObject<HTMLElement | null>,
  itemId: string,
  session?: ChatSession,
): void {
  useEffect(() => {
    const highlights = registry();
    if (!highlights || !session?.onSpokenChunk) return;
    const Ctor = (globalThis as unknown as { Highlight: HighlightCtor }).Highlight;
    // A stable identity for THIS message's claim on the global registry entry.
    const me = {};

    const clear = () => {
      if (owner !== me) return;                   // another message is speaking — leave it
      owner = null;
      highlights.delete(SPOKEN_HIGHLIGHT);
    };

    const paint = (chunk: SpokenChunk | null) => {
      const root = ref.current;
      if (!chunk || !root || chunk.itemId !== itemId) { clear(); return; }
      const range = rangeFor(root, chunk.text);
      // NOT FOUND IS NOT CLEARED — it is left where it was. A chunk can straddle two items,
      // or cover words a block swallowed, and blanking the marker for one sentence in the
      // middle of an answer reads as a fault rather than as a gap.
      if (!range) return;
      owner = me;
      highlights.set(SPOKEN_HIGHLIGHT, new Ctor(range));
    };

    const off = session.onSpokenChunk(paint);
    return () => { off(); clear(); };
  }, [ref, itemId, session]);
}
