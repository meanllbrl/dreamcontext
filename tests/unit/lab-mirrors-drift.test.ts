import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockCatalogMirror, BLOCK_TYPES } from '../../src/lib/lab/blocks.js';

/**
 * The dashboard cannot import `src/`, so the Lab board engine is mirrored:
 * `scripts/gen-lab-mirrors.mjs` writes the catalog JSON and BYTE-IDENTICAL
 * copies of the pure modules; `boardTypes.ts` hand-mirrors the board types.
 * Any drift fails here. Fix: `node scripts/gen-lab-mirrors.mjs` (or edit the
 * boardTypes.ts field to match the engine).
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('generated mirrors', () => {
  it('block-catalog.json equals the engine catalog', () => {
    const json = JSON.parse(read('dashboard/src/generated/block-catalog.json'));
    expect(json).toEqual(JSON.parse(JSON.stringify(blockCatalogMirror())));
  });

  for (const file of ['frameOps.ts', 'grid.ts']) {
    it(`dashboard/src/generated/${file} is byte-identical to src/lib/lab/${file}`, () => {
      expect(read(`dashboard/src/generated/${file}`)).toBe(read(`src/lib/lab/${file}`));
    });

    it(`src/lib/lab/${file} stays self-contained (no imports, so the copy compiles in the dashboard)`, () => {
      expect(read(`src/lib/lab/${file}`)).not.toMatch(/^\s*import\s/m);
      expect(read(`src/lib/lab/${file}`)).not.toMatch(/\brequire\(/);
    });
  }
});

/** `name` / `name?` of every top-level field of `export interface <name>`, plus its extends clause. */
function interfaceShape(source: string, name: string): { extends: string | null; fields: string[] } {
  const head = new RegExp(`export interface ${name}(?:\\s+extends\\s+([\\w, ]+))?\\s*\\{`).exec(source);
  if (!head) throw new Error(`interface ${name} not found`);
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  const body = source.slice(start, i - 1);
  const fields: string[] = [];
  let level = 0;
  for (const line of body.split('\n')) {
    if (level === 0) {
      const m = /^\s*(?:readonly\s+)?(\w+)(\?)?\s*:/.exec(line);
      if (m) fields.push(`${m[1]}${m[2] ?? ''}`);
    }
    for (const ch of line) {
      if (ch === '{') level++;
      else if (ch === '}') level--;
    }
  }
  return { extends: head[1]?.trim() ?? null, fields: fields.sort() };
}

describe('boardTypes.ts mirrors the engine types', () => {
  const dash = read('dashboard/src/components/lab/board/boardTypes.ts');
  const boards = read('src/lib/lab/boards.ts');
  const library = read('src/lib/lab/block-library.ts');
  const blocks = read('src/lib/lab/blocks.ts');

  const pairs: Array<[string, string]> = [
    ['BlockTab', boards],
    ['Block', boards],
    ['Card', boards],
    ['BoardSpec', boards],
    ['BoardError', boards],
    ['BoardDiagnostic', boards],
    ['Board', boards],
    ['BoardResponse', boards],
    ['BoardListResponse', boards],
    ['LibraryBlockInput', library],
    ['LibraryBlock', library],
    ['LocalizedText', blocks],
    ['BlockOptionSchema', blocks],
    ['BlockCatalogEntry', blocks],
  ];
  for (const [name, engine] of pairs) {
    it(`${name} has the same fields`, () => {
      expect(interfaceShape(dash, name)).toEqual(interfaceShape(engine, name));
    });
  }

  it('BlockType lists exactly the catalog types', () => {
    const m = /export type BlockType =([^;]+);/.exec(dash);
    const types = [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    expect(types).toEqual([...BLOCK_TYPES]);
  });

  it('BlockOptionSchema.type lists exactly the engine option types', () => {
    const union = (src: string, re: RegExp) => [...re.exec(src)![1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
    expect(union(dash, /type: ('boolean'[^;]+);/)).toEqual(union(blocks, /export type BlockOptionType =([^;]+);/));
  });

  it('frames and grid come from the generated copies, never a hand mirror', () => {
    expect(dash).toContain("from '../../../generated/frameOps'");
    expect(dash).toContain("from '../../../generated/grid'");
    expect(dash).not.toMatch(/export interface (TableFrame|SeriesFrame|GridRect)\b/);
  });
});
