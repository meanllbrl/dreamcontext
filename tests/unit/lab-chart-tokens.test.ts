import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE CHART FOUNDATION SPEAKS ONLY IN TOKENS, on the lab-board-tokens.test.ts precedent:
 * every colour, text size, weight and duration in dashboard/src/components/lab/chart/*.css
 * comes from tokens.css or from the `--viz-*` palette. The palette block is the ONE place a
 * hex may appear (it is the validated palette; lab-chart-palette.test.ts pins its values),
 * and only as the value of a `--viz-*` custom property.
 *
 * Refused in a declaration: a hex colour, `rgb()/rgba()/hsl()`, a numeric `font-size`, a
 * size off the 12/14 ladder, a weight other than 400/600, a non-zero time literal,
 * `cubic-bezier(`; and a hex in any custom property that is not `--viz-*`. Every .css file
 * under chart/ is scanned, so a new file is covered the day it lands. `LAB_CHART_CSS_ROOT`
 * points the scan at another `dashboard/src` (a mutation proof).
 */

const ROOT = process.env.LAB_CHART_CSS_ROOT ?? join(new URL('../../', import.meta.url).pathname, 'dashboard/src');
const DIR = 'components/lab/chart';

interface Decl { file: string; line: number; prop: string; value: string }

function declarations(file: string): Decl[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const text = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Decl[] = [];
  const re = /(^|[;{\s])(-?[a-z-][a-z0-9-]*)\s*:\s*([^;{}]+)(?=[;}])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const line = text.slice(0, m.index + m[1].length).split('\n').length;
    out.push({ file, line, prop: m[2], value: m[3].trim() });
  }
  return out;
}

function offence({ prop, value }: Decl): string | null {
  if (prop.startsWith('--')) {
    if (prop.startsWith('--viz-')) return null; // the validated palette
    return /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i.test(value) ? 'literal colour in a non-palette custom property' : null;
  }
  if (/#[0-9a-f]{3,8}\b/i.test(value)) return 'hex colour';
  if (/\b(rgba?|hsla?)\(/i.test(value)) return 'literal colour function';
  if (/cubic-bezier\(/i.test(value)) return 'literal curve';
  if (prop === 'font-size' && /^[\d.]/.test(value)) return 'numeric font-size';
  if (prop === 'font-size' && !/^(inherit|var\(--font-size-(xs|sm)\))$/.test(value)) return 'size off the 12/14 ladder';
  if (prop === 'font-weight' && !/^(400|600|inherit|var\(--font-weight-(normal|semibold)\))$/.test(value)) {
    return 'weight off the 400/600 ladder';
  }
  if (/^(transition|animation)/.test(prop)) {
    const times = value.match(/(?<![\w-])\d*\.?\d+m?s\b/g) ?? [];
    if (times.some((t) => parseFloat(t) !== 0)) return 'literal duration';
  }
  return null;
}

const FILES = existsSync(join(ROOT, DIR))
  ? readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.css')).map((f) => `${DIR}/${f}`)
  : [];

describe('chart foundation stylesheet uses tokens only', () => {
  it('finds the chart stylesheet', () => {
    expect(FILES).toContain(`${DIR}/chart.css`);
  });

  for (const file of FILES) {
    it(file, () => {
      const bad = declarations(file)
        .map((d) => ({ d, why: offence(d) }))
        .filter((x) => x.why)
        .map(({ d, why }) => `${d.file}:${d.line} ${d.prop}: ${d.value}  (${why})`);
      expect(bad).toEqual([]);
    });
  }

  it('the scan itself sees declarations (a regex that matched nothing would pass vacuously)', () => {
    const decls = declarations(`${DIR}/chart.css`);
    expect(decls.length).toBeGreaterThan(80);
    expect(decls.some((d) => d.prop === 'font-size')).toBe(true);
    expect(decls.some((d) => d.prop === '--viz-cat-1')).toBe(true);
  });

  it('the scan refuses what it claims to refuse', () => {
    for (const [prop, value] of [
      ['color', '#fff'], ['fill', 'rgba(0, 0, 0, 0.1)'], ['font-size', '13px'], ['font-size', 'var(--font-size-base)'],
      ['font-weight', '500'], ['transition', 'opacity 150ms ease'], ['--chart-local', '#123456'],
    ] as const) {
      expect(offence({ file: 'x', line: 1, prop, value }), `${prop}: ${value}`).not.toBeNull();
    }
    expect(offence({ file: 'x', line: 1, prop: '--viz-cat-1', value: '#7b68ee' })).toBeNull();
    expect(offence({ file: 'x', line: 1, prop: 'stroke', value: 'var(--viz-grid)' })).toBeNull();
  });
});
