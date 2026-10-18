/**
 * Second-pass review, Minor 9: `t(key).replace('{name}', value)` read `$&`, `` $` ``, `$'` and
 * `$$` in the value as replacement patterns, so a task, tag, agent or actor name with a `$`
 * was drawn wrong. Every placeholder in the dashboard now goes through `fill` (lib/fill.ts),
 * which inserts values literally and in one pass.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fill } from '../../dashboard/src/lib/fill';

const ROOT = join(import.meta.dirname, '..', '..');

describe('fill', () => {
  it('inserts a value with $ patterns as typed', () => {
    expect(fill('Delete {name}?', { name: "Fix $' rounding, $` too, $& and $$ cash" })).toBe("Delete Fix $' rounding, $` too, $& and $$ cash?");
  });

  it('fills in one pass, every occurrence, and leaves a placeholder with no value', () => {
    expect(fill('{a} and {b}', { a: '{b}', b: 'B' })).toBe('{b} and B');
    expect(fill('{n} of {n}', { n: 3 })).toBe('3 of 3');
    expect(fill('{done}/{total}', { done: '1' })).toBe('1/{total}');
  });
});

describe('the dashboard fills placeholders only through fill', () => {
  it("no `.replace('{…}', …)` is left in dashboard/src", () => {
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-n', "\\.replace('{", '--', 'dashboard/src'], { cwd: ROOT, encoding: 'utf-8' });
    } catch (err) {
      // git grep exits 1 when nothing matches: that is the pass.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    expect(hits).toBe('');
  });
});

/**
 * Third pass: the rewrite to `fill` broke the build where a file already had its own `fill`. A
 * local one shadowed the import and called itself; `export { fill } from` re-exported without
 * a local binding, so the file's own calls threw; a second import of the same name; a function
 * passed where `fill` wants a value. None of those shapes may come back.
 */
describe('fill has one definition, bound wherever it is used', () => {
  const SRC = join(ROOT, 'dashboard', 'src');
  const LIB = join(SRC, 'lib', 'fill.ts');
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
      return /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }
  const files = walk(SRC).filter((p) => p !== LIB).map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf-8') }));
  /** Every `import { … } from '…'` clause that binds the name `fill` itself (not `fill as x`). */
  const fillImports = (src: string) => [...src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'[^']+'/gm)]
    .filter((m) => m[1].split(',').map((x) => x.trim()).includes('fill'));

  it('no local `const fill =` / `let fill =` / `function fill(` outside lib/fill.ts', () => {
    const offenders = files.filter((f) => /^\s*(export\s+)?(const|let|var)\s+fill\s*[=:]|^\s*(export\s+)?function\s+fill\s*\(/m.test(f.src)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('a re-export of fill comes with an import that binds it', () => {
    const fromForm = files.filter((f) => /^export\s*\{[^}]*\bfill\b[^}]*\}\s*from\s*'/m.test(f.src)).map((f) => f.rel);
    expect(fromForm, 'export { fill } from … binds nothing in the file').toEqual([]);
    const bare = files.filter((f) => /^export\s*\{[^}]*\bfill\b[^}]*\};?\s*$/m.test(f.src) && fillImports(f.src).length === 0).map((f) => f.rel);
    expect(bare, 'export { fill } with no import').toEqual([]);
  });

  it('a file imports fill at most once', () => {
    const dup = files.filter((f) => fillImports(f.src).length > 1).map((f) => f.rel);
    expect(dup).toEqual([]);
  });

  it('a fill value is a value, never a function', () => {
    const fnValue = files.flatMap((f) => f.src.split('\n').map((line, i) => ({ line, at: `${f.rel}:${i + 1}` })))
      .filter(({ line }) => /\bfill(Text)?\(.*\{[^{}]*:\s*(\(\s*\)|[A-Za-z_]\w*)\s*=>/.test(line))
      .map(({ at }) => at);
    expect(fnValue).toEqual([]);
  });
});
