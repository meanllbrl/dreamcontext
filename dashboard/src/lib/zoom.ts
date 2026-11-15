/**
 * The window's one zoom (owner 2026-11-15, "zoom daha iyi ayarlanabilsin"): the `--zoom` every
 * type token multiplies, in 5% steps from 75% to 150%. The title bar's zoom icon, its panel and
 * Settings → General all read these, so there is no second scale.
 */
export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.05;

/** Every level, 0.75 … 1.5, rounded so `1.05` is `1.05` and not `1.0500000000000003`. */
export const ZOOM_LEVELS: readonly number[] = Array.from(
  { length: Math.round((ZOOM_MAX - ZOOM_MIN) / ZOOM_STEP) + 1 },
  (_, i) => Math.round((ZOOM_MIN + i * ZOOM_STEP) * 100) / 100,
);

/** The level nearest `value`, inside the range; a stored value from the old 10% steps survives. */
export function snapZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
  return Math.round(clamped * 20) / 20;
}

/** One step up (+1) or down (-1) from `zoom`, held inside the range. */
export function stepZoom(zoom: number, delta: -1 | 1): number {
  return snapZoom(snapZoom(zoom) + delta * ZOOM_STEP);
}
