/**
 * `common.*` is the dashboard's shared copy (Loading, Close, Cancel…): any surface may reach
 * for it, including the Turkish-first ones. TR_PARTIAL falls back to ENGLISH for a missing key,
 * so a `common.*` key without Turkish never shows as broken, it just puts "Cancel" on a Turkish
 * dialog (the Mac panel's "Sign all out" confirmation did). Every `common.*` key the source
 * names must therefore exist in both dictionaries, and the two sets must match.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'dashboard', 'src');
const I18N_PATH = join(SRC, 'context', 'I18nContext.tsx');
const I18N = readFileSync(I18N_PATH, 'utf-8');
const TR_AT = I18N.indexOf('const TR_PARTIAL');
const TR_END = I18N.indexOf('const PARTIALS', TR_AT);

const commonKeys = (block: string) => new Set([...block.matchAll(/^\s*'(common\.[\w.-]+)':/gm)].map((m) => m[1]));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && p !== I18N_PATH) out.push(p);
  }
  return out;
}

describe('the shared common.* copy speaks English and Turkish', () => {
  const en = commonKeys(I18N.slice(0, TR_AT));
  const tr = commonKeys(I18N.slice(TR_AT, TR_END));
  const used = new Map<string, string>();
  const dynamic: string[] = [];
  for (const f of sourceFiles(SRC)) {
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/['"`](common\.[A-Za-z][\w.-]*)['"`]/g)) if (!used.has(m[1])) used.set(m[1], f);
    if (/`common\.\$\{/.test(src)) dynamic.push(f);
  }

  it('finds the dictionaries and the call sites it checks', () => {
    expect(TR_AT).toBeGreaterThan(0);
    expect(TR_END).toBeGreaterThan(TR_AT);
    expect(used.has('common.cancel')).toBe(true);
    // A built key would slip past the sweep below.
    expect(dynamic).toEqual([]);
  });

  it('every common.* key the dashboard names has English and Turkish', () => {
    for (const [key, file] of used) {
      expect(en.has(key), `${key} (en) used in ${file}`).toBe(true);
      expect(tr.has(key), `${key} (tr) used in ${file}`).toBe(true);
    }
  });

  it('English and Turkish hold the same common.* keys', () => {
    expect([...tr].sort()).toEqual([...en].sort());
  });

  it('the Mac panel cancel reads Vazgeç in Turkish', () => {
    expect(I18N.slice(TR_AT, TR_END)).toContain("'common.cancel': 'Vazgeç'");
  });
});
