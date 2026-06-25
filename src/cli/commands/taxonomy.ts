import { Command } from 'commander';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, info, success } from '../../lib/format.js';
import { buildCorpus } from '../../lib/recall.js';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import {
  loadProjectVocabulary,
  auditCorpus,
  ensureTaxonomyFile,
  addVocabularyTag,
  addVocabularyAlias,
  classifyTag,
  resolveAlias,
  normalizeTag,
  planTagRewrites,
  FACETS,
  tagIndexValue,
  type Facet,
  type Vocabulary,
  type TagRewrite,
} from '../../lib/taxonomy.js';

// ─── audit --fix helpers ───────────────────────────────────────────────────────

/** Corpus types whose individual files carry a frontmatter `tags:` array. */
const FIX_ELIGIBLE_TYPES = new Set(['knowledge', 'feature', 'task']);

interface FileFix {
  relPath: string;
  slug: string;
  path: string;
  rewrites: TagRewrite[];
  newTags: string[];
}

interface TaxonomyFixReport {
  files: FileFix[];
  /** slug -> non-canonical tags with no safe canonical target (need a vocab decision). */
  unresolved: Array<{ slug: string; tags: string[] }>;
  totalRewrites: number;
}

/**
 * Compute (and optionally apply) the bulk tag-normalization plan across every
 * knowledge/feature/task file. Reads RAW frontmatter per file (not the
 * corpus-normalized tags) so the plan matches exactly what gets written.
 */
function runTaxonomyFix(root: string, vocab: Vocabulary, apply: boolean): TaxonomyFixReport {
  const corpus = buildCorpus(root);
  const seen = new Set<string>();
  const files: FileFix[] = [];
  const unresolved: Array<{ slug: string; tags: string[] }> = [];
  let totalRewrites = 0;

  for (const doc of corpus) {
    if (!FIX_ELIGIBLE_TYPES.has(doc.type)) continue;
    if (seen.has(doc.path)) continue; // one file = one plan
    seen.add(doc.path);

    let rawTags: string[];
    try {
      const { data } = readFrontmatter(doc.path);
      rawTags = Array.isArray((data as { tags?: unknown }).tags)
        ? ((data as { tags: unknown[] }).tags.filter((t): t is string => typeof t === 'string'))
        : [];
    } catch {
      continue; // unreadable / malformed frontmatter — skip, never throw
    }
    if (rawTags.length === 0) continue;

    const plan = planTagRewrites(rawTags, vocab);
    if (plan.unresolved.length > 0) {
      unresolved.push({ slug: doc.slug, tags: plan.unresolved });
    }
    if (plan.rewrites.length === 0) continue;

    totalRewrites += plan.rewrites.length;
    files.push({ relPath: doc.relPath, slug: doc.slug, path: doc.path, rewrites: plan.rewrites, newTags: plan.newTags });

    if (apply) {
      updateFrontmatterFields(doc.path, { tags: plan.newTags });
    }
  }

  return { files, unresolved, totalRewrites };
}

export function registerTaxonomyCommand(program: Command): void {
  const taxonomy = program
    .command('taxonomy')
    .description('Inspect and maintain the project tag vocabulary');

  // vocab — show the resolved vocabulary
  taxonomy
    .command('vocab')
    .description('Show the resolved project vocabulary (DEFAULT + core/taxonomy.json)')
    .option('--json', 'Emit JSON')
    .option('--facet <facet>', 'Filter output to one facet')
    .action((opts: { json?: boolean; facet?: string }) => {
      const root = ensureContextRoot();

      // Validate --facet if provided
      if (opts.facet && !(FACETS as readonly string[]).includes(opts.facet)) {
        process.stderr.write(
          `Error: unknown facet '${opts.facet}'. Valid facets: ${FACETS.join(', ')}\n`,
        );
        process.exit(1);
      }

      const vocab = loadProjectVocabulary(root);

      if (opts.json) {
        if (opts.facet) {
          const facet = opts.facet as Facet;
          console.log(JSON.stringify({ [facet]: vocab.facetTags[facet] }, null, 2));
        } else {
          console.log(JSON.stringify(vocab, null, 2));
        }
        return;
      }

      console.log(header('Taxonomy Vocabulary'));

      console.log(`\n  ${chalk.bold('Faceted tags')}`);
      for (const facet of FACETS) {
        if (opts.facet && opts.facet !== facet) continue;
        const tags = vocab.facetTags[facet];
        if (tags.length === 0) continue;
        console.log(`    ${chalk.cyan(facet)}:`);
        for (const tag of tags) {
          console.log(`      ${chalk.magentaBright(tag)}`);
        }
      }

      if (!opts.facet) {
        console.log(`\n  ${chalk.bold('Aliases')}  ${chalk.dim('(alias → canonical)')}`);
        for (const [alias, canonical] of Object.entries(vocab.aliases)) {
          console.log(`    ${chalk.yellow(alias)} → ${chalk.magentaBright(canonical)}`);
        }

        console.log(`\n  ${chalk.bold('Bare tags')}`);
        for (const tag of vocab.bareTags) {
          console.log(`    ${chalk.magentaBright(tag)}`);
        }
      }

      console.log('');
      console.log(chalk.dim('  Source: DEFAULT_VOCABULARY merged with core/taxonomy.json (if present)'));
      console.log(chalk.dim('  Run: dreamcontext taxonomy init  to scaffold core/taxonomy.json'));
    });

  // audit — read-only corpus audit (or --fix to bulk-normalize)
  taxonomy
    .command('audit')
    .description('Audit corpus tags against the vocabulary (read-only). Use --fix to bulk-normalize.')
    .option('--json', 'Emit JSON')
    .option('--fix', 'Rewrite alias/normalizable tags to canonical form across knowledge/feature/task files')
    .option('--dry-run', 'With --fix: print the exact rewrite plan but write nothing')
    .action((opts: { json?: boolean; fix?: boolean; dryRun?: boolean }) => {
      const root = ensureContextRoot();
      const vocab = loadProjectVocabulary(root);

      // ── --fix path: bulk-normalize tags (apply unless --dry-run) ──────────────
      if (opts.fix) {
        const apply = !opts.dryRun;
        const report = runTaxonomyFix(root, vocab, apply);

        if (opts.json) {
          console.log(JSON.stringify({ applied: apply, ...report }, null, 2));
          return;
        }

        console.log(header(apply ? 'Taxonomy Fix' : 'Taxonomy Fix (dry-run)'));

        if (report.files.length === 0) {
          console.log(`\n  ${chalk.green('✓')} No alias/normalizable tags found — nothing to fix.`);
        } else {
          const verb = apply ? 'Rewrote' : 'Would rewrite';
          console.log(`\n  ${apply ? chalk.green('✓') : chalk.cyan('•')} ${verb} ${chalk.bold(String(report.totalRewrites))} tag${report.totalRewrites === 1 ? '' : 's'} across ${chalk.bold(String(report.files.length))} file${report.files.length === 1 ? '' : 's'}:`);
          for (const f of report.files) {
            console.log(`\n    ${chalk.dim(f.relPath)}`);
            for (const r of f.rewrites) {
              console.log(`      ${chalk.yellow(r.from)} → ${chalk.magentaBright(r.to)}`);
            }
          }
        }

        if (report.unresolved.length > 0) {
          const count = report.unresolved.reduce((n, u) => n + u.tags.length, 0);
          console.log(`\n  ${chalk.yellow('Needs a vocab decision')} (${count} tag${count === 1 ? '' : 's'} — no alias/canonical, left untouched):`);
          for (const u of report.unresolved) {
            console.log(`    ${chalk.dim(u.slug)}: ${u.tags.map((t) => chalk.yellow(t)).join(', ')}`);
          }
          console.log(chalk.dim('\n  Resolve with: dreamcontext taxonomy add <tag>  OR  taxonomy alias <orphan> <canonical>, then re-run --fix.'));
        }

        if (!apply && report.files.length > 0) {
          console.log(chalk.dim('\n  Dry run — nothing written. Re-run without --dry-run to apply.'));
        }
        console.log('');
        return;
      }

      // ── default path: read-only audit ────────────────────────────────────────
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
        let fixable = 0;
        for (const { doc, tag, suggestion } of buckets.nonCanonical) {
          const willFix = suggestion !== tag;
          if (willFix) fixable++;
          const hint = willFix ? chalk.dim(` → ${suggestion}`) : '';
          console.log(`    ${chalk.dim(doc)}: ${chalk.yellow(tag)}${hint}`);
        }
        if (fixable > 0) {
          console.log(chalk.dim(`\n  ↳ ${fixable} alias/normalizable occurrence${fixable === 1 ? '' : 's'} — \`dreamcontext taxonomy audit --fix\` rewrites these in knowledge/feature/task files (\`--fix --dry-run\` to preview; changelog/memory tags are managed elsewhere).`));
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

  // init — scaffold core/taxonomy.json
  taxonomy
    .command('init')
    .description('Scaffold core/taxonomy.json from the default vocabulary (idempotent)')
    .action(() => {
      const root = ensureContextRoot();

      if (!ensureTaxonomyFile(root)) {
        info('core/taxonomy.json already exists — no changes made.');
        return;
      }

      success('Created: core/taxonomy.json');
      console.log(chalk.dim('  Edit it or use `dreamcontext taxonomy add` / `alias` to add project-specific vocabulary.'));
      console.log(chalk.dim('  Run: dreamcontext taxonomy vocab  to see the resolved vocabulary.'));
    });

  // add — add a tag to the project vocabulary
  taxonomy
    .command('add <tag>')
    .description('Add a tag to the project vocabulary (creates core/taxonomy.json if missing)')
    .action((rawTag: string) => {
      const root = ensureContextRoot();
      const result = addVocabularyTag(root, rawTag);

      if (result.added) {
        success(`Added: ${result.tag}`);
        return;
      }

      // Benign already-exists: exit 0 with info
      if (result.reason === 'already exists') {
        info(`${result.tag} already exists in vocabulary — no changes made.`);
        return;
      }

      // Validation rejection: exit 1 with reason
      process.stderr.write(`Error: ${result.reason}\n`);
      process.exit(1);
    });

  // alias — add an alias mapping to the project vocabulary
  taxonomy
    .command('alias <alias> <canonical>')
    .description('Add an alias → canonical mapping to the project vocabulary')
    .action((rawAlias: string, rawCanonical: string) => {
      const root = ensureContextRoot();
      const result = addVocabularyAlias(root, rawAlias, rawCanonical);

      if (result.added) {
        success(`Added alias: ${normalizeTag(rawAlias)} → ${normalizeTag(rawCanonical)}`);
        return;
      }

      // Benign already-exists: exit 0 with info
      if (result.reason === 'already exists') {
        info(`Alias already exists — no changes made.`);
        return;
      }

      // Validation rejection: exit 1 with reason
      process.stderr.write(`Error: ${result.reason}\n`);
      process.exit(1);
    });

  // resolve — resolve + classify a tag
  taxonomy
    .command('resolve <tag>')
    .description('Show normalized form, classification, and canonical resolution of a tag')
    .option('--json', 'Emit JSON')
    .action((rawTag: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const vocab = loadProjectVocabulary(root);
      const tag = normalizeTag(rawTag);
      const classification = classifyTag(tag, vocab);
      const canonical = resolveAlias(tag, vocab);
      const indexValue = tagIndexValue(tag);

      if (opts.json) {
        console.log(JSON.stringify({ tag, classification, canonical, indexValue }, null, 2));
        return;
      }

      console.log(`  ${chalk.bold('Tag')}:            ${chalk.magentaBright(tag)}`);
      console.log(`  ${chalk.bold('Classification')}: ${chalk.cyan(classification)}`);
      if (classification === 'alias') {
        console.log(`  ${chalk.bold('Canonical')}:      ${chalk.green(canonical)}`);
      }
      console.log(`  ${chalk.bold('Index value')}:    ${chalk.dim(indexValue)}`);
      console.log('');
    });
}
