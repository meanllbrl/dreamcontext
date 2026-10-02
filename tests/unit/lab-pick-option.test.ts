/**
 * The `pick` option type (W0 seam): a name picked from the block's frame or the
 * insight cache (`from`: funnels, dims, metrics, app-pages), one string or, with
 * `multi`, a list. The engine validator and the inspector's `optionAccepts` check
 * SHAPE only (a non-blank string up to 128 characters); whether the name exists
 * is decided at render time. The engine half adds two fixture options to the
 * funnel entry for the duration of the test; the catalog's own pick options
 * (W3) are checked to validate the same in the engine and the editor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCK_CATALOG, type BlockOptionSchema } from '../../src/lib/lab/blocks.js';
import { validateBoardSpec } from '../../src/lib/lab/boards.js';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import type { BlockCatalogEntry, BlockOptionSchema as DashSchema } from '../../dashboard/src/components/lab/board/boardTypes';
import { fieldsFor, optionAccepts } from '../../dashboard/src/components/lab/board/editorModel';

const PICK_ONE: BlockOptionSchema = { key: 'pickOne', type: 'pick', from: 'funnels', labelKey: 'lab.block.opt.pickOne', label: { en: 'Funnel', tr: 'Huni' } };
const PICK_MANY: BlockOptionSchema = { key: 'pickMany', type: 'pick', from: 'metrics', multi: true, labelKey: 'lab.block.opt.pickMany', label: { en: 'Metrics', tr: 'Metrikler' } };

const LONG = 'x'.repeat(129);
const GOOD_ONE = ['main', 'a', 'x'.repeat(128)];
const BAD_ONE: unknown[] = ['', '   ', LONG, 3, true, ['main'], { id: 'main' }];
const GOOD_MANY = [['cr'], ['cr', 'arpu'], []];
const BAD_MANY: unknown[] = ['cr', [''], ['cr', 2], [LONG], { cr: true }];

describe('pick option: the engine validates shape only', () => {
  const original = BLOCK_CATALOG.funnel;
  beforeAll(() => {
    BLOCK_CATALOG.funnel = { ...original, options: [...original.options, PICK_ONE, PICK_MANY] };
  });
  afterAll(() => {
    BLOCK_CATALOG.funnel = original;
  });

  const check = (key: string, value: unknown) =>
    validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ funnel: { data: 'a', [key]: value } }] }] }, 't');

  it('accepts one non-blank name up to 128 characters', () => {
    for (const v of GOOD_ONE) expect(check('pickOne', v).errors, String(v)).toEqual([]);
  });

  it('refuses blank, over-long and non-string single picks', () => {
    for (const v of BAD_ONE) expect(check('pickOne', v).errors.length, JSON.stringify(v)).toBeGreaterThan(0);
  });

  it('multi accepts a list of names and refuses anything else', () => {
    for (const v of GOOD_MANY) expect(check('pickMany', v).errors, JSON.stringify(v)).toEqual([]);
    for (const v of BAD_MANY) expect(check('pickMany', v).errors.length, JSON.stringify(v)).toBeGreaterThan(0);
  });

  it('a pick name absent from the data still validates (render time falls back visibly)', () => {
    expect(check('pickOne', 'no-such-funnel').errors).toEqual([]);
  });
});

describe('pick option: the inspector model agrees with the engine', () => {
  const one = PICK_ONE as DashSchema;
  const many = PICK_MANY as DashSchema;

  it('optionAccepts takes and refuses the same shapes', () => {
    for (const v of GOOD_ONE) expect(optionAccepts(one, v), String(v)).toBe(true);
    for (const v of BAD_ONE) expect(optionAccepts(one, v), JSON.stringify(v)).toBe(false);
    for (const v of GOOD_MANY) expect(optionAccepts(many, v), JSON.stringify(v)).toBe(true);
    for (const v of BAD_MANY) expect(optionAccepts(many, v), JSON.stringify(v)).toBe(false);
  });

  it('a single pick edits as a select, a multi pick as a checklist', () => {
    const entry = { ...(catalogJson.blocks.find((b) => b.type === 'funnel') as unknown as BlockCatalogEntry), options: [one, many] };
    expect(fieldsFor(entry).map((f) => f.control)).toEqual(['pick', 'pick-list']);
  });

  it('every catalog pick option validates the same in the engine and the editor', () => {
    const entries = catalogJson.blocks as unknown as BlockCatalogEntry[];
    const picks = entries.flatMap((b) => b.options.filter((o) => o.type === 'pick').map((o) => ({ type: b.type, schema: o as DashSchema })));
    expect(picks.length).toBeGreaterThan(0);
    const spec = (type: string, extra: Record<string, unknown>) =>
      validateBoardSpec({ title: 'T', cards: [{ id: 'c-a', insight: 'a', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ [type]: { data: 'a', ...extra } }] }] }, 't');
    for (const { type, schema } of picks) {
      const at = `${type}.${schema.key}`;
      expect(spec(type, {}).errors, `${at} baseline`).toEqual([]);
      const engine = BLOCK_CATALOG[type as keyof typeof BLOCK_CATALOG].options.find((o) => o.key === schema.key)!;
      expect(engine.type, at).toBe('pick');
      expect({ from: engine.from, multi: !!engine.multi }, at).toEqual({ from: schema.from, multi: !!schema.multi });
      const values = [...GOOD_ONE, ...BAD_ONE, ...GOOD_MANY, ...BAD_MANY];
      for (const v of values) {
        const engineOk = spec(type, { [schema.key]: v }).errors.length === 0;
        expect(optionAccepts(schema, v), `${at} ${JSON.stringify(v)}`).toBe(engineOk);
      }
    }
  });
});
