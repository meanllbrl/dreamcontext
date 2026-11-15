/**
 * Control, hidden and direction-changing characters: the ONE set every "what is shown is what
 * runs" check refuses (the Telegram Allow cards, a routine's condition script). Built from a
 * string so the file holds only escapes, never the raw characters. TAB (U+0009) and LF (U+000A)
 * are not in it: a script needs them and a reader sees them.
 */
export const HIDDEN_CHARS = '\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2069\\ufeff';
const HIDDEN_ONE = new RegExp(`[${HIDDEN_CHARS}]`);
const HIDDEN_ALL = new RegExp(`[${HIDDEN_CHARS}]`, 'g');

/** True when `text` holds any character of {@link HIDDEN_CHARS}. */
export function hasHiddenChars(text: string): boolean {
  return HIDDEN_ONE.test(text);
}

/** `text` with every hidden or direction-changing character drawn as a visible `\u{…}` escape. */
export function showHiddenChars(text: string): string {
  return text.replace(HIDDEN_ALL, (c) => `\\u{${c.codePointAt(0)!.toString(16).padStart(4, '0')}}`);
}
