import { nanoid } from 'nanoid';

/**
 * Whiteboard widgets (D3): an Excalidraw `embeddable` element whose `link` starts with
 * {@link WIDGET_LINK_PREFIX} and whose payload lives in `customData.dc`.
 *
 * MIRRORED in `dashboard/src/lib/whiteboardWidgets.ts` (src/ and dashboard/src are separate
 * build roots). `tests/unit/whiteboard-widget-mirror.test.ts` fails the moment the two drift.
 */

export const WIDGET_KINDS = ['insight', 'knowledge', 'task', 'todo', 'note', 'html', 'web', 'wiki', 'lab-card', 'agent'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_LINK_PREFIX = 'dreamcontext://';

/** Kinds whose payload points at a dreamcontext entity by slug. */
export const REF_KINDS: readonly WidgetKind[] = ['insight', 'knowledge', 'task', 'lab-card', 'agent'];

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

/** The automation slugs `isSafeAutomationSlug` reserves (automations/types.ts `RESERVED_SLUGS`). */
const RESERVED_AGENT_SLUGS: readonly string[] = ['cache', 'output', 'review', 'hitl'];

/**
 * An `agent` card's ref: an automation slug. MIRRORS `isSafeAutomationSlug`
 * (automations/store.ts), pinned equal by `whiteboard-agent-widget.test.ts`; a mirror rather
 * than an import because that store already imports this module's validator.
 */
export function isAgentSlugShape(ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length > 200) return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ref) || ref.includes('--') || ref.endsWith('-')) return false;
  return !RESERVED_AGENT_SLUGS.includes(ref);
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
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

export interface WidgetPayload {
  v: 1;
  kind: WidgetKind;
  /** insight/task: a slug. knowledge (a "page"): a knowledge slug or a project-relative .md/.pdf/.html path.
   *  lab-card: `<board-slug>/<card-id>`. agent: an automation slug. */
  ref?: string;
  title?: string;
  markdown?: string;
  html?: string;
  items?: TodoItem[];
  url?: string;
  tag?: string;
  /** Grid size preset (A17). Absent: the dashboard derives the nearest preset from width/height. */
  size?: WidgetSize;
  /** wiki: the card's own list of sections and pages (src/lib/whiteboards/nav.ts edits it). */
  sections?: WikiSection[];
}

/**
 * Apple-Widgets-style sizes on a 180px grid with 16px gaps (A17): S 1x1, M 2x1, L 2x2, XL 4x2.
 * A span of n cells is `n*cell + (n-1)*gap`, so two widgets placed one pitch apart never touch.
 */
export const WIDGET_SIZES = { s: [180, 180], m: [376, 180], l: [376, 376], xl: [768, 376] } as const;
export type WidgetSize = keyof typeof WIDGET_SIZES;
export const WIDGET_GRID = { cell: 180, gap: 16 } as const;

/** Each kind's size when none is asked for; the dashboard palette uses the same defaults. */
export const DEFAULT_WIDGET_SIZES: Readonly<Record<WidgetKind, WidgetSize>> = {
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

/**
 * The loose element shape the store and CLI handle. Only what the merge and the validators
 * rely on is typed; every other Excalidraw field rides along untouched.
 */
export type WhiteboardElement = Record<string, unknown> & {
  id: string;
  type: string;
  version: number;
  versionNonce?: number;
  index?: string | null;
  isDeleted?: boolean;
  customData?: Record<string, unknown>;
};

export function isWidgetKind(v: unknown): v is WidgetKind {
  return typeof v === 'string' && (WIDGET_KINDS as readonly string[]).includes(v);
}

/** The widget payload of an element, or null when it is not a widget. */
export function widgetPayloadOf(el: { customData?: unknown }): WidgetPayload | null {
  const cd = el.customData;
  if (!cd || typeof cd !== 'object') return null;
  const dc = (cd as Record<string, unknown>).dc;
  if (!dc || typeof dc !== 'object' || !isWidgetKind((dc as Record<string, unknown>).kind)) return null;
  return dc as WidgetPayload;
}

/**
 * The group tag of any element: a widget carries it in `customData.dc.tag`, a plain drawn
 * element (imported by `draw --tag`) in `customData.dcTag`.
 */
export function elementTag(el: { customData?: unknown }): string | undefined {
  const dc = widgetPayloadOf(el);
  if (dc?.tag) return dc.tag;
  const cd = el.customData as Record<string, unknown> | undefined;
  return typeof cd?.dcTag === 'string' ? cd.dcTag : undefined;
}

/** A 31-bit random, the range Excalidraw's own `randomInteger` draws seeds and nonces from. */
export function randomInteger(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * A nanoid that never starts with '-': ids are passed to the CLI as positional arguments,
 * and commander reads a leading '-' as an option ("unknown option '-H2az…'").
 */
export function cliSafeId(size: number): string {
  const id = nanoid(size);
  return id[0] === '-' ? `x${id.slice(1)}` : id;
}

export function newElementId(): string {
  return cliSafeId(21);
}

/**
 * A fully-formed `embeddable` element, every schema field of Excalidraw 0.18 present so
 * `restoreElements` has nothing to repair (a repair bumps `version`, D11).
 *
 * Size: `payload.size` wins and sets width/height to its preset. Otherwise an explicit
 * positive `box.w`/`box.h` is kept free-form (no `dc.size`); with neither, the kind's default
 * preset is used and recorded. Width and height are never 0: `restoreElements` silently drops
 * an invisibly small element. `index` must be supplied by the caller (the store knows the
 * board's current max index).
 */
export function makeWidgetElement(
  kind: WidgetKind,
  payload: Omit<WidgetPayload, 'v' | 'kind'>,
  box: { x: number; y: number; w?: number; h?: number },
  index: string,
  now: number = Date.now(),
): WhiteboardElement {
  const id = newElementId();
  const freeForm = !payload.size && !!box.w && box.w > 0 && !!box.h && box.h > 0;
  const size = freeForm ? undefined : (payload.size ?? DEFAULT_WIDGET_SIZES[kind]);
  const [w, h] = size ? WIDGET_SIZES[size] : [box.w!, box.h!];
  const dc: WidgetPayload = { v: 1, kind, ...stripUndefined({ ...payload, size }) };
  return {
    id,
    type: 'embeddable',
    x: box.x,
    y: box.y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    seed: randomInteger(),
    version: 1,
    versionNonce: randomInteger(),
    index,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: now,
    link: `${WIDGET_LINK_PREFIX}${kind}/${payload.ref ?? id}`,
    locked: false,
    customData: { dc },
  };
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}
