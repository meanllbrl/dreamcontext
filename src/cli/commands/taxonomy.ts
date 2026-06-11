import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, info, success, error } from '../../lib/format.js';
import { buildCorpus } from '../../lib/recall.js';
import {
  loadProjectVocabulary,
  auditCorpus,
  renderDefaultTaxonomyMarkdown,
  DEFAULT_VOCABULARY,
  FACETS,
  tagIndexValue,
} from '../../lib/taxonomy.js';

export function registerTaxonomyCommand(program: Command): void {
  const taxonomy = program
    .command('taxonomy')
    .description('Inspect and maintain the project tag vocabulary');

  // vocab — show the resolved vocabulary
  taxonomy
    .command('vocab')
    .description('Show the resolved project vocabulary (DEFAULT + core/taxonomy.md)')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const vocab = loadProjectVocabulary(root);

      if (opts.json) {
        console.log(JSON.stringify(vocab, null, 2));
        return;
      }

      console.log(header('Taxonomy Vocabulary'));

      console.log(`\n  ${chalk.bold('Faceted tags')}`);
      for (const facet of FACETS) {
        const tags = vocab.facetTags[facet];
        if (tags.length === 0) continue;
        console.log(`    ${chalk.cyan(facet)}:`);
        for (const tag of tags) {
          console.log(`      ${chalk.magentaBright(tag)}`);
        }
      }

      console.log(`\n  ${chalk.bold('Aliases')}  ${chalk.dim('(alias → canonical)')}`);
      for (const [alias, canonical] of Object.entries(vocab.aliases)) {
        console.log(`    ${chalk.yellow(alias)} → ${chalk.magentaBright(canonical)}`);
      }

      console.log(`\n  ${chalk.bold('Bare tags')}`);
      for (const tag of vocab.bareTags) {
        console.log(`    ${chalk.magentaBright(tag)}`);
      }

      console.log('');
      console.log(chalk.dim('  Source: DEFAULT_VOCABULARY merged with core/taxonomy.md (if present)'));
      console.log(chalk.dim('  Run: dreamcontext taxonomy init  to scaffold core/taxonomy.md'));
    });

  // audit — read-only corpus audit
  taxonomy
    .command('audit')
    .description('Audit corpus tags against the vocabulary (read-only, exit 0)')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const vocab = loadProjectVocabulary(root);
      const corpus = buildCorpus(root);

      // Build slim doc list for audit (slug + tags only).
      const docs = corpus.map((d) => ({ slug: d.slug, tags: d.tags }));
      const buckets = auditCorpus(docs, vocab);

      if (opts.json) {
        console.log(JSON.stringify(buckets, null, 2));
        return;
      }

      console.log(header('Taxonomy Audit'));

      if (buckets.untagged.length > 0) {
        console.log(`\n  ${chalk.yellow('Untagged docs')} (${buckets.untagged.length}):`);
        for (const slug of buckets.untagged) {
          console.log(`    ${chalk.dim(slug)}`);
        }
      } else {
        console.log(`\n  ${chalk.green('✓')} All docs have tags`);
      }

      if (buckets.nonCanonical.length > 0) {
        console.log(`\n  ${chalk.yellow('Non-canonical tags')} (${buckets.nonCanonical.length}):`);
        for (const { doc, tag, suggestion } of buckets.nonCanonical) {
          const hint = suggestion !== tag ? chalk.dim(` → ${suggestion}`) : '';
          console.log(`    ${chalk.dim(doc)}: ${chalk.yellow(tag)}${hint}`);
        }
      } else {
        console.log(`  ${chalk.green('✓')} All tags are canonical`);
      }

      if (buckets.orphan.length > 0) {
        console.log(`\n  ${chalk.yellow('Orphan tags')} (not in vocab, ${buckets.orphan.length}):`);
        for (const tag of buckets.orphan) {
          console.log(`    ${chalk.yellow(tag)}`);
        }
      } else {
        console.log(`  ${chalk.green('✓')} No orphan tags`);
      }

      if (buckets.nearDups.length > 0) {
        console.log(`\n  ${chalk.yellow('Near-duplicate vocab tags')} (${buckets.nearDups.length} pairs):`);
        for (const [a, b] of buckets.nearDups) {
          console.log(`    ${chalk.yellow(a)} ~ ${chalk.yellow(b)}`);
        }
      }

      console.log('');
      // exit 0 always (audit is strictly read-only and informational)
    });

  // init — scaffold core/taxonomy.md
  taxonomy
    .command('init')
    .description('Scaffold core/taxonomy.md from the default vocabulary (idempotent)')
    .action(() => {
      const root = ensureContextRoot();
      const taxonomyPath = join(root, 'core', 'taxonomy.md');

      if (existsSync(taxonomyPath)) {
        info('core/taxonomy.md already exists — no changes made.');
        return;
      }

      const content = renderDefaultTaxonomyMarkdown(DEFAULT_VOCABULARY);
      writeFileSync(taxonomyPath, content, 'utf-8');
      success('Created: core/taxonomy.md');
      console.log(chalk.dim('  Edit it to add project-specific facets, aliases, and domain vocabulary.'));
      console.log(chalk.dim('  Run: dreamcontext taxonomy vocab  to see the resolved vocabulary.'));
    });
}
