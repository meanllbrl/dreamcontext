/**
 * Chart colour by JOB (dataviz method): categorical = identity, sequential =
 * magnitude, diverging = polarity. Every value is a `var(--viz-*)` token declared
 * (and validated, light and dark) in chart.css, so a theme switch repaints every
 * chart with no JS and no hex ever reaches a component.
 *
 * Categorical colours follow the ENTITY, never its current rank: a colour scale is
 * built over the full domain (every series/category the block could show, in its
 * canonical order) and a filter only hides entries, so survivors keep their hue.
 * Hues are never cycled or generated past the eighth slot: the ninth entity and on
 * wear the "Other" grey (fold the tail into an Other row upstream when it matters).
 */

/** Categorical slots the palette validates. A ninth series is never given a hue. */
export const CATEGORICAL_SLOTS = 8;

/** The de-emphasis grey: a folded "Other" bucket, a muted comparison series. */
export const OTHER_COLOR = 'var(--viz-other)';

/** Sequential / diverging step counts (see chart.css). */
export const SEQUENTIAL_STEPS = 7;
export const DIVERGING_STEPS = 7;

/** The categorical colour for 0-based `slot`, or the Other grey past the eighth. */
export function categoricalColor(slot: number): string {
  if (!Number.isFinite(slot) || slot < 0 || slot >= CATEGORICAL_SLOTS) return OTHER_COLOR;
  return `var(--viz-cat-${Math.floor(slot) + 1})`;
}

/** A 1-based block `color` option (1..8) as a 0-based slot offset. */
export function colorStartOffset(start: number | null | undefined): number {
  if (typeof start !== 'number' || !Number.isFinite(start)) return 0;
  return Math.min(CATEGORICAL_SLOTS - 1, Math.max(0, Math.round(start) - 1));
}

export interface ColorScale {
  /** The colour of `entity`; an entity outside the domain (or past slot 8) wears Other. */
  color(entity: string): string;
  /** The 0-based palette slot `entity` wears, or null when it wears Other. */
  slot(entity: string): number | null;
  /** The domain the scale was built over, in its canonical order. */
  readonly domain: readonly string[];
}

export interface ColorScaleOptions {
  /** The block's `color` option: the 1-based slot the FIRST entity takes (default 1). */
  start?: number | null;
  /** Entities that always wear the Other grey (a folded "Other" row), whatever their position. */
  other?: readonly string[];
}

/**
 * A stable entity -> colour assignment. `domain` is the full, canonical entity
 * list (the unfiltered series names or categories, in source order); the i-th
 * entity (skipping any `other` entries) takes slot `start + i`. With a start above
 * 1 the slots rotate (8 wraps to 1: the wrap pair is validated too), but at most
 * eight entities ever get a hue, so no two share one.
 */
export function colorScale(domain: readonly string[], opts: ColorScaleOptions = {}): ColorScale {
  const offset = colorStartOffset(opts.start);
  const other = new Set(opts.other ?? []);
  const slots = new Map<string, number>();
  let i = 0;
  for (const entity of domain) {
    if (slots.has(entity) || other.has(entity)) continue;
    if (i < CATEGORICAL_SLOTS) slots.set(entity, (offset + i) % CATEGORICAL_SLOTS);
    i++;
  }
  const slotOf = (entity: string): number | null => slots.get(entity) ?? null;
  return {
    domain,
    slot: slotOf,
    color: (entity) => {
      const s = slotOf(entity);
      return s === null ? OTHER_COLOR : categoricalColor(s);
    },
  };
}

/** Clamp to [0, 1]; NaN reads as 0. */
function unit(t: number): number {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/** The 1-based sequential step for `t` in [0, 1] (0 = least, 1 = most). */
export function sequentialStep(t: number): number {
  return 1 + Math.round(unit(t) * (SEQUENTIAL_STEPS - 1));
}

/** The sequential fill for `t` in [0, 1]. */
export function sequentialColor(t: number): string {
  return `var(--viz-seq-${sequentialStep(t)})`;
}

/** The label ink (white or ink by luminance) for a label set inside `sequentialColor(t)`. */
export function sequentialInk(t: number): string {
  return `var(--viz-seq-ink-${sequentialStep(t)})`;
}

/**
 * The 1-based diverging step for `t` in [-1, 1]: -1 is the negative pole (red),
 * 0 the neutral grey midpoint (step 4), +1 the positive pole (blue). Any value
 * that is not exactly the midpoint moves at least one step off the grey, so a
 * small but real deviation never reads as "nothing".
 */
export function divergingStep(t: number): number {
  const v = Number.isFinite(t) ? Math.min(1, Math.max(-1, t)) : 0;
  const mid = (DIVERGING_STEPS + 1) / 2;
  if (v === 0) return mid;
  const arm = (DIVERGING_STEPS - 1) / 2;
  const k = Math.max(1, Math.round(Math.abs(v) * arm));
  return v > 0 ? mid + k : mid - k;
}

export function divergingColor(t: number): string {
  return `var(--viz-div-${divergingStep(t)})`;
}

export function divergingInk(t: number): string {
  return `var(--viz-div-ink-${divergingStep(t)})`;
}

export interface ValueColorScale {
  /** The fill for value `v`. */
  color(v: number): string;
  /** The label ink for a label drawn inside that fill. */
  ink(v: number): string;
  /** `v` normalized onto the scale (0..1 sequential, -1..1 diverging). */
  t(v: number): number;
}

/** A sequential scale over [min, max] (one hue, more is darker in light / brighter in dark). */
export function sequentialScale(min: number, max: number): ValueColorScale {
  const span = max - min;
  const t = (v: number) => (span > 0 ? unit((v - min) / span) : (Number.isFinite(v) && v > min ? 1 : 0));
  return { t, color: (v) => sequentialColor(t(v)), ink: (v) => sequentialInk(t(v)) };
}

/**
 * A diverging scale around `mid` (default 0): each arm is scaled by the larger
 * distance from the midpoint, so equal distances read as equal intensity on
 * both sides and the midpoint itself is the neutral grey.
 */
export function divergingScale(min: number, max: number, mid = 0): ValueColorScale {
  const reach = Math.max(Math.abs(max - mid), Math.abs(mid - min));
  const t = (v: number) => (reach > 0 && Number.isFinite(v) ? Math.min(1, Math.max(-1, (v - mid) / reach)) : 0);
  return { t, color: (v) => divergingColor(t(v)), ink: (v) => divergingInk(t(v)) };
}
