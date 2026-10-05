/**
 * Whiteboard widgets (D3), the dashboard's copy of the contract.
 *
 * A widget is an Excalidraw `embeddable` element whose `link` starts with
 * {@link WIDGET_LINK_PREFIX} and whose payload lives in `customData.dc`.
 *
 * MIRRORED from `src/lib/whiteboards/widgets.ts`: the dashboard and the CLI are separate build
 * roots, so neither can import the other. `tests/unit/whiteboard-widget-mirror.test.ts` fails
 * the moment the two drift, so change both together.
 *
 * No React, no CSS: root vitest imports this file.
 */

export const WIDGET_KINDS = ['insight', 'knowledge', 'task', 'todo', 'note', 'html', 'web', 'wiki', 'lab-card', 'agent'] as const;

export const WIDGET_LINK_PREFIX = 'dreamcontext://';

/** File types a page (a `knowledge` widget, a page on a wiki card) may point at by path. */
export const PAGE_FILE_EXTENSIONS = ['.md', '.pdf', '.html', '.htm'] as const;
export type PageKind = 'md' | 'pdf' | 'html';

const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9\-/]{0,200}$/;
const MAX_PAGE_PATH = 500;

/**
 * What a page ref points at: `'knowledge'` for a knowledge slug, the file kind for a
 * project-relative path, or null when the ref is neither. A path is relative (no leading `/`,
 * `~`, drive letter or scheme), uses `/`, has no empty, `.` or `..` segment and no control
 * character, and ends in one of {@link PAGE_FILE_EXTENSIONS}.
 */
export function pageRefKind(ref: unknown): 'knowledge' | PageKind | null {
  if (typeof ref !== 'string' || !ref) return null;
  if (PAGE_SLUG_RE.test(ref)) return ref.split('/').includes('..') ? null : 'knowledge';
  if (ref.length > MAX_PAGE_PATH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:]/.test(ref) || ref.startsWith('/') || ref.startsWith('~')) return null;
  if (ref.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  const lower = ref.toLowerCase();
  if (lower.endsWith('.md')) return 'md';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return null;
}

/** A page ref: a knowledge slug OR a project-relative `.md` / `.pdf` / `.html` / `.htm` path. */
export function isValidPageRef(ref: unknown): ref is string {
  return pageRefKind(ref) !== null;
}

/** A Lab board card on a whiteboard (`lab-card`): `<board-slug>/<card-id>`, both kebab-case. */
const LAB_CARD_REF_RE = /^[a-z0-9][a-z0-9-]{0,99}\/[a-z0-9][a-z0-9-]{0,199}$/;

export function isLabCardRef(ref: unknown): ref is string {
  return typeof ref === 'string' && LAB_CARD_REF_RE.test(ref);
}

/** A lab-card ref split into its board and card, or null when it is not one. */
export function splitLabCardRef(ref: unknown): { board: string; card: string } | null {
  if (!isLabCardRef(ref)) return null;
  const slash = ref.indexOf('/');
  return { board: ref.slice(0, slash), card: ref.slice(slash + 1) };
}

/** The automation slugs the server reserves (automations/types.ts `RESERVED_SLUGS`). */
const RESERVED_AGENT_SLUGS: readonly string[] = ['cache', 'output', 'review', 'hitl'];

/** An `agent` card's ref: an automation slug, by the server's `isSafeAutomationSlug` rule. */
export function isAgentSlugShape(ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length > 200) return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ref) || ref.includes('--') || ref.endsWith('-')) return false;
  return !RESERVED_AGENT_SLUGS.includes(ref);
}

/** A page on a wiki card: a page ref ({@link isValidPageRef}) and an optional label. */
export interface WikiPage {
  ref: string;
  label?: string;
}

/** One section of a wiki card's list; `id` is stable across renames and reorders. */
export interface WikiSection {
  id: string;
  title: string;
  pages: WikiPage[];
}

export type WidgetPayload = {
  v: 1;
  kind: (typeof WIDGET_KINDS)[number];
  /** insight/task: a slug. knowledge (a "page"): a knowledge slug or a project-relative .md/.pdf/.html path.
   *  lab-card: `<board-slug>/<card-id>`. agent: an automation slug. */
  ref?: string;
  title?: string;
  markdown?: string;
  html?: string;
  items?: { id: string; text: string; done: boolean }[];
  url?: string;
  tag?: string;
  /** Grid size preset (A17). Absent: the dashboard derives the nearest preset from width/height. */
  size?: WidgetSize;
  /** wiki: the card's own list of sections and pages (src/lib/whiteboards/nav.ts edits it). */
  sections?: WikiSection[];
};

/**
 * Apple-Widgets-style sizes on a 180px grid with 16px gaps (A17): S 1x1, M 2x1, L 2x2, XL 4x2.
 * A span of n cells is `n*cell + (n-1)*gap`, so two widgets placed one pitch apart never touch.
 */
export const WIDGET_SIZES = { s: [180, 180], m: [376, 180], l: [376, 376], xl: [768, 376] } as const;
export type WidgetSize = keyof typeof WIDGET_SIZES;
export const WIDGET_GRID = { cell: 180, gap: 16 } as const;

/** Each kind's size when none is asked for; the CLI uses the same defaults. */
export const DEFAULT_WIDGET_SIZES: Readonly<Record<(typeof WIDGET_KINDS)[number], WidgetSize>> = {
  insight: 'm',
  knowledge: 's',
  task: 's',
  todo: 'm',
  note: 'm',
  html: 'l',
  web: 'l',
  wiki: 'l',
  'lab-card': 'xl',
  agent: 'l',
};

export function isWidgetSize(v: unknown): v is WidgetSize {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_SIZES, v);
}

/** The preset closest to a free-form width/height (squared distance; ties go to the smaller). */
export function nearestWidgetSize(w: number, h: number): WidgetSize {
  let best: WidgetSize = 's';
  let bestD = Infinity;
  for (const [k, [pw, ph]] of Object.entries(WIDGET_SIZES) as [WidgetSize, readonly [number, number]][]) {
    const d = (w - pw) ** 2 + (h - ph) ** 2;
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}
