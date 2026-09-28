import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The quest party's colour tokens (tokens.css): three role hue families and two status inks.
 *
 * The hues are STATIC chrome, the same contract as the nav section hues: an alias of a chart
 * hue, never a colour that already speaks for a state. The ★★★ rule (colour = mood, movement =
 * mode) holds only while the hue a character wears can never be mistaken for the accent
 * (active), chart-7 (the asking magenta), a Sleepy mood, warning, success or error. The inks
 * are per-theme values (a dark ink may be lighter than its base), measured for text contrast;
 * the ratios live in the comment next to them.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const TOKENS = join(ROOT, 'dashboard/src/styles/tokens.css');

/** The declarations inside one CSS block, keyed by custom-property name. */
function blockVars(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  expect(at, `${selector} not found in tokens.css`).toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) out[m[1]] = m[2].trim();
  return out;
}

const BLOCKS = [':root {', "[data-theme='dark']"];
const HUES: Record<string, string> = {
  '--role-hue-maker': 'var(--chart-2)',
  '--role-hue-judge': 'var(--chart-8)',
  '--role-hue-neutral': 'var(--chart-6)',
};
const INKS = ['--color-success-ink', '--color-error-ink'];

describe('quest party tokens', () => {
  it('declares all five tokens in BOTH theme blocks', () => {
    const css = readFileSync(TOKENS, 'utf-8');
    for (const block of BLOCKS) {
      const vars = blockVars(css, block);
      for (const name of [...Object.keys(HUES), ...INKS]) {
        expect(vars[name], `${name} missing from ${block}`).toBeDefined();
      }
    }
  });

  it('each hue is exactly its chart alias', () => {
    const css = readFileSync(TOKENS, 'utf-8');
    for (const block of BLOCKS) {
      const vars = blockVars(css, block);
      for (const [name, value] of Object.entries(HUES)) {
        expect(vars[name], `${name} in ${block}`).toBe(value);
      }
    }
  });

  it('no hue aliases a colour that already carries a state', () => {
    const css = readFileSync(TOKENS, 'utf-8');
    const banned = /--chart-7|--chart-1\b|--mood-|accent|warning|success|error|caution/;
    for (const block of BLOCKS) {
      const vars = blockVars(css, block);
      for (const name of Object.keys(HUES)) {
        expect(vars[name], `${name} in ${block} aliases a state colour`).not.toMatch(banned);
      }
    }
  });

  it('the inks are real per-theme hsl() values, not aliases of the base swatch', () => {
    const css = readFileSync(TOKENS, 'utf-8');
    for (const block of BLOCKS) {
      const vars = blockVars(css, block);
      for (const name of INKS) {
        expect(vars[name], `${name} in ${block}`).toMatch(/^hsl\(/);
      }
    }
  });
});
