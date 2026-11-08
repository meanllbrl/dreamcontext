import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Brain Search's glows and the phone sidebar's shadow and scrim come from tokens, the way the
 * rest of the dashboard does them: a shadow token, or `color-mix(in oklch, var(--…) N%,
 * transparent)` for a tint. A raw rgba(123, 104, 238, …) is the LIGHT theme's accent only, so
 * the dark theme glowed in the wrong violet. (The sidebar mascot's eye gradient is artwork.)
 */

const SRC = join(__dirname, '..', '..', 'dashboard', 'src');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const RAW = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('Brain Search uses tokens, not raw colours', () => {
  it('BrainSearch.css carries no colour literal', () => {
    const lines = strip(readFileSync(join(SRC, 'components', 'search', 'BrainSearch.css'), 'utf-8')).split('\n');
    expect(lines.map((l, i) => `${i + 1}: ${l.trim()}`).filter((l) => RAW.test(l))).toEqual([]);
  });

  it('the intelligence glow follows the theme accent', () => {
    const css = strip(readFileSync(join(SRC, 'components', 'search', 'BrainSearch.css'), 'utf-8'));
    expect(rule(css, '.bsearch-intel--on')).toContain('color-mix(in oklch, var(--color-accent) 60%, transparent)');
    expect(rule(css, '.bsearch-intel--on::after')).toContain('color-mix(in oklch, var(--color-accent) 16%, transparent)');
  });
});
