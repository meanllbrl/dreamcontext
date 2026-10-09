import { createElement, type ComponentType } from 'react';
import type { BlockRenderer, BlockType } from '../board/boardTypes';
import type { BlockViewProps } from './blockCommon';
import { StatBlock } from './StatBlock';
import { LineBlock } from './LineBlock';
import { BarBlock } from './BarBlock';
import { StackedBlock } from './StackedBlock';
import { PieBlock } from './PieBlock';
import { TableBlock } from './TableBlock';
import { HeatmapBlock } from './HeatmapBlock';
import { FunnelBlock } from './FunnelBlock';
import { PivotBlock } from './PivotBlock';
import { TextBlock } from './TextBlock';
import { CalloutBlock } from './CalloutBlock';
import { TabsBlock } from './TabsBlock';
import { FilterBlock } from './FilterBlock';
import { HtmlBlock } from './HtmlBlock';
import { InsightBlock } from './InsightBlock';
import { BreakdownBlock } from './BreakdownBlock';
import { TrendBlock } from './TrendBlock';
import { BenchmarkBlock } from './BenchmarkBlock';
import { SegmentsBlock } from './SegmentsBlock';
import { RankingBlock } from './RankingBlock';
import { PaymentBlock } from './PaymentBlock';
import { AccessBlock } from './AccessBlock';
import './blocks.css';

export type { BlockViewProps } from './blockCommon';
export { blockRenderKey, htmlBlockKey } from './htmlBlockBridge';
export { activeFilterFor, filterTarget, setActiveFilter, shapeBlockFrame, type ActiveFilter, type FilterTarget } from './frameShape';

/**
 * The block registry: ONE component per catalog type. `Record<BlockType, ...>`,
 * so a type added to the engine catalog (src/lib/lab/blocks.ts, mirrored into
 * generated/block-catalog.json and boardTypes.ts) cannot compile until it has
 * a component here; tests/unit/lab-block-registry-drift.test.ts also checks
 * these keys against the generated catalog and the engine.
 */
export const BLOCK_REGISTRY: Record<BlockType, ComponentType<BlockViewProps>> = {
  stat: StatBlock,
  line: LineBlock,
  bar: BarBlock,
  stacked: StackedBlock,
  pie: PieBlock,
  table: TableBlock,
  heatmap: HeatmapBlock,
  funnel: FunnelBlock,
  pivot: PivotBlock,
  text: TextBlock,
  callout: CalloutBlock,
  tabs: TabsBlock,
  filter: FilterBlock,
  html: HtmlBlock,
  insight: InsightBlock,
  breakdown: BreakdownBlock,
  trend: TrendBlock,
  benchmark: BenchmarkBlock,
  segments: SegmentsBlock,
  ranking: RankingBlock,
  payment: PaymentBlock,
  access: AccessBlock,
};

/**
 * The renderer BoardCard draws blocks through. Each block sits in a
 * `.lab-block` box that fills the space the card gives it.
 *
 * The caller's contract: `props.frame` is already shaped
 * (`shapeBlockFrame`, once), and the element is mounted under
 * `blockRenderKey(card.id, path, block)` so an html block remounts on edit.
 */
export const renderBlock: BlockRenderer = (block, props) => {
  const Component = BLOCK_REGISTRY[block.type];
  if (!Component) return null;
  return createElement(
    'div',
    { className: `lab-block lab-block--${block.type}`, 'data-block-type': block.type },
    createElement(Component, { ...props, block }),
  );
};
