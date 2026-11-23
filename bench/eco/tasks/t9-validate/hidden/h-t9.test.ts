import { expect, it } from 'vitest';
import { load } from '../src/store.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const good = { id: 'a', name: 'Beans', category: 'canned', quantity: 2, unit: 'pcs', expiresOn: '2026-06-01', location: 'shelf-a' };
const fam = { id: 'h1', name: 'Ada', size: 3, infants: 1 };
const file = (data: unknown) => { const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json'); writeFileSync(p, JSON.stringify(data)); return p; };
const err = (data: unknown) => { try { load(file(data)); return 'no error'; } catch (e) { return (e as Error).message; } };
it('h9 valid data and missing file load', () => {
  expect(load(file({ items: [good, { ...good, id: 'b', expiresOn: null, quantity: 0 }], households: [fam] })).items).toHaveLength(2);
  expect(load(join(mkdtempSync(join(tmpdir(), 'pp-')), 'none.json'))).toEqual({ items: [], households: [] });
});
it('h9 bad category and unit', () => {
  expect(err({ items: [{ ...good, category: 'frozen' }], households: [] })).toBe('invalid item a: category');
  expect(err({ items: [{ ...good, unit: 'lb' }], households: [] })).toBe('invalid item a: unit');
});
it('h9 quantity must be a finite number, 0 or more', () => {
  expect(err({ items: [{ ...good, quantity: -1 }], households: [] })).toBe('invalid item a: quantity');
  expect(err({ items: [{ ...good, quantity: '3' }], households: [] })).toBe('invalid item a: quantity');
});
it('h9 expiresOn must be a real calendar date', () => {
  expect(err({ items: [{ ...good, expiresOn: '2026-02-30' }], households: [] })).toBe('invalid item a: expiresOn');
  expect(err({ items: [{ ...good, expiresOn: '2026-6-1' }], households: [] })).toBe('invalid item a: expiresOn');
});
it('h9 first failing field in order, first bad item in file order', () => {
  expect(err({ items: [{ ...good, name: '', unit: 'lb' }], households: [] })).toBe('invalid item a: name');
  expect(err({ items: [good, { ...good, id: 'b', location: '' }, { ...good, id: 'c', category: 'x' }], households: [] })).toBe('invalid item b: location');
});
it('h9 missing id is written as ?', () => {
  expect(err({ items: [{ ...good, id: '' }], households: [] })).toBe('invalid item ?: id');
});
it('h9 households: size and infants', () => {
  expect(err({ items: [good], households: [{ ...fam, size: 0 }] })).toBe('invalid household h1: size');
  expect(err({ items: [good], households: [{ ...fam, size: 2.5 }] })).toBe('invalid household h1: size');
  expect(err({ items: [good], households: [{ ...fam, infants: 4 }] })).toBe('invalid household h1: infants');
});
it('h9 items are checked before households', () => {
  expect(err({ items: [{ ...good, unit: 'lb' }], households: [{ ...fam, size: 0 }] })).toBe('invalid item a: unit');
});
