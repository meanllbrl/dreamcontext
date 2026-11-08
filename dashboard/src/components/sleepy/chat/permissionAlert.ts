/**
 * The text of an app frame's Allow alert (plan r9, D10): what runs, in full, measured after it is
 * cleaned, so a command cannot hide behind bidi marks, zero-width characters or a wall of spaces.
 */

export const ALLOW_TEXT_MAX = 600;

/** Bidi, zero-width and control characters, as `BAD_CHARS` on the server. */
const BAD_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff\\u2028\\u2029]', 'g');

export function cleanAlertText(text: string): string {
  return text.replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** May the frame offer Allow for this? A line break would read as a comment in a one-line alert. */
export function allowOffered(toolName: string, input: unknown): boolean {
  const text = allowAlertText(toolName, input);
  return cleanAlertText(text).length <= ALLOW_TEXT_MAX && !(toolName === 'Bash' && /[\r\n]|\u2028|\u2029/.test(text));
}

/** Per tool: Bash the command, Edit and Write the path and size, MCP server and tool and args. */
export function allowAlertText(toolName: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const args = (() => { try { return JSON.stringify(input) ?? ''; } catch { return String(input); } })();
  if (toolName === 'Bash' && typeof o.command === 'string') return o.command;
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') && typeof o.file_path === 'string') {
    const size = [o.content, o.new_string].filter((v): v is string => typeof v === 'string').reduce((n, v) => n + v.length, 0);
    return `${toolName} ${o.file_path} (${size} characters)`;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `MCP ${mcp[1]} / ${mcp[2]} ${args}`;
  return `${toolName} ${args}`;
}
