/**
 * The block inspector (dashboard/src/components/lab/board/BlockInspector.tsx): its form is
 * generated from the catalog, a type changes in place only across matching frame kinds, every
 * option edit yields the expected next card, and blocks are added, removed and reordered,
 * including inside a tabs block (one level).
 *
 * Pure-function tests (this repo runs no DOM harness): the component is a thin input layer over
 * editorModel.ts, whose functions produce every card it emits. Source checks pin what the
 * functions cannot: the form is driven by `fieldsFor`, never a hand list of option keys, and the
 * shared DOM hooks the verify script reads are present.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import type { Block, BlockCatalog, BlockType, Card } from '../../dashboard/src/components/lab/board/boardTypes';
import {
  addBlock, addTab, canChangeType, canRemoveBlock, cardProblems, changeType, datasetKeys, effectiveBlocks, entryOf,
  fieldsFor, formatSortField, formatWhereField, getBlock, moveBlock, movedPath, moveTab, newBlock, parseBinding,
  parseListField, parseNumberField, parseSortField, parseWhereField, removeBlock, removeTab, renameTab, setBinding,
  setInputs, setOption, typeChoices, updateBlock,
} from '../../dashboard/src/components/lab/board/editorModel';

const catalog = catalogJson as unknown as BlockCatalog;
const SRC = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/board');
const ctx = { insight: 'daily-signups', tabLabel: 'Tab 1', htmlStarter: '<p>Hi</p>' };

const card = (blocks?: Block[], insight: string | null = 'daily-signups'): Card => ({
  id: 'c-daily-signups',
  at: { x: 0, y: 0, w: 4, h: 3 },
  ...(insight ? { insight } : {}),
  ...(blocks ? { blocks } : {}),
});
const line: Block = { type: 'line', data: 'daily-signups', options: { area: true, color: 3 } };
const stat: Block = { type: 'stat', data: 'daily-signups', options: {} };
const text = (markdown: string): Block => ({ type: 'text', options: { markdown } });
const tabs: Block = {
  type: 'tabs',
  options: {},
  tabs: [
    { label: 'One', blocks: [text('a'), text('b'), text('c')] },
    { label: 'Two', blocks: [] },
  ],
};

describe('the form is generated from the catalog', () => {
  it('every catalog type yields one field per option, in catalog order, each with its label key', () => {
    expect(catalog.blocks.map((b) => b.type)).toEqual([...catalog.types]);
    for (const entry of catalog.blocks) {
      const fields = fieldsFor(entry);
      expect(fields.map((f) => f.key), entry.type).toEqual(entry.options.map((o) => o.key));
      for (const f of fields) {
        expect(f.labelKey).toBe(entry.options.find((o) => o.key === f.key)!.labelKey);
        expect(f.control).toBeTruthy();
      }
    }
  });

  it('maps each schema type to its control; an html ref is the library picker', () => {
    const controls = new Map<string, string>();
    for (const entry of catalog.blocks) for (const f of fieldsFor(entry)) controls.set(`${entry.type}.${f.key}`, f.control);
    expect(controls.get('stat.delta')).toBe('select');
    expect(controls.get('stat.spark')).toBe('toggle');
    expect(controls.get('line.color')).toBe('number');
    expect(controls.get('stat.unit')).toBe('text');
    expect(controls.get('text.markdown')).toBe('textarea');
    expect(controls.get('table.columns')).toBe('list');
    expect(controls.get('bar.where')).toBe('where');
    expect(controls.get('bar.sort')).toBe('sort');
    expect(controls.get('tabs.tabs')).toBe('tabs');
    expect(controls.get('html.inputs')).toBe('inputs');
    expect(controls.get('html.html')).toBe('html');
    expect(controls.get('html.ref')).toBe('library-ref');
  });

  it('a new catalog option becomes a field with no inspector edit', () => {
    const entry = { ...entryOf(catalog, 'line') };
    entry.options = [...entry.options, { key: 'smooth', type: 'boolean', default: false, labelKey: 'lab.block.opt.smooth', label: { en: 'Smooth', tr: 'Yumuşak' } }];
    expect(fieldsFor(entry).at(-1)).toMatchObject({ key: 'smooth', control: 'toggle' });
  });

  it('the inspector source renders fields through fieldsFor and lists no option key by hand', () => {
    const src = readFileSync(join(SRC, 'BlockInspector.tsx'), 'utf8');
    expect(src).toMatch(/fieldsFor\(entry\)/);
    // Option keys appear only as catalog data, never as literals in the inspector.
    for (const key of ['delta', 'spark', 'orientation', 'comparePrev', 'donut', 'compact', 'tone', 'dim', 'area']) {
      expect(src.includes(`'${key}'`), key).toBe(false);
    }
    for (const hook of ['data-lab-inspector', 'data-lab-field="type"', 'field="data"', 'data-lab-field={field}', 'data-lab-field={key}', 'data-lab-save-to-library']) {
      expect(src.includes(hook), hook).toBe(true);
    }
    expect(src).not.toMatch(/data-lab-placeholder/);
    expect(src).not.toMatch(/—/); // no em dash
  });
});

describe('type change in place', () => {
  it('is allowed only across matching frame kinds and data modes', () => {
    expect(canChangeType(catalog, 'line', 'bar')).toBe(true); // series
    expect(canChangeType(catalog, 'stat', 'line')).toBe(true); // value/series vs series
    expect(canChangeType(catalog, 'pivot', 'table')).toBe(true); // table
    expect(canChangeType(catalog, 'funnel', 'line')).toBe(false);
    expect(canChangeType(catalog, 'line', 'funnel')).toBe(false);
    expect(canChangeType(catalog, 'line', 'pivot')).toBe(false); // series vs table only
    expect(canChangeType(catalog, 'text', 'callout')).toBe(true);
    expect(canChangeType(catalog, 'text', 'line')).toBe(false);
    expect(canChangeType(catalog, 'text', 'tabs')).toBe(false);
    expect(canChangeType(catalog, 'tabs', 'text')).toBe(false);
    expect(canChangeType(catalog, 'html', 'text')).toBe(false);
    expect(canChangeType(catalog, 'insight', 'line')).toBe(false);
  });

  it('every choice list includes the block itself and is symmetric with canChangeType', () => {
    for (const from of catalog.types) {
      const choices = typeChoices(catalog, from);
      expect(choices).toContain(from);
      for (const to of catalog.types) expect(choices.includes(to)).toBe(canChangeType(catalog, from, to));
    }
    expect(typeChoices(catalog, 'funnel')).toEqual(['funnel']);
  });

  it('keeps the binding and the options the new type accepts, drops the rest', () => {
    const bar = changeType(catalog, { type: 'line', data: 'x/ds', options: { area: true, color: 3, limit: 10 } }, 'bar');
    expect(bar).toEqual({ type: 'bar', data: 'x/ds', options: { color: 3, limit: 10 } });
    const pie = changeType(catalog, bar, 'pie');
    expect(pie).toEqual({ type: 'pie', data: 'x/ds', options: { limit: 10 } });
    expect(changeType(catalog, { type: 'text', options: { markdown: '# Hi' } }, 'callout'))
      .toEqual({ type: 'callout', options: { markdown: '# Hi' } });
  });

  it('the result passes the client strict checks', () => {
    const next = updateBlock(card([line]), [0], (b) => changeType(catalog, b, 'bar'));
    expect(cardProblems(catalog, next)).toEqual([]);
  });
});

describe('each option edit yields the expected spec', () => {
  const base = card([{ type: 'bar', data: 'daily-signups', options: {} }]);
  const edit = (fn: (b: Block) => Block) => getBlock(updateBlock(base, [0], fn), [0])!;

  it('boolean, enum and number', () => {
    expect(edit((b) => setOption(b, 'comparePrev', true)).options).toEqual({ comparePrev: true });
    expect(edit((b) => setOption(b, 'orientation', 'v')).options).toEqual({ orientation: 'v' });
    expect(edit((b) => setOption(b, 'color', parseNumberField('5', { min: 1, max: 8 }))).options).toEqual({ color: 5 });
    expect(parseNumberField('99', { min: 1, max: 8 })).toBe(8);
    expect(parseNumberField('0', { min: 1, max: 8 })).toBe(1);
    expect(parseNumberField('2.6', { min: 1, max: 8 })).toBe(3);
    expect(parseNumberField('', { min: 1, max: 8 })).toBeUndefined();
    expect(parseNumberField('abc', { min: 1, max: 8 })).toBeUndefined();
  });

  it('unset (undefined, empty text, empty list, empty where) removes the key', () => {
    const b = { type: 'bar' as BlockType, data: 'x', options: { color: 2, series: ['a'], where: { c: 'TR' }, orientation: 'v' } };
    expect(setOption(b, 'color', undefined).options).not.toHaveProperty('color');
    expect(setOption(b, 'series', []).options).not.toHaveProperty('series');
    expect(setOption(b, 'where', {}).options).not.toHaveProperty('where');
    expect(setOption(b, 'orientation', '').options).not.toHaveProperty('orientation');
    // An html block keeps an empty inputs map (it declares none).
    expect(setOption({ type: 'html', options: { html: 'x' } }, 'inputs', {}).options).toEqual({ html: 'x', inputs: {} });
  });

  it('string-list, where and sort round-trip through their text forms', () => {
    expect(parseListField(' a, b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(edit((b) => setOption(b, 'series', parseListField('signups, trials'))).options).toEqual({ series: ['signups', 'trials'] });

    const where = parseWhereField('country: TR, DE\nplan: pro\n\nbad line\n: x');
    expect(where).toEqual({ country: ['TR', 'DE'], plan: 'pro' });
    expect(formatWhereField(where)).toBe('country: TR, DE\nplan: pro');
    expect(edit((b) => setOption(b, 'where', where)).options).toEqual({ where });

    expect(parseSortField('v', 'desc')).toBe('-v');
    expect(parseSortField('country', 'asc')).toBe('country');
    expect(parseSortField('  ', 'asc')).toBeUndefined();
    expect(parseSortField('two words', 'desc')).toEqual({ by: 'two words', dir: 'desc' });
    expect(formatSortField('-v')).toEqual({ by: 'v', dir: 'desc' });
    expect(formatSortField({ by: 'country', dir: 'asc' })).toEqual({ by: 'country', dir: 'asc' });
    expect(formatSortField(undefined)).toEqual({ by: '', dir: 'desc' });
  });

  it('every option of every type accepts a value the form produces, and the card stays valid', () => {
    const sample: Record<string, unknown> = {
      boolean: true, number: 2, string: 'x', markdown: '# x', 'string-list': ['a'], where: { c: 'TR' }, sort: '-v',
    };
    for (const entry of catalog.blocks) {
      for (const schema of entry.options) {
        if (['tabs', 'inputs', 'html'].includes(schema.type) || schema.key === 'ref') continue;
        const value = schema.type === 'enum' ? schema.enum![schema.enum!.length - 1] : sample[schema.type];
        let block = newBlock(catalog, entry.type, ctx);
        if (entry.type === 'filter') block = setOption(block, 'dim', 'country');
        block = setOption(block, schema.key, value);
        expect(block.options[schema.key], `${entry.type}.${schema.key}`).toEqual(value);
        const c = card([block]);
        expect(cardProblems(catalog, c), `${entry.type}.${schema.key}`).toEqual([]);
      }
    }
  });

  it('binding: insight, insight/dataset, unbind', () => {
    expect(setBinding(line, 'weekly-trials').data).toBe('weekly-trials');
    expect(setBinding(line, 'weekly-trials', 'by-country').data).toBe('weekly-trials/by-country');
    expect(setBinding(line, 'weekly-trials', '  ').data).toBe('weekly-trials');
    expect(setBinding({ type: 'insight', data: 'x', options: {} }, null)).toEqual({ type: 'insight', options: {} });
    expect(parseBinding('a/b')).toEqual({ insight: 'a', dataset: 'b' });
    expect(parseBinding('../etc')).toBeNull();
    expect(parseBinding('a%2Fb')).toBeNull();
    expect(datasetKeys({ datasets: { bundle: { datasets: [{ key: 'series' }, { key: 'by-country' }] } } })).toEqual(['series', 'by-country']);
    expect(datasetKeys(null)).toEqual([]);
  });

  it('html inputs: rows to a map, blank names dropped, order kept', () => {
    const html: Block = { type: 'html', options: { html: '<p/>', inputs: {} } };
    const next = setInputs(html, [{ name: 'signups', binding: 'daily-signups' }, { name: ' ', binding: 'x' }, { name: 'trials', binding: 'weekly-trials/series' }]);
    expect(next.options.inputs).toEqual({ signups: 'daily-signups', trials: 'weekly-trials/series' });
    expect(Object.keys(next.options.inputs as object)).toEqual(['signups', 'trials']);
  });
});

describe('client strict checks keep an unsavable edit a draft', () => {
  it('flags what the engine refuses on write', () => {
    const codes = (c: Card) => cardProblems(catalog, c).map((p) => p.code);
    expect(codes(card([{ type: 'line', options: {} }]))).toEqual(['data-required']);
    expect(codes(card([{ type: 'line', data: '../x', options: {} }]))).toEqual(['data-unsafe']);
    expect(codes(card([{ type: 'filter', data: 'x', options: {} }]))).toEqual(['filter-dim']);
    expect(codes(card([{ type: 'html', options: {} }]))).toEqual(['html-source']);
    expect(codes(card([{ type: 'html', options: { html: '<p/>', ref: 'lib' } }]))).toEqual(['html-source']);
    expect(codes(card([{ type: 'html', options: { ref: 'Bad Slug' } }]))).toEqual(['ref-unsafe']);
    expect(codes(card([{ type: 'html', options: { html: 'x', inputs: { '1bad': 'a' } } }]))).toEqual(['input-name']);
    expect(codes(card([{ type: 'html', options: { html: 'x', inputs: { ok: '../a' } } }]))).toEqual(['input-binding']);
    expect(codes(card([{ type: 'insight', options: {} }], null))).toEqual(['insight-missing']);
    expect(codes(card([{ type: 'line', data: 'x', options: { color: 12 } }]))).toEqual(['option-invalid']);
    expect(codes(card([{ type: 'tabs', options: {}, tabs: [] }]))).toEqual(['tabs-empty']);
    expect(codes(card([{ type: 'tabs', options: {}, tabs: [{ label: ' ', blocks: [] }] }]))).toEqual(['tab-label']);
    expect(codes(card(undefined, null))).toEqual(['card-empty']);
    expect(codes(card([line, stat, tabs]))).toEqual([]);
  });

  it('every new block from the catalog is valid on a card with an insight (filter aside: it needs a dimension)', () => {
    for (const type of catalog.types) {
      const problems = cardProblems(catalog, card([newBlock(catalog, type, ctx)]));
      expect(problems.map((p) => p.code), type).toEqual(type === 'filter' ? ['filter-dim'] : []);
    }
  });

  it('the inspector commits only a problem-free card', () => {
    const src = readFileSync(join(SRC, 'BlockInspector.tsx'), 'utf8');
    expect(src).toMatch(/if \(cardProblems\(catalog, next\)\.length === 0\) \{\s*setDraft\(null\);\s*onChange\(next\);/);
  });
});

describe('add, remove, reorder', () => {
  it('a legacy card (insight, no blocks) shows one insight block, written out on the first structural edit', () => {
    const legacy = card();
    expect(effectiveBlocks(legacy)).toEqual([{ type: 'insight', options: {} }]);
    const res = addBlock(legacy, stat)!;
    expect(res.card.blocks).toEqual([{ type: 'insight', options: {} }, stat]);
    expect(res.path).toEqual([1]);
    expect(cardProblems(catalog, res.card)).toEqual([]);
  });

  it('adds at the end and reports the new path', () => {
    const res = addBlock(card([line]), stat)!;
    expect(res.card.blocks!.map((b) => b.type)).toEqual(['line', 'stat']);
    expect(res.path).toEqual([1]);
  });

  it('removes; the last block of an insight card falls back to the legacy render; a card with no insight keeps its last block', () => {
    expect(removeBlock(card([line, stat]), [0]).blocks).toEqual([stat]);
    const bare = removeBlock(card([line]), [0]);
    expect(bare).not.toHaveProperty('blocks');
    expect(bare.insight).toBe('daily-signups');
    const noInsight = card([text('x')], null);
    expect(canRemoveBlock(noInsight, [0])).toBe(false);
    expect(removeBlock(noInsight, [0])).toBe(noInsight);
  });

  it('reorders within bounds and tracks the moved path', () => {
    const c = card([line, stat, text('t')]);
    expect(moveBlock(c, [0], 1).blocks!.map((b) => b.type)).toEqual(['stat', 'line', 'text']);
    expect(moveBlock(c, [2], -1).blocks!.map((b) => b.type)).toEqual(['line', 'text', 'stat']);
    expect(moveBlock(c, [0], -1)).toBe(c);
    expect(moveBlock(c, [2], 1)).toBe(c);
    expect(movedPath([2, 0, 1], 1)).toEqual([2, 0, 2]);
  });

  it('edits never mutate the input card', () => {
    const c = card([line, tabs]);
    const snapshot = JSON.stringify(c);
    moveBlock(c, [0], 1);
    removeBlock(c, [1, 0, 0]);
    addBlock(c, stat, { at: 1, tab: 0 });
    updateBlock(c, [0], (b) => setOption(b, 'area', false));
    renameTab(c, 1, 0, 'X');
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

describe('inside a tabs block (one level)', () => {
  const c = card([line, tabs]);

  it('reads, edits, reorders and removes a tab child by [block, tab, child]', () => {
    expect(getBlock(c, [1, 0, 1])).toEqual(text('b'));
    const edited = updateBlock(c, [1, 0, 1], (b) => setOption(b, 'markdown', 'B'));
    expect(getBlock(edited, [1, 0, 1])).toEqual(text('B'));
    expect(getBlock(edited, [0])).toBe(line);
    const moved = moveBlock(c, [1, 0, 0], 1);
    expect(moved.blocks![1].tabs![0].blocks.map((b) => b.options.markdown)).toEqual(['b', 'a', 'c']);
    const removed = removeBlock(c, [1, 0, 2]);
    expect(removed.blocks![1].tabs![0].blocks.map((b) => b.options.markdown)).toEqual(['a', 'b']);
    expect(canRemoveBlock(c, [1, 1, 0])).toBe(false); // tab Two is empty: nothing there
  });

  it('adds into a tab, never a tabs block', () => {
    const res = addBlock(c, stat, { at: 1, tab: 1 })!;
    expect(res.path).toEqual([1, 1, 0]);
    expect(res.card.blocks![1].tabs![1].blocks).toEqual([stat]);
    expect(addBlock(c, tabs, { at: 1, tab: 0 })).toBeNull();
    expect(addBlock(c, stat, { at: 0, tab: 0 })).toBeNull(); // block 0 is not a tabs block
    expect(cardProblems(catalog, res.card)).toEqual([]);
  });

  it('adds, renames, reorders and removes tabs; the last tab stays', () => {
    const three = addTab(c, 1, 'Three');
    expect(three.blocks![1].tabs!.map((t) => t.label)).toEqual(['One', 'Two', 'Three']);
    expect(renameTab(three, 1, 2, 'Third').blocks![1].tabs![2].label).toBe('Third');
    expect(moveTab(three, 1, 0, 1).blocks![1].tabs!.map((t) => t.label)).toEqual(['Two', 'One', 'Three']);
    expect(removeTab(three, 1, 0).blocks![1].tabs!.map((t) => t.label)).toEqual(['Two', 'Three']);
    const one = card([{ type: 'tabs', options: {}, tabs: [{ label: 'Only', blocks: [] }] }]);
    expect(removeTab(one, 0, 0)).toEqual(one);
  });

  it('a tabs block nested in a tab is flagged', () => {
    const nested = card([{ type: 'tabs', options: {}, tabs: [{ label: 'A', blocks: [{ type: 'tabs', options: {}, tabs: [{ label: 'B', blocks: [] }] }] }] }]);
    expect(cardProblems(catalog, nested).map((p) => p.code)).toContain('tabs-nested');
  });
});
