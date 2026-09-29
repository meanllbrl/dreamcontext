import type { Render } from './types.js';
import type { FrameKind } from './frameOps.js';

/**
 * The board block catalog: the SINGLE source of every block type, the frame
 * kinds it accepts, its options schema and its default footprint.
 *
 * Everything else derives from it: the strict board validation (boards.ts),
 * frame resolution (frames.ts), `lab block list`, and the dashboard, which
 * reads the generated `dashboard/src/generated/block-catalog.json`
 * (`scripts/gen-lab-mirrors.mjs`; `tests/unit/lab-mirrors-drift.test.ts`
 * fails when it drifts). The dashboard's `blockRegistry.ts` is a
 * `Record<BlockType, ...>`, so a type added here cannot ship without a component.
 *
 * Labels: `labelKey` is the dashboard i18n key; `label` carries the EN/TR copy
 * that key must hold (the CLI prints `label.en`).
 */

export const BLOCK_TYPES = [
  'stat',
  'line',
  'bar',
  'stacked',
  'pie',
  'table',
  'heatmap',
  'funnel',
  'pivot',
  'text',
  'callout',
  'tabs',
  'filter',
  'html',
  'insight',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export function isBlockType(v: unknown): v is BlockType {
  return typeof v === 'string' && (BLOCK_TYPES as readonly string[]).includes(v);
}

export type BlockOptionType =
  | 'boolean'
  | 'enum'
  | 'number'
  | 'string'
  | 'markdown'
  | 'string-list'
  | 'where'
  | 'sort'
  | 'tabs'
  | 'inputs'
  | 'html';

export interface LocalizedText {
  en: string;
  tr: string;
}

export interface BlockOptionSchema {
  key: string;
  type: BlockOptionType;
  /** Allowed values (`enum` only). */
  enum?: readonly (string | number)[];
  default?: string | number | boolean | null;
  /** Inclusive bounds (`number` only). */
  min?: number;
  max?: number;
  labelKey: string;
  label: LocalizedText;
}

/**
 * What a block binds to:
 *   binding - one `data: "<insight>[/<datasetKey>]"`, resolved to a frame;
 *   inputs  - named bindings (`html`), each resolved to its own frame;
 *   insight - the whole cache of the card's insight (legacy v1 render);
 *   none    - no data (text, callout, tabs).
 */
export type BlockDataMode = 'binding' | 'inputs' | 'insight' | 'none';

export interface BlockCatalogEntry {
  type: BlockType;
  data: BlockDataMode;
  /** Accepted frame kinds, in preference order (the first the cache can build wins). */
  frames: readonly FrameKind[];
  labelKey: string;
  label: LocalizedText;
  descriptionKey: string;
  description: LocalizedText;
  /** Footprint a new card holding only this block gets. */
  defaultSize: { w: number; h: number };
  options: readonly BlockOptionSchema[];
}

const opt = (
  key: string,
  type: BlockOptionType,
  en: string,
  tr: string,
  extra: Partial<Pick<BlockOptionSchema, 'enum' | 'default' | 'min' | 'max'>> = {},
): BlockOptionSchema => ({ key, type, ...extra, labelKey: `lab.block.opt.${key}`, label: { en, tr } });

// Shared option definitions: one label per key across every block that uses it.
const COLOR = opt('color', 'number', 'Color', 'Renk', { min: 1, max: 8, default: 1 });
const WHERE = opt('where', 'where', 'Only rows where', 'Yalnızca şu satırlar');
const SORT = opt('sort', 'sort', 'Sort by', 'Sıralama');
const LIMIT = opt('limit', 'number', 'Row limit', 'Satır sınırı', { min: 1, max: 400 });
const SERIES = opt('series', 'string-list', 'Series', 'Seriler');
const MARKDOWN = opt('markdown', 'markdown', 'Text', 'Metin', { default: '' });

const entry = (
  type: BlockType,
  data: BlockDataMode,
  frames: readonly FrameKind[],
  label: LocalizedText,
  description: LocalizedText,
  defaultSize: { w: number; h: number },
  options: readonly BlockOptionSchema[],
): BlockCatalogEntry => ({
  type,
  data,
  frames,
  labelKey: `lab.block.${type}`,
  label,
  descriptionKey: `lab.block.${type}.description`,
  description,
  defaultSize,
  options,
});

/** `Record<BlockType, ...>`: a new block type cannot compile without an entry. */
export const BLOCK_CATALOG: Record<BlockType, BlockCatalogEntry> = {
  stat: entry(
    'stat', 'binding', ['value', 'series'],
    { en: 'Stat', tr: 'Sayı' },
    { en: 'One number with its change and a sparkline.', tr: 'Değişimi ve küçük grafiğiyle tek bir sayı.' },
    { w: 3, h: 3 },
    [
      opt('delta', 'enum', 'Change', 'Değişim', { enum: ['none', 'prev'], default: 'none' }),
      opt('spark', 'boolean', 'Sparkline', 'Küçük grafik', { default: false }),
      opt('unit', 'string', 'Unit', 'Birim'),
      opt('format', 'enum', 'Format', 'Biçim', { enum: ['number', 'compact', 'percent', 'currency'], default: 'number' }),
      SERIES,
    ],
  ),
  line: entry(
    'line', 'binding', ['series'],
    { en: 'Line', tr: 'Çizgi' },
    { en: 'Series over time.', tr: 'Zaman içindeki seriler.' },
    { w: 6, h: 4 },
    [opt('area', 'boolean', 'Fill area', 'Alanı doldur', { default: false }), COLOR, SERIES, LIMIT],
  ),
  bar: entry(
    'bar', 'binding', ['table', 'series'],
    { en: 'Bar', tr: 'Çubuk' },
    { en: 'Values side by side.', tr: 'Yan yana değerler.' },
    { w: 6, h: 4 },
    [
      opt('orientation', 'enum', 'Orientation', 'Yön', { enum: ['h', 'v'], default: 'h' }),
      COLOR,
      opt('comparePrev', 'boolean', 'Compare with previous period', 'Önceki dönemle karşılaştır', { default: false }),
      WHERE,
      SORT,
      LIMIT,
      SERIES,
    ],
  ),
  stacked: entry(
    'stacked', 'binding', ['table', 'series'],
    { en: 'Stacked', tr: 'Yığılmış' },
    { en: 'Parts of a whole over time.', tr: 'Zaman içinde bütünün parçaları.' },
    { w: 6, h: 4 },
    [COLOR, WHERE, SERIES, LIMIT],
  ),
  pie: entry(
    'pie', 'binding', ['table', 'series'],
    { en: 'Pie', tr: 'Pasta' },
    { en: 'Shares of a total. Seven or more slices draw as bars.', tr: 'Toplamın payları. Yedi ve daha fazla dilim çubuk olarak çizilir.' },
    { w: 4, h: 4 },
    [opt('donut', 'boolean', 'Donut', 'Halka', { default: false }), WHERE, SORT, LIMIT],
  ),
  table: entry(
    'table', 'binding', ['table', 'series'],
    { en: 'Table', tr: 'Tablo' },
    { en: 'Rows and columns of numbers.', tr: 'Sayılardan oluşan satırlar ve sütunlar.' },
    { w: 8, h: 6 },
    [opt('columns', 'string-list', 'Columns', 'Sütunlar'), WHERE, SORT, LIMIT],
  ),
  heatmap: entry(
    'heatmap', 'binding', ['table', 'series'],
    { en: 'Heatmap', tr: 'Isı haritası' },
    { en: 'Intensity across two axes.', tr: 'İki eksen boyunca yoğunluk.' },
    { w: 6, h: 5 },
    [COLOR, WHERE],
  ),
  funnel: entry(
    'funnel', 'binding', ['funnel'],
    { en: 'Funnel', tr: 'Huni' },
    { en: 'Step by step conversion.', tr: 'Adım adım dönüşüm.' },
    { w: 8, h: 6 },
    [opt('compact', 'boolean', 'Compact', 'Sıkı', { default: false })],
  ),
  pivot: entry(
    'pivot', 'binding', ['table'],
    { en: 'Pivot', tr: 'Özet tablo' },
    { en: 'One dimension down, another across.', tr: 'Bir boyut aşağı, diğeri yana.' },
    { w: 8, h: 6 },
    [opt('rows', 'string', 'Rows', 'Satırlar'), opt('cols', 'string', 'Columns', 'Sütunlar'), WHERE],
  ),
  text: entry(
    'text', 'none', [],
    { en: 'Text', tr: 'Metin' },
    { en: 'Markdown notes and headings.', tr: 'Markdown notlar ve başlıklar.' },
    { w: 12, h: 1 },
    [MARKDOWN],
  ),
  callout: entry(
    'callout', 'none', [],
    { en: 'Callout', tr: 'Vurgu' },
    { en: 'A highlighted note.', tr: 'Öne çıkarılmış bir not.' },
    { w: 6, h: 2 },
    [opt('tone', 'enum', 'Tone', 'Ton', { enum: ['info', 'success', 'warning', 'danger'], default: 'info' }), MARKDOWN],
  ),
  tabs: entry(
    'tabs', 'none', [],
    { en: 'Tabs', tr: 'Sekmeler' },
    { en: 'Panels of blocks, one visible at a time. Tabs do not nest.', tr: 'Her seferinde biri görünen blok panelleri. Sekmeler iç içe girmez.' },
    { w: 8, h: 6 },
    [opt('tabs', 'tabs', 'Tabs', 'Sekmeler')],
  ),
  filter: entry(
    'filter', 'binding', ['table'],
    { en: 'Filter', tr: 'Filtre' },
    { en: 'Chips that filter the blocks bound to the same dataset.', tr: 'Aynı veri kümesine bağlı blokları süzen çipler.' },
    { w: 12, h: 1 },
    [opt('dim', 'string', 'Dimension', 'Boyut')],
  ),
  html: entry(
    'html', 'inputs', ['table', 'series', 'value', 'funnel'],
    { en: 'Custom HTML', tr: 'Özel HTML' },
    { en: 'Your own markup in a sandbox, fed only the inputs it declares.', tr: 'Yalnızca bildirdiği girdileri alan, korumalı alanda kendi işaretlemeniz.' },
    { w: 6, h: 6 },
    [
      opt('html', 'html', 'HTML', 'HTML'),
      opt('ref', 'string', 'Library block', 'Kütüphane bloğu'),
      opt('inputs', 'inputs', 'Inputs', 'Girdiler'),
    ],
  ),
  insight: entry(
    'insight', 'insight', [],
    { en: 'Insight', tr: 'İçgörü' },
    { en: 'The insight exactly as it renders on its own.', tr: 'İçgörü, kendi başına nasıl görünüyorsa öyle.' },
    { w: 4, h: 4 },
    [],
  ),
};

/** Every block type, in catalog order. */
export function listBlockCatalog(): BlockCatalogEntry[] {
  return BLOCK_TYPES.map((type) => BLOCK_CATALOG[type]);
}

/** Frame kinds an html input accepts when its library entry names no kind. */
export const HTML_INPUT_DEFAULT_FRAMES: readonly FrameKind[] = ['table', 'series', 'value'];

/**
 * Board columns (1-3, legacy thirds) a v1 render wants before any manifest
 * `size`/`width` override. Moved here from the dashboard's `chartRegistry.ts`
 * so derivation (engine) and the dashboard read one table.
 */
export const RENDER_DEFAULT_SPAN: Record<Render, 1 | 2 | 3> = {
  number: 1,
  line: 1,
  pie: 1,
  raw: 1,
  funnel: 2,
  bar: 1,
  bar_compare: 1,
  stacked: 1,
  table: 2,
  heatmap: 1,
  breakdown: 2,
  app: 2,
};

/** The JSON the dashboard mirror holds (`dashboard/src/generated/block-catalog.json`). */
export function blockCatalogMirror(): {
  types: readonly BlockType[];
  blocks: BlockCatalogEntry[];
  renderDefaultSpan: Record<Render, 1 | 2 | 3>;
  htmlInputDefaultFrames: readonly FrameKind[];
} {
  return {
    types: BLOCK_TYPES,
    blocks: listBlockCatalog(),
    renderDefaultSpan: RENDER_DEFAULT_SPAN,
    htmlInputDefaultFrames: HTML_INPUT_DEFAULT_FRAMES,
  };
}
