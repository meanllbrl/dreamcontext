import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { insertToSection, readSection, extractMermaidNodes, nodeStatus, countCheckboxes } from '../../lib/markdown.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { success, error, header } from '../../lib/format.js';
import { getActivePlanningVersion } from '../../lib/active-version.js';
import { mergeRice, normalizeRice, validateRiceInput, type RiceFields, type RiceInput } from '../../lib/rice.js';
import {
  toTaskRecord,
  filterTasks,
  groupTasks,
  collectTags,
  GROUP_BY_FIELDS,
  type TaskRecord,
  type TaskFilter,
  type GroupBy,
} from '../../lib/task-query.js';

function getStateDir(): string {
  const root = ensureContextRoot();
  return join(root, 'state');
}

/** Commander collector for repeatable string options (e.g. `--tag a --tag b`). */
function collectOption(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

/** Render one task as a colorized human-readable line. */
function renderTaskLine(t: TaskRecord, opts: { long?: boolean } = {}): string {
  const statusColor =
    t.status === 'in_progress' ? chalk.yellow
    : t.status === 'in_review' ? chalk.magenta
    : t.status === 'completed' ? chalk.green
    : chalk.white;
  const prio = t.priority !== '-' ? chalk.dim(` [${t.priority}]`) : '';
  let line = `  ${statusColor(t.status.padEnd(12))} ${t.name}${prio}  ${chalk.dim(t.updated_at)}`;
  if (opts.long) {
    const meta: string[] = [];
    if (t.version) meta.push(`v:${t.version}`);
    if (t.tags.length > 0) meta.push(t.tags.map((tag) => `#${tag}`).join(' '));
    if (meta.length > 0) line += `\n${' '.repeat(15)}${chalk.dim(meta.join('  '))}`;
  }
  return line;
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
urgency: "{{URGENCY}}"
status: "{{STATUS}}"
created_at: "{{DATE}}"
updated_at: "{{DATE}}"
tags: {{TAGS}}
parent_task: null
related_feature: null
version: {{VERSION}}
---

## Workflow
<!-- The shape of this task at a glance. One node per acceptance criterion, grouped under milestone subgraphs. Update node classes as work progresses: \`:::done\` (green), \`:::active\` (amber), \`:::todo\` (gray), \`:::blocked\` (red). Run \`dreamcontext tasks doctor\` to verify sync. -->

\`\`\`mermaid
flowchart TD
  subgraph M1 ["Milestone 1 — rename me"]
    A1[First criterion]:::todo
  end

  classDef done fill:#86efac,stroke:#15803d,color:#052e16
  classDef active fill:#fde68a,stroke:#b45309,color:#451a03
  classDef todo fill:#e5e7eb,stroke:#6b7280,color:#111827
  classDef blocked fill:#fecaca,stroke:#b91c1c,color:#450a0a
\`\`\`

## Why
<!-- What problem does this solve? What breaks if we don't do it? Be concrete — name the user, the friction, the cost. -->

{{WHY}}

## User Stories
<!-- As a <role>, I can <action>, so that <outcome>. Tick when demonstrably true in the running system. -->

- [ ] As a [role], I can [action], so that [outcome]

## Acceptance Criteria
<!-- The contract. Each line is testable and gets a node in the Workflow flowchart above. -->

- [ ] First criterion (matches node A1 in Workflow)

## Constraints & Decisions
<!-- LIFO: newest at top. Capture the why, not just the what. -->

## Technical Details
<!-- Where the work lives. Files, services, key functions to reuse. Body is current truth — update in place; don't append. -->

(Key files, services, dependencies, implementation approach.)

## Notes
<!-- Loose ends, edge cases, open questions. -->

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest at top. Auto-prepended by \`dreamcontext tasks log\`. -->

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
    .description('List tasks, with filters, grouping, tag discovery, and JSON output')
    .option('-s, --status <status>', 'Filter by status (todo, in_progress, in_review, completed)')
    .option('-a, --all', 'Show all tasks including completed')
    .option('--tag <tag>', 'Filter by tag (repeatable; AND semantics)', collectOption, [])
    .option('--any-tag <tag>', 'Filter by tag (repeatable; OR semantics)', collectOption, [])
    .option('--version <id>', 'Filter by version/milestone (e.g. S5, BACKLOG, memoryos-v2)')
    .option('--priority <level>', 'Filter by priority (critical, high, medium, low)')
    .option('--feature <slug>', 'Filter by related_feature')
    .option('-g, --group-by <field>', `Group output by ${GROUP_BY_FIELDS.join('|')}`)
    .option('--long', 'Show tags + version inline in human output')
    .option('--tags', 'List distinct tags with counts (respects -s/--all; ignores other filters)')
    .option('--json', 'Emit the filtered tasks as JSON (flat array)')
    .action((opts: {
      status?: string; all?: boolean; tag?: string[]; anyTag?: string[];
      version?: string; priority?: string; feature?: string;
      groupBy?: string; long?: boolean; tags?: boolean; json?: boolean;
    }) => {
      const dir = getStateDir();
      const files = fg.sync('*.md', { cwd: dir, absolute: true });

      const validStatuses = ['todo', 'in_progress', 'in_review', 'completed'];
      if (opts.status && !validStatuses.includes(opts.status)) {
        error(`Status must be one of: ${validStatuses.join(', ')}`);
        return;
      }
      const validPriorities = ['critical', 'high', 'medium', 'low'];
      if (opts.priority && !validPriorities.includes(opts.priority)) {
        error(`Priority must be one of: ${validPriorities.join(', ')}`);
        return;
      }
      if (opts.groupBy && !GROUP_BY_FIELDS.includes(opts.groupBy as GroupBy)) {
        error(`--group-by must be one of: ${GROUP_BY_FIELDS.join(', ')}`);
        return;
      }

      const all: TaskRecord[] = [];
      for (const file of files) {
        try {
          const { data } = readFrontmatter<Record<string, unknown>>(file);
          all.push(toTaskRecord(data, basename(file, '.md'), file));
        } catch { /* skip unreadable */ }
      }

      // Tag discovery: visibility filters only (status/all), other narrowing ignored.
      if (opts.tags) {
        const visible = filterTasks(all, { status: opts.status, all: opts.all });
        const counts = collectTags(visible);
        if (opts.json) { console.log(JSON.stringify(counts, null, 2)); return; }
        if (counts.length === 0) { console.log(chalk.dim('No tags.')); return; }
        console.log(header('Tags'));
        const width = Math.max(...counts.map((c) => c.tag.length));
        for (const c of counts) {
          console.log(`  ${c.tag.padEnd(width)}  ${chalk.dim(String(c.count))}`);
        }
        return;
      }

      const filter: TaskFilter = {
        status: opts.status,
        all: opts.all,
        tags: opts.tag,
        anyTags: opts.anyTag,
        version: opts.version,
        priority: opts.priority,
        feature: opts.feature,
      };
      const matched = filterTasks(all, filter);

      if (opts.json) {
        console.log(JSON.stringify(matched, null, 2));
        return;
      }

      if (matched.length === 0) {
        const narrowed = (opts.tag && opts.tag.length > 0) || (opts.anyTag && opts.anyTag.length > 0)
          || opts.version || opts.priority || opts.feature;
        const msg = files.length === 0 ? 'No tasks.'
          : opts.status ? `No tasks with status "${opts.status}".`
          : narrowed ? 'No tasks match the given filters.'
          : 'No active tasks.';
        console.log(chalk.dim(msg));
        return;
      }

      console.log(header('Tasks'));
      if (opts.groupBy) {
        for (const g of groupTasks(matched, opts.groupBy as GroupBy)) {
          console.log(`\n  ${chalk.bold(g.key)} ${chalk.dim(`(${g.tasks.length})`)}`);
          for (const t of g.tasks) console.log(renderTaskLine(t, { long: opts.long }));
        }
      } else {
        for (const t of matched) console.log(renderTaskLine(t, { long: opts.long }));
      }
    });

  // Tag discovery (canonical form of `tasks list --tags`)
  tasks
    .command('tags')
    .description('List distinct task tags with counts')
    .option('-a, --all', 'Include completed tasks in the counts')
    .option('--json', 'Emit tag counts as JSON')
    .action((opts: { all?: boolean; json?: boolean }) => {
      const dir = getStateDir();
      const files = fg.sync('*.md', { cwd: dir, absolute: true });
      const all: TaskRecord[] = [];
      for (const file of files) {
        try {
          const { data } = readFrontmatter<Record<string, unknown>>(file);
          all.push(toTaskRecord(data, basename(file, '.md'), file));
        } catch { /* skip unreadable */ }
      }
      const counts = collectTags(filterTasks(all, { all: opts.all }));
      if (opts.json) { console.log(JSON.stringify(counts, null, 2)); return; }
      if (counts.length === 0) { console.log(chalk.dim('No tags.')); return; }
      console.log(header('Tags'));
      const width = Math.max(...counts.map((c) => c.tag.length));
      for (const c of counts) {
        console.log(`  ${c.tag.padEnd(width)}  ${chalk.dim(String(c.count))}`);
      }
    });

  // Create task
  tasks
    .command('create')
    .argument('<name>')
    .description('Create a new task')
    .option('-d, --description <desc>', 'Task description')
    .option('-p, --priority <priority>', 'Priority (critical, high, medium, low)')
    .option('-u, --urgency <level>', 'Urgency (critical, high, medium, low)')
    .option('-s, --status <status>', 'Status (todo, in_progress, in_review, completed)')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('-w, --why <why>', 'Why is this task needed?')
    .option('-v, --version <version>', 'Version/milestone')
    .option('--reach <n>', 'RICE reach (integer 1–10)')
    .option('--impact <n>', 'RICE impact (integer 1–5)')
    .option('--confidence <n>', 'RICE confidence (25, 50, 75, or 100)')
    .option('--effort <n>', 'RICE effort in weeks (> 0, ≤ 52)')
    .action(async (name: string, opts: { description?: string; priority?: string; urgency?: string; status?: string; tags?: string; why?: string; version?: string; reach?: string; impact?: string; confidence?: string; effort?: string }) => {
      const dir = getStateDir();
      const slug = slugify(name);
      const filePath = join(dir, `${slug}.md`);

      if (existsSync(filePath)) {
        error(`Task already exists: ${slug}.md`);
        return;
      }

      const validPriorities = ['critical', 'high', 'medium', 'low'];
      const validStatuses = ['todo', 'in_progress', 'in_review', 'completed'];

      const priority = opts.priority || 'medium';
      if (!validPriorities.includes(priority)) {
        error(`Priority must be one of: ${validPriorities.join(', ')}`);
        return;
      }

      const urgency = opts.urgency || 'medium';
      if (!validPriorities.includes(urgency)) {
        error(`Urgency must be one of: ${validPriorities.join(', ')}`);
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
      const version = opts.version || getActivePlanningVersion();

      const riceInput: RiceInput = {};
      if (opts.reach !== undefined) riceInput.reach = Number(opts.reach);
      if (opts.impact !== undefined) riceInput.impact = Number(opts.impact);
      if (opts.confidence !== undefined) riceInput.confidence = Number(opts.confidence);
      if (opts.effort !== undefined) riceInput.effort = Number(opts.effort);
      let riceBlock: RiceFields | null = null;
      if (Object.keys(riceInput).length > 0) {
        const errs = validateRiceInput(riceInput);
        if (errs.length > 0) {
          error(errs.map(e => `${e.field}: ${e.message}`).join('; '));
          return;
        }
        riceBlock = mergeRice(null, riceInput);
      }

      const template = getTaskTemplate();
      const content = template
        .replaceAll('{{ID}}', generateId('task'))
        .replaceAll('{{NAME}}', name)
        .replaceAll('{{DESCRIPTION}}', description)
        .replaceAll('{{PRIORITY}}', priority)
        .replaceAll('{{URGENCY}}', urgency)
        .replaceAll('{{STATUS}}', status)
        .replaceAll('{{TAGS}}', JSON.stringify(tags))
        .replaceAll('{{DATE}}', today())
        .replaceAll('{{WHY}}', why || '(To be defined)')
        .replaceAll('{{VERSION}}', version ? `"${version}"` : 'null');

      writeFileSync(filePath, content, 'utf-8');
      if (riceBlock) {
        updateFrontmatterFields(filePath, { rice: riceBlock });
      }
      success(`Task created: ${slug}.md`);
    });

  // RICE: print or update RICE values for a task
  tasks
    .command('rice')
    .argument('<name>', 'Task slug or name')
    .description('Print or update RICE values (reach × impact × confidence ÷ effort)')
    .option('--reach <n>', 'RICE reach (integer 1–10)')
    .option('--impact <n>', 'RICE impact (integer 1–5)')
    .option('--confidence <n>', 'RICE confidence (25, 50, 75, or 100)')
    .option('--effort <n>', 'RICE effort in weeks (> 0, ≤ 52)')
    .option('--clear', 'Clear all RICE values on this task')
    .action((name: string, opts: { reach?: string; impact?: string; confidence?: string; effort?: string; clear?: boolean }) => {
      const file = findTaskFile(name);
      if (!file) {
        error(`Task not found: ${name}`);
        return;
      }
      const slug = basename(file, '.md');
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      const existing = normalizeRice(data.rice);

      const hasFlag = opts.reach !== undefined || opts.impact !== undefined || opts.confidence !== undefined || opts.effort !== undefined;

      if (opts.clear) {
        if (hasFlag) {
          error('--clear cannot be combined with rating flags.');
          return;
        }
        updateFrontmatterFields(file, { rice: null, updated_at: today() });
        success(`Cleared RICE on ${slug}`);
        return;
      }

      if (!hasFlag) {
        // Print current values
        if (!existing) {
          console.log(chalk.dim(`No RICE values on ${slug}.`));
          return;
        }
        console.log(header(`RICE: ${slug}`));
        console.log(`  reach:      ${existing.reach ?? '—'}`);
        console.log(`  impact:     ${existing.impact ?? '—'}`);
        console.log(`  confidence: ${existing.confidence ?? '—'}`);
        console.log(`  effort:     ${existing.effort ?? '—'}`);
        console.log(`  ${chalk.bold('score:')}      ${existing.score ?? chalk.dim('— (incomplete)')}`);
        return;
      }

      const patch: RiceInput = {};
      if (opts.reach !== undefined) patch.reach = Number(opts.reach);
      if (opts.impact !== undefined) patch.impact = Number(opts.impact);
      if (opts.confidence !== undefined) patch.confidence = Number(opts.confidence);
      if (opts.effort !== undefined) patch.effort = Number(opts.effort);

      const errs = validateRiceInput(patch);
      if (errs.length > 0) {
        error(errs.map(e => `${e.field}: ${e.message}`).join('; '));
        return;
      }

      const next = mergeRice(existing, patch);
      updateFrontmatterFields(file, { rice: next, updated_at: today() });
      const scoreStr = next?.score === null || next?.score === undefined ? '— (incomplete)' : String(next.score);
      success(`RICE updated on ${slug} — score: ${scoreStr}`);
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

  // Change status (todo, in_progress, in_review, completed)
  tasks
    .command('status')
    .argument('<name>')
    .argument('<new-status>', 'todo, in_progress, in_review, or completed')
    .argument('[reason...]', 'Optional reason for the status change')
    .description('Change a task\'s status (logs the change in the changelog)')
    .action(async (name: string, newStatus: string, reasonParts: string[]) => {
      const validStatuses = ['todo', 'in_progress', 'in_review', 'completed'];
      if (!validStatuses.includes(newStatus)) {
        error(`Status must be one of: ${validStatuses.join(', ')}`);
        return;
      }

      const file = findTaskFile(name);
      if (!file) {
        error(`Task not found: ${name}`);
        return;
      }

      const reason = reasonParts.join(' ').trim();
      const headerLabel = newStatus === 'completed' ? 'Completed' : `Status → ${newStatus}`;
      const logContent = reason
        ? `### ${today()} - ${headerLabel}\n- ${reason}`
        : `### ${today()} - ${headerLabel}`;

      try {
        insertToSection(file, 'Changelog', logContent, 'top');
      } catch {
        const existing = readFileSync(file, 'utf-8');
        writeFileSync(file, existing.trimEnd() + '\n\n' + logContent + '\n', 'utf-8');
      }

      updateFrontmatterFields(file, { status: newStatus, updated_at: today() });
      success(`Task ${basename(file, '.md')} → ${newStatus}`);
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

  // Doctor: validate Workflow flowchart matches Acceptance Criteria
  tasks
    .command('doctor')
    .argument('[name]', 'Task name (omit to check every task)')
    .description('Validate Workflow flowchart is in sync with Acceptance Criteria')
    .action((name?: string) => {
      const dir = getStateDir();
      const files: string[] = name
        ? (() => {
            const f = findTaskFile(name);
            if (!f) {
              error(`Task not found: ${name}`);
              return [];
            }
            return [f];
          })()
        : fg.sync('*.md', { cwd: dir, absolute: true });

      if (files.length === 0) return;

      let drift = 0;
      console.log(header(name ? `Workflow check: ${basename(files[0], '.md')}` : 'Workflow check'));

      for (const file of files) {
        const slug = basename(file, '.md');
        const issues = checkWorkflow(file);
        if (issues.length === 0) {
          console.log(`  ${chalk.green('ok')}      ${slug}`);
        } else {
          drift++;
          console.log(`  ${chalk.red('drift')}   ${slug}`);
          for (const issue of issues) console.log(`            ${chalk.dim('-')} ${issue}`);
        }
      }

      if (drift > 0) {
        error(`${drift} task(s) have flowchart drift. Update the \`## Workflow\` mermaid block to match Acceptance Criteria.`);
        process.exitCode = 1;
      } else {
        success(`All ${files.length} task(s) clean.`);
      }
    });
}

function checkWorkflow(file: string): string[] {
  const issues: string[] = [];
  const workflow = readSection(file, 'Workflow');
  if (workflow === null) {
    issues.push('Missing `## Workflow` section.');
    return issues;
  }
  if (!/```mermaid[\s\S]*?```/.test(workflow)) {
    issues.push('No ```mermaid``` block in Workflow section.');
    return issues;
  }

  const nodes = extractMermaidNodes(workflow);
  if (nodes.length === 0) {
    issues.push('Mermaid block has no recognisable nodes.');
  }

  for (const n of nodes) {
    if (!nodeStatus(n)) {
      issues.push(`Node "${n.id}" has no status class (done/active/todo/blocked).`);
    }
  }

  const ac = readSection(file, 'Acceptance Criteria');
  if (ac === null) {
    issues.push('Missing `## Acceptance Criteria` section.');
    return issues;
  }
  const { total, done } = countCheckboxes(ac);

  if (total === 0) {
    if (nodes.length > 1) {
      issues.push(`Workflow has ${nodes.length} nodes but Acceptance Criteria has no checkboxes.`);
    }
    return issues;
  }

  if (nodes.length !== total) {
    issues.push(`Node count (${nodes.length}) ≠ acceptance-criteria checkbox count (${total}).`);
  }

  const doneNodes = nodes.filter((n) => nodeStatus(n) === 'done').length;
  if (doneNodes !== done) {
    issues.push(`${doneNodes} node(s) marked :::done, but ${done} criterion(s) checked [x].`);
  }

  return issues;
}
