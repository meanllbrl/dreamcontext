/**
 * Unit tests for `patchMarkdownBlocks` — the half that touches the DOM.
 *
 * The claim under test is IDENTITY, not markup: a block whose source did not change must come
 * out of the patch as the very same node object it went in as. That is the whole fix. A
 * `<video>` survives a streamed token because its node is never re-created; re-created means a
 * fresh `src`, which means the browser re-requests the clip, at the stream's frame rate (owner
 * report 07-26).
 *
 * There is no jsdom/happy-dom in this repo (root vitest runs under plain Node), so `document`
 * is shimmed below with a minimal tree that does real parent/child bookkeeping — append,
 * remove, replaceChildren, lastChild, parentNode — and treats each block's HTML as one opaque
 * element. That is exactly the surface the patcher uses; nothing about the algorithm is
 * simulated away. HTML parsing is not the patcher's job and is covered by the sibling suite's
 * equivalence test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  patchMarkdownBlocks, emptyBlockState, type MarkdownBlockState,
} from '../../dashboard/src/lib/markdownBlocks.js';

// ─── The smallest honest DOM ────────────────────────────────────────────────────────

interface FakeNode {
  kind: 'comment' | 'element';
  text: string;
  parentNode: FakeParent | null;
  remove(): void;
}

interface FakeParent {
  childNodes: FakeNode[];
  readonly lastChild: FakeNode | null;
  append(...nodes: (FakeNode | { childNodes: FakeNode[] })[]): void;
  replaceChildren(): void;
}

function makeNode(kind: FakeNode['kind'], text: string): FakeNode {
  const node: FakeNode = {
    kind,
    text,
    parentNode: null,
    remove() {
      const parent = node.parentNode;
      if (!parent) return;
      parent.childNodes = parent.childNodes.filter((n) => n !== node);
      node.parentNode = null;
    },
  };
  return node;
}

function makeParent(): FakeParent {
  const parent: FakeParent = {
    childNodes: [],
    get lastChild() { return parent.childNodes[parent.childNodes.length - 1] ?? null; },
    append(...nodes) {
      for (const node of nodes) {
        // A template's `content` hands over its children, not itself.
        const incoming = 'childNodes' in node ? node.childNodes.splice(0) : [node];
        for (const child of incoming) {
          child.parentNode = parent;
          parent.childNodes.push(child);
        }
      }
    },
    replaceChildren() {
      for (const child of parent.childNodes) child.parentNode = null;
      parent.childNodes = [];
    },
  };
  return parent;
}

beforeEach(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createComment: (text: string) => makeNode('comment', text),
    createElement: (tag: string) => {
      if (tag !== 'template') return makeNode('element', tag);
      const content = makeParent();
      return {
        content,
        set innerHTML(html: string) { content.append(makeNode('element', html)); },
      };
    },
  };
});

/** The container, as a real element would be handed to the patcher. */
function container(): HTMLElement {
  return makeParent() as unknown as HTMLElement;
}

/** Block HTML, and a counter proving an unchanged block is never re-rendered. */
function renderer() {
  const calls: string[] = [];
  const toHtml = (block: string): string => { calls.push(block); return `<p>${block}</p>`; };
  return { toHtml, calls };
}

/** The elements currently in the container, in order, skipping the boundary comments. */
function elements(el: HTMLElement): FakeNode[] {
  return (el as unknown as FakeParent).childNodes.filter((n) => n.kind === 'element');
}

describe('patchMarkdownBlocks — what survives a patch', () => {
  it('writes every block on the first pass', () => {
    const el = container();
    const { toHtml, calls } = renderer();
    const state = patchMarkdownBlocks(el, emptyBlockState(), ['a', 'b'], toHtml);
    expect(calls).toEqual(['a', 'b']);
    expect(elements(el).map((n) => n.text)).toEqual(['<p>a</p>', '<p>b</p>']);
    expect(state.blocks).toEqual(['a', 'b']);
    expect(state.markers).toHaveLength(2);
  });

  it('touches NOTHING when the markdown is unchanged', () => {
    const el = container();
    const first = renderer();
    let state = patchMarkdownBlocks(el, emptyBlockState(), ['a', 'b'], first.toHtml);
    const before = elements(el);

    const second = renderer();
    state = patchMarkdownBlocks(el, state, ['a', 'b'], second.toHtml);
    expect(second.calls).toEqual([]);                      // not one block re-rendered
    expect(elements(el)).toEqual(before);                  // the SAME node objects
    expect(elements(el)[0]).toBe(before[0]);
    expect(state.blocks).toEqual(['a', 'b']);
  });

  it('appends a new block without rebuilding the ones above it — the streaming case', () => {
    const el = container();
    const first = renderer();
    let state = patchMarkdownBlocks(el, emptyBlockState(), ['clip', 'text'], first.toHtml);
    const clipNode = elements(el)[0];

    const second = renderer();
    state = patchMarkdownBlocks(el, state, ['clip', 'text', 'more'], second.toHtml);
    expect(second.calls).toEqual(['more']);
    expect(elements(el)[0]).toBe(clipNode);                // the clip's element, untouched
    expect(elements(el).map((n) => n.text)).toEqual(['<p>clip</p>', '<p>text</p>', '<p>more</p>']);
    expect(state.blocks).toEqual(['clip', 'text', 'more']);
  });

  it('re-renders only the block that grew, and keeps the clip above it', () => {
    const el = container();
    const first = renderer();
    let state = patchMarkdownBlocks(el, emptyBlockState(), ['clip', 'tail'], first.toHtml);
    const clipNode = elements(el)[0];
    const tailNode = elements(el)[1];

    const second = renderer();
    state = patchMarkdownBlocks(el, state, ['clip', 'tail+more'], second.toHtml);
    expect(second.calls).toEqual(['tail+more']);
    expect(elements(el)[0]).toBe(clipNode);                // survived
    expect(elements(el)[1]).not.toBe(tailNode);            // rebuilt
    expect(tailNode.parentNode).toBeNull();                // and the old one is gone, not orphaned
    expect(elements(el)).toHaveLength(2);
  });

  it('rebuilds from the first change when an earlier block changes', () => {
    const el = container();
    const first = renderer();
    let state = patchMarkdownBlocks(el, emptyBlockState(), ['a', 'b', 'c'], first.toHtml);

    const second = renderer();
    state = patchMarkdownBlocks(el, state, ['a', 'b2', 'c'], second.toHtml);
    expect(second.calls).toEqual(['b2', 'c']);             // 'a' is still reused
    expect(elements(el).map((n) => n.text)).toEqual(['<p>a</p>', '<p>b2</p>', '<p>c</p>']);
  });

  it('removes the tail when blocks disappear — a rewind, or a shorter re-render', () => {
    const el = container();
    const first = renderer();
    let state = patchMarkdownBlocks(el, emptyBlockState(), ['a', 'b', 'c'], first.toHtml);
    const dropped = elements(el)[2];

    const second = renderer();
    state = patchMarkdownBlocks(el, state, ['a'], second.toHtml);
    expect(second.calls).toEqual([]);
    expect(elements(el).map((n) => n.text)).toEqual(['<p>a</p>']);
    expect(dropped.parentNode).toBeNull();
    expect(state.blocks).toEqual(['a']);
    expect(state.markers).toHaveLength(1);
  });

  it('empties the container when the message goes away', () => {
    const el = container();
    const { toHtml } = renderer();
    let state = patchMarkdownBlocks(el, emptyBlockState(), ['a'], toHtml);
    state = patchMarkdownBlocks(el, state, [], toHtml);
    expect((el as unknown as FakeParent).childNodes).toEqual([]);
    expect(state.blocks).toEqual([]);
  });
});

describe('patchMarkdownBlocks — when the DOM is not the one the state describes', () => {
  it('rebuilds from scratch against a fresh container rather than appending into it', () => {
    const el = container();
    const first = renderer();
    const state = patchMarkdownBlocks(el, emptyBlockState(), ['a', 'b'], first.toHtml);

    // What a re-mount looks like: same state ref, brand new empty element. Appending block 'c'
    // into it would silently drop 'a' and 'b' from the message.
    const remounted = container();
    const second = renderer();
    const next = patchMarkdownBlocks(remounted, state, ['a', 'b', 'c'], second.toHtml);
    expect(second.calls).toEqual(['a', 'b', 'c']);
    expect(elements(remounted).map((n) => n.text)).toEqual(['<p>a</p>', '<p>b</p>', '<p>c</p>']);
    expect(next.markers.every((m) => (m as unknown as FakeNode).parentNode === remounted as unknown as FakeParent)).toBe(true);
  });

  it('rebuilds when a boundary marker was removed from under it', () => {
    const el = container();
    const first = renderer();
    const state = patchMarkdownBlocks(el, emptyBlockState(), ['a', 'b'], first.toHtml);
    (state.markers[1] as unknown as FakeNode).remove();

    const second = renderer();
    patchMarkdownBlocks(el, state, ['a', 'b2'], second.toHtml);
    expect(second.calls).toEqual(['a', 'b2']);
    expect(elements(el).map((n) => n.text)).toEqual(['<p>a</p>', '<p>b2</p>']);
  });

  it('rebuilds when the state is internally inconsistent', () => {
    const el = container();
    const first = renderer();
    const state = patchMarkdownBlocks(el, emptyBlockState(), ['a', 'b'], first.toHtml);
    const broken: MarkdownBlockState = { blocks: state.blocks, markers: state.markers.slice(0, 1) };

    const second = renderer();
    patchMarkdownBlocks(el, broken, ['a', 'b'], second.toHtml);
    expect(second.calls).toEqual(['a', 'b']);
    expect(elements(el).map((n) => n.text)).toEqual(['<p>a</p>', '<p>b</p>']);
  });
});
