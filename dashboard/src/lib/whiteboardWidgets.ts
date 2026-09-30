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

export const WIDGET_KINDS = ['insight', 'knowledge', 'task', 'todo', 'note', 'html', 'web'] as const;

export const WIDGET_LINK_PREFIX = 'dreamcontext://';

export type WidgetPayload = {
  v: 1;
  kind: (typeof WIDGET_KINDS)[number];
  ref?: string;
  title?: string;
  markdown?: string;
  html?: string;
  items?: { id: string; text: string; done: boolean }[];
  url?: string;
  tag?: string;
  /** Grid size preset (A17). Absent: the dashboard derives the nearest preset from width/height. */
  size?: WidgetSize;
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
