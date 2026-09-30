/**
 * The shared chart foundation for the lab's hand-rolled SVG charts. Every
 * chart composes the same pieces, in this order (ReferenceLineChart is the
 * worked example; the full API is documented in the task's chart-api.md):
 *
 *   useChartSize()        real cell size (width + height), tick font px, text measurer, dpr
 *   cartesianLayout()     plot rect + collision-free x/y tick labels for that size
 *   linearScale / bandScale / pointPositions / timeScale + timeTicks   value -> px
 *   tickFormatter / timeTickFormatter / formatValue / formatTimeKey     text
 *   <Grid> <Axis> <Crosshair> <HitArea>                                 SVG chrome
 *   useChartHover() / useMarkHover()                                   pointer -> datum
 *   <ChartFrame legend tooltip>                                         fill the cell, never scroll
 *   colorScale() / sequentialScale() / divergingScale()                colour by job
 */
export { Axis, Crosshair, Grid, HitArea } from './Axis';
export { ChartFrame, type ChartFrameProps } from './ChartFrame';
export {
  CHART_FORMATS, currencyCode, formatNumber, formatTimeKey, formatValue, resolveFormat, stepDecimals, tickFormatter,
  timeTickFormatter, toChartFormat, unitSuffix, type ChartFormat, type FormatOptions,
} from './format';
export { nearestIndex, placeTooltip, pointerToIndex, pointerToLocal, stepIndex, type ClientRectLike } from './hover';
export {
  cartesianLayout, estimateTextWidth, textMeasurer, thinStride, truncateToWidth,
  type AxisTick, type CartesianLayout, type CartesianLayoutInput, type Measure, type PlacedLabel, type Rect, type ResolvedAxis,
  type XLabelMode,
} from './layout';
export {
  Legend, LEGEND_POSITIONS, toggleHidden, toLegendPosition, useSeriesToggle,
  type LegendItem, type LegendPosition, type LegendProps,
} from './Legend';
export {
  CATEGORICAL_SLOTS, OTHER_COLOR, SEQUENTIAL_STEPS, DIVERGING_STEPS, categoricalColor, colorScale, colorStartOffset,
  divergingColor, divergingInk, divergingScale, divergingStep, sequentialColor, sequentialInk, sequentialScale, sequentialStep,
  type ColorScale, type ColorScaleOptions, type ValueColorScale,
} from './palette';
export { ReferenceLineChart, type ReferenceLineChartProps, type RefSeries } from './ReferenceLineChart';
export {
  allTimeKeys, bandScale, keyGrain, linearScale, niceDomain, niceStep, niceTicks, parseTimeKey, pointPositions, tickCountFor,
  timeScale, timeTicks,
  type BandScale, type BandScaleOptions, type LinearScale, type LinearScaleOptions, type TimeScale, type TimeTicks, type TimeUnit,
} from './scales';
export { Tooltip, type KeyShape, type TooltipRow, type TooltipSpec } from './Tooltip';
export { useChartHover, useMarkHover, type ChartHover, type ChartHoverOptions, type MarkHover } from './useChartHover';
export { crisp, useChartSize, type ChartSize } from './useChartSize';
