/**
 * Scaffold-template helpers shared by the create paths (`tasks create`, the dashboard's task
 * create and proposal accept, `features create`).
 */

/**
 * Fill a `{{TOKEN}}` the template quotes itself (`name: "{{NAME}}"`) with a valid YAML
 * double-quoted scalar: JSON's string escaping is valid YAML there, so a `"` or `\` in a task
 * name no longer ends the scalar early and corrupts the card. A plain or Turkish value
 * produces the same bytes as before (golden-pinned). Any unquoted use of the token (an
 * override body's heading) still gets the raw text.
 */
export function fillQuotedToken(template: string, token: string, value: string): string {
  return template.replaceAll(`"${token}"`, JSON.stringify(value)).replaceAll(token, value);
}
