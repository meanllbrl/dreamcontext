import { expect, it } from 'vitest';
import { Inventory } from '../src/inventory.js';
import { buildParcel } from '../src/parcels.js';
import { load, save } from '../src/store.js';
import { run } from '../src/cli.js';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const can = (id: string, q: number) => ({ id, name: id, category: 'canned' as const, quantity: q, unit: 'pcs' as const, expiresOn: '2026-08-01', location: 's' });
const NOW = '2026-05-04T10:00:00.000Z';
it('h4 reserve lowers available, release returns it', () => {
  const inv = new Inventory([can('b', 10)]);
  inv.reserve('h1', 'b', 4, NOW);
  expect(inv.available('b')).toBe(6);
  expect(inv.get('b')?.quantity).toBe(10);
  expect(inv.release('h1', 'b')).toBe(4);
  expect(inv.release('h1', 'b')).toBe(0);
  expect(inv.available('b')).toBe(10);
});
it('h4 reserve throws past availability and for unknown items', () => {
  const inv = new Inventory([can('b', 5)]);
  inv.reserve('h1', 'b', 3, NOW);
  expect(() => inv.reserve('h2', 'b', 3, NOW)).toThrow();
  expect(() => inv.reserve('h2', 'zz', 1, NOW)).toThrow();
  expect(inv.available('zz')).toBe(0);
});
it('h4 same household adds up', () => {
  const inv = new Inventory([can('b', 9)]);
  inv.reserve('h1', 'b', 2, NOW); inv.reserve('h1', 'b', 3, '2026-05-05T10:00:00.000Z');
  expect(inv.reservations()).toHaveLength(1);
  expect(inv.reservations()[0]).toMatchObject({ quantity: 5, at: '2026-05-05T10:00:00.000Z' });
});
it('h4 expire after 48h', () => {
  const inv = new Inventory([can('b', 9), can('c', 9)], [
    { householdId: 'h1', itemId: 'b', quantity: 2, at: '2026-05-01T09:00:00.000Z' },
    { householdId: 'h1', itemId: 'c', quantity: 2, at: '2026-05-03T12:00:00.000Z' },
  ]);
  expect(inv.expireReservations(NOW)).toBe(1);
  expect(inv.available('b')).toBe(9);
  expect(inv.available('c')).toBe(7);
});
it('h4 lowStock and parcels respect reservations', () => {
  const inv = new Inventory([can('b', 6)]);
  inv.reserve('h9', 'b', 4, NOW);
  expect(inv.lowStock(2).map((i) => i.id)).toEqual(['b']);
  const p = buildParcel({ id: 'h1', name: 'Oak', size: 3, infants: 0 }, inv, '2026-05-04');
  expect(p.lines.reduce((s, l) => s + l.quantity, 0)).toBe(2);
  expect(inv.get('b')?.quantity).toBe(4);
  expect(inv.available('b')).toBe(0);
});
it('h4 store round-trips reservations', () => {
  const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json');
  writeFileSync(p, JSON.stringify({ items: [], households: [] }));
  expect(load(p).reservations).toEqual([]);
  const r = [{ householdId: 'h', itemId: 'b', quantity: 1, at: NOW }];
  save(p, { items: [can('b', 3)], households: [], reservations: r });
  expect(load(p).reservations).toEqual(r);
});
it('h4 cli reserve and release persist', () => {
  const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json');
  writeFileSync(p, JSON.stringify({ items: [can('b', 8)], households: [{ id: 'h1', name: 'Oak', size: 2, infants: 0 }] }));
  expect(typeof run(['reserve', 'h1', 'b', '3'], p, '2026-05-04')).toBe('string');
  expect(JSON.parse(readFileSync(p, 'utf-8')).reservations[0]).toMatchObject({ householdId: 'h1', itemId: 'b', quantity: 3 });
  run(['release', 'h1', 'b'], p, '2026-05-04');
  expect(JSON.parse(readFileSync(p, 'utf-8')).reservations ?? []).toEqual([]);
});
