import { nanoid } from 'nanoid';
import { WhiteboardValidationError } from './errors.js';
import {
  isValidPageRef,
  randomInteger,
  widgetPayloadOf,
  type WhiteboardElement,
  type WidgetPayload,
  type WikiPage,
  type WikiSection,
} from './widgets.js';

/**
 * A wiki card's list: ordered sections, each holding ordered pages. It lives in the `wiki`
 * widget's own payload (`customData.dc.sections`), so a board may hold several wiki cards, each
 * with its own list, and the list travels with its element: the element merge (merge.ts, higher
 * version wins) and git sync carry it like any other widget payload. Nothing about it lives in
 * the board's frontmatter.
 *
 * A page's `ref` is what a page widget's ref is: a knowledge slug, or a project-relative
 * `.md` / `.pdf` / `.html` / `.htm` path ({@link isValidPageRef}).
 *
 * Everything here is pure; callers wrap an edit in `mutateWhiteboard` for locking and the atomic
 * write, and {@link applyWikiEdit} bumps the element's version so the edit wins the merge.
 */

export type WikiNavPage = WikiPage;
export type WikiNavSection = WikiSection;

/** The part of a wiki card the ops edit: its sections. A wiki payload is one. */
export interface WikiNav {
  sections: WikiNavSection[];
}

export const MAX_NAV_SECTIONS = 100;
export const MAX_NAV_PAGES = 500;
const MAX_TITLE = 200;
const SECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function emptyNav(): WikiNav {
  return { sections: [] };
}

function cleanText(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new WhiteboardValidationError(`${what} must be a string`);
  const t = v.trim();
  if (!t) throw new WhiteboardValidationError(`${what} must not be empty`);
  if (t.length > MAX_TITLE) throw new WhiteboardValidationError(`${what} is too long (max ${MAX_TITLE} chars)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new WhiteboardValidationError(`${what} must be a single line`);
  return t;
}

export function validatePage(raw: unknown): WikiNavPage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WhiteboardValidationError('each page must be an object {ref, label?}');
  const p = raw as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => k !== 'ref' && k !== 'label');
  if (extra.length > 0) throw new WhiteboardValidationError(`unexpected page keys: ${extra.join(', ')}`);
  if (!isValidPageRef(p.ref)) {
    throw new WhiteboardValidationError(
      `invalid page ref '${String(p.ref)}' (a knowledge slug, or a project-relative .md/.pdf/.html path with no '..')`,
    );
  }
  const page: WikiNavPage = { ref: p.ref };
  if (p.label !== undefined && p.label !== null && p.label !== '') page.label = cleanText(p.label, 'page label');
  return page;
}

/** Strictly validate a `{sections}` list (a wiki card's). Returns a clean copy. */
export function validateNav(raw: unknown): WikiNav {
  if (raw === undefined || raw === null) return emptyNav();
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new WhiteboardValidationError('wiki sections must be an object {sections}');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== 'sections');
  if (extra.length > 0) throw new WhiteboardValidationError(`unexpected wiki keys: ${extra.join(', ')}`);
  if (r.sections === undefined) return emptyNav();
  if (!Array.isArray(r.sections)) throw new WhiteboardValidationError('wiki sections must be an array');
  if (r.sections.length > MAX_NAV_SECTIONS) throw new WhiteboardValidationError(`too many wiki sections (max ${MAX_NAV_SECTIONS})`);
  const ids = new Set<string>();
  const sections = r.sections.map((s): WikiNavSection => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new WhiteboardValidationError('each section must be an object {id, title, pages}');
    const sec = s as Record<string, unknown>;
    const bad = Object.keys(sec).filter((k) => k !== 'id' && k !== 'title' && k !== 'pages');
    if (bad.length > 0) throw new WhiteboardValidationError(`unexpected section keys: ${bad.join(', ')}`);
    if (typeof sec.id !== 'string' || !SECTION_ID_RE.test(sec.id)) throw new WhiteboardValidationError(`invalid section id '${String(sec.id)}'`);
    if (ids.has(sec.id)) throw new WhiteboardValidationError(`duplicate section id '${sec.id}'`);
    ids.add(sec.id);
    const pages = sec.pages === undefined ? [] : sec.pages;
    if (!Array.isArray(pages)) throw new WhiteboardValidationError(`section '${sec.id}' pages must be an array`);
    if (pages.length > MAX_NAV_PAGES) throw new WhiteboardValidationError(`too many pages in section '${sec.id}' (max ${MAX_NAV_PAGES})`);
    return { id: sec.id, title: cleanText(sec.title, 'section title'), pages: pages.map(validatePage) };
  });
  return { sections };
}

// ─── ops ────────────────────────────────────────────────────────────────────

export function newSectionId(): string {
  return `s-${nanoid(8)}`;
}

/** Find a section by exact id, else by title (case-insensitive). Ambiguous titles are refused. */
export function findSectionIndex(nav: WikiNav, key: string): number {
  const byId = nav.sections.findIndex((s) => s.id === key);
  if (byId >= 0) return byId;
  const k = key.trim().toLowerCase();
  const hits = nav.sections.flatMap((s, i) => (s.title.toLowerCase() === k ? [i] : []));
  if (hits.length > 1) throw new WhiteboardValidationError(`more than one section is titled '${key}'; use its id`);
  if (hits.length === 0) throw new WhiteboardValidationError(`no section '${key}' in this wiki card`);
  return hits[0];
}

/** A target index for a list of `len` items: clamped into range; negative counts from the end. */
function clampIndex(to: number, len: number): number {
  if (!Number.isInteger(to)) throw new WhiteboardValidationError(`--to must be an integer (got ${to})`);
  const i = to < 0 ? len + to : to;
  return Math.max(0, Math.min(len - 1, i));
}

function moveItem<T>(list: T[], from: number, to: number): void {
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

export function addSection(nav: WikiNav, title: string, opts: { id?: string; at?: number } = {}): { nav: WikiNav; section: WikiNavSection } {
  const next = structuredClone(nav);
  const clean = cleanText(title, 'section title');
  if (next.sections.length >= MAX_NAV_SECTIONS) throw new WhiteboardValidationError(`too many wiki sections (max ${MAX_NAV_SECTIONS})`);
  const id = opts.id ?? newSectionId();
  if (!SECTION_ID_RE.test(id)) throw new WhiteboardValidationError(`invalid section id '${id}'`);
  if (next.sections.some((s) => s.id === id)) throw new WhiteboardValidationError(`duplicate section id '${id}'`);
  const section: WikiNavSection = { id, title: clean, pages: [] };
  const at = opts.at === undefined ? next.sections.length : Math.max(0, Math.min(next.sections.length, opts.at));
  next.sections.splice(at, 0, section);
  return { nav: next, section };
}

export function removeSection(nav: WikiNav, key: string): { nav: WikiNav; removed: WikiNavSection } {
  const next = structuredClone(nav);
  const i = findSectionIndex(next, key);
  const [removed] = next.sections.splice(i, 1);
  return { nav: next, removed };
}

export function moveSection(nav: WikiNav, key: string, to: number): WikiNav {
  const next = structuredClone(nav);
  const i = findSectionIndex(next, key);
  moveItem(next.sections, i, clampIndex(to, next.sections.length));
  return next;
}

/**
 * Find a page in a section by 0-based position (`#2` or a bare integer) or by ref. A ref
 * listed twice resolves to its first occurrence.
 */
export function findPageIndex(section: WikiNavSection, key: string): number {
  const pos = /^#?(\d+)$/.exec(key.trim());
  if (pos) {
    const n = Number(pos[1]);
    if (n < section.pages.length) return n;
  }
  const i = section.pages.findIndex((p) => p.ref === key);
  if (i < 0) throw new WhiteboardValidationError(`no page '${key}' in section '${section.title}'`);
  return i;
}

export function addPage(
  nav: WikiNav,
  sectionKey: string,
  page: WikiNavPage,
  opts: { at?: number } = {},
): WikiNav {
  const next = structuredClone(nav);
  const sec = next.sections[findSectionIndex(next, sectionKey)];
  const clean = validatePage(page);
  if (sec.pages.length >= MAX_NAV_PAGES) throw new WhiteboardValidationError(`too many pages in section '${sec.title}' (max ${MAX_NAV_PAGES})`);
  if (sec.pages.some((p) => p.ref === clean.ref)) throw new WhiteboardValidationError(`'${clean.ref}' is already in section '${sec.title}'`);
  const at = opts.at === undefined ? sec.pages.length : Math.max(0, Math.min(sec.pages.length, opts.at));
  sec.pages.splice(at, 0, clean);
  return next;
}

export function removePage(nav: WikiNav, sectionKey: string, pageKey: string): { nav: WikiNav; removed: WikiNavPage } {
  const next = structuredClone(nav);
  const sec = next.sections[findSectionIndex(next, sectionKey)];
  const [removed] = sec.pages.splice(findPageIndex(sec, pageKey), 1);
  return { nav: next, removed };
}

/** Move a page within its section, or into another section (`toSection`) at index `to`. */
export function movePage(nav: WikiNav, sectionKey: string, pageKey: string, to: number, toSection?: string): WikiNav {
  const next = structuredClone(nav);
  const src = next.sections[findSectionIndex(next, sectionKey)];
  const from = findPageIndex(src, pageKey);
  if (toSection === undefined) {
    moveItem(src.pages, from, clampIndex(to, src.pages.length));
    return next;
  }
  const dst = next.sections[findSectionIndex(next, toSection)];
  if (dst === src) {
    moveItem(src.pages, from, clampIndex(to, src.pages.length));
    return next;
  }
  const [page] = src.pages.splice(from, 1);
  if (dst.pages.some((p) => p.ref === page.ref)) throw new WhiteboardValidationError(`'${page.ref}' is already in section '${dst.title}'`);
  if (dst.pages.length >= MAX_NAV_PAGES) throw new WhiteboardValidationError(`too many pages in section '${dst.title}' (max ${MAX_NAV_PAGES})`);
  dst.pages.splice(clampIndex(to, dst.pages.length + 1), 0, page);
  return next;
}

// ─── wiki cards on a board ──────────────────────────────────────────────────

export interface WikiCardView {
  id: string;
  title: string;
  sections: WikiNavSection[];
}

/** The live wiki cards of a board, in element order. */
export function wikiCards(elements: readonly WhiteboardElement[]): WhiteboardElement[] {
  return elements.filter((el) => el.isDeleted !== true && widgetPayloadOf(el)?.kind === 'wiki');
}

/**
 * A wiki card's list as read from disk, normalised so a reader never trips on it: no list (a
 * card written before it had one) is empty, and a section missing its `pages` (writes refuse
 * that, but a hand-edited file can arrive through git sync, which does not validate elements)
 * reads with `pages: []`. The next edit writes the normalised list back.
 */
export function wikiNavOf(el: WhiteboardElement): WikiNav {
  const dc = widgetPayloadOf(el);
  if (dc?.kind !== 'wiki') throw new WhiteboardValidationError(`element ${el.id} is not a wiki card`);
  return { sections: readWikiSections(dc.sections) };
}

/** The lenient read behind {@link wikiNavOf}: never throws, never returns a section without `pages`. */
export function readWikiSections(raw: unknown): WikiNavSection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
    .map((s) => ({
      ...structuredClone(s),
      id: typeof s.id === 'string' ? s.id : String(s.id ?? ''),
      title: typeof s.title === 'string' ? s.title : '',
      pages: Array.isArray(s.pages)
        ? (structuredClone(s.pages) as unknown[]).filter((p): p is WikiNavPage => !!p && typeof p === 'object' && typeof (p as WikiNavPage).ref === 'string')
        : [],
    }) as WikiNavSection);
}

export function wikiCardView(el: WhiteboardElement): WikiCardView {
  return { id: el.id, title: widgetPayloadOf(el)?.title ?? '', sections: wikiNavOf(el).sections };
}

/**
 * The wiki card an edit targets: `cardId` when given; otherwise the board's only wiki card. No
 * card, several cards without `cardId`, or an id that is not a live wiki card is refused with
 * what to do next.
 */
export function resolveWikiCard(elements: readonly WhiteboardElement[], slug: string, cardId?: string): WhiteboardElement {
  const cards = wikiCards(elements);
  if (cardId !== undefined) {
    const hit = cards.find((el) => el.id === cardId);
    if (hit) return hit;
    const other = elements.find((el) => el.id === cardId && el.isDeleted !== true);
    if (other) throw new WhiteboardValidationError(`element '${cardId}' on ${slug} is not a wiki card`);
    throw new WhiteboardValidationError(`no wiki card '${cardId}' on ${slug}`);
  }
  if (cards.length === 1) return cards[0];
  if (cards.length === 0) {
    throw new WhiteboardValidationError(
      `${slug} has no wiki card. Add one: dreamcontext whiteboard add ${slug} wiki --title "<title>"`,
    );
  }
  const list = cards.map((el) => `${el.id} "${widgetPayloadOf(el)?.title ?? ''}"`).join(', ');
  throw new WhiteboardValidationError(`${slug} has ${cards.length} wiki cards; pick one with --card <id>: ${list}`);
}

/**
 * Apply a list edit to a wiki card; returns the new, version-bumped element (D4, the same bump
 * as ops.ts `bumpVersion`, which this module cannot import: ops -> validate -> nav).
 */
export function applyWikiEdit(
  el: WhiteboardElement,
  fn: (nav: WikiNav) => WikiNav,
  now = Date.now(),
): WhiteboardElement {
  const next = validateNav(fn(wikiNavOf(el)));
  const dc: WidgetPayload = { ...structuredClone(widgetPayloadOf(el)!), sections: next.sections };
  return {
    ...el,
    customData: { ...(el.customData ?? {}), dc },
    version: (typeof el.version === 'number' ? el.version : 0) + 1,
    versionNonce: randomInteger(),
    updated: now,
  };
}
