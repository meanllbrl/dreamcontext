import { describe, it, expect } from 'vitest';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Brand tokens only in the onboarding screens: no colour literal may appear anywhere under
 * dashboard/src/pages/onboarding/**. A hex value, an rgb()/hsl()/oklch() call or a named
 * colour in a declaration would ignore the theme (light/dark) and drift from the palette the
 * moment it changes. Colours come from `var(--…)` tokens in styles/tokens.css.
 *
 * Comments are stripped before matching so a file may still explain a rule in prose.
 */

const ROOT = join(__dirname, '..', '..', 'dashboard', 'src', 'pages', 'onboarding');

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const COLOUR_FN_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const NAMED_COLOURS = [
  'white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'yellow', 'orange', 'purple',
  'pink', 'magenta', 'cyan', 'violet', 'indigo', 'silver', 'navy', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'fuchsia',
];
/** A named colour as the value (or part of the value) of a colour-bearing CSS property. */
const NAMED_DECL_RE = new RegExp(
  `(?:^|[;{\\s])(?:color|background(?:-color)?|border(?:-[a-z]+)*(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color)\\s*:[^;{}]*\\b(?:${NAMED_COLOURS.join('|')})\\b`,
  'i',
);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every .css/.ts/.tsx file under `dir`, never following a symlink. */
function walk(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walk(path));
    else if (/\.(css|tsx?)$/.test(name)) out.push(path);
  }
  return out;
}

function colourLiterals(src: string, isCss: boolean): string[] {
  const hits: string[] = [];
  stripComments(src).split('\n').forEach((line, i) => {
    if (HEX_RE.test(line) || COLOUR_FN_RE.test(line) || (isCss && NAMED_DECL_RE.test(line))) {
      hits.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

describe('onboarding screens use brand tokens only', () => {
  const files = walk(ROOT);

  it('finds the onboarding files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('the detector catches every literal shape it bans, and spares tokens', () => {
    expect(colourLiterals('.a { color: #fff; }', true)).toHaveLength(1);
    expect(colourLiterals('.a { background: rgba(0, 0, 0, 0.1); }', true)).toHaveLength(1);
    expect(colourLiterals('.a { fill: hsl(142 71% 40%); }', true)).toHaveLength(1);
    expect(colourLiterals('.a { border: 1px solid white; }', true)).toHaveLength(1);
    expect(colourLiterals("const s = { color: '#7b68ee' };", false)).toHaveLength(1);
    expect(colourLiterals('.a { color: var(--color-text); background: transparent; }', true)).toEqual([]);
    expect(colourLiterals('/* #fff in a comment */ .a { color: currentColor; }', true)).toEqual([]);
  });

  for (const file of files) {
    it(`${relative(ROOT, file)} has no colour literal`, () => {
      expect(colourLiterals(readFileSync(file, 'utf-8'), file.endsWith('.css'))).toEqual([]);
    });
  }
});
