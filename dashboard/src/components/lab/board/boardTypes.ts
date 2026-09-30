import type { ReactNode } from 'react';
import type { InsightCache, InsightSummary } from '../../../hooks/useLab';
import type { Frame, FrameKind } from '../../../generated/frameOps';
import type { GridRect } from '../../../generated/grid';

/**
 * Board seams: the dashboard mirror of the engine's board types
 * (`src/lib/lab/boards.ts`, `block-library.ts`, `blocks.ts`) plus the props
 * every board surface is built against, pinned in Wave 0 so the block, grid,
 * page and editor lanes never import each other mid-wave.
 *
 * The dashboard cannot import `src/`, so these are hand mirrors;
 * `tests/unit/lab-mirrors-drift.test.ts` fails when a field or a block type
 * drifts from the engine. Frames and grid geometry are NOT mirrored here: they
 * come from the byte-identical generated copies, so they cannot drift.
 */

export type { EmptyReason, Frame, FrameKind, TableRow, TableTotal } from '../../../generated/frameOps';
export type { GridRect } from '../../../generated/grid';

export type BlockType =
  | 'stat'
  | 'line'
  | 'bar'
  | 'stacked'
  | 'pie'
  | 'table'
  | 'heatmap'
  | 'funnel'
  | 'pivot'
  | 'text'
  | 'callout'
  | 'tabs'
  | 'filter'
  | 'html'
  | 'insight';

// ─── Board spec (mirror of src/lib/lab/boards.ts) ───────────────────────────

export interface BlockTab {
  label: string;
  blocks: Block[];
}

export interface Block {
  type: BlockType;
  data?: string;
  options: Record<string, unknown>;
  tabs?: BlockTab[];
}

export interface Card {
  id: string;
  at: GridRect;
  title?: string;
  insight?: string;
  blocks?: Block[];
}

export interface BoardSpec {
  title: string;
  titleKey?: string;
  order: number;
  cards: Card[];
  body: string;
}

export interface BoardError {
  kind: 'parse' | 'conflict';
  message: string;
}

export interface BoardDiagnostic {
  cardId: string | null;
  path: string;
  message: string;
  fix: string;
}

export interface Board extends BoardSpec {
  slug: string;
  rev: string;
  derived: boolean;
  error: BoardError | null;
  warnings: BoardDiagnostic[];
}

/** `GET /api/lab/boards/:slug`: spec + frames + per-insight freshness/summaries. */
export interface BoardResponse {
  board: Board;
  frames: Record<string, Frame>;
  summaries: Record<string, InsightSummary>;
  unplaced: string[];
}

/** `GET /api/lab/boards`. */
export interface BoardListResponse {
  boards: Board[];
  derived: boolean;
  unplaced: string[];
}

// ─── Block library (mirror of src/lib/lab/block-library.ts) ─────────────────

export interface LibraryBlockInput {
  name: string;
  kind: 'series' | 'table' | 'value' | 'funnel' | null;
}

export interface LibraryBlock {
  slug: string;
  title: string;
  description: string | null;
  inputs: LibraryBlockInput[];
  html: string;
  rev: string;
}

// ─── Catalog (shape of dashboard/src/generated/block-catalog.json) ──────────

export interface LocalizedText {
  en: string;
  tr: string;
}

export interface BlockOptionSchema {
  key: string;
  type: 'boolean' | 'enum' | 'number' | 'string' | 'markdown' | 'string-list' | 'where' | 'sort' | 'tabs' | 'inputs' | 'html' | 'pick';
  enum?: readonly (string | number)[];
  default?: string | number | boolean | null;
  min?: number;
  max?: number;
  /** Where a `pick` option's choices come from (the block's frame or the insight cache). */
  from?: 'funnels' | 'dims' | 'metrics' | 'app-pages';
  /** A list of picks instead of one (`pick` only). */
  multi?: boolean;
  labelKey: string;
  label: LocalizedText;
}

export interface BlockCatalogEntry {
  type: BlockType;
  data: 'binding' | 'inputs' | 'insight' | 'none';
  frames: readonly FrameKind[];
  labelKey: string;
  label: LocalizedText;
  descriptionKey: string;
  description: LocalizedText;
  defaultSize: { w: number; h: number };
  options: readonly BlockOptionSchema[];
}

export interface BlockCatalog {
  types: readonly BlockType[];
  blocks: BlockCatalogEntry[];
  /** Legacy thirds (1-3) a v1 render wants; moved from chartRegistry.ts. */
  renderDefaultSpan: Record<string, 1 | 2 | 3>;
  htmlInputDefaultFrames: readonly string[];
}

// ─── Surface seams ──────────────────────────────────────────────────────────

/** The interactive filter a `filter` block publishes to its siblings on the same dataset. */
export interface BlockFilter {
  dim: string;
  value: string;
}

/** What every block component receives. */
/**
 * A block's colour identity, taken from its RAW frame (before the series pick,
 * where, the interactive filter, sort, topN or limit ran), in source order.
 * A chart builds its colour scale over this list, so hiding, picking or
 * filtering entities never repaints the ones that remain. `series` names what
 * series-shaped charts draw (line, stacked, pie from series); `rows` names what
 * row-shaped charts draw (bar, pie from a table). An entity missing from the
 * list (a folded "Other") falls to the end or wears the Other grey.
 */
export interface ColorDomain {
  series: readonly string[];
  rows: readonly string[];
}

export interface BlockProps {
  /** The block's frame (already shaped by frameOps), or null for blocks with no data. */
  frame: Frame | null;
  /** The unfiltered entity names colours are assigned over (see ColorDomain). */
  colorDomain?: ColorDomain | null;
  options: Record<string, unknown>;
  /** The primary insight's summary (legacy `insight` block, stat titles). */
  summary?: InsightSummary;
  /** The whole cache (legacy `insight` block only; seeded by the bulk caches request). */
  cache?: InsightCache | null;
  filter?: BlockFilter | null;
  onFilter?: (filter: BlockFilter | null) => void;
  /** Detail-panel variant. */
  full?: boolean;
  /** `html` blocks: one frame per DECLARED input name. Undeclared names never appear. */
  inputs?: Record<string, Frame>;
  /** `tabs` blocks: render a panel's child block at its path (`[index, tab, index]`). */
  renderChild?: (block: Block, path: number[]) => ReactNode;
  /** The card's breakdown selection for this block's insight (one value per dim). */
  selection?: Record<string, string>;
  onSelection?: (selection: Record<string, string>) => void;
  /** Selections pinned as side-by-side lanes (at most 4). */
  lanes?: readonly Record<string, string>[];
  onLanes?: (lanes: readonly Record<string, string>[]) => void;
  /** `tabs` blocks: the open tab, held by the card so fullscreen keeps it. */
  activeTab?: number;
  onTab?: (index: number) => void;
  /** `insight` blocks on a v1 app: the open page, or null for the app's own start page. */
  appPage?: string | null;
  onAppPage?: (id: string) => void;
  /** The card is shown fullscreen. */
  fullscreen?: boolean;
}

/** The injected renderer BoardCard draws blocks through (placeholder default until blockRegistry is wired). */
export type BlockRenderer = (block: Block, props: BlockProps) => ReactNode;

/** Mounted by BoardPage through a slot prop (W2 wires BlockInspector). */
export interface InspectorProps {
  board: Board;
  card: Card;
  /** The selected block's path in `card.blocks`, or null = the card itself. */
  blockPath: number[] | null;
  catalog: BlockCatalog;
  library: LibraryBlock[];
  /** Insight slugs bindings can pick from. */
  insights: InsightSummary[];
  /** The board's resolved frames by frame key (`pick` options read their choices here). */
  frames: Record<string, Frame>;
  /** Insight caches by slug, null while not loaded (`pick` options on app pages read them). */
  caches: Record<string, InsightCache | null>;
  /** A new card value; BoardPage records undo and saves. */
  onChange: (card: Card) => void;
  onSelectBlock: (path: number[] | null) => void;
  /** Save an html block's markup to the vault library. */
  onSaveToLibrary?: (slug: string, block: Pick<LibraryBlock, 'title' | 'description' | 'inputs' | 'html'>) => void;
  onClose: () => void;
}

/** Mounted by BoardPage through a slot prop (W2 wires AddCardMenu). */
export interface AddCardMenuProps {
  board: Board;
  /** Insights on no board, listed first. */
  unplaced: string[];
  insights: InsightSummary[];
  catalog: BlockCatalog;
  library: LibraryBlock[];
  /** A new card; BoardPage places it (free slot), records undo and saves. */
  onAdd: (card: Omit<Card, 'at'> & { at?: GridRect }) => void;
  onClose: () => void;
}
