import { expect, it } from 'vitest';
import { toCsv } from '../src/export.js';
import { run } from '../src/cli.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const base = { category: 'canned' as const, quantity: 2, unit: 'pcs' as const, location: 'shelf-a' };
it('h2 header and empty input', () => { expect(toCsv([])).toBe('id,name,category,quantity,unit,expiresOn,location\n'); });
it('h2 rows sorted by name, null expiry empty', () => {
  const out = toCsv([{ ...base, id: 'b', name: 'Rice', expiresOn: null }, { ...base, id: 'a', name: 'Beans', expiresOn: '2026-06-01' }]);
  expect(out).toBe('id,name,category,quantity,unit,expiresOn,location\na,Beans,canned,2,pcs,2026-06-01,shelf-a\nb,Rice,canned,2,pcs,,shelf-a\n');
});
it('h2 quotes commas, quotes and newlines', () => {
  const out = toCsv([{ ...base, id: 'c', name: 'Beans, "large"', expiresOn: null, location: 'shelf\nb' }]);
  expect(out.split('\n').slice(1).join('\n')).toBe('c,"Beans, ""large""",canned,2,pcs,,"shelf\nb"\n');
});
it('h2 cli export', () => {
  const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json');
  writeFileSync(p, JSON.stringify({ items: [{ ...base, id: 'a', name: 'Beans', expiresOn: null }], households: [] }));
  expect(run(['export'], p, '2026-05-04')).toContain('a,Beans,canned,2,pcs,,shelf-a');
});
