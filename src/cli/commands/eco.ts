import { Command } from 'commander';
import { ecoModeDefault, ecoPlusDefault, ecoPlusInEffect } from '../../lib/context-watch.js';
import { lowerModel } from '../../lib/eco-plus.js';

/** The roles `eco model` answers for, and the model each runs on with Eco Plus off. */
const ROLE_MODELS: Readonly<Record<string, string>> = { builder: 'opus' };

/**
 * `dreamcontext eco`: this Mac's Tasarruf modu (Kapalı · Eco · Eco Plus, plan eco-plus D1).
 * `eco model builder` prints the model a goal-skill run's builders use, resolved ONCE per run
 * (D8): `sonnet` under Eco Plus, `opus` otherwise.
 */
export function registerEcoCommand(program: Command): void {
  const eco = program
    .command('eco')
    .description("This Mac's saving mode (Kapalı · Eco · Eco Plus) and the models it picks");

  eco
    .command('status')
    .description('Print the saving mode: off, eco or plus')
    .action(() => {
      console.log(!ecoModeDefault() ? 'off' : ecoPlusDefault() ? 'plus' : 'eco');
    });

  eco
    .command('model')
    .description('Print the model a role runs on under the current saving mode (role: builder)')
    .argument('<role>', 'builder')
    .action((role: string) => {
      const base = Object.hasOwn(ROLE_MODELS, role) ? ROLE_MODELS[role] : undefined;
      if (!base) {
        console.error(`Unknown role "${role}": use builder.`);
        process.exitCode = 1;
        return;
      }
      // Inside an escalated (kept-heavy) tree the builders stay on the base model.
      console.log(ecoPlusInEffect() ? lowerModel(base) : base);
    });
}
