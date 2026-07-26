import { marked } from 'marked';

/**
 * Incremental markdown rendering — the difference between "re-render the answer" and
 * "re-render the sentence being typed".
 *
 * A streaming answer's text grows by a few characters per frame, and the whole message used
 * to be re-parsed and written back with `dangerouslySetInnerHTML` on every one of those
 * frames. React compares that prop by identity, so a fresh `{ __html }` meant a destructive
 * `innerHTML` write: every node in the message was thrown away and rebuilt, per frame.
 *
 * For text that costs a reflow. For a `<video>` it costs the clip: the element is new, so its
 * `src` is set again, so the browser re-requests and re-decodes it — at the stream's frame
 * rate. The owner saw a clip mid-answer stutter the whole window (report 07-26).
 *
 * Markdown is a sequence of top-level blocks, and a stream only ever appends to the LAST one.
 * So: lex the message into blocks, compare against what is already on the page, and touch
 * only the blocks that actually changed. A clip in a finished paragraph is then never touched
 * again — it is the same DOM element for the rest of the turn, still buffered, still playing.
 *
 * Measured on a real 546-char answer with a clip in it, streamed in 12-char deltas: the clip's
 * block is rendered ONCE (frozen 133 chars in, the moment the blank line after it arrives)
 * instead of once per delta, and total block renders drop 322 → 51.
 *
 * Block boundaries are tracked with COMMENT nodes, not by holding the rendered elements: the
 * decorating passes replace nodes in place (mermaid swaps a `<pre>` for its stage, a media
 * reference becomes a `<video>`), so an element reference goes stale while a comment never
 * does. Comments are also invisible to CSS — `:first-child` and friends only ever match
 * elements — so the flat `.markdown-body > *` shape every stylesheet here relies on is
 * unchanged.
 */

// The lexer here and the parser in `MarkdownPreview` have to agree, and marked's options are
// global singleton state — so this module sets the same ones its callers do rather than
// depending on which module happened to be imported first.
marked.setOptions({ gfm: true, breaks: true });

/** Marks one block's start in the container, so a later patch knows where to cut. */
const MARKER_PREFIX = 'md:';

/**
 * A link reference definition (`[id]: https://…`) is resolved by the lexer against the WHOLE
 * document — the definition is not a block of its own, it is state. A block parsed in
 * isolation would render `[text][id]` as literal brackets, so a message containing one is
 * rendered whole. Rare in an answer, and correctness beats the optimization.
 */
const LINK_DEF_RE = /^ {0,3}\[[^\]\n]+\]:\s/m;

/**
 * The top-level markdown blocks of `content`, as source strings — the unit of re-rendering.
 *
 * `space` tokens (blank lines) are dropped rather than attached to a neighbour: they render to
 * nothing, and attaching them would change the preceding block's text the moment the blank
 * line after it arrives, re-rendering a block whose output is identical.
 */
export function markdownBlocks(content: string): string[] {
  if (!content) return [];
  // Cheap bail-outs to whole-document rendering, where splitting would change the output.
  if (LINK_DEF_RE.test(content)) return [content];
  try {
    const blocks: string[] = [];
    for (const token of marked.lexer(content)) {
      if (token.type === 'space') continue;
      if (token.raw) blocks.push(token.raw);
    }
    return blocks.length ? blocks : [content];
  } catch {
    // A lexer throw must never lose the answer — fall back to one block.
    return [content];
  }
}

/** One block's HTML, unsanitized — the caller sanitizes before it reaches the document. */
export function renderMarkdownBlock(block: string): string {
  return marked.parse(block) as string;
}

/**
 * Index of the first block whose source differs — i.e. how many leading blocks the DOM can
 * keep as-is. Equal to both lengths when nothing changed; equal to `prev.length` for the
 * append-only case a stream produces.
 */
export function firstChangedBlock(prev: readonly string[], next: readonly string[]): number {
  const shared = Math.min(prev.length, next.length);
  let i = 0;
  while (i < shared && prev[i] === next[i]) i++;
  return i;
}

/** What is currently on the page: the block sources, and the comment that starts each one. */
export interface MarkdownBlockState {
  blocks: string[];
  markers: Comment[];
}

export function emptyBlockState(): MarkdownBlockState {
  return { blocks: [], markers: [] };
}

/** Remove `marker` and everything after it — the tail of the container the patch replaces. */
function removeFrom(container: HTMLElement, marker: Comment | undefined): void {
  if (!marker || marker.parentNode !== container) return;
  while (container.lastChild && container.lastChild !== marker) container.lastChild.remove();
  marker.remove();
}

/**
 * Bring `container` in line with `next`, re-rendering only the blocks that changed.
 * Returns the new state, which the caller holds for the next patch.
 *
 * `toHtml` is called ONLY for blocks that are actually (re)rendered, so an unchanged block
 * costs neither a parse nor a sanitize — the caller may memoize it, but does not have to.
 */
export function patchMarkdownBlocks(
  container: HTMLElement,
  state: MarkdownBlockState,
  next: readonly string[],
  toHtml: (block: string) => string,
): MarkdownBlockState {
  let from = firstChangedBlock(state.blocks, next);

  // Only trust the cut point if the DOM is still the one this state describes. A component
  // re-mount (the transcript window sliding, a rewind) hands us a fresh empty container while
  // the state ref may still hold the old markers; appending into it would drop every block
  // before the cut. Verifying the boundary marker — or, for a pure append, the last one —
  // is O(1), and falling back to a full rebuild is always correct.
  const boundary = state.markers[from];
  const anchor = boundary ?? state.markers[state.markers.length - 1];
  if (from > 0 && (state.markers.length !== state.blocks.length || !anchor || anchor.parentNode !== container)) {
    from = 0;
  }

  if (from === 0) container.replaceChildren();
  else removeFrom(container, state.markers[from]);

  const blocks = state.blocks.slice(0, from);
  const markers = state.markers.slice(0, from);
  for (let i = from; i < next.length; i++) {
    const marker = document.createComment(`${MARKER_PREFIX}${i}`);
    container.append(marker);
    // A template parses the HTML without running it or touching the live document, then
    // hands over its nodes in one insert.
    const template = document.createElement('template');
    template.innerHTML = toHtml(next[i]);
    container.append(template.content);
    blocks.push(next[i]);
    markers.push(marker);
  }
  return { blocks, markers };
}
