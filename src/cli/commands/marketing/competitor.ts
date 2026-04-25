import { Command } from 'commander';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { success, error, info, warn, header } from '../../../lib/format.js';
import { MARKETING_PATHS } from '../../../lib/marketing/paths.js';
import {
  ingestCompetitor, health, IngestBusyError, type IngestSummary,
} from '../../../lib/marketing/competitors.js';
import { isBootstrapped } from '../../../lib/marketing/bootstrap.js';

export function registerMarketingCompetitor(parent: Command): void {
  const cmd = parent
    .command('competitor')
    .description('Ingest competitor IG / YouTube content (Reinfluence pipeline).');

  cmd
    .command('ingest <target>')
    .description('Ingest a single URL or an IG handle. Outputs land under _dream_context/marketing/competitors/<handle>/.')
    .option('--model <name>', 'Whisper model size (tiny|base|small|medium|large)', 'medium')
    .option('--max <n>', 'Max reels for IG handle ingest (0 = all)', '0')
    .option('--skip-transcripts', 'Skip Whisper transcription', false)
    .option('--skip-frames', 'Skip frame extraction', false)
    .option('--timeout <seconds>', 'Wall-clock kill', '600')
    .action(async (target: string, opts: {
      model?: string; max?: string; skipTranscripts?: boolean;
      skipFrames?: boolean; timeout?: string;
    }) => {
      console.log(header(`Competitor ingest — ${target}`));

      if (!isBootstrapped()) {
        error('Marketing not bootstrapped. Run `dreamcontext marketing init`.');
        process.exit(1);
      }

      const h = health();
      if (!h.ok) {
        error('Health check failed:');
        for (const c of h.checks) {
          if (!c.ok) console.log(`  ${chalk.red('✗')} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
        }
        for (const hint of h.installHints) console.log(chalk.dim(`  → ${hint}`));
        process.exit(1);
      }

      info(`whisper model: ${opts.model ?? 'medium'} · max: ${opts.max ?? '0'} · timeout: ${opts.timeout ?? '600'}s`);

      let summary: IngestSummary;
      try {
        summary = await ingestCompetitor({
          target,
          model: opts.model ?? 'medium',
          max: Number.parseInt(opts.max ?? '0', 10),
          skipTranscripts: !!opts.skipTranscripts,
          skipFrames: !!opts.skipFrames,
          timeoutMs: Number.parseInt(opts.timeout ?? '600', 10) * 1000,
        });
      } catch (e) {
        if (e instanceof IngestBusyError) {
          error('Another ingest is already running in this process.');
          process.exit(1);
        }
        error(`Ingest failed: ${(e as Error).message}`);
        process.exit(1);
      }

      console.log();
      success(`${summary.postsIngested} post(s) ingested · run ${chalk.dim(summary.runId)}`);
      if (summary.warnings.length) {
        warn(`${summary.warnings.length} warning(s)`);
        for (const w of summary.warnings.slice(0, 5)) console.log(chalk.dim(`  · ${w}`));
      }
      if (summary.errors.length) {
        error(`${summary.errors.length} error(s)`);
        for (const e of summary.errors.slice(0, 5)) console.log(chalk.dim(`  · ${e}`));
      }
    });

  cmd
    .command('list')
    .description('List ingested competitor handles.')
    .action(() => {
      const dir = MARKETING_PATHS.competitorsDir();
      if (!existsSync(dir)) {
        info('No competitors ingested yet.');
        return;
      }
      const handles = readdirSync(dir).filter((name) => {
        if (name.startsWith('_') || name.startsWith('.')) return false;
        const full = join(dir, name);
        try { return statSync(full).isDirectory(); } catch { return false; }
      });
      if (handles.length === 0) {
        info('No competitors ingested yet.');
        return;
      }
      console.log(header('Competitors'));
      for (const handle of handles) {
        const postsDir = join(dir, handle, 'posts');
        const postCount = existsSync(postsDir)
          ? readdirSync(postsDir).filter((f) => f.endsWith('.json')).length
          : 0;
        console.log(`  ${chalk.cyan('@' + handle)}  ${chalk.dim(`${postCount} post(s)`)}`);
      }
    });

  cmd
    .command('health')
    .description('Run the Reinfluence health probe (cached 60s).')
    .action(() => {
      const h = health();
      console.log(header('Reinfluence health'));
      for (const c of h.checks) {
        const sym = c.ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${sym} ${c.name}${c.detail ? chalk.dim(' — ' + c.detail) : ''}`);
      }
      if (!h.ok) {
        console.log();
        for (const hint of h.installHints) console.log(chalk.yellow(`  → ${hint}`));
        process.exitCode = 1;
      }
    });
}

