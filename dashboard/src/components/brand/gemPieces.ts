/**
 * The dream gem as separate pieces, for surfaces that animate the mark rather than show
 * the flat `logo.png` (the onboarding hand-off's converge, the Node setup screen).
 *
 * MIRRORED, not imported: these strings are the computed output of
 * `marketing/remotion/src/splash/geometry.ts` (the vector fit of the app icon that the
 * opening splash is rendered from), and the dashboard cannot import from the marketing
 * package. `tests/unit/desktop-pages-mirror.test.ts` recomputes them from that file and
 * fails on any drift, and checks the same strings inside `node-setup.html`.
 *
 * Coordinates are the master PNG's pixels (1024 x 1024). Draw them in
 * {@link GEM_VIEWBOX}, clip LEFT / CHEVRON / WEDGE by BODY (they overshoot it on
 * purpose), and paint RHOMBUS on top, the same stacking `Gem.tsx` uses.
 */

/** Centre of the mark: every converge transform pivots here. */
export const GEM_CENTER = [508, 499] as const;

/** 800-unit square around {@link GEM_CENTER}, as `Gem.tsx` draws it. */
export const GEM_VIEWBOX = '108 99 800 800';

/** Stroke width of the outline ring. */
export const GEM_RING_WIDTH = 26;

export const GEM_PATHS = {
  /** The light kite; also the clip for left, chevron and wedge. */
  body: 'M204.69 542.58 Q169.00 497.50 203.25 451.32 L340.09 266.81 Q380.00 213.00 437.99 246.56 L759.93 432.88 Q878.50 501.50 760.10 570.43 L451.17 750.30 Q395.00 783.00 354.66 732.04 Z',
  /** The outline ring's centreline (stroked, not filled). */
  ring: 'M168.22 559.74 Q118.50 496.75 166.95 432.77 L320.08 230.56 Q371.25 163.00 444.33 205.92 L809.61 420.47 Q948.00 501.75 809.72 583.22 L454.93 792.25 Q384.50 833.75 333.85 769.58 Z',
  left: 'M353.69 248.47 Q353.69 248.47 353.69 248.47 L429.50 350.00 Q429.50 350.00 429.50 350.00 L507.99 455.13 Q540.00 498.00 508.79 541.46 L433.00 647.00 Q433.00 647.00 433.00 647.00 L363.72 743.48 Q363.72 743.48 363.72 743.48 L40.00 980.00 Q40.00 980.00 40.00 980.00 L40.00 20.00 Q40.00 20.00 40.00 20.00 Z',
  chevron: 'M353.69 248.47 Q353.69 248.47 353.69 248.47 L333.69 60.00 Q333.69 60.00 333.69 60.00 L632.00 120.00 Q632.00 120.00 632.00 120.00 L564.60 315.94 Q562.00 323.50 566.84 329.87 L662.76 456.18 Q693.00 496.00 663.57 536.42 L549.35 693.27 Q547.00 696.50 548.35 700.27 L627.00 920.00 Q627.00 920.00 627.00 920.00 L333.72 960.00 Q333.72 960.00 333.72 960.00 L363.72 743.48 Q363.72 743.48 363.72 743.48 L433.00 647.00 Q433.00 647.00 433.00 647.00 L508.79 541.46 Q540.00 498.00 507.99 455.13 L429.50 350.00 Q429.50 350.00 429.50 350.00 Z',
  wedge: 'M561.94 315.50 Q562.00 323.50 566.84 329.87 L662.76 456.18 Q693.00 496.00 663.57 536.42 L549.35 693.27 Q547.00 696.50 547.21 700.49 L560.00 940.00 Q560.00 940.00 560.00 940.00 L1010.00 500.00 Q1010.00 500.00 1010.00 500.00 L560.00 60.00 Q560.00 60.00 560.00 60.00 Z',
  rhombus: 'M420.90 361.68 Q429.50 350.00 438.17 361.62 L507.99 455.13 Q540.00 498.00 508.79 541.46 L442.33 634.00 Q433.00 647.00 423.52 634.11 L351.91 536.69 Q322.00 496.00 351.94 455.33 Z',
  /** The two hairlines where the chevron's edge crosses the body. */
  hairlines: 'M353.69 248.47 L429.50 350.00 M433.00 647.00 L363.72 743.48',
} as const;

export type GemPiece = keyof typeof GEM_PATHS;
