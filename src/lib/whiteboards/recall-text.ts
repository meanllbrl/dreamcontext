import { widgetPayloadOf, pageRefKind, type WhiteboardElement } from './widgets.js';

/**
 * What memory recall reads from a board: the words a person put on it, never the scene.
 *
 * `## Text Elements` (what {@link extractExcalidrawText} indexes for a knowledge-folder board)
 * only carries live text and widget TITLES — a note's markdown, a todo's items, a wiki card's
 * pages and an HTML block's prose all live in `customData.dc` and would stay unsearchable.
 * This walks the parsed elements instead:
 *
 *   - text elements: `originalText` (pre-wrap), frames: their `name`
 *   - every widget: title, tag, ref, url
 *   - note: markdown · todo: item texts · wiki: section titles + page labels/refs
 *   - html: the visible text (script/style dropped, tags stripped), capped per block
 *
 * Deleted elements (tombstones are kept forever) are skipped — an erased card must not be
 * what recall finds. Coordinates, ids, colours and sizes never enter: JSON-only terms must not
 * score, the same rule the knowledge-board extractor holds.
 */

/** One HTML block's text cap: an embedded report must not drown the board's own words. */
export const MAX_HTML_TEXT = 1500;
/** Whole-board cap, so one huge board cannot dominate document length stats. */
export const MAX_BOARD_TEXT = 20_000;

export interface WhiteboardRecallText {
  body: string;
  /** Knowledge/task/insight slugs the board's cards and wiki pages point at — fed to recall as [[links]]. */
  refs: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Visible text of an HTML block: no script/style bodies, no tags, entities decoded, whitespace folded. */
export function htmlVisibleText(html: string): string {
  return html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function whiteboardRecallText(elements: readonly WhiteboardElement[]): WhiteboardRecallText {
  const lines: string[] = [];
  const refs = new Set<string>();
  // A group tag rides on every card in the group; written once so it does not inflate tf.
  const tags = new Set<string>();
  const push = (s: string) => { if (s) lines.push(s); };

  for (const el of elements) {
    if (el.isDeleted === true) continue;
    if (el.type === 'text') {
      push(str(el.originalText) || str(el.text));
      continue;
    }
    if (el.type === 'frame' || el.type === 'magicframe') push(str(el.name));

    const dc = widgetPayloadOf(el);
    if (!dc) continue;
    push(str(dc.title));
    if (str(dc.tag)) tags.add(str(dc.tag));
    const ref = str(dc.ref);
    if (ref) {
      push(ref);
      // Only a bare slug is a recall identity; a page card's file path is not.
      if (dc.kind === 'task' || dc.kind === 'insight' || (dc.kind === 'knowledge' && pageRefKind(ref) === 'knowledge')) {
        refs.add(ref);
      }
    }
    push(str(dc.url));
    push(str(dc.markdown));
    if (Array.isArray(dc.items)) {
      for (const item of dc.items) push(str(item?.text));
    }
    if (Array.isArray(dc.sections)) {
      for (const section of dc.sections) {
        push(str(section?.title));
        for (const page of Array.isArray(section?.pages) ? section.pages : []) {
          push(str(page?.label));
          const pageRef = str(page?.ref);
          push(pageRef);
          if (pageRefKind(pageRef) === 'knowledge') refs.add(pageRef);
        }
      }
    }
    if (typeof dc.html === 'string') push(htmlVisibleText(dc.html).slice(0, MAX_HTML_TEXT));
  }

  lines.push(...tags);
  let body = lines.join('\n');
  if (body.length > MAX_BOARD_TEXT) body = body.slice(0, MAX_BOARD_TEXT);
  return { body, refs: [...refs] };
}
