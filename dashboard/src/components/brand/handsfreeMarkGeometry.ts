import { GEM_PATHS, GEM_RING_WIDTH } from './gemPieces';

/**
 * The hands-free mark: the REAL dream gem with two sound-wave arcs on its right ("dreamcontext
 * you talk to"). ONE description, three renderings:
 *
 *   - `HandsfreeMark.tsx` turns {@link handsfreeMarkTree} into React elements (painted by
 *     `handsfreeMark.css` from the `--gem-*` tokens);
 *   - {@link handsfreeMarkSvg} turns the same tree into standalone markup, either painted by
 *     classes (the phone's server-rendered pages, `src/server/handsfree-mark.ts`) or with the
 *     token colours written in (the installed app's icons);
 *   - `scripts/gen-handsfree-icons.ts` writes the static SVG and renders the PNGs from it.
 *
 * The gem is not redrawn: it is `GEM_PATHS` at its own coordinates, stacked exactly as the
 * marketing `Gem.tsx` and the onboarding `GemConverge.tsx` stack it (ring, left, chevron, wedge
 * clipped by the body, the rhombus on top, the hairlines), with the fitted mark's own colours
 * (`--gem-*`, mirrored from the splash geometry's GEM_COLORS). The waves live in the same
 * coordinate space, so the composition is one viewBox away from the gem: the mark's tight box
 * for UI, a square with the whole composition inside the maskable safe circle for an icon.
 */

/** Where the waves come from: a point on the gem's axis, inside its right half. */
export const HF_WAVE_ORIGIN = [760, 500] as const;
/** Stroke width of a wave, in gem units (the ring is {@link GEM_RING_WIDTH}). */
export const HF_WAVE_WIDTH = 40;
/** The two waves, near and far: radius from {@link HF_WAVE_ORIGIN} and half the arc's angle. */
export const HF_WAVES = [
  { tone: 'near', r: 215, halfDeg: 42 },
  { tone: 'far', r: 345, halfDeg: 42 },
] as const;

/** The gem's painted extent (ring included) in gem units, measured in Chromium. */
const GEM_BOX = { x: 130, y: 176, w: 762, h: 646 } as const;

const round = (n: number) => Math.round(n * 100) / 100;

/** One wave: a circular arc about {@link HF_WAVE_ORIGIN}, top to bottom through its right. */
export function wavePath(r: number, halfDeg: number): string {
  const [cx, cy] = HF_WAVE_ORIGIN;
  const a = (halfDeg * Math.PI) / 180;
  const x = round(cx + r * Math.cos(a));
  const dy = r * Math.sin(a);
  return `M${x} ${round(cy - dy)} A${r} ${r} 0 0 1 ${x} ${round(cy + dy)}`;
}

/** The composition's painted box: the gem plus the far wave and its round caps. */
export const HF_MARK_BOX = (() => {
  const far = HF_WAVES[HF_WAVES.length - 1];
  const right = HF_WAVE_ORIGIN[0] + far.r + HF_WAVE_WIDTH / 2;
  return { x: GEM_BOX.x, y: GEM_BOX.y, w: right - GEM_BOX.x, h: GEM_BOX.h };
})();

/** The mark's tight viewBox (a hair of room so antialiasing is not clipped). */
export const HF_MARK_VIEWBOX = (() => {
  const pad = 8;
  const b = HF_MARK_BOX;
  return `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`;
})();

/**
 * The radius, around the box's centre, that the whole composition stays inside: the far wave's
 * crest and the gem's left tip sit on the axis, its corners and the far wave's caps inside.
 */
const MARK_REACH = HF_MARK_BOX.w / 2;
/** A maskable icon keeps everything inside a circle of 40 % of its side (the W3C safe zone). */
export const HF_ICON_SAFE = 0.4;
/**
 * The square icon viewBox, with the whole composition inside the safe circle. The gem's mass
 * sits left of the composition's box centre (the waves are only strokes), so the composition is
 * placed {@link HF_ICON_OPTICAL_SHIFT} of the side right of the icon's centre to balance it; the
 * side grows by exactly that much, so the far wave's crest lands ON the safe circle, never past
 * it (`tests/unit/handsfree-mark.test.ts` measures every point of it).
 */
export const HF_ICON_OPTICAL_SHIFT = 0.012;
export const HF_ICON_BOX = (() => {
  const side = round(MARK_REACH / (HF_ICON_SAFE - HF_ICON_OPTICAL_SHIFT));
  const cx = HF_MARK_BOX.x + HF_MARK_BOX.w / 2 - side * HF_ICON_OPTICAL_SHIFT;
  const cy = HF_MARK_BOX.y + HF_MARK_BOX.h / 2;
  return { x: round(cx - side / 2), y: round(cy - side / 2), side };
})();
export const HF_ICON_VIEWBOX = `${HF_ICON_BOX.x} ${HF_ICON_BOX.y} ${HF_ICON_BOX.side} ${HF_ICON_BOX.side}`;

// ─── The tree ───────────────────────────────────────────────────────────────

/** What paints a node. Each maps to one `--gem-*` token (see {@link HF_PAINT_TOKEN}). */
export type HfPaint =
  | 'ring' | 'body-hi' | 'body-lo' | 'chevron-hi' | 'chevron-lo'
  | 'dark' | 'dark-lo' | 'dark-edge' | 'hairline' | 'wave-near' | 'wave-far';

/** Each paint's token. The waves are the gem's own two tones: the near one the wedge's deep
 *  violet (the voice leaves from the dark side), the far one the ring's lavender (it fades). */
export const HF_PAINT_TOKEN: Record<HfPaint, string> = {
  ring: '--gem-ring',
  'body-hi': '--gem-body-hi',
  'body-lo': '--gem-body-lo',
  'chevron-hi': '--gem-chevron-hi',
  'chevron-lo': '--gem-chevron-lo',
  dark: '--gem-dark',
  'dark-lo': '--gem-dark-lo',
  'dark-edge': '--gem-dark-edge',
  hairline: '--gem-hairline',
  'wave-near': '--gem-dark',
  'wave-far': '--gem-ring',
};

export interface HfNode {
  tag: 'defs' | 'clipPath' | 'linearGradient' | 'stop' | 'g' | 'path';
  /** Plain SVG attributes, kebab-case as in markup. */
  attrs: Record<string, string | number>;
  /** How this node is painted: its stroke, its fill, or (a gradient stop) its stop colour. */
  paint?: { kind: 'stroke' | 'fill' | 'stop'; role: HfPaint };
  children?: HfNode[];
}

/** Gradient and clip ids, unique per rendering (two marks on a page must not share them). */
export interface HfIds { clip: string; body: string; chev: string; dark: string }

export function hfIds(prefix: string): HfIds {
  return { clip: `${prefix}-clip`, body: `${prefix}-body`, chev: `${prefix}-chev`, dark: `${prefix}-dark` };
}

const stop = (offset: number, role: HfPaint): HfNode => ({ tag: 'stop', attrs: { offset }, paint: { kind: 'stop', role } });
const grad = (id: string, x1: number, y1: number, x2: number, y2: number, stops: HfNode[]): HfNode => ({
  tag: 'linearGradient', attrs: { id, x1, y1, x2, y2, gradientUnits: 'userSpaceOnUse' }, children: stops,
});
const clipped = (ids: HfIds, d: string, fill: string): HfNode => ({
  tag: 'g', attrs: { 'clip-path': `url(#${ids.clip})` }, children: [{ tag: 'path', attrs: { d, fill } }],
});

/** The mark as data, in paint order. The gem part is `Gem.tsx` at rest, piece by piece. */
export function handsfreeMarkTree(ids: HfIds): HfNode[] {
  return [
    {
      tag: 'defs', attrs: {}, children: [
        { tag: 'clipPath', attrs: { id: ids.clip, clipPathUnits: 'userSpaceOnUse' }, children: [{ tag: 'path', attrs: { d: GEM_PATHS.body } }] },
        grad(ids.body, 300, 230, 420, 780, [stop(0, 'body-hi'), stop(1, 'body-lo')]),
        grad(ids.chev, 500, 250, 470, 770, [stop(0, 'chevron-hi'), stop(0.45, 'chevron-hi'), stop(1, 'chevron-lo')]),
        grad(ids.dark, 400, 330, 780, 680, [stop(0, 'dark'), stop(1, 'dark-lo')]),
      ],
    },
    { tag: 'path', attrs: { d: GEM_PATHS.ring, fill: 'none', 'stroke-width': GEM_RING_WIDTH, 'stroke-linecap': 'round' }, paint: { kind: 'stroke', role: 'ring' } },
    clipped(ids, GEM_PATHS.left, `url(#${ids.body})`),
    clipped(ids, GEM_PATHS.chevron, `url(#${ids.chev})`),
    clipped(ids, GEM_PATHS.wedge, `url(#${ids.dark})`),
    { tag: 'path', attrs: { d: GEM_PATHS.rhombus, fill: `url(#${ids.dark})`, 'stroke-width': 3 }, paint: { kind: 'stroke', role: 'dark-edge' } },
    { tag: 'path', attrs: { d: GEM_PATHS.hairlines, fill: 'none', 'stroke-width': 3 }, paint: { kind: 'stroke', role: 'hairline' } },
    ...HF_WAVES.map((w): HfNode => ({
      tag: 'path',
      attrs: { d: wavePath(w.r, w.halfDeg), fill: 'none', 'stroke-width': HF_WAVE_WIDTH, 'stroke-linecap': 'round', 'data-wave': w.tone },
      paint: { kind: 'stroke', role: w.tone === 'near' ? 'wave-near' : 'wave-far' },
    })),
  ];
}

/**
 * The decoration the phone pages carry in their corners: the gem's own ring and rhombus as
 * hairline outlines, no fill. Painted by one class (`hfm-decor-line`), so the page decides how
 * faint it is.
 */
export function handsfreeDecorTree(): HfNode[] {
  return [
    { tag: 'path', attrs: { d: GEM_PATHS.ring, fill: 'none', 'stroke-width': 10, 'stroke-linejoin': 'round' } },
    { tag: 'path', attrs: { d: GEM_PATHS.body, fill: 'none', 'stroke-width': 6, 'stroke-linejoin': 'round' } },
    { tag: 'path', attrs: { d: GEM_PATHS.rhombus, fill: 'none', 'stroke-width': 6, 'stroke-linejoin': 'round' } },
  ];
}

/** The decoration's viewBox: the gem's painted box with room for its strokes. */
export const HF_DECOR_VIEWBOX = `${GEM_BOX.x - 8} ${GEM_BOX.y - 8} ${GEM_BOX.w + 16} ${GEM_BOX.h + 16}`;

// ─── Markup ─────────────────────────────────────────────────────────────────

/** The class a paint role takes when the page paints it (`handsfreeMark.css`). */
export const hfPaintClass = (kind: 'stroke' | 'fill' | 'stop', role: HfPaint) => `hfm-${kind}-${role}`;

const escAttr = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function nodeMarkup(n: HfNode, colors: Record<HfPaint, string> | null, extraClass?: string): string {
  const attrs: Array<[string, string | number]> = Object.entries(n.attrs);
  const classes: string[] = [];
  if (n.paint) {
    if (colors) {
      const name = n.paint.kind === 'stop' ? 'stop-color' : n.paint.kind;
      attrs.push([name, colors[n.paint.role]]);
    } else classes.push(hfPaintClass(n.paint.kind, n.paint.role));
  }
  if (extraClass) classes.push(extraClass);
  if (classes.length) attrs.push(['class', classes.join(' ')]);
  const a = attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  const kids = (n.children ?? []).map((c) => nodeMarkup(c, colors, extraClass && c.tag === 'path' ? extraClass : undefined)).join('');
  return kids ? `<${n.tag}${a}>${kids}</${n.tag}>` : `<${n.tag}${a}/>`;
}

export interface HfSvgOptions {
  /** Id prefix for the clip and gradients. */
  idPrefix: string;
  /** 'mark' = the tight box (UI); 'icon' = the square safe-zone box (an app icon). */
  box: 'mark' | 'icon';
  /** Token colours written into the markup (a standalone file); null = painted by classes. */
  colors: Record<HfPaint, string> | null;
  /** A square background behind an icon (a literal colour; the generator reads it from tokens). */
  background?: string;
  /** Pixel size (square for an icon); omitted = sized by the page. */
  size?: number;
  className?: string;
  /** An accessible name; omitted = decorative (`aria-hidden`). */
  title?: string;
}

/** The mark as standalone SVG markup, from {@link handsfreeMarkTree}. */
export function handsfreeMarkSvg(o: HfSvgOptions): string {
  const viewBox = o.box === 'icon' ? HF_ICON_VIEWBOX : HF_MARK_VIEWBOX;
  const head = [`xmlns="http://www.w3.org/2000/svg"`, `viewBox="${viewBox}"`];
  if (o.size) {
    const h = o.box === 'icon' ? o.size : round((o.size * (HF_MARK_BOX.h + 16)) / (HF_MARK_BOX.w + 16));
    head.push(`width="${o.size}"`, `height="${h}"`);
  }
  if (o.className) head.push(`class="${escAttr(o.className)}"`);
  head.push(o.title ? `role="img" aria-label="${escAttr(o.title)}"` : 'aria-hidden="true" focusable="false"');
  const bg = o.background && o.box === 'icon'
    ? `<rect x="${HF_ICON_BOX.x}" y="${HF_ICON_BOX.y}" width="${HF_ICON_BOX.side}" height="${HF_ICON_BOX.side}" fill="${escAttr(o.background)}"/>`
    : '';
  const body = handsfreeMarkTree(hfIds(o.idPrefix)).map((n) => nodeMarkup(n, o.colors)).join('');
  return `<svg ${head.join(' ')}>${bg}${body}</svg>`;
}

/** The corner decoration as markup, painted by `hfm-decor-line`. */
export function handsfreeDecorSvg(className: string): string {
  const body = handsfreeDecorTree().map((n) => nodeMarkup(n, null, 'hfm-decor-line')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${HF_DECOR_VIEWBOX}" class="${escAttr(className)}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Every paint the class-painted markup needs, once: [selector, property, value]. */
export function handsfreePaintRules(): Array<[string, string, string]> {
  const seen = new Map<string, [string, string, string]>();
  const walk = (n: HfNode) => {
    if (n.paint) {
      const sel = `.${hfPaintClass(n.paint.kind, n.paint.role)}`;
      const prop = n.paint.kind === 'stop' ? 'stop-color' : n.paint.kind;
      seen.set(sel, [sel, prop, `var(${HF_PAINT_TOKEN[n.paint.role]})`]);
    }
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of handsfreeMarkTree(hfIds('x'))) walk(n);
  return [...seen.values()];
}

/** {@link handsfreePaintRules} as one minified stylesheet (the phone's server-rendered pages). */
export function handsfreePaintCss(): string {
  return handsfreePaintRules().map(([sel, prop, val]) => `${sel}{${prop}:${val}}`).join('');
}
