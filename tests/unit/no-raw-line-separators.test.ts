/**
 * No raw LINE SEPARATOR (U+2028) or PARAGRAPH SEPARATOR (U+2029) in the TypeScript sources.
 *
 * Why: twice in one build a builder's raw separator landed in a regex literal (the write path
 * turns an escape typed in prose into the real character). The compiler reads either one as a
 * line terminator, so the literal is cut in two: the type-check fails and every test that imports
 * the file goes red, far from the cause, and a reviewer had to find it by eye. Written as
 * backslash-u escapes they are harmless; this test makes the raw form fail here, with its path
 * and line, at the wave check.
 *
 * Only these two: other invisible characters (bidi controls, zero-width ones) still parse, and
 * several sources hold them raw on purpose (the Telegram cleaning regexes, a zero-width space
 * inserted to defuse a forged header).
 *
 * The characters are built with String.fromCharCode, and no backslash-u sequence is spelled in
 * this file, so it never holds them raw itself.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const ROOTS = ['src', join('dashboard', 'src')];
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BS = String.fromCharCode(0x5c);
/** Generated or vendored trees are not ours to write in, and walking them costs seconds. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) out.push(...sourceFiles(join(dir, ent.name)));
    } else if (ent.isFile() && /\.tsx?$/.test(ent.name)) {
      out.push(join(dir, ent.name));
    }
  }
  return out;
}

/** Every line holding a raw separator, with which ones. Lines are counted on `\n` only, as an
 *  editor shows them: counting the separators themselves as breaks would point past the line. */
function separatorLines(text: string): Array<{ line: number; kinds: string[] }> {
  if (!text.includes(LS) && !text.includes(PS)) return [];
  const hits: Array<{ line: number; kinds: string[] }> = [];
  text.split('\n').forEach((line, i) => {
    const kinds = [line.includes(LS) ? 'U+2028' : '', line.includes(PS) ? 'U+2029' : ''].filter(Boolean);
    if (kinds.length) hits.push({ line: i + 1, kinds });
  });
  return hits;
}

function rawSeparators(file: string): string[] {
  return separatorLines(readFileSync(file, 'utf8')).map((h) => `${relative(REPO, file)}:${h.line} (${h.kinds.join(', ')})`);
}

describe('sources hold no raw U+2028 / U+2029', () => {
  it('finds the source trees it guards', () => {
    // A moved tree would make the scan below pass on nothing.
    for (const r of ROOTS) expect(sourceFiles(join(REPO, r)).length, r).toBeGreaterThan(0);
  });

  it('no .ts/.tsx file under src/ or dashboard/src/ contains one raw', () => {
    const hits = ROOTS.flatMap((r) => sourceFiles(join(REPO, r))).flatMap(rawSeparators);
    const how = `write them as the escapes ${BS}u2028 and ${BS}u2029 (a raw one ends the line for the compiler)`;
    expect(hits, `raw line/paragraph separators; ${how}:\n${hits.join('\n')}`).toEqual([]);
  });

  it('the detector itself sees a raw separator (self-check, no file written)', () => {
    // Guards the guard: a detector that never fires would keep the test above green forever.
    const sample = `const a = 1;\nconst re = /[${LS}]/;\nconst b = 2;\nconst re2 = /${PS}${LS}/;\n`;
    expect(separatorLines(sample)).toEqual([
      { line: 2, kinds: ['U+2028'] },
      { line: 4, kinds: ['U+2028', 'U+2029'] },
    ]);
    // The escaped spelling is the fix the failure message asks for: it must not fire.
    expect(separatorLines(`const re = /[${BS}u2028${BS}u2029]/;`)).toEqual([]);
    // Other invisible characters are out of scope (held raw on purpose elsewhere).
    expect(separatorLines(`const zw = '${String.fromCharCode(0x200b)}${String.fromCharCode(0x202e)}';`)).toEqual([]);
  });
});
