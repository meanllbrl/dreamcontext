/**
 * Every chart option lives in the engine catalog (src/lib/lab/blocks.ts), the single source:
 * each has a type, a default, EN+TR labels (and EN+TR labels per enum value), the dashboard's
 * I18nContext carries the same copy under the same keys, the inspector draws a field for it from
 * the schema alone, the engine validator accepts every default and enum value, and the options
 * that existed before keep their names, types and defaults so written boards render unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_CATALOG, BLOCK_TYPES, OPTION_ENUM_LABELS, type BlockOptionSchema, type BlockType } from '../../src/lib/lab/blocks.js';
import { validateBoardSpec } from '../../src/lib/lab/boards.js';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import type { BlockCatalog } from '../../dashboard/src/components/lab/board/boardTypes';
import { enumLabelKey, fieldsFor } from '../../dashboard/src/components/lab/board/editorModel';

const ROOT = new URL('../../', import.meta.url).pathname;
const I18N = readFileSync(join(ROOT, 'dashboard/src/context/I18nContext.tsx'), 'utf-8');
const TR_AT = I18N.indexOf('const TR_PARTIAL');
const EN_SRC = I18N.slice(0, TR_AT);
const TR_SRC = I18N.slice(TR_AT);

/** The string a `'key': 'value'` entry holds in one locale table, or null. */
function copyOf(src: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`'${esc}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(src);
  return m ? m[1].replace(/\\'/g, "'") : null;
}

/** Options the per-chart acceptance criteria name, per block. */
const REQUIRED: Partial<Record<BlockType, string[]>> = {
  line: ['curve', 'points', 'area', 'yMin', 'reference', 'referenceLabel', 'legend', 'axes', 'grid', 'format', 'series', 'color'],
  bar: ['orientation', 'sort', 'valueLabels', 'topN', 'group', 'comparePrev', 'color', 'format', 'axes', 'grid', 'legend'],
  stacked: ['mode', 'normalize', 'color', 'legend', 'format', 'axes', 'grid'],
  pie: ['donut', 'centerTotal', 'labels', 'topN', 'sort', 'color', 'format'],
  heatmap: ['scale', 'cellLabels', 'color', 'format'],
  table: ['density', 'bars', 'deltaColor', 'columns', 'limit', 'sort', 'format'],
  stat: ['size', 'goal', 'delta', 'spark', 'unit', 'format'],
  funnel: ['compact', 'showConversion'],
};

/** Enum values the criteria name. */
const REQUIRED_ENUMS: Record<string, string[]> = {
  curve: ['linear', 'smooth', 'step'],
  points: ['auto', 'always', 'never'],
  yMin: ['auto', 'zero'],
  legend: ['top', 'bottom', 'right', 'none'],
  axes: ['both', 'x', 'y', 'none'],
  group: ['grouped', 'stacked'],
  mode: ['area', 'bar'],
  labels: ['legend', 'outside', 'inside', 'none'],
  scale: ['sequential', 'diverging'],
  density: ['compact', 'comfortable'],
  size: ['sm', 'md', 'lg'],
};

/** Every option that existed before this work: its key and type, per block (order-free). */
const LEGACY_KEYS: Partial<Record<BlockType, Record<string, string>>> = {
  stat: { delta: 'enum', spark: 'boolean', unit: 'string', format: 'enum', series: 'string-list' },
  line: { area: 'boolean', color: 'number', series: 'string-list', limit: 'number' },
  bar: { orientation: 'enum', color: 'number', comparePrev: 'boolean', where: 'where', sort: 'sort', limit: 'number', series: 'string-list' },
  stacked: { color: 'number', where: 'where', series: 'string-list', limit: 'number' },
  pie: { donut: 'boolean', where: 'where', sort: 'sort', limit: 'number' },
  table: { columns: 'string-list', where: 'where', sort: 'sort', limit: 'number' },
  heatmap: { color: 'number', where: 'where' },
  funnel: { compact: 'boolean' },
  pivot: { rows: 'string', cols: 'string', where: 'where' },
  text: { markdown: 'markdown' },
  callout: { tone: 'enum', markdown: 'markdown' },
  tabs: { tabs: 'tabs' },
  filter: { dim: 'string' },
  html: { html: 'html', ref: 'string', inputs: 'inputs' },
  insight: { page: 'pick', nav: 'boolean' },
  // Funnel explorer blocks (their first options; kept from here on like the rest).
  breakdown: { funnel: 'pick', dims: 'pick', counts: 'boolean', lanes: 'boolean' },
  trend: { funnel: 'pick', metrics: 'pick', chart: 'enum', switch: 'boolean', legend: 'enum', axes: 'enum', grid: 'boolean', format: 'enum' },
  benchmark: { funnel: 'pick', metrics: 'pick', comparePrev: 'boolean', sources: 'boolean' },
  segments: { funnel: 'pick', by: 'pick', metrics: 'pick', bands: 'boolean', sort: 'sort', limit: 'number', density: 'enum' },
};

/** The legacy defaults / enums / bounds, which must not move (today's look). */
const LEGACY_VALUES: Partial<Record<BlockType, Record<string, Partial<BlockOptionSchema>>>> = {
  stat: {
    delta: { enum: ['none', 'prev'], default: 'none' },
    spark: { default: false },
    format: { enum: ['number', 'compact', 'percent', 'currency'], default: 'number' },
  },
  line: { area: { default: false }, color: { default: 1, min: 1, max: 8 }, limit: { min: 1, max: 400 } },
  bar: { orientation: { enum: ['h', 'v'], default: 'h' }, color: { default: 1, min: 1, max: 8 }, comparePrev: { default: false }, limit: { min: 1, max: 400 } },
  stacked: { color: { default: 1, min: 1, max: 8 }, limit: { min: 1, max: 400 } },
  pie: { donut: { default: false }, limit: { min: 1, max: 400 } },
  table: { limit: { min: 1, max: 400 } },
  heatmap: { color: { default: 1, min: 1, max: 8 } },
  // markWorst off and layout bars: a funnel block written before the explorer draws exactly as before.
  funnel: { compact: { default: false }, markWorst: { default: false }, layout: { enum: ['bars', 'flow'], default: 'bars' } },
  insight: { nav: { default: false } },
  callout: { tone: { enum: ['info', 'success', 'warning', 'danger'], default: 'info' } },
};

const all = BLOCK_TYPES.flatMap((type) => BLOCK_CATALOG[type].options.map((o) => ({ type, o })));
const EM_DASH = /—/;

describe('catalog options: every option is complete', () => {
  it('names every option the per-chart criteria ask for, with the named enum values', () => {
    for (const [type, keys] of Object.entries(REQUIRED) as [BlockType, string[]][]) {
      const have = BLOCK_CATALOG[type].options.map((o) => o.key);
      for (const k of keys) expect(have, `${type}.${k}`).toContain(k);
    }
    for (const { type, o } of all) {
      const want = REQUIRED_ENUMS[o.key];
      if (want) expect(o.enum, `${type}.${o.key}`).toEqual(expect.arrayContaining(want));
    }
  });

  it('each option: a type, a default (null = unset), label key + EN/TR copy, and a valid default', () => {
    for (const { type, o } of all) {
      const at = `${type}.${o.key}`;
      expect(o.type, at).toBeTruthy();
      expect(o.labelKey, at).toBe(`lab.block.opt.${o.key}`);
      expect(o.label.en.trim(), at).not.toBe('');
      expect(o.label.tr.trim(), at).not.toBe('');
      if (o.type === 'boolean') expect(typeof o.default, at).toBe('boolean');
      if (o.type === 'enum') {
        expect(o.enum && o.enum.length > 0, at).toBe(true);
        expect(o.enum, at).toContain(o.default);
        // Each value carries its own EN/TR label.
        for (const v of o.enum ?? []) {
          const l = OPTION_ENUM_LABELS[o.key]?.[String(v)];
          expect(l?.en.trim(), `${at}=${v}`).toBeTruthy();
          expect(l?.tr.trim(), `${at}=${v}`).toBeTruthy();
        }
      }
      if (o.type === 'number' && typeof o.default === 'number') {
        if (o.min !== undefined) expect(o.default, at).toBeGreaterThanOrEqual(o.min);
        if (o.max !== undefined) expect(o.default, at).toBeLessThanOrEqual(o.max);
      }
    }
  });

  it('one key, one label: a key shared across blocks carries the same copy everywhere', () => {
    const seen = new Map<string, string>();
    for (const { o } of all) {
      const text = JSON.stringify(o.label);
      const prev = seen.get(o.key);
      if (prev) expect(text, o.key).toBe(prev);
      else seen.set(o.key, text);
    }
  });

  it('no em dash in any label', () => {
    for (const { type, o } of all) {
      const texts = [o.label.en, o.label.tr, ...Object.values(OPTION_ENUM_LABELS[o.key] ?? {}).flatMap((l) => [l.en, l.tr])];
      for (const s of texts) expect(EM_DASH.test(s), `${type}.${o.key}: ${s}`).toBe(false);
    }
  });
});

describe('catalog options: the dashboard holds the same copy (I18nContext, EN + TR_PARTIAL)', () => {
  it('every option label and enum value label, in both locales, equal to the catalog', () => {
    for (const { type, o } of all) {
      expect(copyOf(EN_SRC, o.labelKey), `${type} EN ${o.labelKey}`).toBe(o.label.en);
      expect(copyOf(TR_SRC, o.labelKey), `${type} TR ${o.labelKey}`).toBe(o.label.tr);
      for (const [v, l] of Object.entries(OPTION_ENUM_LABELS[o.key] ?? {})) {
        const key = enumLabelKey(o.key, v);
        expect(copyOf(EN_SRC, key), `EN ${key}`).toBe(l.en);
        expect(copyOf(TR_SRC, key), `TR ${key}`).toBe(l.tr);
      }
    }
  });

  it('the mirror carries the enum labels', () => {
    expect((catalogJson as unknown as { enumLabels: unknown }).enumLabels).toEqual(OPTION_ENUM_LABELS);
  });

  it('the Other row topN folds has its word in both locales', () => {
    expect(copyOf(EN_SRC, 'lab.blocks.other')).toBe('Other');
    expect(copyOf(TR_SRC, 'lab.blocks.other')).toBe('Diğer');
  });
});

describe('catalog options: legacy names, types and defaults are unchanged', () => {
  it('every option that existed keeps its key and type', () => {
    for (const type of BLOCK_TYPES) {
      // Types added after this pin (ranking, payment, access) have no legacy options; the I18n half covers them.
      const legacy = LEGACY_KEYS[type];
      if (!legacy) continue;
      const now = Object.fromEntries(BLOCK_CATALOG[type].options.map((o) => [o.key, o.type]));
      for (const [k, t] of Object.entries(legacy)) expect(now[k], `${type}.${k}`).toBe(t);
    }
  });

  it('keeps each legacy default, enum and bound', () => {
    for (const [type, opts] of Object.entries(LEGACY_VALUES) as [BlockType, Record<string, Partial<BlockOptionSchema>>][]) {
      for (const [k, want] of Object.entries(opts)) {
        const o = BLOCK_CATALOG[type].options.find((x) => x.key === k)!;
        for (const [field, value] of Object.entries(want)) {
          expect((o as unknown as Record<string, unknown>)[field], `${type}.${k}.${field}`).toEqual(value);
        }
      }
    }
  });

  it('new options are the only additions and none is required: an options-free block still validates', () => {
    for (const type of ['line', 'bar', 'stacked', 'pie', 'heatmap', 'table', 'stat', 'funnel'] as BlockType[]) {
      const v = validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ [type]: { data: 'a' } }] }] }, 't');
      expect(v.errors, type).toEqual([]);
    }
  });
});

describe('catalog options: engine and inspector take them without a hand list', () => {
  it('the engine validator accepts every default and every enum value, and refuses a value off the enum', () => {
    for (const { type, o } of all) {
      if (!['boolean', 'enum', 'number'].includes(o.type) || BLOCK_CATALOG[type].data !== 'binding') continue;
      const values = o.type === 'enum' ? [...(o.enum ?? [])] : [o.default];
      for (const value of values) {
        if (value === null || value === undefined) continue;
        const v = validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ [type]: { data: 'a', [o.key]: value } }] }] }, 't');
        expect(v.errors, `${type}.${o.key}=${String(value)}`).toEqual([]);
      }
      if (o.type === 'enum') {
        const bad = validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ [type]: { data: 'a', [o.key]: 'nope-not-a-value' } }] }] }, 't');
        expect(bad.errors.length, `${type}.${o.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('the sort shorthands none/desc/asc validate', () => {
    for (const sort of ['none', 'desc', 'asc']) {
      const v = validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ bar: { data: 'a', sort } }] }] }, 't');
      expect(v.errors, sort).toEqual([]);
    }
  });

  it('the generated catalog the inspector reads has a field for every option, in catalog order', () => {
    const catalog = catalogJson as unknown as BlockCatalog;
    for (const type of BLOCK_TYPES) {
      const entry = catalog.blocks.find((b) => b.type === type)!;
      expect(fieldsFor(entry).map((f) => f.key), type).toEqual(BLOCK_CATALOG[type].options.map((o) => o.key));
    }
  });
});
