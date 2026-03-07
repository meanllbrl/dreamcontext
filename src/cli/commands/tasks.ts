import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { insertToSection } from '../../lib/markdown.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { success, error, header } from '../../lib/format.js';

function getStateDir(): string {
  const root = ensureContextRoot();
  return join(root, 'state');
}

function findTaskFile(name: string): string | null {
  const dir = getStateDir();
  const slug = slugify(name);

  const exact = join(dir, `${slug}.md`);
  if (existsSync(exact)) return exact;

  // Prefer exact match, then prefix, then substring
  const files = fg.sync('*.md', { cwd: dir, absolute: true });

  const exactGlob = files.find((f) => basename(f, '.md') === slug);
  if (exactGlob) return exactGlob;

  const prefixMatches = files.filter((f) => basename(f, '.md').startsWith(slug));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    error(`Ambiguous task name "${name}". Did you mean: ${prefixMatches.map(f => basename(f, '.md')).join(', ')}?`);
    return null;
  }

  const substringMatches = files.filter((f) => basename(f, '.md').includes(slug));
  if (substringMatches.length === 1) return substringMatches[0];
  if (substringMatches.length > 1) {
    error(`Ambiguous task name "${name}". Did you mean: ${substringMatches.map(f => basename(f, '.md')).join(', ')}?`);
    return null;
  }

  return null;
}

function getTaskTemplate(): string {
  const candidates = [
    join(new URL('.', import.meta.url).pathname, '..', '..', 'templates', 'task.md'),
    join(new URL('.', import.meta.url).pathname, '..', 'templates', 'task.md'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }

  // Inline fallback
  return `---
id: "{{ID}}"
name: "{{NAME}}"
description: "{{DESCRIPTION}}"
priority: "{{PRIORITY}}"
status: "{{STATUS}}"
created_at: "{{DATE}}"
updated_at: "{{DATE}}"
tags: {{TAGS}}
parent_task: null
related_feature: null
---

## Why

{{WHY}}

## User Stories

- [ ] As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- (Specific, testable conditions for this task to be complete)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

## Technical Details

(Key files, services, dependencies, implementation approach.)

## Notes

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest entry at top -->

### {{DATE}} - Created
- Task created.
`;
}

export function registerTasksCommand(program: Command): void {
  const tasks = program
    .command('tasks')
    .description('Create tasks, log progress, insert into sections, and mark complete');

  // List tasks
  tasks
    .command('list')
    .description('List tasks with optional status filter')
    .option('-s, --status <status>', 'Filter by status (todo, in_progress, completed)')
    .option('-a, --all', 'Show all tasks including completed')
    .action((opts: { status?: string; all?: boolean }) => {
      const dir = getStateDir();
      const files = fg.sync('*.md', { cwd: dir, absolute: true });

      if (files.length === 0) {
        console.log(chalk.dim('No tasks.'));
        return;
      }

      const validStatuses = ['todo', 'in_progress', 'completed', 'new'];
      if (opts.status && !validStatuses.includes(opts.status)) {
        error(`Status must be one of: ${validStatuses.join(', ')}`);
        return;
      }

      const tasks: { name: string; status: string; priority: string; updated: string }[] = [];

      for (const file of files) {
        try {
          const { data } = readFrontmatter(file);
          const status = String(data.status ?? 'unknown');
          const name = basename(file, '.md');
          const priority = String(data.priority ?? '-');
          const updated = String(data.updated_at ?? data.created_at ?? '-');

          // Filter logic: --status wins, otherwise --all shows everything, default hides completed
          if (opts.status) {
            if (status !== opts.status) continue;
          } else if (!opts.all) {
            if (status === 'completed') continue;
          }

          tasks.push({ name, status, priority, updated });
        } catch { /* skip unreadable */ }
      }

      if (tasks.length === 0) {
        console.log(chalk.dim(opts.status ? `No tasks with status "${opts.status}".` : 'No active tasks.'));
        return;
      }

      console.log(header('Tasks'));
      for (const t of tasks) {
        const statusColor = t.status === 'in_progress' ? chalk.yellow : t.status === 'completed' ? chalk.green : chalk.white;
        const prio = t.priority !== '-' ? chalk.dim(` [${t.priority}]`) : '';
        console.log(`  ${statusColor(t.status.padEnd(12))} ${t.name}${prio}  ${chalk.dim(t.updated)}`);
      }
    });

  // Create task
  tasks
    .command('create')
    .argument('<name>')
    .description('Create a new task')
    .option('-d, --description <desc>', 'Task description')
    .option('-p, --priority <priority>', 'Priority (critical, high, medium, low)')
    .option('-s, --status <status>', 'Status (todo, in_progress, completed)')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('-w, --why <why>', 'Why is this task needed?')
    .action(async (name: string, opts: { description?: string; priority?: string; status?: string; tags?: string; why?: string }) => {
      const dir = getStateDir();
      const slug = slugify(name);
      const filePath = join(dir, `${slug}.md`);

      if (existsSync(filePath)) {
        error(`Task already exists: ${slug}.md`);
        return;
      }

      const validPriorities = ['critical', 'high', 'medium', 'low'];
      const validStatuses = ['todo', 'in_progress', 'completed'];

      const priority = opts.priority || 'medium';
      if (!validPriorities.includes(priority)) {
        error(`Priority must be one of: ${validPriorities.join(', ')}`);
        return;
      }

      const status = opts.status || 'todo';
      if (!validStatuses.includes(status)) {
        error(`Status must be one of: ${validStatuses.join(', ')}`);
        return;
      }

      const description = opts.description || name;
      const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const why = opts.why || '';

      const template = getTaskTemplate();
      const content = template
        .replaceAll('{{ID}}', generateId('task'))
        .replaceAll('{{NAME}}', name)
        .replaceAll('{{DESCRIPTION}}', description)
        .replaceAll('{{PRIORITY}}', priority)
        .replaceAll('{{STATUS}}', status)
        .replaceAll('{{TAGS}}', JSON.stringify(tags))
        .replaceAll('{{DATE}}', today())
        .replaceAll('{{WHY}}', why || '(To be defined)');

      writeFileSync(filePath, content, 'utf-8');
      success(`Task created: ${slug}.md`);
    });

  // Insert into a section
  tasks
    .command('insert')
    .argument('<name>')
    .argument(
      '<section>',
      'Section: why, user_stories, acceptance_criteria, constraints, technical_details, notes, changelog',
    )
    .argument('[content...]', 'Content to insert')
    .description('Insert content into a task section')
    .action(async (name: string, section: string, contentParts: string[]) => {
      const file = findTaskFile(name);
      if (!file) {
        error(`Task not found: ${name}`);
        return;
      }

      const sectionMap: Record<string, string> = {
        changelog: 'Changelog',
        notes: 'Notes',
        technical_details: 'Technical Details',
        constraints: 'Constraints & Decisions',
        user_stories: 'User Stories',
        acceptance_criteria: 'Acceptance Criteria',
        why: 'Why',
      };

      const sectionKey = section.toLowerCase();
      if (!sectionMap[sectionKey]) {
        error(`Unknown section: "${section}". Valid sections: ${Object.keys(sectionMap).join(', ')}`);
        return;
      }
      const sectionName = sectionMap[sectionKey];

      let content: string;
      if (contentParts.length > 0) {
        content = contentParts.join(' ');
      } else {
        content = await input({ message: `Content for ${sectionName}:` });
      }

      if (!content.trim()) {
        error('No content provided.');
        return;
      }

      // For changelog, auto-prepend date header
      if (sectionKey === 'changelog') {
        content = `### ${today()} - Update\n- ${content}`;
      }

      // For constraints, prepend with date
      if (sectionKey === 'constraints') {
        content = `- **[${today()}]** ${content}`;
      }

      const position =
        ['changelog', 'constraints'].includes(sectionKey)
          ? 'top'
          : 'bottom';

      try {
        insertToSection(file, sectionName, content, position as 'top' | 'bottom', true);
        updateFrontmatterFields(file, { updated_at: today() });
        success(`Inserted into ${sectionName} in ${basename(file)}`);
      } catch (err: any) {
        error(err.message);
      }
    });

  // Complete task
  tasks
    .command('complete')
    .argument('<name>')
    .argument('[summary...]', 'Completion summary')
    .description('Mark a task as completed')
    .action(async (name: string, summaryParts: string[]) => {
      const file = findTaskFile(name);
      if (!file) {
        error(`Task not found: ${name}`);
        return;
      }

      let summary: string;
      if (summaryParts.length > 0) {
        summary = summaryParts.join(' ');
      } else {
        summary = await input({ message: 'Completion summary (optional):', default: 'Task completed.' });
      }

      // Add final changelog entry
      const logContent = `### ${today()} - Completed\n- ${summary}`;
      try {
        insertToSection(file, 'Changelog', logContent, 'top');
      } catch {
        // If no changelog section, just append
        const existing = readFileSync(file, 'utf-8');
        writeFileSync(file, existing.trimEnd() + '\n\n' + logContent + '\n', 'utf-8');
      }

      updateFrontmatterFields(file, {
        status: 'completed',
        updated_at: today(),
      });

      success(`Task completed: ${basename(file, '.md')}`);
    });

  // Log entry (cross-session continuity)
  tasks
    .command('log')
    .argument('<name>')
    .argument('[content...]', 'Log entry content')
    .description('Add a changelog entry to a task (cross-session continuity)')
    .action(async (name: string, contentParts: string[]) => {
      const file = findTaskFile(name);
      if (!file) {
        error(`Task not found: ${name}`);
        return;
      }

      let content: string;
      if (contentParts.length > 0) {
        content = contentParts.join(' ');
      } else {
        content = await input({ message: 'Log entry:' });
      }

      if (!content.trim()) {
        error('No content provided.');
        return;
      }

      const logContent = `### ${today()} - Session Update\n- ${content}`;

      try {
        insertToSection(file, 'Changelog', logContent, 'top');
      } catch {
        const existing = readFileSync(file, 'utf-8');
        writeFileSync(file, existing.trimEnd() + '\n\n' + logContent + '\n', 'utf-8');
      }

      updateFrontmatterFields(file, { updated_at: today() });
      success(`Log entry added to ${basename(file, '.md')}`);
    });
}
