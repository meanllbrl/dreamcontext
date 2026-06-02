import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { writeFrontmatter } from '../../lib/frontmatter.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { success, error, info, header } from '../../lib/format.js';
import { buildKnowledgeIndex, STANDARD_TAGS } from '../../lib/knowledge-index.js';
import { readSleepState, writeSleepState, bumpKnowledgeAccess } from './sleep.js';

function getKnowledgeDir(): string {
  const root = ensureContextRoot();
  return join(root, 'knowledge');
}

export function registerKnowledgeCommand(program: Command): void {
  const knowledge = program
    .command('knowledge')
    .description('Create and index knowledge files');

  // Create
  knowledge
    .command('create')
    .argument('<name>')
    .option('-d, --description <desc>', 'Description')
    .option('-t, --tags <tags>', 'Tags (comma-separated)')
    .option('-c, --content <content>', 'Content body')
    .description('Create a new knowledge file')
    .action(async (name: string, opts: { description?: string; tags?: string; content?: string }) => {
      const dir = getKnowledgeDir();
      const slug = slugify(name);
      const filePath = join(dir, `${slug}.md`);

      if (existsSync(filePath)) {
        error(`Knowledge file already exists: ${slug}.md`);
        return;
      }

      const description = opts.description || await input({ message: 'Description:' });
      const tagsStr = opts.tags || await input({ message: 'Tags (comma-separated):' });
      const content = opts.content || await input({ message: 'Content:' });

      const tags = tagsStr.split(',').map((s) => s.trim()).filter(Boolean);

      writeFrontmatter(
        filePath,
        {
          id: generateId('know'),
          name,
          description,
          tags,
          pinned: false,
          date: today(),
        },
        `\n${content || '(Content to be added)'}\n`,
      );
      success(`Knowledge file created: ${slug}.md`);
    });

  // Index
  knowledge
    .command('index')
    .description('Show knowledge file index (names, descriptions, tags)')
    .option('--plain', 'Plain text output (no colors, for piping)')
    .option('--tag <tag>', 'Filter by tag (case-insensitive)')
    .action((opts: { plain?: boolean; tag?: string }) => {
      const root = ensureContextRoot();
      let entries = buildKnowledgeIndex(root);

      if (opts.tag) {
        const tag = opts.tag.toLowerCase();
        entries = entries.filter(e => e.tags.some(t => t.toLowerCase() === tag));
      }

      if (entries.length === 0) {
        const suffix = opts.tag ? ` matching tag "${opts.tag}"` : '';
        if (opts.plain) {
          console.log(`No knowledge files found${suffix}.`);
        } else {
          info(`No knowledge files found${suffix}.`);
        }
        return;
      }

      if (opts.plain) {
        for (const entry of entries) {
          const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
          const pin = entry.pinned ? ' (pinned)' : '';
          console.log(`- ${entry.slug}: ${entry.description}${tagsStr}${pin}`);
        }
      } else {
        const tagLabel = opts.tag ? ` (tag: ${opts.tag})` : '';
        console.log(header(`Knowledge Index${tagLabel}`));
        for (const entry of entries) {
          const tagsStr = entry.tags.length > 0
            ? chalk.dim(` [${entry.tags.join(', ')}]`)
            : '';
          const pin = entry.pinned ? chalk.yellow(' ★ pinned') : '';
          console.log(`  ${chalk.magentaBright(entry.slug)}${pin}`);
          console.log(`    ${entry.description}${tagsStr}`);
        }
        console.log(`\n  ${chalk.dim(`${entries.length} knowledge file(s)`)}`);
      }
    });

  // Tags
  knowledge
    .command('tags')
    .description('List standard knowledge tags')
    .option('--plain', 'Plain text output (no colors)')
    .action((opts: { plain?: boolean }) => {
      if (opts.plain) {
        for (const tag of STANDARD_TAGS) {
          console.log(tag);
        }
      } else {
        console.log(header('Standard Knowledge Tags'));
        console.log(chalk.dim('  Use these when creating or tagging knowledge files.'));
        console.log(chalk.dim('  Custom tags are also allowed.\n'));
        for (const tag of STANDARD_TAGS) {
          console.log(`  ${chalk.magentaBright(tag)}`);
        }
      }
    });

  // Touch (access tracking)
  knowledge
    .command('touch')
    .argument('<slug>', 'Knowledge file slug')
    .description('Record access to a knowledge file (for decay tracking)')
    .action((slug: string) => {
      const root = ensureContextRoot();
      const knowledgePath = join(root, 'knowledge', `${slug}.md`);

      if (!existsSync(knowledgePath)) {
        error(`Knowledge file not found: ${slug}.md`);
        return;
      }

      const state = readSleepState(root);
      bumpKnowledgeAccess(state, slug);

      writeSleepState(root, state);
      success(`Touched: ${slug} (access count: ${state.knowledge_access[slug].count})`);
    });
}
