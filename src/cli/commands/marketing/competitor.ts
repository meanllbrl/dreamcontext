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
import { runVisionPassOnPost, pickVisionProvider } from '../../../lib/marketing/vision.js';

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
    .command('relabel <shortcode>')
    .description('Re-run vision pass on an already-ingested post. Updates pattern_tags + vision_summary in place. Requires OPENAI_VISION_API_KEY or GOOGLE_API_KEY.')
    .option('--handle <handle>', 'Disambiguate when the same shortcode exists across handles')
    .option('--force', 'Overwrite existing pattern_tags', false)
    .action(async (shortcode: string, opts: { handle?: string; force?: boolean }) => {
      console.log(header(`Vision relabel — ${shortcode}`));

      const provider = pickVisionProvider();
      if (!provider) {
        error('No vision provider configured.', 'Set OPENAI_VISION_API_KEY or GOOGLE_API_KEY in _dream_context/marketing/.env.');
        process.exit(1);
      }
      info(`Provider: ${provider.provider}`);

      const competitorsDir = MARKETING_PATHS.competitorsDir();
      const handles = opts.handle
        ? [opts.handle]
        : (existsSync(competitorsDir)
          ? readdirSync(competitorsDir).filter((h) => !h.startsWith('_') && statSync(join(competitorsDir, h)).isDirectory())
          : []);

      const matches: string[] = [];
      for (const h of handles) {
        const candidate = join(competitorsDir, h, 'posts', `${shortcode}.json`);
        if (existsSync(candidate)) matches.push(candidate);
      }

      if (matches.length === 0) {
        error(`No post JSON found for shortcode "${shortcode}".`);
        process.exit(1);
      }
      if (matches.length > 1) {
        error(`Multiple posts match shortcode "${shortcode}". Disambiguate with --handle.`);
        for (const m of matches) console.log(chalk.dim(`  ${m}`));
        process.exit(1);
      }

      try {
        const result = await runVisionPassOnPost(matches[0], { force: opts.force });
        if (result.skipped === 'no-hook-frames') {
          warn('No hook frames present — vision pass is a no-op for transcript-only ingests (e.g. YouTube).');
          return;
        }
        if (result.skipped === 'already-labeled') {
          warn('Post already has pattern_tags. Use --force to relabel.');
          return;
        }
        success(`Labeled ${result.framesLabeled} hook frame(s); pattern_tags: ${result.patternTags.join(', ') || '(none)'}.`);
      } catch (e) {
        error(`Relabel failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('relabel-all')
    .description('Run vision pass on every ingested post that has hook frames + no pattern_tags yet. Skip with --dry-run to preview.')
    .option('--force', 'Re-label posts that already have pattern_tags', false)
    .option('--dry-run', 'List candidate posts; do not call the vision API', false)
    .action(async (opts: { force?: boolean; dryRun?: boolean }) => {
      console.log(header('Vision relabel-all'));

      const provider = pickVisionProvider();
      if (!provider && !opts.dryRun) {
        error('No vision provider configured.', 'Set OPENAI_VISION_API_KEY or GOOGLE_API_KEY in _dream_context/marketing/.env.');
        process.exit(1);
      }

      const competitorsDir = MARKETING_PATHS.competitorsDir();
      if (!existsSync(competitorsDir)) {
        warn('No competitors directory yet — nothing to relabel.');
        return;
      }
      const handles = readdirSync(competitorsDir)
        .filter((h) => !h.startsWith('_') && statSync(join(competitorsDir, h)).isDirectory());

      let labeled = 0;
      let skipped = 0;
      for (const h of handles) {
        const postsDir = join(competitorsDir, h, 'posts');
        if (!existsSync(postsDir)) continue;
        for (const f of readdirSync(postsDir).filter((n) => n.endsWith('.json'))) {
          const path = join(postsDir, f);
          if (opts.dryRun) {
            info(`would relabel: ${path}`);
            continue;
          }
          try {
            const result = await runVisionPassOnPost(path, { force: opts.force });
            if (result.skipped) {
              skipped += 1;
            } else {
              labeled += 1;
              console.log(chalk.dim(`  ${chalk.green('+')} ${result.shortcode}: ${result.patternTags.join(', ') || '(no labels)'}`));
            }
          } catch (e) {
            warn(`relabel failed for ${path}: ${(e as Error).message}`);
          }
        }
      }
      success(`Done. Labeled ${labeled}; skipped ${skipped}.`);
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

