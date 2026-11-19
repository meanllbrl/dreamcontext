/**
 * The fixed opening of an automation's fire prompt ({@link buildPreamble} in runner.ts), in its own
 * tiny module so the prompt hook can recognise a fire without importing the runner.
 *
 * A fire prompt is written by the runner, not typed by the owner: the same preamble and job text on
 * every fire. The prompt hook runs no judged recall on it (and no peers): measured on one Mac's last
 * 24 h, a fire's prompt hook took 14-20 s (one 120 s) for one Haiku judge call on the same text each
 * night. An owner's reply in the automation's thread does not open this way and is recalled as usual.
 */
export const AUTOMATION_FIRE_PREFIX = 'You are scheduled dreamcontext automation "';

/** True when `prompt` is an automation fire prompt (leading whitespace ignored). */
export function isAutomationFirePrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(AUTOMATION_FIRE_PREFIX);
}
