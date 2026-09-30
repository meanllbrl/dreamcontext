import { nanoid } from 'nanoid';

/**
 * Whiteboard widgets (D3): an Excalidraw `embeddable` element whose `link` starts with
 * {@link WIDGET_LINK_PREFIX} and whose payload lives in `customData.dc`.
 *
 * MIRRORED in `dashboard/src/lib/whiteboardWidgets.ts` (src/ and dashboard/src are separate
 * build roots). `tests/unit/whiteboard-widget-mirror.test.ts` fails the moment the two drift.
 */

export const WIDGET_KINDS = ['insight', 'knowledge', 'task', 'todo', 'note', 'html', 'web'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_LINK_PREFIX = 'dreamcontext://';

/** Kinds whose payload points at a dreamcontext entity by slug. */
export const REF_KINDS: readonly WidgetKind[] = ['insight', 'knowledge', 'task'];

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface WidgetPayload {
  v: 1;
  kind: WidgetKind;
  ref?: string;
  title?: string;
  markdown?: string;
  html?: string;
  items?: TodoItem[];
  url?: string;
  tag?: string;
  /** Grid size preset (A17). Absent: the dashboard derives the nearest preset from width/height. */
  size?: WidgetSize;
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

export function newElementId(): string {
  return nanoid(21);
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
