import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { confirm, input } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, info, success, error } from '../../lib/format.js';
import { buildCorpus, bm25Search, type CorpusType, type RecallHit } from '../../lib/recall.js';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { today } from '../../lib/id.js';

const TYPE_LABELS: Record<CorpusType, string> = {
  knowledge: 'knowledge',
  feature: 'feature',
  task: 'task',
  memory: 'memory',
  changelog: 'changelog',
  skill: 'skill', // never produced by buildCorpus; present only to satisfy the Record type
};

function parseTypes(value: string | undefined): CorpusType[] | undefined {
  if (!value) return undefined;
  const valid: CorpusType[] = ['knowledge', 'feature', 'task', 'memory', 'changelog'];
  const parts = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as CorpusType[];
  const filtered = parts.filter((p) => valid.includes(p));
  return filtered.length > 0 ? filtered : undefined;
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command('memory')
    .description('Search and explore the project corpus (knowledge, features, tasks, memory)');

  // recall
  memory
    .command('recall')
    .argument('<query...>', 'Search query (multiple words OK)')
    .description('BM25 search over knowledge + features + tasks + memory entries')
    .option('-t, --top <n>', 'Number of hits to return', '5')
    .option('--types <types>', 'Comma-separated subset: knowledge,feature,task,memory')
    .option('--json', 'Emit JSON for piping into other tools')
    .option('--plain', 'Plain text output without colors')
    .action(
      (
        queryParts: string[],
        opts: { top?: string; types?: string; json?: boolean; plain?: boolean },
      ) => {
        const root = ensureContextRoot();
        const query = queryParts.join(' ');
        const topK = Math.max(1, Math.min(50, Number.parseInt(opts.top ?? '5', 10) || 5));
        const types = parseTypes(opts.types);
        const corpus = buildCorpus(root, types ? { types } : {});
        const hits = bm25Search(query, corpus, topK);

        if (opts.json) {
          const payload = hits.map((h) => ({
            type: h.doc.type,
            slug: h.doc.slug,
            path: h.doc.relPath,
            title: h.doc.title,
            description: h.doc.description,
            tags: h.doc.tags,
            score: Number(h.score.toFixed(4)),
            snippet: h.snippet,
          }));
          console.log(JSON.stringify({ query, corpusSize: corpus.length, hits: payload }, null, 2));
          return;
        }

        if (hits.length === 0) {
          const msg = `No hits for "${query}" (searched ${corpus.length} docs).`;
          if (opts.plain) console.log(msg);
          else info(msg);
          return;
        }

        if (opts.plain) {
          for (const h of hits) {
            console.log(`[${TYPE_LABELS[h.doc.type]}] ${h.doc.slug}  (score ${h.score.toFixed(3)})`);
            console.log(`  ${h.doc.relPath}`);
            if (h.doc.description) console.log(`  ${h.doc.description}`);
            if (h.snippet) {
              for (const line of h.snippet.split('\n')) console.log(`    ${line}`);
            }
            console.log('');
          }
          return;
        }

        console.log(header(`Recall: "${query}"  ${chalk.dim(`(${corpus.length} docs scanned)`)}`));
        for (const h of hits) {
          const typeBadge = chalk.cyan(`[${TYPE_LABELS[h.doc.type]}]`);
          const slug = chalk.magentaBright(h.doc.slug);
          const score = chalk.dim(`score ${h.score.toFixed(3)}`);
          console.log(`  ${typeBadge} ${slug}  ${score}`);
          console.log(`    ${chalk.dim(h.doc.relPath)}`);
          if (h.doc.description) console.log(`    ${h.doc.description}`);
          if (h.doc.tags.length > 0) {
            console.log(`    ${chalk.dim('tags: ' + h.doc.tags.join(', '))}`);
          }
          if (h.snippet) {
            const snipLines = h.snippet.split('\n').map((l) => `      ${chalk.gray('│')} ${l}`);
            console.log(snipLines.join('\n'));
          }
          console.log('');
        }
      },
    );

  // remember — quick CHANGELOG entry capture (post-Option-E, 2026-05-23).
  // Previously appended a LIFO entry to 2.memory.md; that section is gone.
  // Ship events now live exclusively in CHANGELOG.json — `memory remember`
  // is a fast path to that file with sensible defaults.
  memory
    .command('remember')
    .argument('<text...>', 'The memory text to record (multiple words OK)')
    .option('--summary <summary>', 'Optional ≤200 char one-liner (defaults to first 200 chars of text)')
    .option('--type <type>', 'Changelog type (default: note)', 'note')
    .option('--scope <scope>', 'Changelog scope (default: quick)', 'quick')
    .option('--references <refs>', 'Optional comma-separated references (commit:<sha>, file:<path>, knowledge:<slug>, feature:<slug>, task:<slug>, url:<href>)')
    .option('--person <list>', 'Optional comma-separated people to attribute this memory to (e.g. "mehmet,ada")')
    .description('Quick-append a CHANGELOG entry. Fast path; for full control use `dreamcontext core changelog add`.')
    .action(async (
      textParts: string[],
      opts: { summary?: string; type?: string; scope?: string; references?: string; person?: string },
    ) => {
      const root = ensureContextRoot();
      const text = textParts.join(' ').trim();
      if (!text) {
        error('Cannot remember empty text.');
        return;
      }
      const summary = opts.summary
        ?? (text.length > 200 ? text.slice(0, 197) + '...' : text);
      const references = opts.references
        ? opts.references.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      // Person attribution uses the UNIFIED `authors` carrier (the same field as
      // `core changelog add --authors`), NOT references. recall.ts indexes
      // `authors` into the doc tags so the person name is searchable.
      const authors = opts.person
        ? opts.person.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const changelogPath = join(root, 'core', 'CHANGELOG.json');
      const entry: Record<string, unknown> = {
        date: today(),
        type: opts.type ?? 'note',
        scope: opts.scope ?? 'quick',
        summary,
        description: text,
        breaking: false,
      };
      if (references && references.length > 0) entry.references = references;
      if (authors && authors.length > 0) entry.authors = authors;
      // insertToJsonArray is the canonical writer (LIFO via top-insert).
      const { insertToJsonArray } = await import('../../lib/json-file.js');
      insertToJsonArray(changelogPath, entry);
      success(`Remembered (CHANGELOG): ${summary}`);
    });

  // update — edit a knowledge file's frontmatter or body
  memory
    .command('update')
    .argument('<slug>', 'Knowledge file slug (without .md)')
    .option('-d, --description <desc>', 'New description (replaces existing)')
    .option('-t, --tags <tags>', 'New tags (comma-separated, replaces existing)')
    .option('-c, --content <content>', 'New body content (replaces existing)')
    .option('--append <text>', 'Append text to body (preserves existing content)')
    .option('--pin', 'Set pinned: true')
    .option('--unpin', 'Set pinned: false')
    .description('Update a knowledge file (frontmatter and/or body)')
    .action(
      async (
        slug: string,
        opts: {
          description?: string;
          tags?: string;
          content?: string;
          append?: string;
          pin?: boolean;
          unpin?: boolean;
        },
      ) => {
        const root = ensureContextRoot();
        const filePath = join(root, 'knowledge', `${slug}.md`);
        if (!existsSync(filePath)) {
          error(`Knowledge file not found: ${slug}.md`);
          return;
        }
        const { data, content } = readFrontmatter(filePath);
        const updates: Record<string, unknown> = { ...data };
        let nextContent = content;
        let changed = false;

        if (opts.description !== undefined) {
          updates.description = opts.description;
          changed = true;
        }
        if (opts.tags !== undefined) {
          updates.tags = opts.tags.split(',').map((s) => s.trim()).filter(Boolean);
          changed = true;
        }
        if (opts.pin) {
          updates.pinned = true;
          changed = true;
        }
        if (opts.unpin) {
          updates.pinned = false;
          changed = true;
        }
        if (opts.content !== undefined) {
          nextContent = `\n${opts.content}\n`;
          changed = true;
        } else if (opts.append !== undefined) {
          nextContent = `${content.trimEnd()}\n\n${opts.append}\n`;
          changed = true;
        }

        if (!changed) {
          info('No update flags provided. Use --description, --tags, --content, --append, --pin, or --unpin.');
          return;
        }

        updates.updated = today();
        writeFrontmatter(filePath, updates, nextContent);
        success(`Updated: knowledge/${slug}.md`);
      },
    );

  // delete — remove a knowledge file (with confirmation)
  memory
    .command('delete')
    .argument('<slug>', 'Knowledge file slug to delete (without .md)')
    .option('-f, --force', 'Skip confirmation prompt')
    .description('Delete a knowledge file (irreversible; use git to recover)')
    .action(async (slug: string, opts: { force?: boolean }) => {
      const root = ensureContextRoot();
      const filePath = join(root, 'knowledge', `${slug}.md`);
      if (!existsSync(filePath)) {
        error(`Knowledge file not found: ${slug}.md`);
        return;
      }
      if (!opts.force) {
        const ok = await confirm({
          message: `Delete knowledge/${slug}.md? (use git to recover if mistaken)`,
          default: false,
        });
        if (!ok) {
          info('Cancelled.');
          return;
        }
      }
      unlinkSync(filePath);
      success(`Deleted: knowledge/${slug}.md`);
    });

  // list — list all corpus docs, optionally filtered
  memory
    .command('list')
    .description('List all docs in the memory corpus (knowledge, features, tasks, memory)')
    .option('--types <types>', 'Comma-separated subset: knowledge,feature,task,memory')
    .option('--plain', 'Plain text (no colors)')
    .action((opts: { types?: string; plain?: boolean }) => {
      const root = ensureContextRoot();
      const types = parseTypes(opts.types);
      const corpus = buildCorpus(root, types ? { types } : {});
      if (corpus.length === 0) {
        const msg = 'No docs in corpus.';
        if (opts.plain) console.log(msg);
        else info(msg);
        return;
      }

      if (opts.plain) {
        for (const doc of corpus) {
          console.log(`[${TYPE_LABELS[doc.type]}] ${doc.slug}  ${doc.relPath}`);
        }
        return;
      }

      const byType: Record<CorpusType, typeof corpus> = {
        knowledge: [],
        feature: [],
        task: [],
        memory: [],
        changelog: [],
        skill: [], // never produced by buildCorpus; present only to satisfy the Record type
      };
      for (const doc of corpus) byType[doc.type].push(doc);
      console.log(header(`Memory Corpus (${corpus.length} docs)`));
      for (const t of ['knowledge', 'feature', 'task', 'memory', 'changelog'] as CorpusType[]) {
        if (byType[t].length === 0) continue;
        console.log(`\n  ${chalk.cyan(TYPE_LABELS[t])} (${byType[t].length}):`);
        for (const doc of byType[t]) {
          const desc = doc.description ? `  ${chalk.dim('— ' + doc.description)}` : '';
          console.log(`    ${chalk.magentaBright(doc.slug)}${desc}`);
        }
      }
    });

  // status
  memory
    .command('status')
    .description('Show corpus size and breakdown by type')
    .action(() => {
      const root = ensureContextRoot();
      const corpus = buildCorpus(root);
      const counts: Record<CorpusType, number> = {
        knowledge: 0,
        feature: 0,
        task: 0,
        memory: 0,
        changelog: 0,
        skill: 0, // never produced by buildCorpus; present only to satisfy the Record type
      };
      let totalTokens = 0;
      for (const doc of corpus) {
        counts[doc.type]++;
        totalTokens += doc.tokens.length;
      }
      console.log(header('Memory Corpus'));
      console.log(`  ${chalk.magentaBright('knowledge')}  ${counts.knowledge} files`);
      console.log(`  ${chalk.magentaBright('feature')}    ${counts.feature} PRDs`);
      console.log(`  ${chalk.magentaBright('task')}       ${counts.task} task files`);
      console.log(`  ${chalk.magentaBright('memory')}     ${counts.memory} LIFO entries`);
      console.log(`  ${chalk.magentaBright('changelog')}  ${counts.changelog} entries`);
      console.log('');
      console.log(`  ${chalk.dim(`${corpus.length} docs · ${totalTokens.toLocaleString()} tokens indexed (in-memory, ephemeral)`)}`);
    });
}
