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

/**
 * EN/TR copy of every enum value, by option key then value: one label per key across blocks,
 * like the option labels. The dashboard shows it under `lab.editor.enum.<key>.<value>`
 * (I18nContext holds the same copy; tests/unit/lab-catalog-options.test.ts compares them).
 */
export const OPTION_ENUM_LABELS: Record<string, Record<string, LocalizedText>> = {};

/** An `enum` option whose every value carries its EN/TR label: `[value, en, tr]`. */
const choice = (
  key: string,
  en: string,
  tr: string,
  values: ReadonlyArray<readonly [string, string, string]>,
  def: string,
): BlockOptionSchema => {
  const labels = (OPTION_ENUM_LABELS[key] ??= {});
  for (const [v, ven, vtr] of values) labels[v] = { en: ven, tr: vtr };
  return opt(key, 'enum', en, tr, { enum: values.map((v) => v[0]), default: def });
};

// Shared option definitions: one label per key across every block that uses it.
const COLOR = opt('color', 'number', 'Color', 'Renk', { min: 1, max: 8, default: 1 });
const WHERE = opt('where', 'where', 'Only rows where', 'Yalnızca şu satırlar');
// `sort` stays the free `sort` type (`-v`, `country`, `{by, dir}`) so written boards keep
// validating; the shorthands `none`, `desc` and `asc` (by value) are what the charts offer.
const SORT = opt('sort', 'sort', 'Sort by', 'Sıralama', { default: null });
const LIMIT = opt('limit', 'number', 'Row limit', 'Satır sınırı', { min: 1, max: 400 });
const SERIES = opt('series', 'string-list', 'Series', 'Seriler');
const MARKDOWN = opt('markdown', 'markdown', 'Text', 'Metin', { default: '' });

const FORMAT_VALUES = [
  ['auto', 'Automatic', 'Otomatik'],
  ['number', 'Number', 'Sayı'],
  ['compact', 'Compact', 'Kısa'],
  ['percent', 'Percent', 'Yüzde'],
  ['currency', 'Currency', 'Para birimi'],
] as const;
/** Chart number format: `auto` is today's look (the unit decides). */
const FORMAT = choice('format', 'Format', 'Biçim', FORMAT_VALUES, 'auto');
/** The stat keeps its own set and default (`number`), as written boards expect. */
const STAT_FORMAT = choice('format', 'Format', 'Biçim', FORMAT_VALUES.slice(1), 'number');
const LEGEND = choice('legend', 'Legend', 'Açıklama', [
  ['top', 'Top', 'Üstte'],
  ['bottom', 'Bottom', 'Altta'],
  ['right', 'Right', 'Sağda'],
  ['none', 'Hidden', 'Gizli'],
], 'bottom');
const AXES = choice('axes', 'Axes', 'Eksenler', [
  ['both', 'X and Y', 'X ve Y'],
  ['x', 'X only', 'Yalnızca X'],
  ['y', 'Y only', 'Yalnızca Y'],
  ['none', 'Hidden', 'Gizli'],
], 'both');
const GRID = opt('grid', 'boolean', 'Gridlines', 'Kılavuz çizgileri', { default: true });
const TOP_N = opt('topN', 'number', 'Top N, rest as Other', 'İlk N, kalanı Diğer', { min: 1, max: 50, default: null });

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
      choice('delta', 'Change', 'Değişim', [['none', 'None', 'Yok'], ['prev', 'Previous period', 'Önceki dönem']], 'none'),
      opt('spark', 'boolean', 'Sparkline', 'Küçük grafik', { default: false }),
      opt('unit', 'string', 'Unit', 'Birim'),
      STAT_FORMAT,
      SERIES,
      choice('size', 'Size', 'Boyut', [['sm', 'Small', 'Küçük'], ['md', 'Medium', 'Orta'], ['lg', 'Large', 'Büyük']], 'md'),
      opt('goal', 'number', 'Goal', 'Hedef', { default: null }),
    ],
  ),
  line: entry(
    'line', 'binding', ['series'],
    { en: 'Line', tr: 'Çizgi' },
    { en: 'Series over time.', tr: 'Zaman içindeki seriler.' },
    { w: 6, h: 4 },
    [
      opt('area', 'boolean', 'Fill area', 'Alanı doldur', { default: false }),
      COLOR,
      SERIES,
      LIMIT,
      choice('curve', 'Curve', 'Eğri', [['linear', 'Straight', 'Düz'], ['smooth', 'Smooth', 'Yumuşak'], ['step', 'Steps', 'Basamak']], 'linear'),
      choice('points', 'Points', 'Noktalar', [['auto', 'Automatic', 'Otomatik'], ['always', 'Always', 'Her zaman'], ['never', 'Never', 'Hiçbir zaman']], 'auto'),
      choice('yMin', 'Y axis starts at', 'Y ekseni başlangıcı', [['auto', 'Automatic', 'Otomatik'], ['zero', 'Zero', 'Sıfır']], 'auto'),
      opt('reference', 'number', 'Reference line', 'Referans çizgisi', { default: null }),
      opt('referenceLabel', 'string', 'Reference label', 'Referans etiketi', { default: '' }),
      LEGEND,
      AXES,
      GRID,
      FORMAT,
    ],
  ),
  bar: entry(
    'bar', 'binding', ['table', 'series'],
    { en: 'Bar', tr: 'Çubuk' },
    { en: 'Values side by side.', tr: 'Yan yana değerler.' },
    { w: 6, h: 4 },
    [
      choice('orientation', 'Orientation', 'Yön', [['h', 'Horizontal', 'Yatay'], ['v', 'Vertical', 'Dikey']], 'h'),
      COLOR,
      opt('comparePrev', 'boolean', 'Compare with previous period', 'Önceki dönemle karşılaştır', { default: false }),
      WHERE,
      SORT,
      LIMIT,
      SERIES,
      opt('valueLabels', 'boolean', 'Value labels', 'Değer etiketleri', { default: true }),
      TOP_N,
      choice('group', 'Several series', 'Birden çok seri', [['grouped', 'Side by side', 'Yan yana'], ['stacked', 'Stacked', 'Üst üste']], 'grouped'),
      FORMAT,
      AXES,
      GRID,
      LEGEND,
    ],
  ),
  stacked: entry(
    'stacked', 'binding', ['table', 'series'],
    { en: 'Stacked', tr: 'Yığılmış' },
    { en: 'Parts of a whole over time.', tr: 'Zaman içinde bütünün parçaları.' },
    { w: 6, h: 4 },
    [
      COLOR,
      WHERE,
      SERIES,
      LIMIT,
      choice('mode', 'Shape', 'Biçim türü', [['bar', 'Bars', 'Çubuklar'], ['area', 'Areas', 'Alanlar']], 'bar'),
      opt('normalize', 'boolean', 'Show as 100%', '%100 olarak göster', { default: false }),
      LEGEND,
      FORMAT,
      AXES,
      GRID,
    ],
  ),
  pie: entry(
    'pie', 'binding', ['table', 'series'],
    { en: 'Pie', tr: 'Pasta' },
    { en: 'Shares of a total. Seven or more slices draw as bars.', tr: 'Toplamın payları. Yedi ve daha fazla dilim çubuk olarak çizilir.' },
    { w: 4, h: 4 },
    [
      opt('donut', 'boolean', 'Donut', 'Halka', { default: false }),
      WHERE,
      SORT,
      LIMIT,
      opt('centerTotal', 'boolean', 'Total in the center', 'Ortada toplam', { default: false }),
      choice('labels', 'Slice labels', 'Dilim etiketleri', [
        ['legend', 'Legend', 'Açıklama'],
        ['outside', 'Outside', 'Dışarıda'],
        ['inside', 'Inside', 'İçeride'],
        ['none', 'Hidden', 'Gizli'],
      ], 'legend'),
      TOP_N,
      COLOR,
      FORMAT,
    ],
  ),
  table: entry(
    'table', 'binding', ['table', 'series'],
    { en: 'Table', tr: 'Tablo' },
    { en: 'Rows and columns of numbers.', tr: 'Sayılardan oluşan satırlar ve sütunlar.' },
    { w: 8, h: 6 },
    [
      opt('columns', 'string-list', 'Columns', 'Sütunlar'),
      WHERE,
      SORT,
      LIMIT,
      choice('density', 'Density', 'Yoğunluk', [['compact', 'Compact', 'Sıkı'], ['comfortable', 'Comfortable', 'Rahat']], 'compact'),
      opt('bars', 'boolean', 'Data bars', 'Veri çubukları', { default: false }),
      opt('deltaColor', 'boolean', 'Color the change', 'Değişimi renklendir', { default: true }),
      FORMAT,
    ],
  ),
  heatmap: entry(
    'heatmap', 'binding', ['table', 'series'],
    { en: 'Heatmap', tr: 'Isı haritası' },
    { en: 'Intensity across two axes.', tr: 'İki eksen boyunca yoğunluk.' },
    { w: 6, h: 5 },
    [
      COLOR,
      WHERE,
      choice('scale', 'Color scale', 'Renk ölçeği', [['sequential', 'Low to high', 'Düşükten yükseğe'], ['diverging', 'Around a midpoint', 'Orta nokta etrafında']], 'sequential'),
      opt('cellLabels', 'boolean', 'Values in cells', 'Hücrelerde değerler', { default: false }),
      FORMAT,
    ],
  ),
  funnel: entry(
    'funnel', 'binding', ['funnel'],
    { en: 'Funnel', tr: 'Huni' },
    { en: 'Step by step conversion.', tr: 'Adım adım dönüşüm.' },
    { w: 8, h: 6 },
    [
      opt('compact', 'boolean', 'Compact', 'Sıkı', { default: false }),
      opt('showConversion', 'boolean', 'Conversion rates', 'Dönüşüm oranları', { default: true }),
    ],
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
    [
      choice('tone', 'Tone', 'Ton', [
        ['info', 'Info', 'Bilgi'],
        ['success', 'Success', 'Başarı'],
        ['warning', 'Warning', 'Uyarı'],
        ['danger', 'Danger', 'Tehlike'],
      ], 'info'),
      MARKDOWN,
    ],
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
  enumLabels: Record<string, Record<string, LocalizedText>>;
} {
  return {
    types: BLOCK_TYPES,
    blocks: listBlockCatalog(),
    enumLabels: OPTION_ENUM_LABELS,
    renderDefaultSpan: RENDER_DEFAULT_SPAN,
    htmlInputDefaultFrames: HTML_INPUT_DEFAULT_FRAMES,
  };
}
