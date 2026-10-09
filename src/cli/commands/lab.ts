import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, header, warn } from '../../lib/format.js';
import { createInsight, getInsight, listInsights, readCache, writeWindowTweaks } from '../../lib/lab/store.js';
import {
  bindInsight,
  normalizeSyncForce,
  planSyncInsight,
  syncInsight,
  syncAll,
  type SyncForce,
  type SyncPlan,
  type SyncResult,
} from '../../lib/lab/sync.js';
import {
  BoardStoreError,
  createBoard,
  deleteBoard,
  deriveBoardsFromLegacy,
  editBoard,
  formatDiagnostic,
  getBoard,
  isMaterialized,
  listBoards,
  putBoard,
  validateBoardSpec,
  type Block,
  type Board,
  type BoardDiagnostic,
  type Card,
} from '../../lib/lab/boards.js';
import { BLOCK_CATALOG, isBlockType, listBlockCatalog } from '../../lib/lab/blocks.js';
import { getLibraryBlock, listLibraryBlocks, parseSafeFrontmatter, saveLibraryBlock, LIBRARY_INPUT_KINDS, type LibraryBlockInput } from '../../lib/lab/block-library.js';
import { frameKey, resolveBoardFrames, resolveFrame, type Frame } from '../../lib/lab/frames.js';
import {
  accessView,
  applyFrameOps,
  benchmarkRows,
  breakdownAxes,
  dailySeries,
  frameOpsFromOptions,
  funnelSlice,
  KN_THRESHOLD,
  orderedNotes,
  parseSelection,
  parseSort,
  paymentView,
  rankableMetrics,
  RANKING_DEFAULT_FLOOR,
  rankingRows,
  segmentRows,
  stepDrops,
  type AccessView,
  type BenchmarkRow,
  type BreakdownAxis,
  type FunnelFrame,
  type FunnelFrameNote,
  type FunnelSlice,
  type Kn,
  type PaymentRow,
  type PaymentView,
  type RankingView,
  type SegmentRow,
  type Selection,
  type SeriesFrame,
  type StepDrop,
} from '../../lib/lab/frameOps.js';
import { cardPicksFunnels, FUNNEL_EXPLORER_SIZE, PRESET_IDS, funnelExplorerBlocks, type PresetId, type PresetLocale } from '../../lib/lab/presets.js';
import { checkLabSnapshot, readLabSnapshot, writeLabSnapshot, type SnapshotCheck } from '../../lib/lab/labData.js';
import { findFreeSlot, isValidRect, type GridRect } from '../../lib/lab/grid.js';
import { ProgressBar } from '../../lib/progress.js';
import { writeCredential, listCredentialNames } from '../../lib/lab/credentials.js';
import { gitignoreCovers } from '../../lib/gitignore.js';
import { computeFunnelPrev, computeStepRows, MAX_FUNNEL_BYTES, worstDropIndex } from '../../lib/lab/funnel.js';
import { dimLabel, dimValues, pivotCell, MATRIX_LOW_SAMPLE_THRESHOLD, MATRIX_SET_KIND } from '../../lib/lab/matrix.js';
import { findAppPage } from '../../lib/lab/app.js';
import { queryDataset, resolveDatasetAsOf, type DatasetQuery } from '../../lib/lab/datasetQuery.js';
import { htmlToText } from '../../lib/lab/htmlText.js';
import {
  INSIGHT_HEIGHTS,
  INSIGHT_SIZES,
  INSIGHT_WIDTHS,
  LabError,
  RENDERS,
  type DatasetCacheEntry,
  type FunnelCacheEntry,
  type InsightCache,
  type InsightHeight,
  type InsightSize,
  type InsightWidth,
  type MatrixCacheEntry,
  type MatrixSet,
  type Render,
} from '../../lib/lab/types.js';

/**
 * `dreamcontext lab` — the analytics-insights subsystem CLI. Mirrors `roadmap`:
 * a thin renderer over the same store/sync engine the dashboard's `/api/lab*`
 * routes call, so behaviour never drifts between CLI and UI.
 */

/** Resolve the project root that holds `_dream_context/` (secrets file location). */
function projectRootFor(contextRoot: string): string {
  return dirname(contextRoot);
}

/** Render `n` as a fixed-width table cell. */
function cell(v: string, width: number): string {
  return v.length >= width ? v : v + ' '.repeat(width - v.length);
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

/** `lab show` funnel view: per-funnel step table with the worst drop highlighted. */
function printFunnelSet(funnel: FunnelCacheEntry, history: InsightCache['funnelHistory']): void {
  const { set, notices, range } = funnel;
  const prev = computeFunnelPrev(funnel, history);
  console.log(`  range: ${range.fromISO} → ${range.toISO}`);
  if (prev.source) console.log(chalk.dim(`  Δ vs snapshot ${prev.source.range.fromISO} → ${prev.source.range.toISO}`));
  for (const notice of notices) warn(notice);

  for (const f of set.funnels) {
    console.log();
    console.log(`  ${chalk.magentaBright(f.id)} — ${f.name}`);
    const metricBits = Object.entries(f.metrics).map(([key, m]) => {
      const v = m.v === null ? '—' : m.format === 'pct' ? `${m.v}%` : m.format === 'usd' ? `$${m.v}` : String(m.v);
      return `${m.label ?? key}=${v}`;
    });
    if (metricBits.length > 0) console.log(chalk.dim(`    ${metricBits.join(' · ')}`));

    const rows = computeStepRows(f.steps);
    const worst = worstDropIndex(rows);
    const labelWidth = Math.min(36, Math.max(8, ...rows.map((r) => r.label.length)));
    console.log(chalk.dim(`    ${cell('step', labelWidth)}  ${cell('users', 8)}  ${cell('of top', 8)}  ${cell('of prev', 8)}  drop`));
    rows.forEach((row, i) => {
      const drop = row.drop === null ? '—' : row.drop < 0 ? `↑${-row.drop}` : `−${row.drop}`;
      const line = `    ${cell(row.label.slice(0, labelWidth), labelWidth)}  ${cell(String(row.users), 8)}  ${cell(fmtPct(row.ofTop), 8)}  ${cell(fmtPct(row.ofPrev), 8)}  ${drop}`;
      console.log(i === worst ? chalk.red(`${line}  ◄ worst drop`) : line);
    });
  }
}

function fmtV(v: number | null, unit?: string): string {
  if (v === null) return '—';
  const s = Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v);
  return unit ? `${s} ${unit}` : s;
}

/** The pivot table itself (rows/cols from dims, n chips, low-sample marks,
 *  total) — the ONE table style every dimensional render shares: `lab show`
 *  on a matrix/v1 insight (printMatrixSet), an app/v1 insight's datasets
 *  (printDatasetBundle) and `lab query`'s result all call this rather than
 *  inventing their own layout. 1 dim → a value list; 2 dims → rows=dim1 ×
 *  cols=dim2; a 3rd dim → one pivot per value. Low-sample cells (n < 30) are
 *  marked, mirroring the F4 idiom. */
function printMatrixPivot(set: MatrixSet): void {
  const unit = set.unit ?? undefined;

  const [dim1, dim2, dim3] = set.dims;
  const printPivot = (coords: Record<string, string>): void => {
    const rowValues = dimValues(set, dim1.key);
    if (!dim2) {
      const width = Math.min(28, Math.max(8, ...rowValues.map((v) => v.length)));
      console.log(chalk.dim(`    ${cell(dimLabel(dim1), width)}  value`));
      for (const value of rowValues) {
        const c = pivotCell(set, { ...coords, [dim1.key]: value });
        const low = c.n !== null && c.n < MATRIX_LOW_SAMPLE_THRESHOLD ? chalk.dim(' (low sample)') : '';
        console.log(`    ${cell(value.slice(0, width), width)}  ${fmtV(c.v, unit)}${c.n !== null ? chalk.dim(` n=${c.n}`) : ''}${low}`);
      }
      return;
    }
    const colValues = dimValues(set, dim2.key);
    const rowWidth = Math.min(28, Math.max(dimLabel(dim1).length, ...rowValues.map((v) => v.length)));
    const colWidth = Math.max(10, ...colValues.map((v) => v.length + 2));
    console.log(chalk.dim(`    ${cell(dimLabel(dim1), rowWidth)}  ${colValues.map((v) => cell(v, colWidth)).join('')}`));
    for (const rowValue of rowValues) {
      const cells = colValues.map((colValue) => {
        const c = pivotCell(set, { ...coords, [dim1.key]: rowValue, [dim2.key]: colValue });
        const text = fmtV(c.v);
        const low = c.n !== null && c.n < MATRIX_LOW_SAMPLE_THRESHOLD;
        return cell(low ? `${text}*` : text, colWidth);
      });
      console.log(`    ${cell(rowValue.slice(0, rowWidth), rowWidth)}  ${cells.join('')}`);
    }
    console.log(chalk.dim('    (* = low sample, n < ' + MATRIX_LOW_SAMPLE_THRESHOLD + ')'));
  };

  if (dim3) {
    for (const value of dimValues(set, dim3.key)) {
      console.log();
      console.log(`  ${chalk.magentaBright(dimLabel(dim3))}: ${value}`);
      printPivot({ [dim3.key]: value });
    }
  } else {
    console.log();
    printPivot({});
  }
  if (set.total) {
    console.log();
    console.log(`  total: ${fmtV(set.total.v, unit)}${set.total.n !== null && set.total.n !== undefined ? chalk.dim(` n=${set.total.n}`) : ''}`);
  }
}

/** `lab show` breakdown view: the pivot the dashboard draws, in text. */
function printMatrixSet(matrix: MatrixCacheEntry): void {
  const { set, notices, range } = matrix;
  console.log(`  range: ${range.fromISO} → ${range.toISO}`);
  for (const notice of notices) warn(notice);
  printMatrixPivot(set);
}

/** `lab show` app view: one pivot per named dataset in the bundle, reusing
 *  the SAME table style `printMatrixSet` draws (a dataset carries the exact
 *  matrix/v1 grammar — dataset.ts delegates its validation to
 *  `parseMatrixSet`, so there is no second table style to invent here). */
function printDatasetBundle(entry: DatasetCacheEntry): void {
  const { bundle, notices, range } = entry;
  console.log(`  range: ${range.fromISO} → ${range.toISO}`);
  for (const notice of notices) warn(notice);
  for (const dataset of bundle.datasets) {
    console.log();
    const primaryTag = dataset.key === bundle.primary ? chalk.dim(' (primary)') : '';
    console.log(`  ${chalk.magentaBright(dataset.key)}${dataset.label ? ` — ${dataset.label}` : ''}${primaryTag}`);
    printMatrixPivot({ kind: MATRIX_SET_KIND, dims: dataset.dims, rows: dataset.rows, total: dataset.total, unit: dataset.unit });
  }
}

/** Repeatable-option accumulator (commander's pattern for `--where a=1 --where b=2`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function handleLabError(err: unknown): void {
  if (err instanceof LabError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  error((err as Error).message ?? String(err));
  process.exitCode = 1;
}

// ─── Sync reporting ─────────────────────────────────────────────────────────

const REASON_TEXT: Record<string, string> = {
  ttl: 'inside its TTL',
  'upstream-unchanged': 'upstream unchanged',
  'error-backoff': 'backing off a recent failure',
  'force-hard': 'forced full refresh',
  'no-cache': 'never synced',
  stale: 'past its TTL',
  user: 'asked for',
  'script-changed': 'script changed since the last run',
  'no-source': 'no valid source',
};

/** One sync outcome, with the skip/fresh reason and the source's own note. */
function printSyncResult(r: SyncResult): void {
  const note = r.freshnessNote ? chalk.dim(` · source: ${r.freshnessNote}`) : '';
  if (r.status === 'ok') {
    success(`${r.slug}: synced (latest=${r.latest ?? 'n/a'}, ${r.granularity})${note}`);
  } else if (r.status === 'fresh') {
    console.log(chalk.dim(`  ${r.slug}: fresh (${REASON_TEXT[r.reason ?? 'ttl'] ?? r.reason}; skipped)`) + note);
  } else if (r.status === 'skipped') {
    console.log(chalk.yellow(`  ${r.slug}: skipped (${REASON_TEXT[r.reason ?? ''] ?? r.reason}${r.error ? `: ${r.error}` : ''}); use --force to retry now.`));
  } else {
    error(`${r.slug}: ${r.error}`);
  }
}

// ─── Snapshots (lab data) ───────────────────────────────────────────────────

/** A snapshot file as JSON (an unreadable or invalid file is a LabError, nothing written). */
function readSnapshotFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    throw new LabError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LabError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

/** A snapshot check in a few lines: what it carries, the stored size against the cap, its notices and problems. */
function printSnapshotCheck(check: SnapshotCheck): void {
  const s = check.summary;
  if (s) {
    const yesNo = (v: boolean) => (v ? 'yes' : 'no');
    const stored = s.storedBytes !== null ? `stored ${s.storedBytes} of ${MAX_FUNNEL_BYTES} bytes` : `${s.bytes} bytes`;
    console.log(`  ${check.kind ?? 'unknown kind'} · ${s.funnels} funnel(s) · ${stored}`);
    if (s.window || s.pulledAt) {
      console.log(chalk.dim(`  ${s.window ? `window ${s.window.from} to ${s.window.to}` : 'no window'}${s.pulledAt ? ` · pulled ${s.pulledAt}` : ''}`));
    }
    if (s.dims.length > 0) console.log(`  dims: ${s.dims.map((d) => `${d.key} (${d.values})`).join(', ')}`);
    console.log(`  paths ${s.segments} on ${s.segmentFunnels} funnel(s) · intersections ${s.intersections} · daily on ${s.dailyFunnels} funnel(s) · ladder ${s.ladderStages} stage(s) · payment ${yesNo(s.payment)} · access ${yesNo(s.access)}`);
  }
  for (const n of check.notices) warn(n);
  for (const p of check.problems) error(p);
  if (check.ok) success('Snapshot is valid.');
}

function printSyncPlan(p: SyncPlan): void {
  const verb = p.action === 'skip' ? chalk.dim('skip ') : p.action === 'probe' ? chalk.cyan('probe') : chalk.yellow('fetch');
  console.log(`  ${verb}  ${chalk.magentaBright(p.slug)} ${chalk.dim(`(${REASON_TEXT[p.reason] ?? p.reason}): ${p.detail}`)}`);
}

// ─── Boards ─────────────────────────────────────────────────────────────────

/** One block as `lab board show` resolves it: the SAME frames the board route
 *  returns, shaped by the SAME frameOps the dashboard runs. */
export interface BoardBlockView {
  /** `0`, or `index.tab.index` inside tabs. */
  path: string;
  type: string;
  data: string | null;
  /** Tab label when the block sits inside a tabs block. */
  tab?: string;
  /** Binding blocks: the shaped frame. */
  frame?: Frame;
  /** html blocks: one frame per declared input. */
  inputs?: Record<string, Frame>;
  /** text / callout blocks. */
  markdown?: string;
  /** Legacy insight blocks: the cached headline. */
  insight?: { latest: number | null; fetchedAt: string | null; error: string | null } | null;
  /** Funnel explorer blocks (and a funnel block in explorer mode): what the card draws for `--select`. */
  explorer?: BoardExplorerView;
}

/** A slice without the parts the explorer view reports elsewhere (daily = `series`, metrics/bands = `rows`). */
export type ExplorerSliceView = Omit<FunnelSlice, 'daily' | 'metrics' | 'bands'>;

/**
 * One explorer block under a selection, computed by the SAME frameOps
 * functions the dashboard blocks call, so the CLI and the card agree:
 * breakdown -> axes; trend -> series; benchmark -> rows; segments -> rows
 * (sorted and limited like the table); funnel -> drops (worst marked).
 */
export interface BoardExplorerView {
  /** The selection the slice honours (undeclared dims are in `slice.ignored`). */
  selection: Selection;
  /**
   * The selection's own slice. Absent on a segments block: its frame keeps only the paths that
   * name its `by` dim, so the bare selection's path is not in it, and "not measured" would be a
   * lie about data that exists. Its rows carry the measurement; `funnelName` names the funnel.
   */
  slice?: ExplorerSliceView;
  funnelName?: string;
  axes?: BreakdownAxis[];
  rows?: BenchmarkRow[] | SegmentRow[];
  /** Segments: the dim the rows split by. */
  by?: string;
  drops?: StepDrop[];
  series?: SeriesFrame;
  /** The funnel the view answers (the block's own pick, else the card's `--funnel`, else the first). */
  funnelId?: string;
  /** A breakdown with the funnel picker: the explorer header (window, source, notes in reading order). */
  header?: {
    window: NonNullable<FunnelFrame['window']> | null;
    provenance: NonNullable<FunnelFrame['provenance']> | null;
    notes: FunnelFrameNote[];
  };
  /** Ranking: each funnel's best breakdown on the default metric (the card's first). */
  ranking?: RankingView;
  /** Ranking: every metric the block can switch to. */
  metrics?: string[];
  payment?: PaymentView;
  /** Access: null when the set carries no access data (the card hides the tab). */
  access?: AccessView | null;
  /** The card hides this block's tab (no data to draw, never zeros). */
  hidden?: boolean;
}

export interface BoardCardView {
  id: string;
  title: string | null;
  insight: string | null;
  at: GridRect;
  blocks: BoardBlockView[];
}

export interface BoardView {
  board: Pick<Board, 'slug' | 'title' | 'rev' | 'derived' | 'error' | 'warnings'>;
  cards: BoardCardView[];
}

function insightHeadline(root: string, slug: string | undefined): BoardBlockView['insight'] {
  if (!slug) return null;
  const cache = readCache(root, slug);
  if (!cache) return null;
  return { latest: cache.latest ?? null, fetchedAt: cache.fetchedAt || null, error: cache.error ?? null };
}

const EXPLORER_TYPES = new Set(['breakdown', 'trend', 'benchmark', 'segments', 'ranking', 'payment', 'access']);

function optString(options: Record<string, unknown>, key: string): string | null {
  const v = options[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function optList(options: Record<string, unknown>, key: string): string[] | null {
  const v = options[key];
  if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim()).filter(Boolean);
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return out.length > 0 ? out : null;
}

/** A requested key list against what exists, in request order, deduped; null = everything available. */
function pickKnown(available: readonly string[], requested: readonly string[] | null): string[] {
  if (!requested) return [...available];
  return requested.filter((k, i) => available.includes(k) && requested.indexOf(k) === i);
}

/** Segment rows sorted like the segments table (unmeasured sorts last, ties keep order), then limited. */
function sortSegmentRows(rows: SegmentRow[], option: unknown, metricKeys: readonly string[], limit: unknown): SegmentRow[] {
  const s = parseSort(option);
  let key: string | null = null;
  if (s) {
    key = s.by === 'users' || s.by === 'n' ? '#users' : s.by === 'value' || s.by === 'label' ? '#value' : s.by;
    if (key !== '#users' && key !== '#value' && !metricKeys.includes(key)) key = null;
  }
  let out = rows.slice();
  if (s && key) {
    const k = key;
    const valueOf = (r: SegmentRow): number | string | null =>
      k === '#value' ? r.value : k === '#users' ? (r.measured ? r.users : null) : r.cells[k]?.v ?? null;
    const sign = s.dir === 'asc' ? 1 : -1;
    out = out
      .map((row, i) => ({ row, i, v: valueOf(row) }))
      .sort((a, b) => {
        if (a.v === null && b.v === null) return a.i - b.i;
        if (a.v === null) return 1;
        if (b.v === null) return -1;
        const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true });
        return c !== 0 ? sign * c : a.i - b.i;
      })
      .map((x) => x.row);
  }
  if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1) out = out.slice(0, limit);
  return out;
}

/**
 * What an explorer block (or a funnel block in explorer mode) draws for
 * `selection`, or null when the block is not one (a funnel block with default
 * options and no selection keeps today's view: no explorer field).
 *
 * `funnelPick` is the card's funnel (`--funnel`, the picker's choice); the
 * block's own `funnel` option wins over it. With neither, the funnel is the
 * first in payload order, as on the card.
 */
export function explorerBlockView(
  type: string,
  frame: FunnelFrame,
  options: Record<string, unknown>,
  selection: Selection,
  funnelPick: string | null = null,
): BoardExplorerView | null {
  if (frame.funnels.length === 0) return null;
  const pick = optString(options, 'funnel') ?? funnelPick;
  const slice = funnelSlice(frame, pick, selection);
  if (type === 'funnel') {
    const inPlay = pick !== null || options.layout === 'flow' || options.markWorst === true || Object.keys(slice.selection).length > 0;
    if (!inPlay) return null;
  } else if (!EXPLORER_TYPES.has(type)) {
    return null;
  }
  if (type === 'ranking') {
    // Ranking is across funnels and ignores the selection: each funnel's best path on the default metric.
    const available = rankableMetrics(frame);
    const metrics = pickKnown(available, optList(options, 'metrics'));
    const out: BoardExplorerView = { selection: {}, metrics };
    if (metrics.length > 0) out.ranking = rankingRows(frame, metrics[0], { minUsers: RANKING_DEFAULT_FLOOR });
    return out;
  }
  const { daily: _daily, metrics: _metrics, bands: _bands, ...sliceView } = slice;
  const out: BoardExplorerView = { selection: slice.selection, slice: sliceView, funnelId: slice.funnelId };
  const levels = frame.funnels.find((f) => f.id === slice.funnelId)?.metrics ?? {};
  if (type === 'funnel') {
    out.drops = slice.measured ? stepDrops(slice.steps) : [];
  } else if (type === 'payment') {
    out.payment = paymentView(frame, slice.funnelId, selection);
  } else if (type === 'access') {
    out.access = accessView(frame, slice.funnelId, selection);
    out.hidden = out.access === null;
  } else if (type === 'breakdown') {
    const axes = breakdownAxes(frame, pick, selection);
    const dims = optList(options, 'dims');
    out.axes = dims ? pickKnown(axes.map((a) => a.key), dims).map((k) => axes.find((a) => a.key === k)!) : axes;
    if (options.picker === true) {
      out.header = {
        window: frame.window ?? null,
        provenance: frame.provenance ?? null,
        notes: orderedNotes(frame, slice.funnelId),
      };
    }
  } else if (type === 'trend') {
    const available = Object.keys(slice.metrics);
    for (const day of slice.daily) for (const k of Object.keys(day.m)) if (!available.includes(k)) available.push(k);
    out.series = dailySeries(slice, pickKnown(available, optList(options, 'metrics')), frame.insight);
  } else if (type === 'benchmark') {
    const picked = optList(options, 'metrics');
    // A ladder names the benchmark's stages and their order; without one, every metric the funnel carries.
    const keys = picked
      ? picked.filter((k) => k in levels || k in slice.metrics)
      : frame.ladder && frame.ladder.length > 0
        ? frame.ladder.slice()
        : Object.keys(levels).length > 0 ? Object.keys(levels) : Object.keys(slice.metrics);
    out.rows = benchmarkRows(slice, keys).map((r) => (r.label === r.key && levels[r.key]?.label
      ? { ...r, label: levels[r.key].label as string, format: r.current === null ? levels[r.key].format : r.format }
      : r));
  } else {
    const dims = frame.dimensions ?? [];
    const byOpt = optString(options, 'by');
    const by = byOpt ? dims.find((d) => d.key === byOpt)?.key ?? null : dims[0]?.key ?? null;
    if (by === null) {
      out.rows = [];
    } else {
      const picked = optList(options, 'metrics');
      const metricKeys = picked ? picked.filter((k) => k in levels) : Object.keys(levels);
      out.by = by;
      delete out.slice;
      out.funnelName = slice.funnelName;
      out.rows = sortSegmentRows(segmentRows(frame, pick, by, selection, metricKeys), options.sort, metricKeys, options.limit);
    }
  }
  return out;
}

/**
 * Resolve every card's blocks exactly as the dashboard draws them (`selection`:
 * the card state `--select` stands for; `funnel`: the funnel `--funnel` picks,
 * honoured, like the dashboard's picker, only on a card with a funnel picker).
 */
export function buildBoardView(root: string, board: Board, selection: Selection = {}, funnel: string | null = null): BoardView {
  const frames = resolveBoardFrames(root, board);
  const viewBlock = (card: Card, block: Block, path: number[], tab?: string): BoardBlockView => {
    const out: BoardBlockView = { path: path.join('.'), type: block.type, data: block.data ?? null };
    if (tab !== undefined) out.tab = tab;
    const entry = BLOCK_CATALOG[block.type];
    if (entry.data === 'binding') {
      const frame = frames[frameKey(card.id, path)];
      if (frame) out.frame = applyFrameOps(frame, frameOpsFromOptions(block.options));
      if (frame?.kind === 'funnel') {
        const cardFunnel = funnel !== null && cardPicksFunnels(card.blocks) ? funnel : null;
        const explorer = explorerBlockView(block.type, frame, block.options, selection, cardFunnel);
        if (explorer) out.explorer = explorer;
      }
    } else if (entry.data === 'inputs') {
      const prefix = `${frameKey(card.id, path)}#`;
      out.inputs = {};
      for (const [key, frame] of Object.entries(frames)) {
        if (key.startsWith(prefix)) out.inputs[key.slice(prefix.length)] = frame;
      }
    } else if (entry.data === 'insight') {
      out.insight = insightHeadline(root, block.data ?? card.insight);
    } else if (typeof block.options.markdown === 'string') {
      out.markdown = block.options.markdown;
    }
    return out;
  };
  const cards = board.cards.map((card): BoardCardView => {
    const blocks: BoardBlockView[] = [];
    if (!card.blocks || card.blocks.length === 0) {
      blocks.push({ path: '0', type: 'insight', data: card.insight ?? null, insight: insightHeadline(root, card.insight) });
    } else {
      card.blocks.forEach((block, i) => {
        if (block.type === 'tabs') {
          blocks.push({ path: String(i), type: 'tabs', data: null });
          (block.tabs ?? []).forEach((t, ti) => t.blocks.forEach((child, ci) => blocks.push(viewBlock(card, child, [i, ti, ci], t.label))));
        } else {
          blocks.push(viewBlock(card, block, [i]));
        }
      });
    }
    return { id: card.id, title: card.title ?? null, insight: card.insight ?? null, at: card.at, blocks };
  });
  const { slug, title, rev, derived, error: err, warnings } = board;
  return { board: { slug, title, rev, derived, error: err, warnings }, cards };
}

function fmtNum(v: number | null | undefined, unit?: string | null): string {
  if (v === null || v === undefined) return 'n/a';
  return fmtV(v, unit ?? undefined);
}

/** A frame in a few terminal lines. */
function frameLines(frame: Frame): string[] {
  switch (frame.kind) {
    case 'empty':
      return [chalk.dim(`(no data: ${frame.reason}${frame.ref ? ` for "${frame.ref}"` : ''})`)];
    case 'value':
      return [`${fmtNum(frame.value, frame.unit)}${frame.prev !== null ? chalk.dim(` (prev ${fmtNum(frame.prev, frame.unit)})`) : ''}`];
    case 'series':
      return frame.series.map((s) => {
        const last = s.points[s.points.length - 1];
        const span = s.points.length > 0 ? chalk.dim(` · ${s.points.length} points ${s.points[0].t} → ${last.t}`) : chalk.dim(' · no points');
        return `${s.name}: ${last ? fmtNum(last.v, frame.unit) : 'n/a'}${span}`;
      });
    case 'table': {
      const lines = [`${frame.total.count} row(s), total ${fmtNum(frame.total.v, frame.unit)}${frame.dataset ? chalk.dim(` · dataset ${frame.dataset}`) : ''}`];
      for (const row of frame.rows.slice(0, 10)) {
        const dims = frame.dims.map((d) => row.d[d.key] ?? 'n/a').join(' / ');
        lines.push(`  ${dims}: ${fmtNum(row.v, frame.unit)}`);
      }
      if (frame.rows.length > 10) lines.push(chalk.dim(`  … ${frame.rows.length - 10} more`));
      return lines;
    }
    case 'funnel':
      return frame.funnels.map((f) => `${f.name}: ${f.steps.map((st) => `${st.label} ${st.users}`).join(' → ')}`);
  }
}

function explorerPct(v: number | null): string {
  return v === null ? 'n/a' : `${Math.round(v * 10) / 10}%`;
}

function notMeasuredLine(reason: string | null): string {
  return chalk.yellow(`Not measured${reason ? `: ${reason}` : ''}`);
}

/** Why a slice's path is missing when the payload gave no reason: its reason code in words. */
function sliceReason(s: ExplorerSliceView): string | null {
  if (s.reason) return s.reason;
  if (s.reasonCode === 'not-pulled') return 'this combination was not pulled from the source';
  if (s.reasonCode === 'below-floor') return 'under the declared user floor, or not pulled';
  return null;
}

/** A count over a count when the denominator is small (KN_THRESHOLD), else null. */
function knText(kn: Kn | null | undefined): string | null {
  return kn && kn.n < KN_THRESHOLD ? `${kn.k}/${kn.n}` : null;
}

function paymentRowText(r: PaymentRow): string {
  const rate = knText(r.kn) ?? (r.rate === null ? 'n/a' : explorerPct(r.rate));
  return `decline rate ${rate} (${r.declines} of ${r.attempts} attempts)${r.lowSample ? chalk.dim(' · low sample') : ''}`;
}

function paymentLines(p: PaymentView): string[] {
  if (p.scope === 'none') return [chalk.dim('payment: no payment data in the snapshot')];
  if (!p.measured) return [notMeasuredLine(p.reason)];
  const lines: string[] = [];
  if (p.scope === 'set') lines.push(chalk.dim('all funnels: this funnel has no payment split'));
  if (p.cohorts.length > 1) lines.push(chalk.dim(`cohort ${p.cohort} (of ${p.cohorts.join(', ')})`));
  const shown = p.current ?? p.total;
  if (!p.current && p.total && Object.keys(p.total.dims).length === 0) lines.push(chalk.dim('not measured for this selection; the funnel total is shown'));
  if (shown) {
    lines.push(paymentRowText(shown));
    for (const reason of shown.reasons) {
      lines.push(`  ${reason.label}: ${reason.count}${reason.share !== null ? chalk.dim(` (${explorerPct(reason.share)} of declines)`) : ''}`);
    }
    if (shown.other > 0) lines.push(`  other or unnamed: ${shown.other}`);
    if (shown.clipped) lines.push(chalk.red('  reasons add up to more than the declines: check the source'));
  }
  for (const group of p.byDim) {
    for (const r of group.rows) lines.push(`${group.dim}=${r.dims[group.dim]}: ${paymentRowText(r)}`);
  }
  return lines;
}

function rankingLines(r: RankingView, metrics: readonly string[]): string[] {
  const lines = [`ranking ${r.label} (at least ${r.minUsers} users, ${r.better} is better)${metrics.length > 1 ? chalk.dim(` · metrics ${metrics.join(', ')}`) : ''}`];
  r.rows.forEach((row, i) => {
    const sel = Object.entries(row.selection).map(([k, v]) => `${k}=${v}`).join(', ');
    const value = knText(row.kn) ?? fmtNum(row.value);
    lines.push(`${i + 1}. ${row.funnelName} ${sel}: ${value}${chalk.dim(` · ${row.users} users${row.total !== null ? ` · funnel ${fmtNum(row.total)}` : ''}`)}${row.lowSample ? chalk.dim(' · low sample') : ''}`);
  });
  if (r.dropped.length > 0) lines.push(chalk.dim(`no breakdown with ${r.minUsers}+ users: ${r.dropped.map((d) => d.funnelName).join(', ')}`));
  return lines;
}

/** An explorer block in a few terminal lines: the selection, then its rows, drops, axes or series. */
function explorerLines(x: BoardExplorerView): string[] {
  if (x.ranking || x.metrics) {
    return x.ranking ? rankingLines(x.ranking, x.metrics ?? []) : [chalk.dim('ranking: no rate metric to rank')];
  }
  const sel = Object.entries(x.selection).map(([k, v]) => `${k}=${v}`).join(', ');
  const s = x.slice;
  const name = s?.funnelName ?? x.funnelName;
  const lines = [`${name ? `${name} · ` : ''}${sel ? `selection ${sel}` : 'all traffic'}${s?.ignored.length ? chalk.dim(` · not split by ${s.ignored.join(', ')}`) : ''}`];
  if (x.header) {
    const w = x.header.window;
    if (w) lines.push(chalk.dim(`window ${w.from} to ${w.to}${w.prevFrom && w.prevTo ? `, previous ${w.prevFrom} to ${w.prevTo}` : ''}`));
    const p = x.header.provenance;
    if (p) lines.push(chalk.dim(`source: ${[p.source, p.freshness, p.pulledAt ? `pulled ${p.pulledAt}` : null].filter(Boolean).join(' · ')}`));
    for (const n of x.header.notes) {
      lines.push(`${n.level === 'trap' ? chalk.yellow('[trap') : chalk.dim('[info')}${n.code ? ` ${n.code}` : ''}${n.level === 'trap' ? chalk.yellow(']') : chalk.dim(']')} ${n.text}`);
    }
  }
  if (x.hidden) {
    lines.push(chalk.dim('access: hidden (no data)'));
    return lines;
  }
  // Payment cells are their own lookup: a missing path does not make the payment unmeasured.
  if (s && !s.measured && !x.payment) lines.push(notMeasuredLine(sliceReason(s)));
  else if (s?.lowSample && !x.payment) lines.push(chalk.dim(`low sample: ${s.users} users`));
  if (x.drops) {
    for (const d of x.drops) {
      if (!d.measured) {
        const reason = s?.steps.find((st) => st.key === d.key)?.reason ?? null;
        lines.push(`${d.label}: ${notMeasuredLine(reason)}`);
        continue;
      }
      const kn = d.prevUsers !== null && d.prevUsers < KN_THRESHOLD ? `${d.users}/${d.prevUsers}` : null;
      const ofPrev = d.ofPrev === null ? '' : chalk.dim(` (${kn ?? explorerPct(d.ofPrev)} of previous)`);
      const derived = d.basis === 'derived' ? chalk.dim(' (derived)') : '';
      lines.push(`${d.label}: ${d.users}${derived}${ofPrev}${d.worst ? chalk.red(` ← biggest drop ${explorerPct(d.dropPct)}`) : ''}`);
    }
  }
  if (x.payment) lines.push(...paymentLines(x.payment));
  if (x.access) {
    if (x.access.asOf) lines.push(chalk.dim(`status as of ${x.access.asOf}; cohort from the window`));
    for (const row of x.access.rows) {
      const head = row.funnel ?? (Object.entries(row.dims).map(([k, v]) => `${k}=${v}`).join(', ') || 'everyone');
      const cells = row.cells.map((c) => `${c.label} ${c.users === null ? 'not measured' : `${c.users}${knText(c.kn) ? ` (${knText(c.kn)})` : c.ofBase !== null ? ` (${explorerPct(c.ofBase)})` : ''}`}`);
      lines.push(`${head}: ${cells.join(' · ')}`);
    }
  }
  if (x.axes) {
    for (const a of x.axes) {
      lines.push(`${a.label}: ${a.chips.map((c) => `${c.active ? `[${c.value}]` : c.value}${c.enabled ? '' : chalk.dim(` (off${c.reason ? `: ${c.reason}` : ''})`)}`).join('  ')}`);
    }
  }
  if (x.series) {
    for (const ser of x.series.series) {
      const last = ser.points[ser.points.length - 1];
      lines.push(`${ser.name}: ${last ? `${fmtNum(last.v, x.series.unit)} on ${last.t}` : 'n/a'}${chalk.dim(` · ${ser.points.length} day(s)`)}`);
    }
  }
  if (x.rows) {
    for (const r of x.rows) {
      if ('status' in r) {
        if (r.status === 'unmeasured') {
          lines.push(`${r.label}: ${notMeasuredLine(r.reason)}`);
          continue;
        }
        const from = (kind: 'book' | 'own' | null, own: string, src: string | null) => (kind === 'own' ? own : kind === 'book' ? `book${src ? `: ${src}` : ''}` : src);
        const floorSrc = from(r.floorFrom, 'own p25', r.floorSource);
        const targetSrc = from(r.targetFrom, 'own p75', r.targetSource);
        const weeks = r.weeks !== null && (r.floorFrom === 'own' || r.targetFrom === 'own') ? `, ${r.weeks} weeks` : '';
        const band = r.floor !== null || r.target !== null ? chalk.dim(` · floor ${fmtNum(r.floor)}${floorSrc ? ` (${floorSrc})` : ''}, target ${fmtNum(r.target)}${targetSrc ? ` (${targetSrc})` : ''}${weeks}`) : '';
        const delta = r.delta !== null ? chalk.dim(` · ${r.delta > 0 ? '+' : ''}${fmtNum(r.delta)} vs prev${r.trend ? `, ${r.trend}` : ''}`) : '';
        const inherited = r.inherited ? chalk.dim(r.inheritedFrom === 'funnel' ? ' · band from the funnel' : r.inheritedFrom === 'set' ? ' · band from the total' : ' · inherited band') : '';
        lines.push(`${r.label}: ${fmtNum(r.current)} ${r.status}${band}${delta}${inherited}`);
      } else {
        const head = `${x.by ?? ''}=${r.value}`;
        if (!r.measured) {
          lines.push(`${head}: ${notMeasuredLine(r.reason)}`);
          continue;
        }
        const cells = Object.entries(r.cells).map(([k, c]) => `${k} ${c.v === null ? 'not measured' : knText(c.kn) ?? fmtNum(c.v)}${c.tone ? chalk.dim(` (${c.tone})`) : ''}`);
        lines.push(`${head}: ${r.users} users${cells.length ? ` · ${cells.join(', ')}` : ''}${r.lowSample ? chalk.dim(' · low sample') : ''}`);
      }
    }
  }
  return lines;
}

function printBoardView(view: BoardView): void {
  const b = view.board;
  console.log(header(`Board: ${b.title} (${b.slug})${b.derived ? ' · derived' : ''}`));
  if (b.error) {
    error(`${b.error.kind === 'conflict' ? 'merge conflict' : 'unreadable'}: ${b.error.message}`);
    return;
  }
  for (const w of b.warnings) warn(formatDiagnostic(w));
  if (view.cards.length === 0) console.log(chalk.dim('  (no cards)'));
  for (const card of view.cards) {
    console.log();
    const at = `${card.at.x},${card.at.y} ${card.at.w}x${card.at.h}`;
    console.log(`  ${chalk.magentaBright(card.id)}${card.title ? `: ${card.title}` : ''}${card.insight ? chalk.dim(` · ${card.insight}`) : ''} ${chalk.dim(`@ ${at}`)}`);
    for (const block of card.blocks) {
      const label = `    [${block.path}] ${block.type}${block.data ? ` ${block.data}` : ''}${block.tab ? chalk.dim(` (tab ${block.tab})`) : ''}`;
      if (block.explorer) {
        console.log(`${label}:`);
        for (const line of explorerLines(block.explorer)) console.log(`      ${line}`);
      } else if (block.frame) {
        const lines = frameLines(block.frame);
        console.log(`${label}: ${lines[0]}`);
        for (const line of lines.slice(1)) console.log(`      ${line}`);
      } else if (block.inputs) {
        console.log(label);
        for (const [name, frame] of Object.entries(block.inputs)) console.log(`      ${name}: ${frameLines(frame)[0]}`);
      } else if (block.type === 'insight') {
        const h = block.insight;
        console.log(`${label}: ${h ? `${fmtNum(h.latest)}${h.error ? chalk.red(` ⚠ ${h.error}`) : ''}${chalk.dim(` · fetched ${h.fetchedAt ?? 'never'}`)}` : chalk.dim('(no cache)')}`);
      } else if (block.markdown !== undefined) {
        console.log(`${label}: ${chalk.dim(block.markdown.split('\n')[0].slice(0, 80))}`);
      } else {
        console.log(label);
      }
    }
  }
}

/** Read a board spec file: `.json`, or YAML with or without `---` fences (safe engine only). */
function readSpecFile(file: string): { raw: unknown; body: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    throw new LabError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    if (extname(file).toLowerCase() === '.json') return { raw: JSON.parse(text), body: '' };
    const fenced = text.trimStart().startsWith('---') ? text.trimStart() : `---\n${text}\n---\n`;
    const { data, content } = parseSafeFrontmatter(fenced);
    return { raw: data, body: content.trim() };
  } catch (err) {
    throw new LabError(`${file} is not a readable board spec: ${(err as Error).message.split('\n')[0]}`);
  }
}

function printDiagnostics(errors: BoardDiagnostic[], warnings: BoardDiagnostic[]): void {
  for (const d of errors) error(formatDiagnostic(d));
  for (const d of warnings) warn(formatDiagnostic(d));
}

function handleBoardError(err: unknown): void {
  if (err instanceof BoardStoreError && err.diagnostics.length > 0) {
    error(`${err.message.split('\n')[0]}`);
    printDiagnostics(err.diagnostics, []);
    process.exitCode = 1;
    return;
  }
  handleLabError(err);
}

function parseAt(raw: string): GridRect {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  const at = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  if (parts.length !== 4 || !isValidRect(at)) {
    throw new LabError(`--at must be x,y,w,h whole numbers on the 12-column grid (w 1..12, x 0..12-w, h 1..24); got "${raw}".`);
  }
  return at;
}

/** Parse `--block '<json>'` (file form `{"line": {...}}` or `{type, data?, options?}`), binding it to `insight` when it names no data. */
function parseBlockArg(raw: string, insight: string | undefined): { block: Record<string, unknown>; type: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LabError(`--block is not valid JSON: ${(err as Error).message}. Example: --block '{"line": {"area": true}}'.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LabError('--block must be one JSON object, e.g. {"stat": {"delta": "prev"}}.');
  }
  const obj = { ...(parsed as Record<string, unknown>) };
  if (isBlockType(obj.type)) {
    if (obj.data === undefined && insight && BLOCK_CATALOG[obj.type].data === 'binding') obj.data = insight;
    return { block: obj, type: obj.type };
  }
  const keys = Object.keys(obj);
  const type = keys.length === 1 ? keys[0] : '';
  if (isBlockType(type)) {
    const value = obj[type];
    if (insight && BLOCK_CATALOG[type].data === 'binding' && (value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).data === undefined))) {
      obj[type] = { ...((value as Record<string, unknown>) ?? {}), data: insight };
    }
  }
  return { block: obj, type };
}

/** A card id not yet on the board: `base`, then `base-2`, `base-3`... */
function freeCardId(cards: readonly Card[], base: string): string {
  const taken = new Set(cards.map((c) => c.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The legacy footprint an insight's manifest asks for (the derivation's own rule). */
function legacyFootprint(root: string, insight: string): { w: number; h: number } {
  const m = getInsight(root, insight);
  if (!m) return BLOCK_CATALOG.insight.defaultSize;
  const hasHtmlBody = m.source?.adapter === 'script' && typeof readCache(root, m.slug)?.html === 'string';
  const card = deriveBoardsFromLegacy([{ ...m, hasHtmlBody }])[0]?.spec.cards.find((c) => c.id === `c-${m.slug}`);
  return card ? { w: card.at.w, h: card.at.h } : BLOCK_CATALOG.insight.defaultSize;
}

/** Append a card to a board under the shared lock (materializes derived boards first). */
async function addCard(
  root: string,
  boardSlug: string,
  opts: { insight?: string; block?: string; at?: string; id?: string },
): Promise<Board> {
  const parsed = opts.block !== undefined ? parseBlockArg(opts.block, opts.insight) : null;
  const at = opts.at !== undefined ? parseAt(opts.at) : null;
  const board = await editBoard(root, boardSlug, (current) => {
    if (!current) throw new BoardStoreError('not-found', `Board "${boardSlug}" does not exist. Create it with \`dreamcontext lab board create ${boardSlug} --title "..."\`.`);
    const size = parsed && isBlockType(parsed.type)
      ? BLOCK_CATALOG[parsed.type].defaultSize
      : opts.insight ? legacyFootprint(root, opts.insight) : BLOCK_CATALOG.insight.defaultSize;
    const card: Record<string, unknown> = {
      id: opts.id ?? freeCardId(current.cards, opts.insight ? `c-${opts.insight}` : 'card'),
      at: at ?? findFreeSlot(current.cards, size.w, size.h),
    };
    if (opts.insight) card.insight = opts.insight;
    if (parsed) card.blocks = [parsed.block];
    return { ...current, cards: [...current.cards, card] };
  });
  return board!;
}

/** The locale a preset card is written in: `--locale`, else the insight's manifest `locale`, else English. */
export function presetCardLocale(root: string, insight: string, flag: string | undefined): PresetLocale {
  if (flag !== undefined) return flag === 'tr' ? 'tr' : 'en';
  return getInsight(root, insight)?.locale === 'tr' ? 'tr' : 'en';
}

/** Why a `--preset` invocation cannot run, or null. */
function presetProblem(opts: { insight?: string; block?: string; preset?: string; locale?: string }): string | null {
  if (opts.block !== undefined) return '--preset and --block are mutually exclusive: a preset writes the whole card.';
  if (!(PRESET_IDS as readonly string[]).includes(opts.preset ?? '')) return `Unknown preset "${opts.preset}". Use one of: ${PRESET_IDS.join(', ')}.`;
  if (!opts.insight) return `--preset ${opts.preset} needs --insight <slug>.`;
  if (opts.locale !== undefined && opts.locale !== 'en' && opts.locale !== 'tr') return `--locale must be en or tr (got "${opts.locale}").`;
  return null;
}

/**
 * `add-card --preset funnel-explorer`: the insight's funnel frame decides the
 * segments tabs (its client dimensions), so an unsynced insight is refused,
 * and a synced one without a funnel set is told it has no funnel data.
 * The blocks come from presets.ts, the same function the dashboard's add-card
 * entry calls, so both produce the same card.
 */
async function addPresetCard(
  root: string,
  boardSlug: string,
  insight: string,
  locale: PresetLocale,
  opts: { at?: string; id?: string },
): Promise<Board> {
  const frame = resolveFrame(root, insight, ['funnel']);
  if (frame.kind === 'empty' && frame.reason === 'kind-mismatch') {
    // Synced, but its cache carries no funnel set: syncing again would not help.
    throw new LabError(
      readCache(root, insight)?.app
        // A hand-built v1 explorer: its pages work, but the preset reads the funnel member its data lacks.
        ? `${insight} is an app insight with no funnel data. To convert it, make its script return \`data.funnel\` (a \`funnel-set/v1\`) next to the dataset bundle (the app pages keep working), run \`dreamcontext lab sync ${insight}\`, then add the preset again. Recipe: the skill reference, "Converting a v1 app explorer".`
        : `${insight} has no funnel data: the preset needs a funnel-set (funnel member).`,
    );
  }
  if (frame.kind !== 'funnel') {
    throw new LabError(`sync ${insight} first: the preset needs its funnel dimensions (\`dreamcontext lab sync ${insight}\`).`);
  }
  const blocks = funnelExplorerBlocks(insight, (frame.dimensions ?? []).map((d) => ({ key: d.key, label: d.label })), locale);
  const title = getInsight(root, insight)?.title ?? null;
  const at = opts.at !== undefined ? parseAt(opts.at) : null;
  const board = await editBoard(root, boardSlug, (current) => {
    if (!current) throw new BoardStoreError('not-found', `Board "${boardSlug}" does not exist. Create it with \`dreamcontext lab board create ${boardSlug} --title "..."\`.`);
    const card: Record<string, unknown> = {
      id: opts.id ?? freeCardId(current.cards, `c-${insight}`),
      at: at ?? findFreeSlot(current.cards, FUNNEL_EXPLORER_SIZE.w, FUNNEL_EXPLORER_SIZE.h),
      insight,
      blocks,
    };
    if (title) card.title = title;
    return { ...current, cards: [...current.cards, card] };
  });
  return board!;
}

/**
 * `lab create` placement (D2). Materialized boards: append to `--board`, else
 * the board titled like the insight's category, else the first board.
 * Derived boards place every insight by category already, so nothing is
 * written unless `--board` asks for a specific one. `--no-board` opts out.
 */
/**
 * `lab create --preset funnel-explorer` placement. A derived vault places the
 * explorer card on the category board by itself (from the manifest's preset).
 * A materialized vault (or an explicit `--board`) is never written here: the
 * card's axis tabs come from the synced snapshot, so the add-card command to
 * run after the first sync is printed instead.
 */
function placeNewExplorer(root: string, slug: string, category: string | null, board: string | false | undefined, preset: PresetId): void {
  if (board === false) return;
  if (!isMaterialized(root) && typeof board !== 'string') {
    console.log(chalk.dim('  It shows as a funnel explorer card on the board for its category (boards are still derived from categories).'));
    return;
  }
  let target = typeof board === 'string' ? board : null;
  if (!target) {
    const boards = listBoards(root).boards.filter((b) => !b.error);
    const want = (category ?? '').trim().toLowerCase();
    target = (want ? boards.find((b) => b.title.trim().toLowerCase() === want) : undefined)?.slug ?? boards[0]?.slug ?? '<board>';
  }
  console.log(chalk.dim(`  Not placed yet: after the first sync, add the explorer card with \`dreamcontext lab board add-card ${target} --insight ${slug} --preset ${preset}\`.`));
}

async function placeNewInsight(root: string, slug: string, category: string | null, board: string | false | undefined): Promise<void> {
  if (board === false) return;
  if (!isMaterialized(root) && typeof board !== 'string') {
    console.log(chalk.dim('  It shows on the board for its category (boards are still derived from categories).'));
    return;
  }
  let target = typeof board === 'string' ? board : null;
  if (!target) {
    const boards = listBoards(root).boards.filter((b) => !b.error);
    const want = (category ?? '').trim().toLowerCase();
    target = (want ? boards.find((b) => b.title.trim().toLowerCase() === want) : undefined)?.slug ?? boards[0]?.slug ?? null;
  }
  if (!target) {
    warn('No board to place it on: create one with `dreamcontext lab board create <slug> --title "..."`.');
    return;
  }
  try {
    const placed = await addCard(root, target, { insight: slug });
    const card = placed.cards[placed.cards.length - 1];
    success(`Placed on board "${target}" as card "${card.id}".`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (typeof board === 'string') {
      error(`Could not place it on board "${target}": ${message}`);
      process.exitCode = 1;
    } else {
      warn(`Could not place it on board "${target}": ${message}`);
    }
  }
}

/** Parse `--inputs name[:kind],name2` for `lab block save`. */
function parseInputsArg(raw: string): LibraryBlockInput[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const [name, kind] = part.split(':').map((x) => x.trim());
    if (kind && !(LIBRARY_INPUT_KINDS as readonly string[]).includes(kind)) {
      throw new LabError(`--inputs: unknown kind "${kind}" for "${name}"; use one of ${LIBRARY_INPUT_KINDS.join(', ')}.`);
    }
    return { name, kind: (kind as LibraryBlockInput['kind']) || null };
  });
}

export function registerLabCommand(program: Command): void {
  const lab = program
    .command('lab')
    .description('Analytics insights: curated metrics from HTTP APIs or scripts, synced into the brain');

  lab
    .command('sync')
    .argument('[slug]', 'Insight slug to sync (omit with --all)')
    .description('Sync one insight, or every insight with --all (only pays for change: TTL, then the upstream probe)')
    .option('--all', 'Sync every insight')
    .option('--force', 'Skip the TTL (the upstream freshness probe still decides whether to fetch)')
    .option('--force-hard', 'Skip the TTL AND the probe: always a full fetch')
    .option('--dry-run', 'Print what would be fetched, probed or skipped; sends ZERO upstream requests')
    .option('--json', 'Emit as JSON')
    .action(async (slug: string | undefined, opts: { all?: boolean; force?: boolean; forceHard?: boolean; dryRun?: boolean; json?: boolean }) => {
      const root = ensureContextRoot();
      if (!opts.all && !slug) {
        error('Provide an insight slug, or pass --all to sync every insight.');
        process.exitCode = 1;
        return;
      }
      const force: SyncForce | undefined = normalizeSyncForce(opts.forceHard ? 'hard' : opts.force ? 'user' : undefined);
      try {
        if (opts.dryRun) {
          const slugs = opts.all ? listInsights(root).map((m) => m.slug) : [slug!];
          const plans = slugs.map((s) => planSyncInsight(root, s, { force }));
          if (opts.json) {
            console.log(JSON.stringify({ dryRun: true, force: force ?? null, plans }, null, 2));
            return;
          }
          console.log(header(`Sync plan (dry run${force ? `, force ${force}` : ''}): no request sent`));
          for (const p of plans) printSyncPlan(p);
          const count = (a: SyncPlan['action']): number => plans.filter((p) => p.action === a).length;
          console.log();
          console.log(chalk.dim(`  ${count('fetch')} fetch · ${count('probe')} probe · ${count('skip')} skip`));
          return;
        }
        if (opts.all) {
          // A full board runs for minutes across concurrent workers — without a
          // live bar the terminal looks hung until the very last insight lands.
          const bar = opts.json ? null : new ProgressBar();
          const { results, failed } = await syncAll(root, {
            force,
            onProgress: (ev) => bar?.update('insights', ev.done, ev.total),
          });
          bar?.done();
          if (opts.json) {
            console.log(JSON.stringify({ results, failed }, null, 2));
          } else {
            for (const r of results) printSyncResult(r);
            console.log();
          }
          if (failed.length > 0) {
            if (!opts.json) error(`${failed.length} of ${results.length} insight(s) failed to sync.`);
            process.exitCode = 1;
          } else if (!opts.json) {
            success(`Synced ${results.length} insight(s).`);
          }
          return;
        }
        const result = await syncInsight(root, slug!, { force });
        if (opts.json) console.log(JSON.stringify({ results: [result], failed: result.status === 'failed' ? [result] : [] }, null, 2));
        else printSyncResult(result);
        if (result.status === 'failed') process.exitCode = 1;
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('list')
    .description('List insights with their latest value and staleness')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const insights = listInsights(root);
      if (opts.json) {
        console.log(JSON.stringify(insights.map((m) => ({ ...m, source: m.source })), null, 2));
        return;
      }
      console.log(header('Lab Insights'));
      if (insights.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext lab create <slug> --title "..." --render number --adapter http)'));
        return;
      }
      for (const m of insights) {
        const cache = readCache(root, m.slug);
        const latest = cache?.latest !== null && cache?.latest !== undefined ? String(cache.latest) : '—';
        const staleness = cache?.fetchedAt
          ? `fetched ${cache.fetchedAt}`
          : 'never synced';
        const errBadge = cache?.error ? chalk.red(' ⚠ error') : '';
        console.log(`  ${chalk.magentaBright(m.slug)} — ${m.title} · ${latest}${m.unit ? ` ${m.unit}` : ''} · ${chalk.dim(staleness)}${errBadge}`);
      }
    });

  lab
    .command('show')
    .argument('<slug>', 'Insight slug')
    .description('Show the cached snapshot for one insight (no fetch)')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getInsight(root, slug);
      if (!manifest) {
        error(`Insight not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const cache = readCache(root, slug);
      if (opts.json) {
        console.log(JSON.stringify({ manifest, cache }, null, 2));
        return;
      }
      console.log(header(`Insight: ${slug}`));
      console.log(`  title: ${manifest.title}`);
      console.log(`  render: ${manifest.render}${manifest.size ? ` (size ${manifest.size})` : ''}`);
      console.log(`  category: ${manifest.category ?? '(none)'}`);
      console.log(`  group: ${manifest.group ?? '(none)'}`);
      if (cache) {
        console.log(`  latest: ${cache.latest ?? '—'}${manifest.unit ? ` ${manifest.unit}` : ''}`);
        console.log(`  granularity: ${cache.granularity}`);
        console.log(`  fetchedAt: ${cache.fetchedAt || '(never)'}`);
        if (cache.error) console.log(chalk.red(`  error: ${cache.error}`));
        if (cache.funnel) printFunnelSet(cache.funnel, cache.funnelHistory);
        if (cache.matrix) printMatrixSet(cache.matrix);
        if (cache.app) {
          console.log();
          const pageList = cache.app.spec.pages
            .map((p) => (p.id === cache.app!.spec.entry ? `${p.id} (entry)` : p.id))
            .join(' · ');
          console.log(`  app: ${cache.app.spec.pages.length} page(s) — ${pageList}`);
          for (const notice of cache.app.notices) warn(notice);
          console.log(chalk.dim(`  → dreamcontext lab body ${slug} [--page <id>] for the html/text/markdown source.`));
        }
        if (cache.datasets) {
          console.log();
          console.log('  datasets:');
          printDatasetBundle(cache.datasets);
        }
      } else {
        console.log(chalk.dim('  (no cache yet — run `dreamcontext lab sync ' + slug + '`)'));
      }
    });

  lab
    .command('body')
    .argument('<slug>', 'Insight slug')
    .description('Read a script-authored card/app body from the cache (never fetches)')
    .option('--page <id>', 'Page id (app/v1 insights only; default: the entry page)')
    .option('--format <format>', 'text|md|html (default text)')
    .option('--json', 'Emit as JSON: { pages, page, html, text }')
    .action((slug: string, opts: { page?: string; format?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getInsight(root, slug);
      if (!manifest) {
        error(`Insight not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const format = opts.format ?? 'text';
      if (format !== 'text' && format !== 'md' && format !== 'html') {
        error(`--format must be text|md|html (got "${format}").`);
        process.exitCode = 1;
        return;
      }
      const cache = readCache(root, slug);
      if (!cache || (!cache.app && !cache.html)) {
        error(`${slug}: no script-authored body cached yet — run \`dreamcontext lab sync ${slug}\`.`);
        process.exitCode = 1;
        return;
      }

      let pages: { id: string; title: string }[] = [];
      let pageId: string | null = null;
      let html: string;

      if (cache.app) {
        const page = findAppPage(cache.app.spec, opts.page ?? null);
        // findAppPage always falls back to the entry page — parseAppSpec
        // guarantees `entry` names a declared page, so this is unreachable
        // except via a hand-corrupted cache; treated as a hard miss.
        if (!page) {
          error(`${slug}: app cache has no pages (corrupt cache — re-run \`dreamcontext lab sync ${slug} --force\`).`);
          process.exitCode = 1;
          return;
        }
        if (opts.page && page.id !== opts.page) {
          warn(`page "${opts.page}" not found — showing the entry page "${page.id}".`);
        }
        pages = cache.app.spec.pages.map((p) => ({ id: p.id, title: p.title }));
        pageId = page.id;
        html = page.html;
      } else {
        if (opts.page) warn(`${slug} is a single-body (html/v1) insight — --page is ignored.`);
        html = cache.html!;
      }

      const text = htmlToText(html, { format: format === 'md' ? 'md' : 'text' });

      if (opts.json) {
        console.log(JSON.stringify({ pages, page: pageId, html, text }, null, 2));
        return;
      }
      console.log(format === 'html' ? html : text);
    });

  lab
    .command('query')
    .argument('<slug>', 'Insight slug')
    .description('Query a cached dataset (dimensional slice/aggregate) — never fetches')
    .option('--dataset <key>', "Dataset key (default: the bundle's primary, else the first)")
    .option('--where <kv>', 'Exact-match filter key=value (repeatable)', collect, [] as string[])
    .option('--group-by <dim>', 'Aggregate rows by one dimension key')
    .option('--top <n>', 'Keep only the top N rows by value')
    .option('--date <date>', 'Resolve to the dataset snapshot at/before this YYYY-MM-DD date (default: live)')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { dataset?: string; where: string[]; groupBy?: string; top?: string; date?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getInsight(root, slug);
      if (!manifest) {
        error(`Insight not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const date = opts.date ?? null;
      if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
        error(`--date must be a valid YYYY-MM-DD date (got "${date}").`);
        process.exitCode = 1;
        return;
      }
      const where: Record<string, string> = {};
      for (const kv of opts.where) {
        const i = kv.indexOf('=');
        if (i <= 0) {
          error(`--where must be key=value (got "${kv}").`);
          process.exitCode = 1;
          return;
        }
        where[kv.slice(0, i)] = kv.slice(i + 1);
      }

      const cache = readCache(root, slug);
      if (!cache) {
        error(`${slug}: no cache yet — run \`dreamcontext lab sync ${slug}\`.`);
        process.exitCode = 1;
        return;
      }
      const resolved = resolveDatasetAsOf(cache, date);
      if (!resolved) {
        if (opts.json) {
          console.log(JSON.stringify({ slug, date, asOf: null, result: null }, null, 2));
          return;
        }
        console.log(header(`Query: ${slug}`));
        console.log(date
          ? `  No dataset snapshot at or before ${date} — nothing to show (no interpolation).`
          : '  No cached data yet.');
        return;
      }

      const query: DatasetQuery = {
        dataset: opts.dataset ?? null,
        where,
        groupBy: opts.groupBy ?? null,
        top: opts.top !== undefined ? Number(opts.top) : null,
      };
      const result = queryDataset(resolved.bundle, query);

      if (opts.json) {
        console.log(JSON.stringify({ slug, date, asOf: resolved.at, result }, null, 2));
        return;
      }
      console.log(header(`Query: ${slug}${manifest.title ? ` — ${manifest.title}` : ''}`));
      console.log(`  dataset: ${result.dataset}${result.label ? ` — ${result.label}` : ''}`);
      console.log(`  as of: ${resolved.at}`);
      for (const notice of result.notices) warn(notice);
      if (result.rows.length === 0) {
        console.log(chalk.dim('  (no rows matched)'));
        return;
      }
      printMatrixPivot({
        kind: MATRIX_SET_KIND,
        dims: result.dims.map((key) => ({ key })),
        rows: result.rows,
        total: result.total ?? undefined,
        unit: result.unit ?? undefined,
      });
    });

  lab
    .command('create')
    .argument('<slug>', 'Kebab-case insight slug (e.g. weekly-active-users)')
    .description('Scaffold a new insight manifest in lab/insights/<slug>.md')
    .requiredOption('--title <title>', 'Insight title')
    .option('--category <category>', 'Top-level dashboard category (side-menu tab, e.g. "Marketing")')
    .option('--group <group>', 'Dashboard section this insight groups under')
    // Enum text derives from RENDERS so a new render never needs a CLI edit.
    .option('--render <render>', `${RENDERS.join('|')} (default number)`)
    // `--size` is the LEGACY single axis and only ever meant width; --width/--height are
    // the two real ones and override it.
    .option('--size <size>', `${INSIGHT_SIZES.join('|')} — legacy footprint (prefer --width/--height)`)
    .option('--width <n>', `${INSIGHT_WIDTHS.join('|')} — board columns (default: the render's own)`)
    .option('--height <h>', `${INSIGHT_HEIGHTS.join('|')} — card body height ceiling (default m)`)
    .option('--adapter <adapter>', 'http|script (default http)')
    .option('--unit <unit>', 'Display unit (e.g. "users")')
    .option('--ttl <minutes>', 'Cache TTL in minutes (default 1440)')
    .option('--board <slug>', 'Board to place the card on (default: the board titled like --category, else the first)')
    .option('--no-board', 'Create the insight without placing it on a board')
    .option('--preset <id>', `A ready-made insight: ${PRESET_IDS.join(', ')} (render funnel + a snapshot-reading script; not with --render <other> or --adapter http)`)
    .option('--locale <en|tr>', 'Language the preset card speaks (written to the manifest; default: none, English)')
    .action(async (slug: string, opts: { title: string; category?: string; group?: string; render?: string; size?: string; width?: string; height?: string; adapter?: string; unit?: string; ttl?: string; board?: string | false; preset?: string; locale?: string }) => {
      const root = ensureContextRoot();
      if (opts.preset !== undefined && !(PRESET_IDS as readonly string[]).includes(opts.preset)) {
        error(`Unknown preset "${opts.preset}". Use one of: ${PRESET_IDS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      const preset = opts.preset as PresetId | undefined;
      try {
        const m = createInsight(root, {
          ...(preset ? { preset } : {}),
          // An unknown value is refused by validateManifestForWrite with the allowed list.
          ...(opts.locale !== undefined ? { locale: opts.locale as 'en' | 'tr' } : {}),
          slug,
          title: opts.title,
          category: opts.category ?? null,
          group: opts.group ?? null,
          // A preset decides render and adapter: only an explicit flag is passed, so a conflict is refused.
          render: (opts.render as Render | undefined) ?? (preset ? undefined : 'number'),
          size: opts.size as InsightSize | undefined,
          // Parsed here so a bad value hits validateManifestForWrite's message, not a silent
          // NaN that would quietly fall through to the render default.
          width: opts.width != null ? (Number(opts.width) as InsightWidth) : undefined,
          height: opts.height as InsightHeight | undefined,
          adapter: (opts.adapter as 'http' | 'script' | undefined) ?? (preset ? undefined : 'http'),
          unit: opts.unit ?? null,
          ttl_minutes: opts.ttl ? Number(opts.ttl) : undefined,
        });
        success(`Insight created: lab/insights/${m.slug}.md`);
        if (preset) {
          placeNewExplorer(root, m.slug, m.category, opts.board, preset);
          console.log(chalk.dim(`  Next: fill the snapshot with the KB queries in the skill (tasks-and-features.md, Funnel explorer), check it with \`dreamcontext lab data check ${m.slug} --file <path>\`, then write it with \`dreamcontext lab data write ${m.slug} --file <path>\`.`));
          return;
        }
        await placeNewInsight(root, m.slug, m.category, opts.board);
        console.log(chalk.dim('  Edit the manifest to set the real endpoint/extract config, then `dreamcontext lab sync ' + m.slug + '`.'));
      } catch (err) {
        handleLabError(err);
      }
    });

  const dataCmd = lab
    .command('data')
    .description('The snapshot a snapshot-fed insight reads (lab/data/<slug>.json): check it, or validate and write it');

  dataCmd
    .command('write')
    .argument('<slug>', 'Insight slug')
    .description('Validate a snapshot ({source, data}) and replace lab/data/<slug>.json with it, then hard-sync the insight (a refused snapshot writes nothing)')
    .requiredOption('--file <path>', 'The snapshot JSON file to write')
    .option('--json', 'Emit the check and the sync result as JSON')
    .action(async (slug: string, opts: { file: string; json?: boolean }) => {
      const root = ensureContextRoot();
      try {
        const manifest = getInsight(root, slug);
        if (!manifest) throw new LabError(`Insight not found: ${slug}`);
        const raw = readSnapshotFile(opts.file);
        const check = writeLabSnapshot(root, slug, raw, { requireFunnel: manifest.preset === 'funnel-explorer' });
        const result = await syncInsight(root, slug, { force: 'hard' });
        if (opts.json) console.log(JSON.stringify({ check, sync: result }, null, 2));
        else {
          success(`Snapshot written: lab/data/${slug}.json`);
          printSnapshotCheck(check);
          printSyncResult(result);
        }
        if (result.status !== 'ok') {
          if (!opts.json) error(`The snapshot is written, but the sync of ${slug} failed: fix the insight's script, then \`dreamcontext lab sync ${slug} --force\`.`);
          process.exitCode = 1;
        }
      } catch (err) {
        handleLabError(err);
      }
    });

  dataCmd
    .command('check')
    .argument('<slug>', 'Insight slug')
    .description('Validate a snapshot without writing anything: the one on disk, or --file')
    .option('--file <path>', 'Check this file instead of lab/data/<slug>.json')
    .option('--json', 'Emit the check as JSON')
    .action((slug: string, opts: { file?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      try {
        const manifest = getInsight(root, slug);
        if (!manifest) throw new LabError(`Insight not found: ${slug}`);
        const raw = opts.file !== undefined ? readSnapshotFile(opts.file) : readLabSnapshot(root, slug);
        if (raw === null) throw new LabError(`No snapshot yet at lab/data/${slug}.json: check a file with --file <path>, or write one with \`dreamcontext lab data write ${slug} --file <path>\`.`);
        const check = checkLabSnapshot(raw, { requireFunnel: manifest.preset === 'funnel-explorer' });
        if (opts.json) console.log(JSON.stringify(check, null, 2));
        else printSnapshotCheck(check);
        if (!check.ok) process.exitCode = 1;
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('tweak')
    .argument('<slug>', 'Insight slug')
    .argument('<key>', 'Tweak key (a declared one, or the well-known range/from/to)')
    .argument('<value>', 'New value')
    .description('Set one tweak value on an insight')
    .action((slug: string, key: string, value: string) => {
      const root = ensureContextRoot();
      try {
        const { moved } = writeWindowTweaks(root, slug, { [key]: value });
        success(`${slug}: tweak "${key}" set to "${value}".`);
        if (moved.length > 0) {
          // tweaks_from: the window is shared, so the rest of the group moved with it.
          console.log(chalk.dim(`  Same window now on: ${moved.join(', ')} (tweaks_from). Re-sync them: dreamcontext lab sync ${[slug, ...moved].join(' && dreamcontext lab sync ')}`));
        }
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('bind')
    .argument('<slug>', 'Insight slug')
    .argument('[objective]', 'Objective slug whose Key Result this insight feeds (omit with --clear)')
    .description('Connect an insight to an objective Key Result (metric.current updates on every sync)')
    .option('--value <value>', 'Bound value: "latest" (default) or "series:<name>"')
    .option('--clear', 'Disconnect the insight from its objective')
    .action((slug: string, objective: string | undefined, opts: { value?: string; clear?: boolean }) => {
      const root = ensureContextRoot();
      if (!opts.clear && !objective) {
        error('Provide an objective slug, or pass --clear to disconnect.');
        process.exitCode = 1;
        return;
      }
      try {
        if (opts.clear) {
          bindInsight(root, slug, null);
          success(`${slug}: binding cleared.`);
          return;
        }
        const { unbound, seededCurrent } = bindInsight(root, slug, { objective: objective!, value: opts.value ?? 'latest' });
        success(`${slug}: now feeds objective "${objective}".`);
        if (seededCurrent !== null) console.log(chalk.dim(`  metric.current seeded to ${seededCurrent} from the cached snapshot.`));
        for (const u of unbound) warn(`${u}: unbound from "${objective}" — an objective's Key Result has one feeder.`);
      } catch (err) {
        handleLabError(err);
      }
    });

  const boardCmd = lab
    .command('board')
    .description('Boards of cards (lab/boards/<slug>.md): list, show resolved values, and edit them');

  boardCmd
    .command('list')
    .description('List boards (derived from categories until the first edit)')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const { boards, derived } = listBoards(root);
      if (opts.json) {
        console.log(JSON.stringify({
          derived,
          boards: boards.map((b) => ({ slug: b.slug, title: b.title, order: b.order, rev: b.rev, cards: b.cards.length, error: b.error, warnings: b.warnings.length })),
        }, null, 2));
        return;
      }
      console.log(header(`Lab Boards${derived ? ' (derived from categories, nothing saved yet)' : ''}`));
      if (boards.length === 0) {
        console.log(chalk.dim('  (none yet: dreamcontext lab board create <slug> --title "...")'));
        return;
      }
      for (const b of boards) {
        const badge = b.error ? chalk.red(` ⚠ ${b.error.kind === 'conflict' ? 'merge conflict' : 'unreadable'}`) : '';
        console.log(`  ${chalk.magentaBright(b.slug)}: ${b.title} · ${b.cards.length} card(s)${badge}`);
      }
    });

  boardCmd
    .command('show')
    .argument('<slug>', 'Board slug')
    .description('Show every card with its blocks resolved (the same values the dashboard draws; no fetch)')
    .option('--select <dim=value,...>', 'Breakdown selection the funnel explorer blocks draw, e.g. "platform=Web,language=EN"')
    .option('--funnel <id>', 'The funnel an explorer card with a funnel picker draws (default: the first in the payload)')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { json?: boolean; select?: string; funnel?: string }) => {
      const root = ensureContextRoot();
      const board = getBoard(root, slug);
      if (!board) {
        error(`Board not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const funnel = typeof opts.funnel === 'string' && opts.funnel.trim() !== '' ? opts.funnel.trim() : null;
      const view = buildBoardView(root, board, opts.select !== undefined ? parseSelection(opts.select) : {}, funnel);
      if (opts.json) console.log(JSON.stringify(view, null, 2));
      else printBoardView(view);
      if (board.error) process.exitCode = 1;
    });

  boardCmd
    .command('create')
    .argument('<slug>', 'Kebab-case board slug')
    .description('Create an empty board after the last one')
    .requiredOption('--title <title>', 'Board title')
    .action(async (slug: string, opts: { title: string }) => {
      const root = ensureContextRoot();
      try {
        const wasDerived = !isMaterialized(root);
        const board = await createBoard(root, slug, opts.title);
        success(`Board created: lab/boards/${board.slug}.md`);
        if (wasDerived) console.log(chalk.dim('  Every derived board was saved to lab/boards/ as well (first edit).'));
      } catch (err) {
        handleBoardError(err);
      }
    });

  boardCmd
    .command('add-card')
    .argument('<board>', 'Board slug')
    .description('Add a card: an insight (renders as v1) and/or one block')
    .option('--insight <slug>', 'Primary insight (detail panel, refresh, range, tweaks)')
    .option('--block <json>', 'One block, e.g. \'{"line": {"area": true}}\' (binds to --insight when it names no data)')
    .option('--at <x,y,w,h>', 'Grid position (default: the first free slot)')
    .option('--id <id>', 'Card id (default c-<insight>)')
    .option('--preset <id>', `A ready-made card for --insight: ${PRESET_IDS.join(', ')} (not with --block)`)
    .option('--locale <en|tr>', "Language of the labels a preset writes into the card (default: the insight's manifest locale, else en)")
    .action(async (boardSlug: string, opts: { insight?: string; block?: string; at?: string; id?: string; preset?: string; locale?: string }) => {
      const root = ensureContextRoot();
      if (opts.preset !== undefined) {
        const problem = presetProblem(opts);
        if (problem) {
          error(problem);
          process.exitCode = 1;
          return;
        }
      } else if (!opts.insight && opts.block === undefined) {
        error('Provide --insight <slug>, --block <json>, or both.');
        process.exitCode = 1;
        return;
      }
      try {
        const board = opts.preset !== undefined
          ? await addPresetCard(root, boardSlug, opts.insight!, presetCardLocale(root, opts.insight!, opts.locale), opts)
          : await addCard(root, boardSlug, opts);
        const card = board.cards[board.cards.length - 1];
        success(`${boardSlug}: card "${card.id}" added at ${card.at.x},${card.at.y} ${card.at.w}x${card.at.h}.`);
        for (const w of board.warnings) warn(formatDiagnostic(w));
      } catch (err) {
        handleBoardError(err);
      }
    });

  boardCmd
    .command('set')
    .argument('<board>', 'Board slug')
    .description('Replace a board from a spec file (strict: every problem names the card, the block path and the fix)')
    .requiredOption('--file <path>', 'Board spec: .md/.yaml (frontmatter or bare YAML) or .json')
    .action(async (slug: string, opts: { file: string }) => {
      const root = ensureContextRoot();
      try {
        const current = getBoard(root, slug);
        const { raw, body } = readSpecFile(opts.file);
        const v = validateBoardSpec(raw, slug, { contextRoot: root, body });
        if (!v.ok) {
          error(`${opts.file}: ${v.errors.length} problem(s); board "${slug}" left unchanged.`);
          printDiagnostics(v.errors, v.warnings);
          process.exitCode = 1;
          return;
        }
        const spec = { ...(raw as Record<string, unknown>), body };
        const board = await putBoard(root, slug, spec, { expectedRev: current ? current.rev : null });
        success(`Board saved: lab/boards/${slug}.md (${board?.cards.length ?? 0} card(s)).`);
        printDiagnostics([], v.warnings);
      } catch (err) {
        handleBoardError(err);
      }
    });

  boardCmd
    .command('validate')
    .description('Strict-validate a board spec file without writing anything')
    .requiredOption('--file <path>', 'Board spec: .md/.yaml (frontmatter or bare YAML) or .json')
    .option('--slug <slug>', 'Board slug the file is for (default: the file name)')
    .action((opts: { file: string; slug?: string }) => {
      const root = ensureContextRoot();
      try {
        const slug = opts.slug ?? (opts.file.split('/').pop() ?? 'board').replace(/\.[^.]+$/, '');
        const { raw, body } = readSpecFile(opts.file);
        const v = validateBoardSpec(raw, slug, { contextRoot: root, body });
        printDiagnostics(v.errors, v.warnings);
        if (!v.ok) {
          error(`${opts.file}: ${v.errors.length} problem(s).`);
          process.exitCode = 1;
          return;
        }
        success(`${opts.file}: valid (${v.spec.cards.length} card(s)${v.warnings.length ? `, ${v.warnings.length} warning(s)` : ''}).`);
      } catch (err) {
        handleLabError(err);
      }
    });

  boardCmd
    .command('remove-card')
    .argument('<board>', 'Board slug')
    .argument('<card-id>', 'Card id (see lab board show)')
    .description('Remove one card from a board')
    .action(async (boardSlug: string, cardId: string) => {
      const root = ensureContextRoot();
      try {
        await editBoard(root, boardSlug, (current) => {
          if (!current) throw new BoardStoreError('not-found', `Board "${boardSlug}" does not exist.`);
          if (!current.cards.some((c) => c.id === cardId)) {
            throw new BoardStoreError('not-found', `Card "${cardId}" is not on board "${boardSlug}" (see \`dreamcontext lab board show ${boardSlug}\`).`);
          }
          return { ...current, cards: current.cards.filter((c) => c.id !== cardId) };
        });
        success(`${boardSlug}: card "${cardId}" removed.`);
      } catch (err) {
        handleBoardError(err);
      }
    });

  boardCmd
    .command('delete')
    .argument('<board>', 'Board slug')
    .description('Delete a board (its insights stay; they become unplaced)')
    .action(async (boardSlug: string) => {
      const root = ensureContextRoot();
      try {
        await deleteBoard(root, boardSlug);
        success(`Board deleted: ${boardSlug}`);
      } catch (err) {
        handleBoardError(err);
      }
    });

  const blockCmd = lab
    .command('block')
    .description('The block catalog and the vault library of custom HTML blocks (lab/blocks/<slug>.md)');

  blockCmd
    .command('list')
    .description('List the block catalog (types, frames, options) and the vault library')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const catalog = listBlockCatalog();
      const library = listLibraryBlocks(root).map(({ html: _html, ...rest }) => rest);
      if (opts.json) {
        console.log(JSON.stringify({ catalog, library }, null, 2));
        return;
      }
      console.log(header('Block catalog'));
      for (const b of catalog) {
        const frames = b.frames.length > 0 ? chalk.dim(` [${b.frames.join('|')}]`) : '';
        console.log(`  ${chalk.magentaBright(b.type)}: ${b.label.en}${frames} ${chalk.dim(`${b.defaultSize.w}x${b.defaultSize.h}`)}`);
        console.log(chalk.dim(`    ${b.description.en}`));
        for (const o of b.options) {
          const range = o.enum ? `: ${o.enum.join('|')}` : o.min !== undefined ? `: ${o.min}..${o.max}` : '';
          const def = o.default !== undefined && o.default !== null && o.default !== '' ? ` (default ${String(o.default)})` : '';
          console.log(chalk.dim(`    · ${o.key} ${o.type}${range}${def}`));
        }
      }
      console.log();
      console.log(header('Library (custom HTML)'));
      if (library.length === 0) console.log(chalk.dim('  (empty: dreamcontext lab block save <slug> --file <html>)'));
      for (const l of library) {
        const inputs = l.inputs.map((i) => (i.kind ? `${i.name}:${i.kind}` : i.name)).join(', ');
        console.log(`  ${chalk.magentaBright(l.slug)}: ${l.title}${inputs ? chalk.dim(` · inputs ${inputs}`) : ''}`);
      }
    });

  blockCmd
    .command('save')
    .argument('<slug>', 'Kebab-case library slug')
    .description('Save an HTML file to the vault block library (reuse it on a card with html: {ref: <slug>})')
    .requiredOption('--file <path>', 'The block markup (HTML)')
    .option('--inputs <list>', 'Declared inputs: name[:series|table|value|funnel], comma separated')
    .option('--title <title>', 'Title (default: the existing title, else the slug)')
    .option('--description <text>', 'One-line description')
    .action((slug: string, opts: { file: string; inputs?: string; title?: string; description?: string }) => {
      const root = ensureContextRoot();
      try {
        let html: string;
        try {
          html = readFileSync(opts.file, 'utf-8');
        } catch (err) {
          throw new LabError(`Cannot read ${opts.file}: ${(err as Error).message}`);
        }
        const existing = getLibraryBlock(root, slug);
        const block = saveLibraryBlock(root, slug, {
          title: opts.title ?? existing?.title ?? slug,
          description: opts.description ?? existing?.description ?? null,
          inputs: opts.inputs !== undefined ? parseInputsArg(opts.inputs) : existing?.inputs ?? [],
          html,
        }, existing ? existing.rev : null);
        success(`Library block saved: lab/blocks/${block.slug}.md${block.inputs.length ? ` (inputs ${block.inputs.map((i) => i.name).join(', ')})` : ''}`);
        console.log(chalk.dim(`  Use it on a card: - html: {ref: ${block.slug}${block.inputs.length ? `, inputs: {${block.inputs.map((i) => `${i.name}: <insight>`).join(', ')}}` : ''}}`));
      } catch (err) {
        handleLabError(err);
      }
    });

  const credentials = lab
    .command('credentials')
    .description('Manage lab/credentials.json (gitignore-first — never printed back)');

  credentials
    .command('set')
    .argument('<key>', 'Credential key (referenced by manifests as {{cred:key}})')
    .description('Store a credential value (hidden prompt; --value is shell-history-risky)')
    .option('--value <value>', 'Provide the value directly (visible in shell history — prefer the interactive prompt)')
    .action(async (key: string, opts: { value?: string }) => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);
      try {
        const value = opts.value ?? await password({ message: `Value for credential "${key}":` });
        if (!value || !value.trim()) {
          error('A non-empty value is required.');
          process.exitCode = 1;
          return;
        }
        writeCredential(projectRoot, root, key, value);
        success(`Credential "${key}" stored in lab/credentials.json (mode 0600, gitignored).`);
      } catch (err) {
        handleLabError(err);
      }
    });

  credentials
    .command('list')
    .description('List credential KEY NAMES only — values are never printed')
    .action(() => {
      const root = ensureContextRoot();
      const names = listCredentialNames(root);
      console.log(header('Lab Credentials (names only)'));
      if (names.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext lab credentials set <key>)'));
        return;
      }
      for (const name of names) console.log(`  ${chalk.magentaBright(name)}`);
      // Self-heal nudge: warn if the file exists but isn't covered by a gitignore.
      const projectRoot = projectRootFor(root);
      const covered = gitignoreCovers(root, ['lab/credentials.json'])
        || gitignoreCovers(projectRoot, ['_dream_context/lab/credentials.json']);
      if (!covered) {
        warn('lab/credentials.json is not covered by a governing .gitignore — run `dreamcontext doctor` then re-run `lab credentials set` to self-heal.');
      }
    });
}
