/**
 * The categorical scale every hand-rolled lab chart draws from. The values are
 * design tokens (`--chart-1…8`, defined per theme in styles/tokens.css), not
 * hexes: SVG `fill`/`stroke` and CSS backgrounds accept `var()`, so a theme
 * switch repaints the charts without any JS.
 */
export const CHART_COLORS: readonly string[] = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];
