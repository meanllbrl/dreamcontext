import { Command } from 'commander';
import chalk from 'chalk';
import { resolveContextRoot } from '../../lib/context-path.js';
import { cleanTmp, formatBytes, stampTmpClean, TMP_CLEAN_LOG } from '../../lib/tmp-clean.js';

/** `dreamcontext tmp clean`: the daily tmp clean, now, for this project (src/lib/tmp-clean.ts). */
export function registerTmpCommand(program: Command): void {
  const tmp = program
    .command('tmp')
    .description("The project's _dream_context/tmp/ scratch folder");

  tmp
    .command('clean')
    .description('Remove tmp files older than 14 days that nothing in the brain links (also runs daily on its own)')
    .option('--dry-run', 'List what would go and how much space it frees; remove nothing')
    .option('--json', 'Machine-readable output')
    .action((opts: { dryRun?: boolean; json?: boolean }) => {
      const root = resolveContextRoot();
      if (!root) {
        console.error(chalk.red('_dream_context/ not found here: run it inside a project.'));
        process.exitCode = 1;
        return;
      }
      const now = Date.now();
      const r = cleanTmp(root, { dryRun: opts.dryRun === true, now });
      stampTmpClean(root, now, r);
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      if (r.skipped === 'missing') { console.log(chalk.dim('No _dream_context/tmp/ here: nothing to clean.')); return; }
      if (r.skipped === 'symlink') { console.log(chalk.yellow('_dream_context/tmp/ is a symlink: refused, nothing removed.')); process.exitCode = 1; return; }
      if (r.skipped === 'unreadable-records') {
        console.log(chalk.yellow('Some brain records could not be read, so their links are unknown: nothing removed.'));
        for (const e of r.errors) console.log(chalk.yellow(`  ⚠ ${e}`));
        process.exitCode = 1;
        return;
      }
      const verb = r.dryRun ? 'Would remove' : 'Removed';
      for (const d of r.deleted) console.log(`  ${chalk.dim(formatBytes(d.bytes).padStart(9))}  ${d.path}`);
      console.log(`${verb} ${r.deleted.length} file(s), ${formatBytes(r.bytes)}.`);
      console.log(chalk.dim(`Kept: ${r.kept.linked} linked from the brain, ${r.kept.live} used by a live Super child, ${r.kept.recent} touched in the last 14 days, ${r.kept.symlink} symlink(s) left alone, ${r.kept.repo} git checkout(s) kept whole.`));
      if (!r.dryRun && r.deleted.length) console.log(chalk.dim(`What went is listed in _dream_context/tmp/${TMP_CLEAN_LOG}.`));
      if (r.dirsRemoved.length) console.log(chalk.dim(`Emptied folders removed: ${r.dirsRemoved.length}.`));
      for (const e of r.errors) console.log(chalk.yellow(`  ⚠ ${e}`));
    });
}
