/**
 * The ⌘F bar over a chat transcript. Matching lives in `findInChat.ts`; this file owns the
 * DOM side: collecting the transcript's visible text nodes, painting hits with the CSS Custom
 * Highlight API (`::highlight(dc-find)` in `cards.css`), and scrolling the current one into
 * view.
 *
 * It searches what is MOUNTED. The transcript is windowed (older entries are not in the DOM
 * at all), so the bar says how many earlier messages it cannot see and offers to reveal them,
 * rather than reporting "no results" for text the reader knows is there. A sandboxed
 * `dream-html` block is an iframe and is out of reach by construction.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { findStepOf, locateMatches } from './findInChat';

const FIND_HIGHLIGHT = 'dc-find';
const FIND_CURRENT_HIGHLIGHT = 'dc-find-current';

/** Typed locally, as in `useSpokenHighlight.ts`: this project's `lib.dom` does not declare it. */
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
interface HighlightCtor { new (...ranges: Range[]): unknown }

function registry(): { reg: HighlightRegistry; Ctor: HighlightCtor } | null {
  const reg = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return reg && Ctor ? { reg, Ctor } : null;
}

/** The registry is global and two chat panes can be open in a split: the bar the reader
 *  last typed in owns the paint, so the other one cannot wipe it on its next re-scan. */
let owner: object | null = null;

function clearPaint(self: object) {
  if (owner !== self) return;
  const r = registry();
  r?.reg.delete(FIND_HIGHLIGHT);
  r?.reg.delete(FIND_CURRENT_HIGHLIGHT);
  owner = null;
}

/** Text nodes a reader can actually see — a collapsed fold's body is in the DOM but has no
 *  box, and a "match" there would be a jump to nowhere. */
function visibleTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (el.closest('script, style, noscript, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      if (el.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

interface Props {
  /** Bumped by the pane on every ⌘F, so a second press re-focuses and selects the query. */
  focusSignal: number;
  contentRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  /** Older entries the window has not mounted — unreachable until revealed. */
  hiddenCount: number;
  onRevealEarlier: () => void;
  /** Called before the bar moves the scroller, so the pane stops pinning to the bottom. */
  onJump: () => void;
  onClose: () => void;
}

export function ChatFindBar({ focusSignal, contentRef, scrollRef, hiddenCount, onRevealEarlier, onJump, onClose }: Props) {
  const self = useRef({}).current;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  /** Scroll only when the reader moved (typed, stepped) — a re-scan caused by a streaming
   *  token must not yank the view to the current hit every few hundred ms. */
  const jumpPendingRef = useRef(false);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  const scan = useCallback(() => {
    const root = contentRef.current;
    if (!root || !query.trim()) { setRanges([]); return; }
    const nodes = visibleTextNodes(root);
    const hits = locateMatches(nodes.map((n) => n.nodeValue ?? ''), query);
    setRanges(hits.map(({ start, end }) => {
      const r = document.createRange();
      r.setStart(nodes[start[0]], start[1]);
      r.setEnd(nodes[end[0]], end[1]);
      return r;
    }));
  }, [contentRef, query]);

  // A new query starts from the first hit and jumps to it.
  useEffect(() => {
    jumpPendingRef.current = true;
    setIndex(0);
    scan();
  }, [scan]);

  // The transcript keeps changing under an open bar (streaming, folds opening, a reveal):
  // re-scan, debounced, keeping the reader's place in the list.
  useEffect(() => {
    const root = contentRef.current;
    if (!root || !query.trim()) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(scan, 200);
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'class', 'hidden'] });
    return () => { mo.disconnect(); clearTimeout(t); };
  }, [contentRef, query, scan]);

  const current = ranges.length ? Math.min(index, ranges.length - 1) : -1;

  // Paint.
  useEffect(() => {
    const r = registry();
    if (!r) return;
    if (!ranges.length) { clearPaint(self); return; }
    if (owner !== null && owner !== self && !jumpPendingRef.current) return;
    owner = self;
    r.reg.set(FIND_HIGHLIGHT, new r.Ctor(...ranges));
    r.reg.set(FIND_CURRENT_HIGHLIGHT, new r.Ctor(ranges[current]));
  }, [ranges, current, self]);

  useEffect(() => () => clearPaint(self), [self]);

  // Scroll the current hit to the middle of the transcript.
  useEffect(() => {
    if (!jumpPendingRef.current || current < 0) return;
    jumpPendingRef.current = false;
    const scroller = scrollRef.current;
    const rect = ranges[current].getBoundingClientRect();
    if (!scroller || (rect.width === 0 && rect.height === 0)) return;
    const box = scroller.getBoundingClientRect();
    if (rect.top >= box.top + 24 && rect.bottom <= box.bottom - 24) return;
    onJump();
    scroller.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
  }, [ranges, current, scrollRef, onJump]);

  const step = (dir: 1 | -1) => {
    if (!ranges.length) return;
    jumpPendingRef.current = true;
    setIndex((i) => (Math.min(i, ranges.length - 1) + dir + ranges.length) % ranges.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const g = findStepOf(e);
    if (g) { e.preventDefault(); step(g); return; }
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  const hasQuery = query.trim().length > 0;
  return (
    <div className="chat-find" role="search" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <input
        ref={inputRef}
        className="chat-find-input"
        type="text"
        placeholder="Find in chat"
        aria-label="Find in chat"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="chat-find-count" aria-live="polite">
        {hasQuery ? (ranges.length ? `${current + 1}/${ranges.length}` : 'No results') : ''}
      </span>
      <button type="button" className="chat-find-btn" aria-label="Previous match" disabled={!ranges.length} onClick={() => step(-1)}>↑</button>
      <button type="button" className="chat-find-btn" aria-label="Next match" disabled={!ranges.length} onClick={() => step(1)}>↓</button>
      <button type="button" className="chat-find-btn" aria-label="Close find" onClick={onClose}>✕</button>
      {hasQuery && hiddenCount > 0 && (
        <button type="button" className="chat-find-more" onClick={onRevealEarlier}>
          Also search {hiddenCount} earlier
        </button>
      )}
    </div>
  );
}
