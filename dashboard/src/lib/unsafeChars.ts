/**
 * What a run card may offer ▶ Run for (sahip-karti-yerinde K4 "what is shown is what runs", K7).
 *
 * MIRROR of src/server/telegram/runs.ts `UNSAFE_CHARS` and its 8-space rule (`commandShowable`):
 * the dashboard cannot import server code, so the pattern is copied here and
 * tests/dashboard/owner-card-unsafe-chars.test.ts reads that file by path and fails on drift.
 *
 * A command holding one of these characters (C0/C1 controls, bidi overrides, zero-width marks and
 * their kin) or a run of 8 or more spaces can show the owner something other than what runs. Such a
 * command is drawn with each of those characters as a visible escape and gets NO Run, on every
 * host (the Super-chat slot, the bar, the child's own chat). The bar also refuses a command it
 * cannot draw whole (`BAR_COMMAND_MAX`): it offers Show instead, which opens the slot.
 */

// eslint-disable-next-line no-control-regex
export const UNSAFE_CHARS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff\u2028\u2029\u3164\u00ad]/;
/** The server's 8-space rule (`/ {8,}/` in `commandShowable`). */
export const SPACE_RUN = / {8,}/;

/** The longest command the bar row draws whole (a longer one gets Show, never ▶ Run). */
export const BAR_COMMAND_MAX = 120;

/** True when the command may not be offered a Run anywhere. */
export function commandUnsafe(command: string): boolean {
  return UNSAFE_CHARS.test(command) || SPACE_RUN.test(command);
}

/** The bar may offer ▶ Run: safe, and short enough to be drawn whole on the row. */
export function barCanRun(command: string): boolean {
  return !commandUnsafe(command) && command.length <= BAR_COMMAND_MAX;
}

const UNSAFE_GLOBAL = new RegExp(UNSAFE_CHARS.source, 'g');

/**
 * The command as it is drawn when it is unsafe: every unsafe character as `\u{hex}`, every run of
 * 8 or more spaces as `\u{20}×N`. A safe command comes back unchanged.
 */
export function escapeUnsafe(command: string): string {
  return command
    .replace(UNSAFE_GLOBAL, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`)
    .replace(/ {8,}/g, (run) => `\\u{20}×${run.length}`);
}
