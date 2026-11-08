/**
 * Resolves design tokens from `dashboard/src/styles/tokens.css` WITHOUT a browser, for the
 * Telegram picture builders (`src/lib/telegram/kit-tokens.ts`, written by
 * `scripts/gen-telegram-kits.ts`). The server has no DOM to call `getComputedStyle` on, so
 * the values a Mac frame would inline into its `:root` are worked out here: the `:root`
 * block is the light theme, the `[data-theme='dark']` block overrides it for dark, and every
 * `var(--x, fallback)` is substituted the way a browser substitutes a custom property's
 * computed value (text in, text out; `calc()` stays as written).
 *
 * Imported by the generator AND by `tests/unit/telegram-kits.test.ts`, which re-resolves
 * and compares, so a token change in tokens.css fails the test until the mirror is regenerated.
 */

/** Custom-property declarations of one top-level rule block, in source order. */
function declarationsOf(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  return out;
}

/** The text between the `{` after `selectorStart` and its matching `}`. */
function blockAfter(css: string, selectorStart: string): string {
  const at = css.indexOf(selectorStart);
  if (at < 0) throw new Error(`tokens.css: no block starting "${selectorStart}"`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`tokens.css: unterminated block "${selectorStart}"`);
}

/** Substitutes every `var(--name[, fallback])` in `value`, recursively. */
function substitute(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 20) throw new Error(`tokens.css: var() cycle in "${value}"`);
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let j = at + 4;
    let level = 1;
    while (j < value.length && level > 0) {
      if (value[j] === '(') level++;
      else if (value[j] === ')') level--;
      j++;
    }
    const inner = value.slice(at + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    const raw = vars.get(name);
    const chosen = raw ?? fallback;
    if (chosen === null || chosen === undefined) throw new Error(`tokens.css: unresolved ${name}`);
    out += substitute(chosen, vars, depth + 1);
    i = j;
  }
  return out;
}

export type KitTheme = 'light' | 'dark';

/** The resolved value of each named token for one theme; a name with no value is omitted
 *  (as `resolveTokens` omits an empty `getPropertyValue`). */
export function resolveTokensFromCss(css: string, names: readonly string[], theme: KitTheme): Record<string, string> {
  const vars = declarationsOf(blockAfter(css, ':root {'));
  if (theme === 'dark') {
    for (const [k, v] of declarationsOf(blockAfter(css, "[data-theme='dark']"))) vars.set(k, v);
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    const raw = vars.get(name);
    if (raw === undefined) continue;
    out[name] = substitute(raw, vars);
  }
  return out;
}
