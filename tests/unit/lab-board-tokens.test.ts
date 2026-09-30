import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE INSIGHTS BOARD SPEAKS ONLY IN TOKENS, on the Automations Elevated precedent
 * (`agents-page-tokens.test.ts`): every colour, text size, weight, duration and curve in the
 * board's stylesheet comes from `tokens.css`, so light and dark render one layout, the type
 * ladder stays two sizes (12 / 14) and two weights (400 / 600).
 *
 * Refused in a declaration: a hex colour, `rgb()/rgba()/hsl()`, a numeric `font-size`, a
 * `font-weight` other than 400/600 (or their tokens), a non-zero time literal, `cubic-bezier(`,
 * and any font-size token off the 12/14 ladder. `LAB_BOARD_CSS_ROOT` points the scan at another
 * `dashboard/src` (a mutation proof).
 */

const ROOT = process.env.LAB_BOARD_CSS_ROOT ?? join(new URL('../../', import.meta.url).pathname, 'dashboard/src');

const FILES = [
  'components/lab/board/board.css',
  // The v1 board's surviving chrome (credentials banner, showcase stage, routed-page toast).
  'components/lab/board/lab-shell.css',
  // The inspector, add-card menu and save-to-library dialog.
  'components/lab/board/editors.css',
  // W2 chart and block stylesheets: bar/pie/heatmap (lane D), table, stat, change mark, data blocks (lane E).
  'components/lab/lab-bar-pie-heat.css',
  'components/lab/MetricTable.css',
  'components/lab/NumberCard.css',
  'components/lab/chartBody.css',
  'components/lab/blocks/dataBlocks.css',
  'components/lab/BreakdownPivot.css',
];

interface Decl { file: string; line: number; prop: string; value: string }

function declarations(file: string): Decl[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  // Blank comments out but keep their newlines, so line numbers stay true.
  const text = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Decl[] = [];
  const re = /(^|[;{\s])(-?[a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const prop = m[2];
    if (prop.startsWith('--')) continue; // a custom property is a local name, checked where used
    const line = text.slice(0, m.index + m[1].length).split('\n').length;
    out.push({ file, line, prop, value: m[3].trim() });
  }
  return out;
}

function offence({ prop, value }: Decl): string | null {
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

describe('Insights board stylesheet uses tokens only', () => {
  for (const file of FILES) {
    it(file, () => {
      expect(existsSync(join(ROOT, file)), `${file} is missing`).toBe(true);
      const bad = declarations(file)
        .map((d) => ({ d, why: offence(d) }))
        .filter((x) => x.why)
        .map(({ d, why }) => `${d.file}:${d.line} ${d.prop}: ${d.value}  (${why})`);
      expect(bad).toEqual([]);
    });
  }

  it('the scan itself sees declarations (a regex that matched nothing would pass vacuously)', () => {
    const decls = declarations(FILES[0]);
    expect(decls.length).toBeGreaterThan(50);
    expect(decls.some((d) => d.prop === 'font-size')).toBe(true);
  });

  it('the scan refuses what it claims to refuse', () => {
    for (const [prop, value] of [
      ['color', '#fff'], ['background', 'rgba(0, 0, 0, 0.1)'], ['font-size', '13px'],
      ['font-size', 'var(--font-size-base)'], ['font-weight', '500'], ['transition', 'opacity 150ms ease'],
    ] as const) {
      expect(offence({ file: 'x', line: 1, prop, value }), `${prop}: ${value}`).not.toBeNull();
    }
  });
});
