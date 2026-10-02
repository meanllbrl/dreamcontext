import { applyFrameOps, frameOpsFromOptions, type Frame, type FrameOps, type Selection } from '../../../generated/frameOps';
import type { Block, BlockFilter, ColorDomain } from '../board/boardTypes';
import { rowLabel } from './frameAdapters';

/**
 * Shaping a block's frame on the client: the static options (`where`, `sort`,
 * `limit`, series pick) plus the interactive `filter` blocks of the same
 * card, through the mirrored frameOps in ONE pass (where -> filter -> sort ->
 * limit), so a filtered table's `total` is taken after the filter and before
 * the limit. Zero network: the server's frames come back un-limited.
 *
 * A card's breakdown selection narrows its same-insight table frames the same
 * way (merged into `where`), so a table beside the breakdown chips follows them.
 *
 * `BlockProps.frame` is the OUTPUT of `shapeBlockFrame`. Shape exactly once:
 * a second pass would see "nothing filtered out" and report the source's
 * grand total instead of the filtered one.
 */

/** What a filter block narrows: the insight + dataset of its own table frame. */
export interface FilterTarget {
  insight: string;
  dataset: string | null;
}

/** One filter block's current choice, keyed by the block's frame key (card id + path). */
export interface ActiveFilter {
  key: string;
  target: FilterTarget;
  filter: BlockFilter;
}

/** The dataset a filter block's frame reads, or null when it has no table to filter. */
export function filterTarget(frame: Frame | null | undefined): FilterTarget | null {
  return frame && frame.kind === 'table' ? { insight: frame.insight, dataset: frame.dataset } : null;
}

/** Record (or clear, with `filter: null`) one filter block's choice. Returns a new list. */
export function setActiveFilter(
  list: readonly ActiveFilter[],
  key: string,
  target: FilterTarget | null,
  filter: BlockFilter | null,
): ActiveFilter[] {
  const rest = list.filter((f) => f.key !== key);
  return filter && target ? [...rest, { key, target, filter }] : rest;
}

/** The choice a filter block shows as active (its own entry), or null. */
export function activeFilterFor(list: readonly ActiveFilter[], key: string): BlockFilter | null {
  return list.find((f) => f.key === key)?.filter ?? null;
}

/**
 * The ops one block runs. The first filter on the block's dataset is the
 * interactive filter; any further ones fold into `where` (AND), so the whole
 * thing is still one applyFrameOps pass.
 */
export function blockFrameOps(
  block: Block,
  frame: Frame,
  active: readonly ActiveFilter[],
  selection: Selection | null = null,
): FrameOps {
  const ops = frameOpsFromOptions(block.options);
  if (block.type === 'filter' || frame.kind !== 'table') return ops;
  narrowBySelection(ops, frame, selection);
  const mine = active.filter((f) => f.target.insight === frame.insight && f.target.dataset === frame.dataset);
  if (mine.length === 0) return ops;
  ops.filter = mine[0].filter;
  if (mine.length > 1) {
    const where: Record<string, string[]> = { ...(ops.where ?? {}) };
    for (const { filter } of mine.slice(1)) {
      const allowed = where[filter.dim];
      where[filter.dim] = allowed ? allowed.filter((v) => v === filter.value) : [filter.value];
    }
    ops.where = where;
  }
  return ops;
}

/**
 * The frame a block draws. A filter block is shaped by its own static options
 * only, never by a filter (its chips would collapse to the one chosen value).
 */
/**
 * The colour identity of a RAW (unshaped) frame, in source order: series
 * frames name their series; tables name the series frameToSeries pivots out of
 * them (the second dim's values, or one per row for a single dim) and the rows
 * frameToBarRows labels. Computed before any op, so it is the same whatever the
 * block picks or the filter keeps.
 */
export function frameColorDomain(raw: Frame | null | undefined): ColorDomain | null {
  if (!raw) return null;
  if (raw.kind === 'series') {
    const names = raw.series.map((s) => s.name);
    return { series: names, rows: names };
  }
  if (raw.kind === 'value') return { series: [raw.insight], rows: [raw.insight] };
  if (raw.kind !== 'table') return null;
  const rows = unique(raw.rows.map((r) => rowLabel(r, raw.dims)));
  const second = raw.dims[1];
  const series = raw.dims[0] && second ? unique(raw.rows.map((r) => r.d[second.key] ?? '')) : rows;
  return { series, rows };
}

function unique(list: readonly string[]): string[] {
  return Array.from(new Set(list.filter((s) => s !== '')));
}

/**
 * A breakdown SELECTION narrows a table frame of the same insight: every selected dim the table
 * carries is ANDed into `where` (so the table's total is taken after it, like a filter's). A dim
 * the table does not carry is left alone and reported by `selectionIgnored`. The caller hands the
 * selection of the frame's own insight, so another insight's selection never reaches it.
 */
function narrowBySelection(ops: FrameOps, frame: Extract<Frame, { kind: 'table' }>, selection: Selection | null): void {
  if (!selection) return;
  const carried = new Set(frame.dims.map((d) => d.key));
  const picks = Object.entries(selection).filter(([dim, value]) => carried.has(dim) && value !== '');
  if (picks.length === 0) return;
  const where: Record<string, string[]> = { ...(ops.where ?? {}) };
  for (const [dim, value] of picks) {
    const allowed = where[dim];
    where[dim] = allowed ? allowed.filter((v) => v === value) : [value];
  }
  ops.where = where;
}

/** The selected dims a table frame cannot narrow by (it is not split by them), in selection order. */
export function selectionIgnored(raw: Frame | null | undefined, selection: Selection | null | undefined): string[] {
  if (!raw || raw.kind !== 'table' || !selection) return [];
  const carried = new Set(raw.dims.map((d) => d.key));
  return Object.entries(selection).filter(([dim, value]) => value !== '' && !carried.has(dim)).map(([dim]) => dim);
}

export function shapeBlockFrame(
  block: Block,
  raw: Frame | null | undefined,
  active: readonly ActiveFilter[] = [],
  selection: Selection | null = null,
): Frame | null {
  if (!raw) return null;
  return applyFrameOps(raw, blockFrameOps(block, raw, active, selection));
}
