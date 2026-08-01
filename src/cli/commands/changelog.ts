import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readJsonArray } from '../../lib/json-file.js';
import { listChangelogEntries, type ChangelogEntry } from '../../lib/changelog-list.js';
import { info } from '../../lib/format.js';

/**
 * `dreamcontext changelog list` — paginated, filterable CHRONOLOGICAL reading
 * of `core/CHANGELOG.json` (LIFO, newest first).
 *
 * Complements recall, never duplicates it: `memory recall --types changelog`
 * answers "where did we do X?" (relevance-ranked); this answers "what
 * happened, in order?" — the browse the snapshot's Recent Changelog head
 * cannot provide (owner ask 2026-07-30). Plain text on purpose: agents are
 * first-class readers.
 */
export function registerChangelogCommand(program: Command): void {
  const changelog = program
    .command('changelog')
    .description('Browse core/CHANGELOG.json chronologically (newest first)');

  changelog
    .command('list')
    .description('Page through changelog entries; filter by type/scope or a text match')
    .option('--page <n>', '1-based page number', '1')
    .option('--size <n>', 'entries per page (max 50)', '10')
    .option('--type <type>', 'exact type filter (feat/fix/change/chore/note/…)')
    .option('--scope <scope>', 'exact scope filter')
    .option('--grep <text>', 'case-insensitive substring over summary + description + scope')
    .option('--json', 'machine-readable output')
    .action((opts: { page: string; size: string; type?: string; scope?: string; grep?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const path = join(root, 'core', 'CHANGELOG.json');
      if (!existsSync(path)) {
        info('No core/CHANGELOG.json in this vault.');
        return;
      }

      const all = readJsonArray<ChangelogEntry>(path);
      const result = listChangelogEntries(all, {
        page: Number(opts.page),
        size: Number(opts.size),
        type: opts.type,
        scope: opts.scope,
        grep: opts.grep,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.total === 0) {
        info('No changelog entries match.');
        return;
      }

      console.log(`Changelog — page ${result.page}/${result.pages} (${result.total} matching entr${result.total === 1 ? 'y' : 'ies'}, newest first)\n`);
      for (const e of result.entries) {
        const date = String(e.date ?? '');
        const type = String(e.type ?? '');
        const scope = String(e.scope ?? '');
        const summary = typeof e.summary === 'string' ? e.summary : '';
        const desc = String(e.description ?? '');
        const authors = Array.isArray(e.authors) && e.authors.length > 0
          ? ` — by ${e.authors.map(String).join(', ')}`
          : '';
        console.log(`- ${date} [${type}] ${scope}: ${summary || desc}${authors}`);
        if (summary && desc && desc !== summary) {
          console.log(`  ${desc}`);
        }
      }
      if (result.page < result.pages) {
        console.log(`\nNext: dreamcontext changelog list --page ${result.page + 1}${opts.grep ? ` --grep "${opts.grep}"` : ''}${opts.type ? ` --type ${opts.type}` : ''}${opts.scope ? ` --scope ${opts.scope}` : ''}`);
      }
    });
}
