/**
 * The page panel's pure half: which file a card or link means, what type chip a page ref
 * wears, how a file path maps back to a page ref or to the app page that owns it, the
 * back/forward stack the panel keeps (and the wiki card's in-card reader reuses), and the
 * panel's width toggle, ⋯ menu rows and Esc order.
 *
 * No React, no CSS: root vitest imports this file.
 */
import { pageRefKind, type PageKind } from '../../lib/whiteboardWidgets';
import { humanizeFileName, pageKindLabel } from './widgetModel';

/** The brain folder every vault keeps its files in, project-relative. */
export const CONTEXT_DIR = '_dream_context';

const KNOWLEDGE_PREFIX = `${CONTEXT_DIR}/knowledge/`;
const TASK_PREFIX = `${CONTEXT_DIR}/state/`;
const TASK_SLUG_RE = /^[a-z0-9][a-z0-9\-/]{0,200}$/;

/** What a card or an element link asks the popup to open. */
export interface PageTarget {
  kind: 'knowledge' | 'task';
  /** knowledge: a page ref (knowledge slug or project-relative path). task: a task slug. */
  ref: string;
}

/** A knowledge slug's file. */
export function knowledgePath(slug: string): string {
  return `${KNOWLEDGE_PREFIX}${slug}.md`;
}

/** A task's file: tasks live at `_dream_context/state/<slug>.md` (see lib/delegateAgent.ts). */
export function taskPath(slug: string): string {
  return `${TASK_PREFIX}${slug}.md`;
}

/**
 * The project-relative file a target names, or null when the ref is not one this popup may
 * read: a page ref must pass `pageRefKind`, a task slug the slug rule (no `..` segment).
 */
export function targetPath(target: PageTarget): string | null {
  if (target.kind === 'task') {
    const slug = target.ref;
    if (!TASK_SLUG_RE.test(slug) || slug.split('/').includes('..')) return null;
    return taskPath(slug);
  }
  const kind = pageRefKind(target.ref);
  if (kind === null) return null;
  return kind === 'knowledge' ? knowledgePath(target.ref) : target.ref;
}

/**
 * The type chip a page ref wears in the panel's vocabulary: MD for a knowledge page (it is a
 * markdown file), else the file's type. The words come from `pageKindLabel` (widgetModel.ts),
 * the one place a page kind becomes a type word.
 */
export function pageTypeChip(ref: unknown): 'MD' | 'PDF' | 'HTML' | null {
  const kind = pageRefKind(ref);
  return kind === null ? null : pageKindChip(kind === 'knowledge' ? 'md' : kind);
}

export function pageKindChip(kind: PageKind): 'MD' | 'PDF' | 'HTML' {
  return pageKindLabel(kind);
}

/** The last segment of a path. */
export function pageFileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * A heading for a file with no title of its own (not a knowledge page or task the app
 * knows): `docs/pricing-sheet.pdf` reads "Pricing sheet". The same rule the cards use —
 * `humanizeFileName` (widgetModel.ts) is the one source, this name stays for the panel.
 */
export function pageTitleFromPath(path: string): string {
  return humanizeFileName(path);
}

/**
 * The app page that owns a file, for the popup's secondary "Open in …" action: a knowledge
 * file opens in Knowledge by slug, a task file in Tasks. Anything else has no owner page.
 */
export function owningPage(path: string): { page: 'knowledge' | 'tasks'; id: string } | null {
  if (!path.endsWith('.md')) return null;
  if (path.startsWith(KNOWLEDGE_PREFIX)) {
    const slug = path.slice(KNOWLEDGE_PREFIX.length, -3);
    return pageRefKind(slug) === 'knowledge' ? { page: 'knowledge', id: slug } : null;
  }
  if (path.startsWith(TASK_PREFIX)) {
    const slug = path.slice(TASK_PREFIX.length, -3);
    return TASK_SLUG_RE.test(slug) && !slug.split('/').includes('..') ? { page: 'tasks', id: slug } : null;
  }
  return null;
}

/** The page ref a file reads as (what "Expand" hands the wiki): a knowledge slug when the
 *  file is a knowledge page, else the path itself when it is a valid page path, else null. */
export function pathToPageRef(path: string): string | null {
  const owner = owningPage(path);
  if (owner?.page === 'knowledge') return owner.id;
  const kind = pageRefKind(path);
  return kind !== null && kind !== 'knowledge' ? path : null;
}

/** The vault-relative form of a project-relative path under `_dream_context/`, else null. */
export function vaultRelativePath(path: string): string | null {
  return path.startsWith(`${CONTEXT_DIR}/`) && path.length > CONTEXT_DIR.length + 1
    ? path.slice(CONTEXT_DIR.length + 1)
    : null;
}

// ── the back/forward stack ────────────────────────────────────────────────────────────────

/** The popup's history: the files read, and which one is showing. Empty means closed. */
export interface PageStack {
  entries: readonly string[];
  index: number;
}

export type PageStackAction =
  /** A card or element link: a fresh stack with this one file. */
  | { type: 'open'; path: string }
  /** A link followed inside the popup: drops anything ahead, then appends. */
  | { type: 'push'; path: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'close' };

export const CLOSED_STACK: PageStack = { entries: [], index: -1 };

/** History depth kept: the oldest entries fall off past this. */
export const MAX_STACK = 50;

export function pageStackReducer(state: PageStack, action: PageStackAction): PageStack {
  switch (action.type) {
    case 'open':
      return { entries: [action.path], index: 0 };
    case 'push': {
      if (state.index < 0) return { entries: [action.path], index: 0 };
      // Following a link to the page already showing changes nothing.
      if (state.entries[state.index] === action.path) return state;
      const entries = [...state.entries.slice(0, state.index + 1), action.path].slice(-MAX_STACK);
      return { entries, index: entries.length - 1 };
    }
    case 'back':
      return state.index > 0 ? { ...state, index: state.index - 1 } : state;
    case 'forward':
      return state.index >= 0 && state.index < state.entries.length - 1 ? { ...state, index: state.index + 1 } : state;
    case 'close':
      return CLOSED_STACK;
  }
}

export function currentPage(state: PageStack): string | null {
  return state.index >= 0 ? state.entries[state.index] ?? null : null;
}

export function canGoBack(state: PageStack): boolean {
  return state.index > 0;
}

export function canGoForward(state: PageStack): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

// ── the side panel: width, the ⋯ menu, Esc ────────────────────────────────────────────────

/** The panel's width: beside the board, or across the whole board ("Expand"). */
export type PanelWidth = 'side' | 'full';

/** The Expand / Collapse button: one button, flipping the width. */
export function togglePanelWidth(width: PanelWidth): PanelWidth {
  return width === 'side' ? 'full' : 'side';
}

/** The ⋯ menu's rows. `open-owner` is "Open in Knowledge" / "Open in Tasks". */
export type PanelMenuItem =
  | { id: 'open-owner'; page: 'knowledge' | 'tasks'; ownerId: string }
  | { id: 'open-computer' }
  | { id: 'reveal' }
  | { id: 'copy-path' };

/**
 * What the ⋯ menu holds for a file: "Open in Knowledge" / "Open in Tasks" only when an app
 * page owns it, then the three ways out to the operating system for EVERY file — which is how
 * a PDF the engine cannot draw, or an HTML page the sandbox strips, stays openable.
 */
export function panelMenuItems(path: string): PanelMenuItem[] {
  const owner = owningPage(path);
  const items: PanelMenuItem[] = owner ? [{ id: 'open-owner', page: owner.page, ownerId: owner.id }] : [];
  items.push({ id: 'open-computer' }, { id: 'reveal' }, { id: 'copy-path' });
  return items;
}

/** Arrow / Home / End inside the menu: the next row's index, wrapping at both ends. */
export function menuIndexAfter(index: number, key: string, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown': return index < 0 ? 0 : (index + 1) % count;
    case 'ArrowUp': return index < 0 ? count - 1 : (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return index;
  }
}

/** What one Esc closes: the ⋯ menu first when it is open, the panel otherwise. */
export function escapeCloses(menuOpen: boolean): 'menu' | 'panel' {
  return menuOpen ? 'menu' : 'panel';
}
