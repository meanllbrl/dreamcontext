import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info, warn } from '../../../lib/format.js';
import { isBootstrapped } from '../../../lib/marketing/bootstrap.js';
import { loadHypothesisFile } from '../../../lib/marketing/hypothesis.js';
import { listCohorts, loadCohort, newCohortId, saveCohort, type Cohort } from '../../../lib/marketing/cohort.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { getActiveProfile } from './_ctx.js';

export function registerMarketingCohort(parent: Command): void {
  const cmd = parent
    .command('cohort')
    .description('Cohort lifecycle (plan, list, close).');

  cmd
    .command('create <name>')
    .description('Create a cohort. Rejects if hypothesis shape is invalid.')
    .requiredOption('--hypothesis-file <path>', 'JSON file with hypothesis (predicted_winner, predicted_metric, decision_threshold, kill_condition)')
    .option('--allow-custom-metric', 'Allow predicted_metric outside the known set', false)
    .option('--note <text>', 'Free-text note to attach to the cohort')
    .action(async (name: string, opts: {
      hypothesisFile: string;
      allowCustomMetric?: boolean;
      note?: string;
    }) => {
      console.log(header(`Cohort create — ${name}`));

      if (!isBootstrapped()) {
        error('Marketing not bootstrapped. Run `dreamcontext marketing init` first.');
        process.exit(1);
      }

      const result = loadHypothesisFile(opts.hypothesisFile, {
        allowCustomMetric: !!opts.allowCustomMetric,
      });
      if (!result.ok) {
        error('Hypothesis shape validation failed:');
        for (const err of result.errors) console.log(chalk.red(`  · ${err}`));
        console.log();
        info('Required fields: predicted_winner (string), predicted_metric (string), decision_threshold (number), kill_condition (number|string).');
        process.exit(1);
      }

      const profile = getActiveProfile() ?? 'default';
      const id = newCohortId();
      const now = new Date().toISOString();
      const cohort: Cohort = {
        id,
        profile,
        name,
        hypothesis: result.data.hypothesis,
        status: 'planning',
        started_at: now,
        closed_at: null,
        campaign_ids: [],
        ...(opts.note ? { note: opts.note } : (result.data.note ? { note: result.data.note } : {})),
        created_at: now,
        updated_at: now,
      };

      try {
        await withLock(async () => {
          const run = beginRun('cohort-create', {
            cohort_id: id,
            name,
            hypothesis: cohort.hypothesis,
          });
          try {
            saveCohort(cohort);
            run.succeed({ cohort_id: id });
          } catch (e) {
            run.fail((e as Error).message);
            throw e;
          }
        });
      } catch (e) {
        error(`Cohort create failed: ${(e as Error).message}`);
        process.exit(1);
      }

      success(`Cohort ${chalk.cyan(id)} created (status=planning)`);
      console.log(`  hypothesis: ${chalk.dim(JSON.stringify(cohort.hypothesis))}`);
      console.log();
      info('Next: dispatch the marketing-strategy agent to plan campaign topology.');
    });

  cmd
    .command('list')
    .description('List cohorts (newest first).')
    .option('--status <status>', 'Filter by status (planning|launched|monitoring|closed_won|closed_lost|killed)')
    .action((opts: { status?: string }) => {
      const cohorts = listCohorts();
      console.log(header('Cohorts'));
      if (cohorts.length === 0) {
        info('No cohorts yet. Create one with `dreamcontext marketing cohort create <name> --hypothesis-file <path>`.');
        return;
      }
      const filtered = opts.status ? cohorts.filter((c) => c.status === opts.status) : cohorts;
      if (filtered.length === 0) {
        warn(`No cohorts with status=${opts.status}.`);
        return;
      }
      for (const c of filtered) {
        const statusColor = statusChalk(c.status);
        console.log(`  ${chalk.cyan(c.id)}  ${statusColor(c.status.padEnd(11))}  ${c.name}`);
        console.log(`    ${chalk.dim(`${c.hypothesis.predicted_metric} ≥ ${c.hypothesis.decision_threshold} · ${c.campaign_ids.length} campaign(s) · started ${c.started_at.slice(0, 10)}`)}`);
      }
    });

  cmd
    .command('show <id>')
    .description('Show a single cohort.')
    .action((id: string) => {
      const cohort = loadCohort(id);
      if (!cohort) {
        error(`Cohort "${id}" not found.`);
        process.exit(1);
      }
      console.log(header(cohort.name));
      console.log(`  id:         ${chalk.cyan(cohort.id)}`);
      console.log(`  status:     ${statusChalk(cohort.status)(cohort.status)}`);
      console.log(`  profile:    ${cohort.profile}`);
      console.log(`  started:    ${cohort.started_at}`);
      console.log(`  campaigns:  ${cohort.campaign_ids.length === 0 ? chalk.dim('(none)') : cohort.campaign_ids.join(', ')}`);
      console.log();
      console.log(chalk.bold('Hypothesis'));
      console.log(`  predicted_winner:    ${cohort.hypothesis.predicted_winner}`);
      console.log(`  predicted_metric:    ${cohort.hypothesis.predicted_metric}`);
      console.log(`  decision_threshold:  ${cohort.hypothesis.decision_threshold}`);
      console.log(`  kill_condition:      ${cohort.hypothesis.kill_condition}`);
      if (cohort.note) {
        console.log();
        console.log(chalk.bold('Note'));
        console.log(`  ${cohort.note}`);
      }
    });
}

function statusChalk(status: string): (s: string) => string {
  switch (status) {
    case 'planning': return chalk.yellow;
    case 'launched':
    case 'monitoring': return chalk.cyan;
    case 'closed_won': return chalk.green;
    case 'closed_lost':
    case 'killed': return chalk.dim;
    default: return chalk.white;
  }
}
