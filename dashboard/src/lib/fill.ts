/**
 * Fill the `{key}` placeholders of a translated string: `fill(t('x.y'), { name, n: String(n) })`.
 *
 * A value goes in LITERALLY and in ONE pass. `String.replace('{name}', value)` reads `$&`,
 * `` $` ``, `$'` and `$$` in the value as patterns, so a task named "Fix $' rounding" or an
 * actor "Save $$" was drawn wrong; and a value holding `{other}` was filled again by the next
 * `.replace` in the chain. Every placeholder of a key is filled; one with no value stays as is.
 */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match);
}
