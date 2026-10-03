import {
  useCallback, useLayoutEffect, useMemo, useRef,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from 'react';
import { marked } from 'marked';
// Arms `==highlight==` on the shared `marked` singleton (lib/markdownMark.ts) — registration is
// global, but which modules a route loads is not, so every parse path imports it for itself.
import '../../lib/markdownMark';
import DOMPurify from 'dompurify';
import { useTheme } from '../../context/ThemeContext';
import { useMermaidRender } from '../../lib/mermaidRender';
import { useCodeHighlight } from '../../lib/codeHighlight';
import {
  emptyBlockState, markdownBlocks, patchMarkdownBlocks, renderMarkdownBlock,
  type MarkdownBlockState,
} from '../../lib/markdownBlocks';
import { decorateMarkdownTables } from '../../lib/markdownTables';
import { markdownWithWikilinks, WIKILINK_ATTR } from '../../lib/wikilinks';
import './MarkdownPreview.css';

marked.setOptions({ gfm: true, breaks: true });

/** Rendered blocks kept per instance, so a rebuild re-uses what it already parsed. Bounded:
 *  a long document is worth a few dozen entries, not an unbounded map per open message. */
const HTML_CACHE_MAX = 64;

interface Props {
  content: string;
  frontmatter?: Record<string, unknown>;
  /**
   * A `[[target]]` / `[[target|label]]` was clicked. Without it a wikilink still renders as its
   * label, link-styled, and a click does nothing (it has no `href` to follow).
   */
  onWikilink?: (target: string) => void;
}

export function MarkdownPreview({ content, frontmatter, onWikilink }: Props) {
  // The markdown as its top-level blocks — the unit that gets re-rendered. A streamed answer
  // only ever appends to the last one, so the blocks before it are written to the DOM once and
  // then left alone for the rest of the turn. See lib/markdownBlocks.ts for why that matters
  // (a `<video>` rebuilt per frame re-fetches the clip per frame).
  // Wikilinks become anchors BEFORE the split: the fence-aware pass needs the whole text to know
  // which lines are inside a code block (see lib/wikilinks.ts).
  const blocks = useMemo(() => markdownBlocks(markdownWithWikilinks(content)), [content]);

  // Sanitize before the HTML reaches the document. marked output for normal markdown
  // (headings, lists, code, tables, links) is preserved; scripts, event handlers, and
  // javascript:/data: URLs are stripped. Mermaid is unaffected — it replaces its code blocks
  // with SVG in the live DOM afterwards (see useMermaidRender), not through this HTML.
  const htmlCache = useRef<Map<string, string>>(new Map());
  const toHtml = useCallback((block: string): string => {
    const cache = htmlCache.current;
    const hit = cache.get(block);
    if (hit !== undefined) return hit;
    const html = DOMPurify.sanitize(renderMarkdownBlock(block));
    if (cache.size >= HTML_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(block, html);
    return html;
  }, []);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const blockState = useRef<MarkdownBlockState>(emptyBlockState());

  // A LAYOUT effect, not a passive one: the content must be in the DOM before the browser
  // paints (no flash of empty message), and before the decorating passes that run in the
  // parent's own layout effect — React runs a child's layout effects first, so the media pass
  // in `useInlineMedia` always sees this commit's markup. Writing the DOM here instead of
  // through `dangerouslySetInnerHTML` is the point: React compares that prop by identity and
  // rewrites the WHOLE subtree, which is what threw away a playing clip on every frame.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    blockState.current = patchMarkdownBlocks(el, blockState.current, blocks, toHtml);
    // Same commit, right after the patch: a table's column model has to be in place before the
    // browser paints, or a wide table paints outside its card for one frame. Idempotent, so a
    // streamed table is re-decorated as its rows arrive. See lib/markdownTables.ts.
    decorateMarkdownTables(el);
    // A clickable wikilink is reachable from the keyboard; an inert one stays out of tab order.
    if (onWikilink) {
      el.querySelectorAll(`[${WIKILINK_ATTR}]:not([tabindex])`).forEach((a) => {
        a.setAttribute('tabindex', '0');
        a.setAttribute('role', 'link');
      });
    }
  }, [blocks, toHtml, onWikilink]);

  const wikilinkTarget = (e: { target: EventTarget | null }): string | null => {
    if (!onWikilink || !(e.target instanceof Element)) return null;
    return e.target.closest(`[${WIKILINK_ATTR}]`)?.getAttribute(WIKILINK_ATTR) ?? null;
  };
  const onBodyClick = (e: ReactMouseEvent) => {
    const target = wikilinkTarget(e);
    if (target === null) return;
    e.preventDefault();
    onWikilink?.(target);
  };
  const onBodyKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const target = wikilinkTarget(e);
    if (target === null) return;
    e.preventDefault();
    onWikilink?.(target);
  };

  const { resolved } = useTheme();
  // Both passes stay keyed to the message text: they are marker-guarded (`data-highlighted`,
  // `.mermaid-rendered`), so re-running them over an unchanged subtree is a walk and nothing
  // more, and keying them narrower risks a re-rendered block being left undecorated.
  useMermaidRender(bodyRef, content, resolved, 'md-mmd');
  useCodeHighlight(bodyRef, content);

  const fmEntries = frontmatter
    ? Object.entries(frontmatter).filter(([, v]) => v !== undefined && v !== null && v !== '')
    : [];

  return (
    <div className={onWikilink ? 'md-preview md-preview--wikilinks' : 'md-preview'}>
      {fmEntries.length > 0 && (
        <div className="md-frontmatter">
          {fmEntries.map(([key, value]) => (
            <div key={key} className="md-fm-row">
              <span className="md-fm-key">{key}</span>
              <span className="md-fm-value">{String(value)}</span>
            </div>
          ))}
        </div>
      )}
      {/* Children are written by the layout effect above, block by block. React must not be
          given any of its own here — it would reconcile them against the patched DOM. */}
      <div
        ref={bodyRef}
        className="markdown-body"
        onClick={onWikilink ? onBodyClick : undefined}
        onKeyDown={onWikilink ? onBodyKey : undefined}
      />
    </div>
  );
}
