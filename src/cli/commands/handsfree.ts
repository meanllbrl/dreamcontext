import { Command } from 'commander';
import { registerHandsfreeMacCommand } from './handsfree-mac.js';

/**
 * `dreamcontext handsfree …` — hands-free mode from the terminal. Hands-free is Mac mode: the
 * work stays on this laptop and the phone reaches it through a tunnel link
 * (`dreamcontext handsfree mac …`, src/cli/commands/handsfree-mac.ts).
 */
export function registerHandsfreeCommand(program: Command): void {
  const hf = program
    .command('handsfree')
    .description('Hands-free mode: drive this laptop\'s sessions from your phone (Mac mode)');

  registerHandsfreeMacCommand(hf);
}
