/**
 * Scaffold-template helpers shared by the create paths (`tasks create`, the dashboard's task
 * create and proposal accept, `features create`).
 *
 * Two rules, both learned the hard way:
 *  - A value the template quotes itself (`name: "{{NAME}}"`) goes in as a JSON string, which is
 *    a valid YAML double-quoted scalar: a `"` or `\` in a task name no longer ends the scalar
 *    early and corrupts the card. A plain or Turkish value produces the same bytes as before
 *    (golden-pinned).
 *  - Values go in LITERALLY and in ONE pass: a replacement string would expand `$&`, `$'`,
 *    `` $` `` and `$$` (a name like "Fix $' rounding" pasted the rest of the template into the
 *    card), and a sequential fill would expand a `{{TOKEN}}` that sits inside a value already
 *    inserted.
 */

const TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;

/**
 * Fill every `{{KEY}}` with `values[KEY]` in one pass. A key listed in `quoted` that the
 * template wraps in double quotes is escaped as a JSON string's body (the template's quotes
 * stay its own, so `"{{A}}""{{B}}"` fills both). A token with no value is left as it is.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>, quoted: readonly string[] = []): string {
  return template.replace(TOKEN_RE, (match: string, key: string, offset: number) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    const value = values[key];
    const inQuotes = template[offset - 1] === '"' && template[offset + match.length] === '"';
    return inQuotes && quoted.includes(key) ? JSON.stringify(value).slice(1, -1) : value;
  });
}

/** Fill one token the way {@link fillTemplate} fills a quoted key. */
export function fillQuotedToken(template: string, token: string, value: string): string {
  const key = token.replace(/^\{\{|\}\}$/g, '');
  return fillTemplate(template, { [key]: value }, [key]);
}
