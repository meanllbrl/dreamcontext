import { Command } from 'commander';
import { join, basename, dirname } from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readSection, extractMermaidNodes, nodeStatus, countCheckboxes } from '../../lib/markdown.js';
import { prepareSectionInsert, SECTION_MAP } from '../../lib/section-insert.js';
import { promptInput } from '../../lib/prompt.js';
import { slugify, today } from '../../lib/id.js';
import { success, error, header } from '../../lib/format.js';
import { readSetupConfig, isMultiPerson } from '../../lib/setup-config.js';
import { getActivePlanningVersion } from '../../lib/active-version.js';
import { mergeRice, validateRiceInput, type RiceFields, type RiceInput } from '../../lib/rice.js';
import {
  getTaskBackend,
  installTaskSyncHooks,
  uninstallTaskSyncHooks,
  TaskBackendError,
  type TaskBackend,
} from '../../lib/task-backend/index.js';
import {
  GROUP_BY_FIELDS,
  collectTags,
  groupTasks,
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

/**
 * Resolve a fuzzy task name through the backend, printing the exact
 * pre-refactor error messages (ambiguity / not found). Returns the slug or null.
 */
async function resolveTaskSlug(backend: TaskBackend, name: string): Promise<string | null> {
  const res = await backend.resolveSlug(name);
  if (res.kind === 'match') return res.slug;
  if (res.kind === 'ambiguous') {
    error(`Ambiguous task name "${name}". Did you mean: ${res.candidates.join(', ')}?`);
  }
  // Pre-refactor parity: ambiguity printed its hint AND the not-found line.
  error(`Task not found: ${name}`);
  return null;
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
    .action(async (opts: {
      status?: string; all?: boolean; tag?: string[]; anyTag?: string[];
      version?: string; priority?: string; feature?: string;
      groupBy?: string; long?: boolean; tags?: boolean; json?: boolean;
    }) => {
      const backend = getTaskBackend();

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

      // Tag discovery: visibility filters only (status/all), other narrowing ignored.
      if (opts.tags) {
        const visible = await backend.list({ status: opts.status, all: opts.all });
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
      const matched = await backend.list(filter);

      if (opts.json) {
        console.log(JSON.stringify(matched, null, 2));
        return;
      }

      if (matched.length === 0) {
        const total = (await backend.list({ all: true })).length;
        const narrowed = (opts.tag && opts.tag.length > 0) || (opts.anyTag && opts.anyTag.length > 0)
          || opts.version || opts.priority || opts.feature;
        const msg = total === 0 ? 'No tasks.'
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
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const backend = getTaskBackend();
      const counts = collectTags(await backend.list({ all: opts.all }));
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
    .option('--person <name>', 'Responsible person (records a person:<slug> tag when multi-person)')
    .option('--reach <n>', 'RICE reach (integer 1–10)')
    .option('--impact <n>', 'RICE impact (integer 1–5)')
    .option('--confidence <n>', 'RICE confidence (25, 50, 75, or 100)')
    .option('--effort <n>', 'RICE effort in weeks (> 0, ≤ 52)')
    .action(async (name: string, opts: { description?: string; priority?: string; urgency?: string; status?: string; tags?: string; why?: string; version?: string; person?: string; reach?: string; impact?: string; confidence?: string; effort?: string }) => {
      const backend = getTaskBackend();
      const slug = slugify(name);

      if ((await backend.get(slug)) !== null) {
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
      // Person attribution rides the tags array as `person:<slug>` (no new
      // frontmatter field, so existing task-query tag handling just works). The
      // tag is injected ONLY when the project is multi-person; single-person
      // projects never get it (`--person` is a silent no-op there).
      if (opts.person && opts.person.trim()) {
        const projectRoot = dirname(ensureContextRoot());
        if (isMultiPerson(readSetupConfig(projectRoot))) {
          const personTag = `person:${slugify(opts.person)}`;
          if (!tags.includes(personTag)) tags.push(personTag);
        }
      }
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

      try {
        await backend.create({
          name,
          description,
          priority,
          urgency,
          status,
          tags,
          why,
          version,
          rice: riceBlock,
          variant: 'cli',
        });
      } catch (err) {
        if (err instanceof TaskBackendError && err.code === 'already_exists') {
          error(`Task already exists: ${slug}.md`);
          return;
        }
        throw err;
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
    .action(async (name: string, opts: { reach?: string; impact?: string; confidence?: string; effort?: string; clear?: boolean }) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;
      const task = await backend.get(slug);
      if (!task) {
        error(`Task not found: ${name}`);
        return;
      }
      const existing = task.rice;

      const hasFlag = opts.reach !== undefined || opts.impact !== undefined || opts.confidence !== undefined || opts.effort !== undefined;

      if (opts.clear) {
        if (hasFlag) {
          error('--clear cannot be combined with rating flags.');
          return;
        }
        await backend.updateFields(slug, { rice: null, updated_at: today() });
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
      await backend.updateFields(slug, { rice: next, updated_at: today() });
      const scoreStr = next?.score === null || next?.score === undefined ? '— (incomplete)' : String(next.score);
      success(`RICE updated on ${slug} — score: ${scoreStr}`);
    });

  // Tag management on existing tasks (person:<slug> tags drive remote assignees)
  tasks
    .command('tag')
    .argument('<name>', 'Task slug or name')
    .argument('<tags...>', 'Tags to add (or remove with --remove); person:<slug> assigns a person')
    .description('Add or remove tags on a task')
    .option('--remove', 'Remove the given tags instead of adding them')
    .action(async (name: string, tagArgs: string[], opts: { remove?: boolean }) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      const task = await backend.get(slug);
      if (!task) {
        error(`Task not found: ${name}`);
        return;
      }

      const given = tagArgs
        .flatMap((t) => t.split(','))
        .map((t) => t.trim())
        .filter(Boolean);
      if (given.length === 0) {
        error('No tags provided.');
        return;
      }

      let next: string[];
      if (opts.remove) {
        const drop = new Set(given.map((t) => t.toLowerCase()));
        next = task.tags.filter((t) => !drop.has(t.toLowerCase()));
      } else {
        next = [...task.tags];
        for (const t of given) {
          if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
        }
        // A person tag is an assignment — only one person tag at a time.
        const persons = next.filter((t) => t.startsWith('person:'));
        if (persons.length > 1) {
          const keep = given.filter((t) => t.startsWith('person:')).pop() ?? persons[persons.length - 1];
          next = next.filter((t) => !t.startsWith('person:') || t === keep);
        }
      }

      await backend.updateFields(slug, { tags: next, updated_at: today() });
      success(`Tags on ${slug}: ${next.length > 0 ? next.join(', ') : '(none)'}`);
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
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      const sectionKey = section.toLowerCase();
      if (!SECTION_MAP[sectionKey]) {
        error(`Unknown section: "${section}". Valid sections: ${Object.keys(SECTION_MAP).join(', ')}`);
        return;
      }

      const rawContent = contentParts.length > 0
        ? contentParts.join(' ')
        : await promptInput({ message: `Content for ${SECTION_MAP[sectionKey]}:` });

      if (!rawContent.trim()) {
        error('No content provided.');
        return;
      }

      const prep = prepareSectionInsert(sectionKey, rawContent, today())!;

      try {
        await backend.insertSection(slug, prep.sectionName, prep.content, {
          position: prep.position,
          replacePlaceholders: prep.replacePlaceholders,
        });
        await backend.updateFields(slug, { updated_at: today() });
        success(`Inserted into ${prep.sectionName} in ${slug}.md`);
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
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      let summary: string;
      if (summaryParts.length > 0) {
        summary = summaryParts.join(' ');
      } else {
        summary = await promptInput({ message: 'Completion summary (optional):', default: 'Task completed.' });
      }

      await backend.complete(slug, summary);
      success(`Task completed: ${slug}`);
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

      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      const reason = reasonParts.join(' ').trim();
      const headerLabel = newStatus === 'completed' ? 'Completed' : `Status → ${newStatus}`;
      const logContent = reason
        ? `### ${today()} - ${headerLabel}\n- ${reason}`
        : `### ${today()} - ${headerLabel}`;

      await backend.addChangelog(slug, logContent, { fallbackAppend: true });
      await backend.updateFields(slug, { status: newStatus, updated_at: today() });
      success(`Task ${slug} → ${newStatus}`);
    });

  // Log entry (cross-session continuity)
  tasks
    .command('log')
    .argument('<name>')
    .argument('[content...]', 'Log entry content')
    .description('Add a changelog entry to a task (cross-session continuity)')
    .action(async (name: string, contentParts: string[]) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      let content: string;
      if (contentParts.length > 0) {
        content = contentParts.join(' ');
      } else {
        content = await promptInput({ message: 'Log entry:' });
      }

      if (!content.trim()) {
        error('No content provided.');
        return;
      }

      const logContent = `### ${today()} - Session Update\n- ${content}`;

      await backend.addChangelog(slug, logContent, { fallbackAppend: true });
      await backend.updateFields(slug, { updated_at: today() });
      success(`Log entry added to ${slug}`);
    });

  // Sync with the remote backend (no-op for local)
  tasks
    .command('sync')
    .argument('[direction]', 'push, pull, or both (default: both)')
    .description('Sync tasks with the configured remote backend (no-op for local)')
    .option('--hook', 'Best-effort mode for git hooks: never fails, bounded time, exit 0')
    .option('--json', 'Emit the sync report as JSON')
    .action(async (direction: string | undefined, opts: { hook?: boolean; json?: boolean }) => {
      const dir = (direction ?? 'both') as 'push' | 'pull' | 'both';
      if (!['push', 'pull', 'both'].includes(dir)) {
        error('Direction must be one of: push, pull, both');
        return;
      }
      try {
        const backend = getTaskBackend();
        const report = opts.hook
          ? await Promise.race([
              backend.sync(dir),
              new Promise<null>((resolveTimeout) => {
                const t = setTimeout(() => resolveTimeout(null), 15000);
                (t as unknown as { unref?: () => void }).unref?.();
              }),
            ])
          : await backend.sync(dir);
        if (report === null) {
          // Hook-mode timeout: report and exit clean — git must never block.
          console.log(chalk.dim('tasks sync: timed out (hook mode) — skipped.'));
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (report.noop) {
          console.log(chalk.dim(`Task backend is "${report.backend}" — nothing to sync.`));
          return;
        }
        success(`Sync (${report.direction}): pushed ${report.pushed}, pulled ${report.pulled}, created ${report.created}, comments ${report.commentsAdded}`);
        if (report.pendingQueue > 0) {
          console.log(chalk.yellow(`  ${report.pendingQueue} queued op(s) pending (offline?) — will replay on next sync.`));
        }
        for (const c of report.conflicts) {
          console.log(chalk.yellow(`  conflict: ${c.slug} (${c.reason}) — local copy saved to ${c.savedTo}`));
        }
        for (const e of report.errors) {
          console.log(chalk.red(`  error: ${e}`));
        }
      } catch (err) {
        if (opts.hook) {
          // Best-effort: a sync failure must NEVER fail the git operation.
          console.log(chalk.dim(`tasks sync: skipped (${(err as Error).message ?? err})`));
          return;
        }
        error(`Sync failed: ${(err as Error).message ?? err}`);
        process.exitCode = 1;
      }
    });

  // Remote members (assignee candidates) — generic: any remote backend may expose them
  tasks
    .command('members')
    .description('List people with access to the remote task container (assignee candidates)')
    .option('--json', 'Emit members as JSON')
    .action(async (opts: { json?: boolean }) => {
      const backend = getTaskBackend();
      if (!backend.listMembers) {
        console.log(chalk.dim(`Task backend is "${backend.name}" — no remote members.`));
        return;
      }
      try {
        const members = await backend.listMembers();
        if (opts.json) { console.log(JSON.stringify(members, null, 2)); return; }
        if (members.length === 0) { console.log(chalk.dim('No members found.')); return; }
        console.log(header('Members'));
        const width = Math.max(...members.map((m) => m.slug.length));
        for (const m of members) {
          console.log(`  ${m.slug.padEnd(width)}  ${chalk.white(m.name)}${m.email ? chalk.dim(`  ${m.email}`) : ''}  ${chalk.dim(`id:${m.id}`)}`);
        }
        console.log(chalk.dim('\n  Assign with a person tag (`--tags person:<slug>`) or the assignee field — sync maps it to the remote member.'));
      } catch (err) {
        error(`Could not fetch members: ${(err as Error).message ?? err}`);
        process.exitCode = 1;
      }
    });

  // Git sync triggers (issue #11 M5): best-effort hooks that can never fail git
  tasks
    .command('sync-hooks')
    .argument('<action>', 'install | uninstall')
    .description('Install/uninstall best-effort git sync triggers (post-commit, pre-push)')
    .action((action: string) => {
      const projectRoot = dirname(ensureContextRoot());
      if (action === 'install') {
        const res = installTaskSyncHooks(projectRoot);
        if (res.noGit) {
          error('Not a git repository — nothing to install into.');
          return;
        }
        if (res.installed.length > 0) {
          success(`Installed git sync hooks: ${res.installed.join(', ')} (best-effort; they can never fail or block git).`);
        }
        for (const skipped of res.skipped) {
          error(`Skipped ${skipped}: a non-dreamcontext hook already exists there.`);
        }
      } else if (action === 'uninstall') {
        const removed = uninstallTaskSyncHooks(projectRoot);
        if (removed.length > 0) success(`Removed git sync hooks: ${removed.join(', ')}`);
        else console.log(chalk.dim('No managed git sync hooks found.'));
      } else {
        error('Action must be one of: install, uninstall');
      }
    });

  // Doctor: validate Workflow flowchart matches Acceptance Criteria
  // (doctor stays local-only by design — issue #11)
  tasks
    .command('doctor')
    .argument('[name]', 'Task name (omit to check every task)')
    .description('Validate Workflow flowchart is in sync with Acceptance Criteria')
    .action(async (name?: string) => {
      const dir = getStateDir();
      let files: string[];
      if (name) {
        const backend = getTaskBackend();
        const slug = await resolveTaskSlug(backend, name);
        if (!slug) return;
        files = [join(dir, `${slug}.md`)];
      } else {
        files = fg.sync('*.md', { cwd: dir, absolute: true });
      }

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
