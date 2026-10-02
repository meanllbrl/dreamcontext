/**
 * The funnel explorer blocks on the catalog side: breakdown, trend, benchmark
 * and segments are catalog types bound to a funnel frame, with the option
 * names the components read (plan §2, pinned), defaults equal to the
 * components' own fallbacks (a written block with no options draws as the
 * component's default), pick fields naming where their choices come from,
 * EN+TR copy in I18nContext, a registered component each, and the
 * funnel-explorer preset validating as a board spec.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_CATALOG, BLOCK_TYPES, blockCatalogMirror, type BlockOptionSchema, type BlockType } from '../../src/lib/lab/blocks.js';
import { validateBoardSpec } from '../../src/lib/lab/boards.js';
import { funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';

const ROOT = join(import.meta.dirname, '../..');
const I18N = readFileSync(join(ROOT, 'dashboard/src/context/I18nContext.tsx'), 'utf-8');
const TR_AT = I18N.indexOf('const TR_PARTIAL');
const EN_SRC = I18N.slice(0, TR_AT);
const TR_SRC = I18N.slice(TR_AT);
const REGISTRY = readFileSync(join(ROOT, 'dashboard/src/components/lab/blocks/blockRegistry.ts'), 'utf-8');
const BOARD_TYPES = readFileSync(join(ROOT, 'dashboard/src/components/lab/board/boardTypes.ts'), 'utf-8');
const BLOCKS_CSS = readFileSync(join(ROOT, 'dashboard/src/components/lab/blocks/blocks.css'), 'utf-8');

function copyOf(src: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`'${esc}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(src);
  return m ? m[1].replace(/\\'/g, "'") : null;
}

const NEW_TYPES = ['breakdown', 'trend', 'benchmark', 'segments'] as const;

/** Plan §2 option names, in catalog order. */
const OPTIONS: Record<(typeof NEW_TYPES)[number], string[]> = {
  breakdown: ['funnel', 'dims', 'counts', 'lanes'],
  trend: ['funnel', 'metrics', 'chart', 'switch', 'legend', 'axes', 'grid', 'format'],
  benchmark: ['funnel', 'metrics', 'comparePrev', 'sources'],
  segments: ['funnel', 'by', 'metrics', 'bands', 'sort', 'limit', 'density'],
};

const SIZES = { breakdown: { w: 12, h: 2 }, benchmark: { w: 6, h: 6 }, segments: { w: 8, h: 6 }, trend: { w: 8, h: 4 } };

const opt = (type: BlockType, key: string): BlockOptionSchema => {
  const o = BLOCK_CATALOG[type].options.find((x) => x.key === key);
  expect(o, `${type}.${key}`).toBeTruthy();
  return o!;
};

describe('explorer blocks in the catalog', () => {
  it('are catalog types bound to a funnel frame, with the planned footprint', () => {
    for (const type of NEW_TYPES) {
      expect(BLOCK_TYPES).toContain(type);
      const e = BLOCK_CATALOG[type];
      expect(e.data, type).toBe('binding');
      expect(e.frames, type).toEqual(['funnel']);
      expect(e.defaultSize, type).toEqual(SIZES[type]);
    }
  });

  it('carry exactly the pinned option names', () => {
    for (const type of NEW_TYPES) expect(BLOCK_CATALOG[type].options.map((o) => o.key), type).toEqual(OPTIONS[type]);
    expect(BLOCK_CATALOG.funnel.options.map((o) => o.key)).toEqual(['compact', 'showConversion', 'funnel', 'layout', 'markWorst']);
    expect(BLOCK_CATALOG.insight.options.map((o) => o.key)).toEqual(['page', 'nav']);
  });

  it('pick fields name their source; lists are multi', () => {
    const picks: [BlockType, string, string, boolean][] = [
      ['breakdown', 'funnel', 'funnels', false], ['breakdown', 'dims', 'dims', true],
      ['trend', 'funnel', 'funnels', false], ['trend', 'metrics', 'metrics', true],
      ['benchmark', 'funnel', 'funnels', false], ['benchmark', 'metrics', 'metrics', true],
      ['segments', 'funnel', 'funnels', false], ['segments', 'by', 'dims', false], ['segments', 'metrics', 'metrics', true],
      ['funnel', 'funnel', 'funnels', false], ['insight', 'page', 'app-pages', false],
    ];
    for (const [type, key, from, multi] of picks) {
      const o = opt(type, key);
      expect(o.type, `${type}.${key}`).toBe('pick');
      expect(o.from, `${type}.${key}`).toBe(from);
      expect(o.multi === true, `${type}.${key}`).toBe(multi);
      expect(o.default ?? null, `${type}.${key}`).toBeNull();
    }
  });

  it('defaults match what the components draw with no option set (existing funnel boards unchanged)', () => {
    expect(opt('breakdown', 'lanes').default).toBe(true);
    expect(opt('breakdown', 'counts').default).toBe(false);
    expect(opt('trend', 'switch').default).toBe(true);
    expect(opt('trend', 'chart')).toMatchObject({ type: 'enum', enum: ['line', 'bar'], default: 'line' });
    expect(opt('benchmark', 'comparePrev').default).toBe(true);
    expect(opt('benchmark', 'sources').default).toBe(true);
    expect(opt('segments', 'bands').default).toBe(true);
    expect(opt('segments', 'density').default).toBe('compact');
    expect(opt('funnel', 'layout')).toMatchObject({ type: 'enum', enum: ['bars', 'flow'], default: 'bars' });
    expect(opt('funnel', 'markWorst').default).toBe(false);
    expect(opt('insight', 'nav').default).toBe(false);
    // The bar keeps its own comparePrev default; the label is shared.
    expect(opt('bar', 'comparePrev').default).toBe(false);
    expect(opt('bar', 'comparePrev').label).toEqual(opt('benchmark', 'comparePrev').label);
  });

  it('labels carry the planned EN/TR copy', () => {
    const want: Record<string, [string, string]> = {
      funnel: ['Funnel', 'Huni'], dims: ['Breakdowns', 'Kırılımlar'], counts: ['User counts', 'Kullanıcı sayıları'],
      lanes: ['Compare lanes', 'Karşılaştırma şeritleri'], metrics: ['Metrics', 'Metrikler'], sources: ['Band sources', 'Bant kaynakları'],
      by: ['Split by', 'Kırılım ekseni'], bands: ['Band colors', 'Bant renkleri'], chart: ['Chart', 'Grafik'],
      switch: ['Metric switch', 'Metrik anahtarı'], layout: ['Layout', 'Yerleşim'], markWorst: ['Mark the biggest drop', 'En büyük düşüşü işaretle'],
      page: ['Page', 'Sayfa'], nav: ['Page tabs', 'Sayfa sekmeleri'],
    };
    const all = BLOCK_TYPES.flatMap((t) => BLOCK_CATALOG[t].options);
    for (const [key, [en, tr]] of Object.entries(want)) {
      for (const o of all.filter((x) => x.key === key)) expect(o.label, key).toEqual({ en, tr });
    }
  });

  it('every default and pick shape validates; a pick with the wrong shape is refused', () => {
    const board = (type: string, options: Record<string, unknown>) =>
      validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', at: { x: 0, y: 0, w: 12, h: 6 }, blocks: [{ [type]: { data: 'acme-funnel', ...options } }] }] }, 't');
    for (const type of NEW_TYPES) {
      expect(board(type, {}).errors, type).toEqual([]);
      const all: Record<string, unknown> = {};
      for (const o of BLOCK_CATALOG[type].options) {
        if (o.type === 'pick') all[o.key] = o.multi ? ['a', 'b'] : 'a';
        else if (o.default !== null && o.default !== undefined) all[o.key] = o.default;
      }
      expect(board(type, all).errors, type).toEqual([]);
    }
    expect(board('segments', { by: ['platform'] }).errors.length).toBeGreaterThan(0);
    expect(board('trend', { metrics: 'cvr' }).errors.length).toBeGreaterThan(0);
    expect(board('funnel', { layout: 'sankey' }).errors.length).toBeGreaterThan(0);
  });

  it('the funnel-explorer preset validates as a board card', () => {
    const blocks = funnelExplorerBlocks('acme-funnel', [{ key: 'platform', label: 'Platform' }, { key: 'country', label: 'Country' }], 'en');
    const v = validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', insight: 'acme-funnel', at: { x: 0, y: 0, w: 12, h: 12 }, blocks }] }, 't');
    expect(v.errors).toEqual([]);
  });
});

describe('explorer blocks on the dashboard side', () => {
  it('the generated mirror is the engine catalog (regenerated, not hand-edited)', () => {
    expect(JSON.parse(JSON.stringify(catalogJson))).toEqual(JSON.parse(JSON.stringify(blockCatalogMirror())));
  });

  it('BlockType, the registry and the chart clip rule know the new types', () => {
    const components: Record<string, string> = { breakdown: 'BreakdownBlock', trend: 'TrendBlock', benchmark: 'BenchmarkBlock', segments: 'SegmentsBlock' };
    for (const type of NEW_TYPES) {
      expect(BOARD_TYPES, type).toContain(`| '${type}'`);
      expect(REGISTRY, type).toContain(`  ${type}: ${components[type]},`);
      expect(REGISTRY, type).toContain(`import { ${components[type]} } from './${components[type]}';`);
    }
    // Trend and benchmark draw to the box they get: the outer block clips like every chart.
    expect(BLOCKS_CSS).toMatch(/\.lab-block--trend[^{]*\.lab-block--benchmark\)\s*\{\s*overflow: hidden;/);
  });

  it('I18nContext holds every block label, description and the editor copy in EN and TR', () => {
    const keys = [
      ...NEW_TYPES.flatMap((t) => [`lab.block.${t}`, `lab.block.${t}.description`]),
      'lab.editor.enum.chart.line', 'lab.editor.enum.chart.bar', 'lab.editor.enum.layout.bars', 'lab.editor.enum.layout.flow',
      'lab.editor.pick.empty', 'lab.editor.pick.auto', 'lab.editor.pick.stale', 'lab.blocks.benchmark.cellsNoRates',
    ];
    for (const key of keys) {
      expect(copyOf(EN_SRC, key), `EN ${key}`).toBeTruthy();
      expect(copyOf(TR_SRC, key), `TR ${key}`).toBeTruthy();
      expect(copyOf(EN_SRC, key), `EN ${key}`).not.toBe(copyOf(TR_SRC, key));
    }
    for (const type of NEW_TYPES) {
      const e = BLOCK_CATALOG[type];
      expect(copyOf(EN_SRC, e.labelKey)).toBe(e.label.en);
      expect(copyOf(TR_SRC, e.labelKey)).toBe(e.label.tr);
      expect(copyOf(EN_SRC, e.descriptionKey)).toBe(e.description.en);
      expect(copyOf(TR_SRC, e.descriptionKey)).toBe(e.description.tr);
    }
    expect(copyOf(EN_SRC, 'lab.editor.pick.stale')).toContain('{value}');
    expect(copyOf(TR_SRC, 'lab.editor.pick.stale')).toContain('{value}');
    expect(copyOf(EN_SRC, 'lab.blocks.benchmark.cellsNoRates')).toBe('Rates are not measured for a combined selection');
    expect(copyOf(TR_SRC, 'lab.blocks.benchmark.cellsNoRates')).toBe('Birleşik seçim için oranlar ölçülmüyor');
  });

  it('no em dash in any new copy', () => {
    for (const type of NEW_TYPES) {
      const e = BLOCK_CATALOG[type];
      for (const s of [e.label.en, e.label.tr, e.description.en, e.description.tr]) expect(s).not.toMatch(/—/);
    }
  });
});
