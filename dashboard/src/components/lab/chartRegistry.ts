import type { ComponentType } from 'react';
import type { ChartBodyProps } from './chartBody';
import { NumberBody, NumberDetailBody } from './NumberCard';
import { LineBody } from './LineChart';
import { PieBody } from './PieChart';
import { RawBody } from './RawDataView';
import { BarBody } from './BarChart';
import { BarCompareBody } from './BarCompareChart';
import { StackedBody } from './StackedChart';
import { TableBody } from './MetricTable';
import { HeatmapBody } from './HeatmapChart';
import { FunnelBody } from './funnel/FunnelCardPreview';
import { BreakdownBody } from './BreakdownPivot';

/**
 * The chart registry — the ONE place a render type is wired up. The card and the
 * detail panel resolve their body through it, so adding a chart type is one
 * component plus one entry here; no shell, board or panel edit.
 *
 * RENDERS MIRRORS the engine's `RENDERS` (src/lib/lab/types.ts), which the CLI
 * `--render` enum, doctor and the manifest read all derive from. The dashboard
 * cannot import from `src/`, so `tests/unit/lab-render-registry.test.ts` parses
 * this file and fails on drift — the same guard RangeControl's presets have.
 */
export const RENDERS = [
  'number',
  'line',
  'pie',
  'raw',
  'funnel',
  'bar',
  'bar_compare',
  'stacked',
  'table',
  'heatmap',
  'breakdown',
] as const;

export type Render = (typeof RENDERS)[number];

/** An author's manifest override for a card's board footprint. */
export type InsightSize = 's' | 'm' | 'l';

/** How many board columns a card takes (the grid grants 2 only where 2 exist). */
export type CardSpan = 1 | 2;

export interface ChartRegistryEntry {
  /** The board card's body. */
  CardBody: ComponentType<ChartBodyProps>;
  /** The detail panel's body, when it shows more than a bigger card body. */
  DetailBody?: ComponentType<ChartBodyProps>;
  /** Board columns this render wants, before any manifest `size` override. */
  defaultSpan: CardSpan;
  /** Does a date window change what this render shows? (drives the RangeControl) */
  supportsWindow: boolean;
  /** The body's copy when the insight has no data to draw. */
  emptyHint: string;
  /** Multi-page render: the card routes to its own pages, not the slide-over. */
  routed?: boolean;
  /** Card tooltip — what clicking it does. */
  openHint: string;
}

const DETAIL_HINT = 'Open details, history & interactive chart';

/** `Record<Render, …>`: a new render can't compile until it has an entry. */
export const CHART_REGISTRY: Record<Render, ChartRegistryEntry> = {
  number: {
    CardBody: NumberBody,
    DetailBody: NumberDetailBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No value yet.',
    openHint: DETAIL_HINT,
  },
  line: {
    CardBody: LineBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No data yet.',
    openHint: DETAIL_HINT,
  },
  pie: {
    CardBody: PieBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No data yet.',
    openHint: DETAIL_HINT,
  },
  raw: {
    CardBody: RawBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No data yet.',
    openHint: DETAIL_HINT,
  },
  funnel: {
    CardBody: FunnelBody,
    defaultSpan: 2,
    supportsWindow: true,
    emptyHint: 'No funnel data yet — sync to fetch.',
    routed: true,
    openHint: 'Open the funnel table',
  },
  bar: {
    CardBody: BarBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No data yet.',
    openHint: DETAIL_HINT,
  },
  bar_compare: {
    CardBody: BarCompareBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No data yet.',
    openHint: DETAIL_HINT,
  },
  stacked: {
    CardBody: StackedBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No data yet.',
    openHint: DETAIL_HINT,
  },
  table: {
    // A metric table needs room for four columns of numbers before it wraps.
    CardBody: TableBody,
    defaultSpan: 2,
    supportsWindow: true,
    emptyHint: 'No series yet.',
    openHint: DETAIL_HINT,
  },
  heatmap: {
    CardBody: HeatmapBody,
    defaultSpan: 1,
    supportsWindow: true,
    emptyHint: 'No data yet.',
    openHint: DETAIL_HINT,
  },
  breakdown: {
    // A pivot needs room for its column axis before it wraps.
    CardBody: BreakdownBody,
    defaultSpan: 2,
    supportsWindow: true,
    emptyHint: 'No breakdown data yet — sync to fetch.',
    openHint: DETAIL_HINT,
  },
};

/**
 * The entry for a render string. An UNKNOWN render falls back to `number` —
 * exactly what the engine's lenient manifest read does with it (`toRender`), so
 * a hand-edited or newer-than-this-build manifest degrades instead of blanking
 * the board.
 */
export function chartEntry(render: string): ChartRegistryEntry {
  return CHART_REGISTRY[render as Render] ?? CHART_REGISTRY.number;
}

/** The panel's body: its own when the render has one, else the card's. */
export function detailBodyFor(render: string): ComponentType<ChartBodyProps> {
  const entry = chartEntry(render);
  return entry.DetailBody ?? entry.CardBody;
}

/** Board columns for a card: the manifest's `size` wins, else the render's default. */
export function cardSpan(render: string, size: InsightSize | null | undefined): CardSpan {
  if (size === 'l') return 2;
  if (size === 's' || size === 'm') return 1;
  return chartEntry(render).defaultSpan;
}

/** Does this render open routed pages of its own instead of the slide-over? */
export function isRoutedRender(render: string): boolean {
  return chartEntry(render).routed === true;
}
