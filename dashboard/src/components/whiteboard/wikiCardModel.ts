/**
 * The wiki card's pure half: reading a card's own list of sections and pages off its payload
 * (leniently: a hand-edited board file never crashes the canvas), and the edits the card makes
 * to that list before `commitWidget` writes it back into `customData.dc`.
 *
 * Every edit returns the SAME object when it changes nothing, so the card can skip the write,
 * and every list it returns is one the server's strict validator (src/lib/whiteboards/nav.ts
 * `validateNav`) takes as-is: the save refuses anything else.
 *
 * No React, no CSS: root vitest imports this file.
 */
import { pageRefKind, type WidgetPayload, type WikiPage, type WikiSection } from '../../lib/whiteboardWidgets';

/** A card's list: its sections, each with its pages. */
export interface WikiList {
  sections: WikiSection[];
}

/** The server's caps (nav.ts): an edit past them changes nothing instead of failing the save. */
export const MAX_WIKI_SECTIONS = 100;
export const MAX_WIKI_PAGES = 500;
const MAX_TITLE = 200;
const SECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A fresh section id in the server's shape (`s-` + 8 chars, like nav.ts `newSectionId`). */
export function newSectionId(random: () => number = Math.random): string {
  let id = 's-';
  for (let i = 0; i < 8; i++) id += ID_CHARS[Math.floor(random() * ID_CHARS.length) % ID_CHARS.length];
  return id;
}

/** A title as the server keeps it: trimmed, one line, non-empty, at most 200 chars. Null when unusable. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t && t.length <= MAX_TITLE ? t : null;
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────

/**
 * A card's list as the card draws it and the next edit writes it: anything that is not a
 * section object or a page with a valid ref is dropped, a missing `pages` reads as none, a
 * duplicate ref in one section keeps its first row, a bad title reads as `fallbackTitle`, and
 * a missing or repeated section id gets a deterministic one (so it is the same on every render).
 */
export function readWikiList(raw: unknown, fallbackTitle = 'Section'): WikiList {
  if (!Array.isArray(raw)) return { sections: [] };
  const ids = new Set<string>();
  const sections: WikiSection[] = [];
  for (const [i, s] of raw.entries()) {
    if (sections.length >= MAX_WIKI_SECTIONS) break;
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const sec = s as Record<string, unknown>;
    let id = typeof sec.id === 'string' && SECTION_ID_RE.test(sec.id) ? sec.id : `s-${i}`;
    for (let n = 2; ids.has(id); n++) id = `s-${i}-${n}`;
    ids.add(id);
    const pages: WikiPage[] = [];
    const refs = new Set<string>();
    for (const p of Array.isArray(sec.pages) ? sec.pages : []) {
      if (pages.length >= MAX_WIKI_PAGES) break;
      if (!p || typeof p !== 'object') continue;
      const { ref, label } = p as Record<string, unknown>;
      if (typeof ref !== 'string' || pageRefKind(ref) === null || refs.has(ref)) continue;
      refs.add(ref);
      const clean = cleanTitle(label);
      pages.push(clean ? { ref, label: clean } : { ref });
    }
    sections.push({ id, title: cleanTitle(sec.title) ?? fallbackTitle, pages });
  }
  return { sections };
}

/** Every page of a list in reading order, with where it sits. */
export function listPages(list: WikiList): { section: WikiSection; page: WikiPage; index: number }[] {
  return list.sections.flatMap((section) => section.pages.map((page, index) => ({ section, page, index })));
}

/**
 * Apply one list edit to a payload: read the list leniently, edit it, and hand back a payload
 * with the new list, or the payload itself when the edit changed nothing. `fallbackTitle` is
 * what an untitled section is written as: pass the same (translated) name the card shows.
 */
export function editWikiPayload(
  payload: WidgetPayload, edit: (list: WikiList) => WikiList, fallbackTitle = 'Section',
): WidgetPayload {
  const list = readWikiList(payload.sections, fallbackTitle);
  const next = edit(list);
  return next === list ? payload : { ...payload, sections: next.sections };
}

/**
 * Rename the card itself. The list goes through the same cleanup as a list edit, so renaming
 * a card whose list was broken by hand writes a payload the save accepts instead of one it
 * keeps refusing. Unchanged for an unusable title or the title it already has.
 */
export function renameWikiCard(payload: WidgetPayload, title: string, fallbackTitle = 'Section'): WidgetPayload {
  const clean = cleanTitle(title);
  if (!clean || clean === payload.title) return payload;
  return { ...payload, title: clean, sections: readWikiList(payload.sections, fallbackTitle).sections };
}

// ── edits ────────────────────────────────────────────────────────────────────────────────────

function cloneList(list: WikiList): WikiList {
  return { sections: list.sections.map((s) => ({ ...s, pages: s.pages.map((p) => ({ ...p })) })) };
}

function clamp(i: number, max: number): number {
  return Math.max(0, Math.min(max, i));
}

function sectionIndex(list: WikiList, sectionId: string): number {
  return list.sections.findIndex((s) => s.id === sectionId);
}

/** Add a section at `at` (default: the end). Unchanged for an unusable title, a taken id, or a full card. */
export function addSection(list: WikiList, title: string, id: string, at?: number): WikiList {
  const clean = cleanTitle(title);
  if (!clean || !SECTION_ID_RE.test(id) || sectionIndex(list, id) >= 0) return list;
  if (list.sections.length >= MAX_WIKI_SECTIONS) return list;
  const next = cloneList(list);
  next.sections.splice(at === undefined ? next.sections.length : clamp(at, next.sections.length), 0, { id, title: clean, pages: [] });
  return next;
}

export function renameSection(list: WikiList, sectionId: string, title: string): WikiList {
  const clean = cleanTitle(title);
  const i = sectionIndex(list, sectionId);
  if (!clean || i < 0 || list.sections[i].title === clean) return list;
  const next = cloneList(list);
  next.sections[i].title = clean;
  return next;
}

/** Remove a section and every page in it. */
export function removeSection(list: WikiList, sectionId: string): WikiList {
  if (sectionIndex(list, sectionId) < 0) return list;
  return { sections: cloneList(list).sections.filter((s) => s.id !== sectionId) };
}

/** Move a section to position `to` (its index in the list after the move). */
export function moveSection(list: WikiList, sectionId: string, to: number): WikiList {
  const from = sectionIndex(list, sectionId);
  if (from < 0) return list;
  const target = clamp(to, list.sections.length - 1);
  if (target === from) return list;
  const next = cloneList(list);
  const [s] = next.sections.splice(from, 1);
  next.sections.splice(target, 0, s);
  return next;
}

/** True when the section already lists this ref (the server refuses a duplicate). */
export function sectionHasRef(list: WikiList, sectionId: string, ref: string): boolean {
  return list.sections.find((s) => s.id === sectionId)?.pages.some((p) => p.ref === ref) ?? false;
}

/**
 * Add a page to a section, at `at` (default: the end). Unchanged when the section is unknown,
 * the ref is not a page ref, the section already lists it, or the section is full.
 */
export function addPage(list: WikiList, sectionId: string, page: WikiPage, at?: number): WikiList {
  const i = sectionIndex(list, sectionId);
  if (i < 0 || pageRefKind(page.ref) === null) return list;
  if (sectionHasRef(list, sectionId, page.ref) || list.sections[i].pages.length >= MAX_WIKI_PAGES) return list;
  const next = cloneList(list);
  const label = cleanTitle(page.label);
  const pages = next.sections[i].pages;
  pages.splice(at === undefined ? pages.length : clamp(at, pages.length), 0, label ? { ref: page.ref, label } : { ref: page.ref });
  return next;
}

/**
 * The first page of an empty card: into the first section, or into a new section titled
 * `sectionTitle` (id `sectionId`) when the card has none yet.
 */
export function addFirstPage(list: WikiList, page: WikiPage, sectionTitle: string, sectionId: string): WikiList {
  if (list.sections.length > 0) return addPage(list, list.sections[0].id, page);
  const withSection = addSection(list, sectionTitle, sectionId);
  if (withSection === list) return list;
  const added = addPage(withSection, sectionId, page);
  return added === withSection ? list : added;
}

export function removePage(list: WikiList, sectionId: string, index: number): WikiList {
  const i = sectionIndex(list, sectionId);
  if (i < 0 || !Number.isInteger(index) || index < 0 || index >= list.sections[i].pages.length) return list;
  const next = cloneList(list);
  next.sections[i].pages.splice(index, 1);
  return next;
}

/**
 * Move the page at `fromIndex` of `fromSection` to position `toIndex` of `toSection` (its index
 * in that list after the move). Moving into a section that already holds the ref, or a full
 * one, changes nothing: the server would refuse it.
 */
export function movePage(
  list: WikiList, fromSection: string, fromIndex: number, toSection: string, toIndex: number,
): WikiList {
  const si = sectionIndex(list, fromSection);
  const di = sectionIndex(list, toSection);
  if (si < 0 || di < 0) return list;
  const src = list.sections[si];
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= src.pages.length) return list;
  const page = src.pages[fromIndex];
  if (si === di) {
    const target = clamp(toIndex, src.pages.length - 1);
    if (target === fromIndex) return list;
    const next = cloneList(list);
    const [p] = next.sections[si].pages.splice(fromIndex, 1);
    next.sections[si].pages.splice(target, 0, p);
    return next;
  }
  const dst = list.sections[di];
  if (dst.pages.some((p) => p.ref === page.ref) || dst.pages.length >= MAX_WIKI_PAGES) return list;
  const next = cloneList(list);
  const [p] = next.sections[si].pages.splice(fromIndex, 1);
  next.sections[di].pages.splice(clamp(toIndex, dst.pages.length), 0, p);
  return next;
}

/**
 * Where a drop lands, read as a move: dropping on a row means "before that row", so a page
 * dragged DOWN its own section lands one higher than the row's index once it has left its
 * place. `beforeIndex` is the index of the row dropped on, or the section's length for its end.
 */
export function dropIndex(fromSection: string, fromIndex: number, toSection: string, beforeIndex: number): number {
  return fromSection === toSection && fromIndex < beforeIndex ? beforeIndex - 1 : beforeIndex;
}

/**
 * Where a page lands when the keyboard moves it one step: within its section, or across the
 * boundary into the neighbouring section (to its end going up, its start going down). Null at
 * the very top or bottom, for an unknown row, or when the neighbour already holds the ref.
 */
export function stepPage(
  list: WikiList, sectionId: string, index: number, dir: -1 | 1,
): { section: string; index: number } | null {
  const si = sectionIndex(list, sectionId);
  if (si < 0) return null;
  const pages = list.sections[si].pages;
  if (index < 0 || index >= pages.length) return null;
  const target = index + dir;
  if (target >= 0 && target < pages.length) return { section: sectionId, index: target };
  const neighbour = list.sections[si + dir];
  if (!neighbour || neighbour.pages.some((p) => p.ref === pages[index].ref)) return null;
  return { section: neighbour.id, index: dir < 0 ? neighbour.pages.length : 0 };
}

// ── fitting an inactive card ─────────────────────────────────────────────────────────────────

/**
 * How many page rows an inactive card shows (it cannot scroll: Excalidraw passes it no pointer
 * events). `rowBottoms` are the rows' measured bottom edges, in order, from the top of the
 * list; `limit` is how far down the list may draw; `moreHeight` is the "+N more" line's height
 * with the gap above it. Every row fits: all of them. Otherwise the longest run of WHOLE rows
 * that leaves room for the "+N more" line — never a row cut in half. The card then leaves out
 * any section none of whose rows are shown, so a heading never stands alone.
 */
export function fitWikiRows(rowBottoms: readonly number[], limit: number, moreHeight: number): number {
  const n = rowBottoms.length;
  if (n === 0 || rowBottoms[n - 1] <= limit) return n;
  let shown = 0;
  while (shown < n && rowBottoms[shown] <= limit - moreHeight) shown++;
  return shown;
}
