import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { loadPatterns, matchPatterns, syncPatternShims } from '../../lib/patterns.js';
import { success, error, info } from '../../lib/format.js';

/**
 * Register the `dreamcontext patterns` command.
 *
 * Subcommands: list (what the vault holds, with the triggers it derived),
 * sync (regenerate the `/` menu shims), match (ask what a given prompt fires).
 *
 * `match` is the debugging surface that makes the automatic half inspectable:
 * when a user says "it didn't pick up my pattern", this answers whether the
 * gate saw it, with the exact keys that did or did not line up.
 */
export function registerPatternsCommand(program: Command): void {
  const patterns = program
    .command('patterns')
    .description('Browse project patterns, sync their "/" entries, and test what a prompt triggers');

  // --- list ---
  patterns
    .command('list', { isDefault: true })
    .description('List every pattern with its "/" name and derived triggers')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const docs = loadPatterns(root);

      if (opts.json) {
        console.log(JSON.stringify(
          docs.map((p) => ({
            slug: p.slug,
            name: p.name,
            slash: p.slashName,
            description: p.description,
            triggers: [...p.keys].sort(),
            authored: p.authored,
          })),
          null,
          2,
        ));
        return;
      }

      if (docs.length === 0) {
        info('No patterns yet. They live in knowledge/patterns/ — a pattern is a decided way of doing something here.');
        return;
      }

      console.log();
      for (const p of docs) {
        console.log(`  ${chalk.bold(p.name)}  ${chalk.dim(`/${p.slashName}`)}`);
        if (p.description) console.log(`    ${chalk.dim(p.description)}`);
        console.log(`    ${chalk.dim(`triggers: ${[...p.keys].sort().join(', ')}`)}`);
        console.log();
      }
      info(`${docs.length} pattern${docs.length === 1 ? '' : 's'}. Triggers are derived automatically — add \`triggers:\` to a pattern only to teach it a word its name does not contain.`);
    });

  // --- sync ---
  patterns
    .command('sync')
    .description('Regenerate the "/" menu entries from knowledge/patterns/')
    .action(() => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const result = syncPatternShims(projectRoot, root);
      const total = loadPatterns(root).length;
      if (result.written.length === 0 && result.removed.length === 0) {
        info(`"/" entries already match the vault (${total} pattern${total === 1 ? '' : 's'}).`);
        return;
      }
      success(`Synced ${total} pattern${total === 1 ? '' : 's'} into the "/" menu.`);
      if (result.written.length > 0) info(`  written: ${result.written.length}`);
      if (result.removed.length > 0) info(`  removed: ${result.removed.length}`);
    });

  // --- match ---
  patterns
    .command('match <prompt...>')
    .description('Show which patterns a prompt would trigger, and why')
    .option('--json', 'Machine-readable output')
    .action((words: string[], opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const prompt = words.join(' ');
      const docs = loadPatterns(root);
      const hits = matchPatterns(prompt, docs);

      if (opts.json) {
        console.log(JSON.stringify(
          hits.map((h) => ({
            slug: h.pattern.slug,
            relPath: h.pattern.relPath,
            score: h.score,
            matched: h.matched,
            distinctive: h.distinctive,
            corroborating: h.corroborating,
          })),
          null,
          2,
        ));
        return;
      }

      if (hits.length === 0) {
        info(`No pattern fires on ${JSON.stringify(prompt)}.`);
        info('That is the intended answer for most prompts — the gate stays silent unless a pattern is genuinely named.');
        return;
      }
      console.log();
      for (const h of hits) {
        console.log(`  ${chalk.bold(h.pattern.name)}  ${chalk.dim(`(score ${h.score})`)}`);
        console.log(`    ${chalk.dim(h.pattern.relPath)}`);
        console.log(`    ${chalk.dim(`matched: ${h.matched.join(', ') || '—'}${h.corroborating.length ? `  ·  supporting: ${h.corroborating.join(', ')}` : ''}`)}`);
        console.log();
      }
    });
}
