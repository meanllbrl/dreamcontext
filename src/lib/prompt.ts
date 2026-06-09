import { input } from '@inquirer/prompts';

/**
 * Prompt for a single line of input — but NEVER block in a non-interactive
 * context. Agent/CI invocations have no stdin TTY, where `@inquirer/prompts`
 * would either hang or force-close (`User force closed the prompt`). In that
 * case we return the provided default (or '') so callers fall through to their
 * own defaults/validation instead of deadlocking.
 */
export async function promptInput(opts: { message: string; default?: string }): Promise<string> {
  if (!process.stdin.isTTY) {
    return opts.default ?? '';
  }
  return input(opts);
}
