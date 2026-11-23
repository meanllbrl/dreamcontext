import { expect, it } from 'vitest';
import { expiryLabel } from '../src/labels.js';
import { run } from '../src/cli.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const T = '2026-05-04';
it('h10 no expiry', () => { expect(expiryLabel(null, T)).toBe('no expiry'); });
it('h10 today and tomorrow', () => {
  expect(expiryLabel('2026-05-04', T)).toBe('expires today');
  expect(expiryLabel('2026-05-05', T)).toBe('expires tomorrow');
});
it('h10 future days, across a month end', () => {
  expect(expiryLabel('2026-05-06', T)).toBe('expires in 2 days');
  expect(expiryLabel('2026-06-03', T)).toBe('expires in 30 days');
});
it('h10 past days', () => {
  expect(expiryLabel('2026-05-03', T)).toBe('expired yesterday');
  expect(expiryLabel('2026-05-01', T)).toBe('expired 3 days ago');
  expect(expiryLabel('2026-04-30', T)).toBe('expired 4 days ago');
});
it('h10 list shows the label as its fourth column', () => {
  const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json');
  writeFileSync(p, JSON.stringify({ households: [], items: [
    { id: 'a', name: 'Beans', category: 'canned', quantity: 4, unit: 'pcs', expiresOn: '2026-05-05', location: 'shelf-a' },
    { id: 's', name: 'Soap', category: 'hygiene', quantity: 2, unit: 'pcs', expiresOn: null, location: 'shelf-b' },
    { id: 'r', name: 'Rice', category: 'dry', quantity: 2, unit: 'kg', expiresOn: '2026-05-02', location: 'shelf-c' },
  ] }));
  expect(run(['list'], p, T)).toBe('a\tBeans\t4\texpires tomorrow\nr\tRice\t2 kg\texpired 2 days ago\ns\tSoap\t2\tno expiry');
});
