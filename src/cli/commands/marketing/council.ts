/**
 * mk council "<topic>" — wrapper that creates a `dreamcontext council` debate
 * pre-populated with the 4 marketing personas bundled at
 * `skill-packs/meta-marketing/council-personas/*.md`.
 *
 * Per architect MUST-CHANGE 6: personas live as DATA FILES; this is NOT a
 * `--preset` flag on the upstream `dreamcontext council` command.
 */
import { Command } from 'commander';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { error, info, success, header } from '../../../lib/format.js';
import {
  findPersonasDir,
  loadAllPersonas,
  selectPersonas,
  type MarketingPersona,
} from '../../../lib/marketing/council-personas.js';

/**
 * Resolve the dreamcontext entry script that's currently running.
 * Used to re-invoke the same CLI binary for the `council create` /
 * `council agent create` sub-commands.
 *
 * Falls back to "dreamcontext" on PATH if argv[1] cannot be resolved.
 */
function resolveDreamcontextEntry(): { node: string; script: string | null } {
  // process.argv[0] is node, argv[1] is the script tsup produced.
  const node = process.argv[0];
  const script = process.argv[1];
  if (script && existsSync(script)) {
    return { node, script };
  }
  return { node, script: null };
}

function invokeCouncil(args: string[], input?: string): { stdout: string; status: number } {
  const { node, script } = resolveDreamcontextEntry();
  const cmd = script ? node : 'dreamcontext';
  const argv = script ? [script, ...args] : args;
  const result = spawnSync(cmd, argv, {
    input: input ?? '',
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: (result.stdout ?? '') + (result.stderr ?? ''),
    status: typeof result.status === 'number' ? result.status : 1,
  };
}

/**
 * Extract the debate ID printed on the final line by `dreamcontext council create`.
 * That command prints the ID alone on its last line for scripting.
 */
export function extractDebateIdFromCreateOutput(stdout: string): string | null {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (/^council_[A-Za-z0-9]+$/.test(line)) return line;
  }
  return null;
}

export function registerMarketingCouncil(parent: Command): void {
  parent
    .command('council')
    .argument('<topic...>', 'Debate topic / question (quote it)')
    .option('-r, --rounds <n>', 'Number of rounds', '2')
    .option(
      '-p, --persona <slugs>',
      'Comma-separated subset of persona slugs (default: all bundled).',
      '',
    )
    .option('--interrupt', 'Pause between rounds', false)
    .option('--no-interrupt', 'Do not pause between rounds')
    .description('Run a marketing council debate using the 4 bundled marketing personas.')
    .action(async (
      topicParts: string[],
      opts: { rounds: string; persona: string; interrupt: boolean },
    ) => {
      console.log(header('Marketing council'));
      const topic = topicParts.join(' ').trim();
      if (!topic) {
        error('Topic is required.');
        process.exit(1);
      }

      const rounds = Number(opts.rounds);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
        error('--rounds must be an integer between 1 and 10.');
        process.exit(1);
      }

      // 1. Locate + load personas.
      const personasDir = findPersonasDir();
      if (!personasDir) {
        error('Marketing council personas not found.', 'Try reinstalling dreamcontext (skill-packs missing from dist).');
        process.exit(1);
      }
      let all: MarketingPersona[];
      try {
        all = loadAllPersonas(personasDir);
      } catch (e) {
        error(`Persona load failed: ${(e as Error).message}`);
        process.exit(1);
      }
      if (all.length === 0) {
        error(`No persona files found under ${personasDir}.`);
        process.exit(1);
      }

      const requested = opts.persona
        ? opts.persona.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      let chosen: MarketingPersona[];
      try {
        chosen = selectPersonas(all, requested);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }

      info(`Personas: ${chosen.map((p) => p.slug).join(', ')}`);

      // 2. Create the debate.
      const createArgs = ['council', 'create', topic, '--rounds', String(rounds)];
      if (opts.interrupt) createArgs.push('--interrupt');
      else createArgs.push('--no-interrupt');

      const created = invokeCouncil(createArgs);
      if (created.status !== 0) {
        process.stderr.write(created.stdout);
        error('Failed to create debate.');
        process.exit(created.status || 1);
      }
      const debateId = extractDebateIdFromCreateOutput(created.stdout);
      if (!debateId) {
        process.stderr.write(created.stdout);
        error('Could not parse debate ID from `council create` output.');
        process.exit(1);
      }
      success(`Debate created: ${debateId}`);

      // 3. Register each persona via stdin.
      for (const persona of chosen) {
        const aspectsArg = persona.aspects.length > 0 ? persona.aspects.join(',') : '';
        const args = ['council', 'agent', 'create', debateId, persona.slug, '-m', persona.model];
        if (aspectsArg) args.push('-a', aspectsArg);
        const r = invokeCouncil(args, persona.body);
        if (r.status !== 0) {
          process.stderr.write(r.stdout);
          error(`Failed to register persona ${persona.slug}.`);
          process.exit(r.status || 1);
        }
        info(`  ${chalk.green('+')} ${persona.slug} (${persona.model})`);
      }

      console.log();
      success(`Marketing council debate ready: ${chalk.bold(debateId)}`);
      console.log(chalk.dim(`  topic:    ${topic}`));
      console.log(chalk.dim(`  rounds:   ${rounds}`));
      console.log(chalk.dim(`  personas: ${chosen.map((p) => p.slug).join(', ')}`));
      console.log();
      console.log(chalk.dim('Next: run round 1 with `dreamcontext council round start ' + debateId + ' 1`'));
      console.log(chalk.dim('Or dispatch the debate via your agent runner.'));
    });
}
