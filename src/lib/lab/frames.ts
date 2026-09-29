import { findDataset } from './dataset.js';
import { getInsight, isSafeInsightSlug, readCache } from './store.js';
import { BLOCK_CATALOG, HTML_INPUT_DEFAULT_FRAMES } from './blocks.js';
import { getLibraryBlock, isSafeInputName } from './block-library.js';
import { frameKey, tableTotal } from './frameOps.js';
import type { Block, Board, Card } from './boards.js';
import type { InsightCache, InsightManifest, MatrixDim, MatrixRow, MatrixTotal } from './types.js';
import type { EmptyReason, Frame, FrameKind, FunnelFrame, SeriesFrame, TableFrame, ValueFrame } from './frameOps.js';

export type {
  EmptyFrame,
  EmptyReason,
  Frame,
  FrameKind,
  FunnelFrame,
  SeriesFrame,
  TableFrame,
  TableRow,
  TableTotal,
  ValueFrame,
} from './frameOps.js';
export { EMPTY_REASONS, FRAME_KINDS, frameKey } from './frameOps.js';

/**
 * Frame resolution: a block binding (`<insight>` or `<insight>/<datasetKey>`)
 * becomes the frame the block draws, built from the insight's cache.
 *
 * Every read goes through the hardened store readers (`getInsight`,
 * `readCache`: slug regex, symlink refusal, realpath containment), so a
 * symlinked cache or a `../` / `%2F` binding resolves to an `empty` frame and
 * never to data. The insight part is checked against `isSafeInsightSlug`
 * BEFORE any path is built; the dataset key is only ever an in-memory lookup.
 *
 * Frames come back UN-limited; `frameOps.ts` shapes them per block.
 */

export interface DataRef {
  insight: string;
  dataset: string | null;
}

/** Parse a binding. null = unsafe or malformed (the caller reports `unsafe-ref`). */
export function parseDataRef(ref: unknown): DataRef | null {
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  const slash = s.indexOf('/');
  const insight = slash === -1 ? s : s.slice(0, slash);
  if (!isSafeInsightSlug(insight)) return null;
  if (slash === -1) return { insight, dataset: null };
  const dataset = s.slice(slash + 1);
  if (!dataset || dataset.length > 128 || /[\u0000-\u001f]/.test(dataset)) return null;
  return { insight, dataset };
}

function empty(reason: EmptyReason, ref: string | null): Frame {
  return { kind: 'empty', reason, ref };
}

function dimsOf(dims: MatrixDim[]): TableFrame['dims'] {
  return dims.map((d) => ({ key: d.key, label: d.label ?? d.key }));
}

function tableOf(
  insight: string,
  dataset: string | null,
  label: string | null,
  dims: MatrixDim[],
  rows: MatrixRow[],
  total: MatrixTotal | undefined,
  unit: string | null,
): TableFrame {
  const copied = rows.map((r) => ({ ...r, d: { ...r.d } }));
  const sourceTotal = total ? { ...total } : null;
  return {
    kind: 'table',
    insight,
    dataset,
    label,
    dims: dimsOf(dims),
    rows: copied,
    sourceTotal,
    total: tableTotal(copied, sourceTotal, false),
    unit,
  };
}

function buildTable(slug: string, cache: InsightCache, ref: DataRef): TableFrame | 'missing-dataset' | null {
  const bundle = cache.datasets?.bundle;
  if (ref.dataset !== null) {
    const ds = bundle ? findDataset(bundle, ref.dataset) : null;
    if (!ds) return 'missing-dataset';
    return tableOf(slug, ds.key, ds.label ?? null, ds.dims, ds.rows, ds.total, ds.unit ?? cache.unit ?? null);
  }
  if (bundle) {
    const ds = findDataset(bundle);
    if (ds) return tableOf(slug, ds.key, ds.label ?? null, ds.dims, ds.rows, ds.total, ds.unit ?? cache.unit ?? null);
  }
  const set = cache.matrix?.set;
  if (set) return tableOf(slug, null, null, set.dims, set.rows, set.total, set.unit ?? cache.unit ?? null);
  return null;
}

function buildSeries(slug: string, cache: InsightCache): SeriesFrame | null {
  const series = Array.isArray(cache.series) ? cache.series : [];
  if (series.length === 0) return null;
  return {
    kind: 'series',
    insight: slug,
    series: series.map((s) => ({ name: s.name, points: s.points.map((p) => ({ t: p.t, v: p.v })) })),
    unit: cache.unit ?? null,
    granularity: cache.granularity ?? null,
  };
}

function buildFunnel(slug: string, cache: InsightCache): FunnelFrame | null {
  const set = cache.funnel?.set;
  if (!set || !Array.isArray(set.funnels)) return null;
  return {
    kind: 'funnel',
    insight: slug,
    funnels: set.funnels.map((f) => ({
      id: f.id,
      name: f.name,
      steps: f.steps.map((s) => ({ key: s.key, label: s.label, users: s.users })),
    })),
  };
}

function buildValue(slug: string, cache: InsightCache, ref: DataRef): ValueFrame | 'missing-dataset' {
  const first = Array.isArray(cache.series) ? cache.series[0] : undefined;
  const spark = first ? first.points.map((p) => p.v).filter((v) => Number.isFinite(v)) : [];
  if (ref.dataset !== null) {
    const ds = cache.datasets?.bundle ? findDataset(cache.datasets.bundle, ref.dataset) : null;
    if (!ds) return 'missing-dataset';
    const v = ds.total?.v;
    const prev = ds.total?.prev;
    return {
      kind: 'value',
      insight: slug,
      value: typeof v === 'number' && Number.isFinite(v) ? v : null,
      prev: typeof prev === 'number' && Number.isFinite(prev) ? prev : null,
      spark: [],
      unit: ds.unit ?? cache.unit ?? null,
    };
  }
  const latest = typeof cache.latest === 'number' && Number.isFinite(cache.latest) ? cache.latest : null;
  return {
    kind: 'value',
    insight: slug,
    value: latest ?? (spark.length > 0 ? spark[spark.length - 1] : null),
    prev: spark.length >= 2 ? spark[spark.length - 2] : null,
    spark,
    unit: cache.unit ?? null,
  };
}

/** Memo for one resolution pass (a board reads each insight once). */
export interface FrameReadMemo {
  manifests: Map<string, InsightManifest | null>;
  caches: Map<string, InsightCache | null>;
}

export function newFrameReadMemo(): FrameReadMemo {
  return { manifests: new Map(), caches: new Map() };
}

/**
 * Resolve one binding to the first frame kind in `accepts` the cache can
 * build. Order of checks: unsafe ref -> missing insight -> no cache ->
 * missing dataset -> kind mismatch.
 */
export function resolveFrame(
  contextRoot: string,
  ref: unknown,
  accepts: readonly FrameKind[],
  memo: FrameReadMemo = newFrameReadMemo(),
): Frame {
  const raw = typeof ref === 'string' ? ref : null;
  const parsed = parseDataRef(ref);
  if (!parsed) return empty('unsafe-ref', raw);
  const slug = parsed.insight;
  if (!memo.manifests.has(slug)) memo.manifests.set(slug, getInsight(contextRoot, slug));
  if (!memo.manifests.get(slug)) return empty('missing-insight', raw);
  if (!memo.caches.has(slug)) memo.caches.set(slug, readCache(contextRoot, slug));
  const cache = memo.caches.get(slug);
  if (!cache) return empty('no-cache', raw);

  let missingDataset = false;
  for (const kind of accepts) {
    if (kind === 'table') {
      const t = buildTable(slug, cache, parsed);
      if (t === 'missing-dataset') { missingDataset = true; continue; }
      if (t) return t;
    } else if (kind === 'value') {
      const v = buildValue(slug, cache, parsed);
      if (v === 'missing-dataset') { missingDataset = true; continue; }
      return v;
    } else if (parsed.dataset === null) {
      // Series and funnels live on the insight, not on a named dataset.
      const f = kind === 'series' ? buildSeries(slug, cache) : kind === 'funnel' ? buildFunnel(slug, cache) : null;
      if (f) return f;
    }
  }
  return empty(missingDataset ? 'missing-dataset' : 'kind-mismatch', raw);
}

/** The declared inputs of an html block: name -> {binding, accepted kinds}. Undeclared names never appear. */
export function htmlBlockInputs(
  contextRoot: string,
  block: Block,
): Array<{ name: string; ref: unknown; accepts: readonly FrameKind[] }> {
  const bound = block.options.inputs && typeof block.options.inputs === 'object' && !Array.isArray(block.options.inputs)
    ? (block.options.inputs as Record<string, unknown>)
    : {};
  if (typeof block.options.ref === 'string') {
    const lib = getLibraryBlock(contextRoot, block.options.ref);
    if (!lib) return [];
    return lib.inputs.map((inp) => ({
      name: inp.name,
      ref: Object.prototype.hasOwnProperty.call(bound, inp.name) ? bound[inp.name] : null,
      accepts: inp.kind ? [inp.kind] : HTML_INPUT_DEFAULT_FRAMES,
    }));
  }
  return Object.keys(bound)
    .filter(isSafeInputName)
    .map((name) => ({ name, ref: bound[name], accepts: HTML_INPUT_DEFAULT_FRAMES }));
}

function resolveBlocks(
  contextRoot: string,
  card: Card,
  blocks: readonly Block[],
  prefix: number[],
  out: Record<string, Frame>,
  memo: FrameReadMemo,
): void {
  blocks.forEach((block, i) => {
    const path = [...prefix, i];
    const entry = BLOCK_CATALOG[block.type];
    if (!entry) return;
    if (entry.data === 'binding') {
      out[frameKey(card.id, path)] = resolveFrame(contextRoot, block.data, entry.frames, memo);
    } else if (entry.data === 'inputs') {
      for (const input of htmlBlockInputs(contextRoot, block)) {
        out[frameKey(card.id, path, input.name)] = resolveFrame(contextRoot, input.ref, input.accepts, memo);
      }
    } else if (block.type === 'tabs' && prefix.length === 0) {
      (block.tabs ?? []).forEach((tab, t) => resolveBlocks(contextRoot, card, tab.blocks, [i, t], out, memo));
    }
  });
}

/** Every frame a board's block cards draw, keyed by `frameKey`. Legacy `insight` cards read caches instead. */
export function resolveBoardFrames(contextRoot: string, board: Pick<Board, 'cards'>): Record<string, Frame> {
  const out: Record<string, Frame> = {};
  const memo = newFrameReadMemo();
  for (const card of board.cards) {
    if (card.blocks && card.blocks.length > 0) resolveBlocks(contextRoot, card, card.blocks, [], out, memo);
  }
  return out;
}
