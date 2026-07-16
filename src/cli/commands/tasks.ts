import { Command } from 'commander';
import { join, basename, dirname } from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readSection, extractMermaidNodes, nodeStatus, countCheckboxes } from '../../lib/markdown.js';
import { prepareSectionInsert, SECTION_MAP } from '../../lib/section-insert.js';
import { promptInput } from '../../lib/prompt.js';
import { slugify, today } from '../../lib/id.js';
import { success, error, header, warn } from '../../lib/format.js';
import { matchMember } from '../../lib/task-backend/member-match.js';
import { readSetupConfig, isMultiPerson, writeBrainLocal } from '../../lib/setup-config.js';
import { getActivePlanningVersion } from '../../lib/active-version.js';
import { getExistingReleases } from '../../lib/release-discovery.js';
import { foldAscii } from '../../lib/fold-ascii.js';
import { listObjectives } from '../../lib/objectives-store.js';
import { resolveFeature, applyTaskFeatureLink, anyFeaturesExist } from '../../lib/feature-links.js';
import { loadTaskOverride, fieldKey, type CustomFieldDef } from '../../lib/overrides.js';
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

/** True for a real calendar date in YYYY-MM-DD form (rejects e.g. 2026-13-40). */
function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * Parse + validate a comma-separated objective-slug list against the objectives
 * store (write-time integrity: a task can only reference objectives that exist).
 * Returns null after printing an error when any slug is unknown.
 */
function parseObjectiveSlugs(raw: string): string[] | null {
  const slugs = Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)));
  if (slugs.length === 0) return [];
  const known = new Set(listObjectives(ensureContextRoot()).map((o) => o.slug));
  const unknown = slugs.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    error(
      `Unknown objective(s): ${unknown.join(', ')}. `
      + (known.size > 0
        ? `Existing: ${[...known].join(', ')}. `
        : 'No objectives exist yet. ')
      + 'Create one first: dreamcontext roadmap objective create <slug> --title "..."',
    );
    return null;
  }
  return slugs;
}

/**
 * Whether moving a task to `newStatus` should auto-stamp its actual start date.
 * Rule: the FIRST time a task enters `in_progress` with no `start_date` yet, we
 * record today as the real start. An already-set (explicitly planned) start is
 * never overwritten, and no other transition stamps anything — so this only ever
 * captures a previously-unrecorded start.
 */
export function shouldStampStartDate(newStatus: string, currentStart: string | null | undefined): boolean {
  return newStatus === 'in_progress' && !currentStart;
}

/**
 * Set or CLEAR one end of a task's date range. `raw` is a YYYY-MM-DD or the
 * literal "clear". Shared by `tasks start` and `tasks due` so both behave
 * identically (validation, range sanity start≤due, backlog-removal notice, and
 * the same remote-synced write path). Backlog handling is enforced in the
 * backend; here we just surface the "backlog removed" notice.
 */
async function setTaskDate(
  backend: TaskBackend,
  slug: string,
  field: 'start_date' | 'due_date',
  raw: string,
): Promise<void> {
  const label = field === 'start_date' ? 'Start date' : 'Due date';
  if (raw.toLowerCase() === 'clear') {
    await backend.updateFields(slug, { [field]: null, updated_at: today() });
    success(`${label} cleared on ${slug}`);
    return;
  }
  if (!isCalendarDate(raw)) {
    error(`${label} must be a valid YYYY-MM-DD (or "clear").`);
    return;
  }
  const before = await backend.get(slug);
  // Range sanity: a start date can never be after the due date.
  const start = field === 'start_date' ? raw : (before?.start_date ?? null);
  const due = field === 'due_date' ? raw : (before?.due_date ?? null);
  if (start && due && start > due) {
    error(`Start date (${start}) cannot be after the due date (${due}). Adjust or clear the other date first.`);
    return;
  }
  const updated = await backend.updateFields(slug, { [field]: raw, updated_at: today() });
  success(`${label} on ${slug}: ${raw}`);
  if (before?.tags.some((t) => t.toLowerCase() === 'backlog') && !updated.tags.some((t) => t.toLowerCase() === 'backlog')) {
    console.log(chalk.dim('  backlog tag removed — a dated task is planned, not backlog.'));
  }
}

/** Resolve + validate a custom-field value against the override schema (if any). */
function coerceCustomFieldValue(
  def: CustomFieldDef | undefined,
  raw: string,
): { ok: true; value: string | number } | { ok: false; message: string } {
  if (def?.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, message: `Field "${def.key}" is a number; "${raw}" is not numeric.` };
    return { ok: true, value: n };
  }
  if (def?.type === 'select' && def.options && def.options.length > 0) {
    const match = def.options.find((o) => o.toLowerCase() === raw.toLowerCase());
    if (!match) return { ok: false, message: `Field "${def.key}" is a select; "${raw}" is not one of: ${def.options.join(', ')}` };
    return { ok: true, value: match };
  }
  return { ok: true, value: raw };
}

/**
 * Set or clear ONE user-defined custom field on a task. Validates against the
 * override schema when present (unknown key / bad number / bad select option are
 * rejected, never silently written). Merges into the existing custom_fields map
 * so other fields survive, then writes through the backend (synced on next sync).
 */
async function setCustomField(
  backend: TaskBackend,
  slug: string,
  key: string,
  raw: string | undefined,
): Promise<void> {
  const task = await backend.get(slug);
  if (!task) { error(`Task not found: ${slug}`); return; }

  const override = loadTaskOverride(ensureContextRoot());
  const defs = override?.customFields ?? [];
  const def = defs.find((d) => d.key === key || d.key === fieldKey(key));
  const realKey = def?.key ?? fieldKey(key);
  if (defs.length > 0 && !def) {
    error(`No custom field "${key}" declared in overrides/task.md (declared: ${defs.map((d) => d.key).join(', ') || '(none)'}).`);
    return;
  }

  const current: Record<string, string | number | null> = { ...(task.custom_fields ?? {}) };
  if (raw === undefined || raw.toLowerCase() === 'clear') {
    current[realKey] = null;
    await backend.updateFields(slug, { custom_fields: current, updated_at: today() });
    success(`Custom field "${realKey}" cleared on ${slug}`);
    return;
  }

  const coerced = coerceCustomFieldValue(def, raw);
  if (!coerced.ok) { error(coerced.message); return; }
  current[realKey] = coerced.value;
  await backend.updateFields(slug, { custom_fields: current, updated_at: today() });
  success(`Custom field "${realKey}" set to "${coerced.value}" on ${slug}`);
}

/**
 * Resolve a human-entered person reference to a CANONICAL, member-backed slug
 * for a `person:<slug>` tag. On a remote backend whose members are known, the
 * input is fuzzy-matched against the real roster so we never mint an unmappable
 * slug — an unmapped slug is silently dropped on push and the remote then
 * defaults the assignee to the API-token owner. On a local backend (or when members are
 * unavailable) it falls back to a plain slugify with no warning, since free-text
 * assignment is harmless there.
 *
 * Returns `{ abort: true }` on an ambiguous match (a message is printed and the
 * caller must stop rather than guess an assignee).
 */
async function resolvePersonSlug(
  backend: TaskBackend,
  input: string,
): Promise<{ slug: string } | { abort: true }> {
  const fallback = slugify(input);
  if (!backend.listMembers) return { slug: fallback };
  let members;
  try {
    members = await backend.listMembers();
  } catch {
    return { slug: fallback }; // offline — keep intent; the push-side warning catches it
  }
  if (members.length === 0) return { slug: fallback };

  const match = matchMember(input, members);
  if (match.kind === 'exact' || match.kind === 'fuzzy') {
    if (match.member.slug !== fallback) {
      console.log(chalk.dim(`  → assignee "${input}" resolved to ${match.member.slug} (${match.member.name}).`));
    }
    return { slug: match.member.slug };
  }
  if (match.kind === 'ambiguous') {
    error(`Ambiguous assignee "${input}" — matches ${match.matches.map((m) => m.slug).join(', ')}. Be more specific.`);
    return { abort: true };
  }
  warn(`"${input}" matches no member on the "${backend.name}" backend — recording person:${fallback}, but it will NOT sync until they are a member (see \`dreamcontext tasks members\`).`);
  return { slug: fallback };
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
    const cfKeys = Object.keys(t.custom_fields ?? {});
    if (cfKeys.length > 0) {
      meta.push(
        cfKeys
          .map((k) => {
            const v = t.custom_fields[k];
            return v === null || v === undefined || String(v).trim() === '' ? `${k}=unset` : `${k}=${String(v)}`;
          })
          .join('  '),
      );
    }
    if (meta.length > 0) line += `\n${' '.repeat(15)}${chalk.dim(meta.join('  '))}`;
  }
  return line;
}

/** REQUIRED custom fields (from overrides/task.md) left unset on a task. */
function missingRequiredFields(
  values: Record<string, unknown> | undefined,
  root: string,
): CustomFieldDef[] {
  const requiredDefs = (loadTaskOverride(root)?.customFields ?? []).filter((d) => d.required);
  return requiredDefs.filter((d) => {
    const v = values?.[d.key];
    return v === undefined || v === null || String(v).trim() === '';
  });
}

/** Whether an explicit draft escape was given (per-command flag or env var). */
function allowMissingRequired(flag?: boolean): boolean {
  return flag === true || process.env.DREAMCONTEXT_ALLOW_MISSING_REQUIRED === '1';
}

/** Print one fix hint per unset required field (exact command + the field's prompt). */
function printRequiredHints(missing: CustomFieldDef[], fix: (key: string) => string): void {
  for (const d of missing) {
    const hint = d.prompt ? `  (${d.prompt.length > 100 ? d.prompt.slice(0, 100) + '…' : d.prompt})` : '';
    console.log(chalk.dim(`  → ${fix(d.key)}${hint}`));
  }
}

/**
 * Hard backstop to the snapshot briefing: when REQUIRED custom fields are unset,
 * BLOCK the action (returns true → caller aborts; sets a non-zero exit code).
 * An explicit draft escape (`--allow-missing-required` / env) downgrades it to a
 * warning so automated/intentional drafts still go through.
 */
function blockOnMissingRequired(
  action: string,
  slug: string,
  values: Record<string, unknown> | undefined,
  root: string,
  fix: (key: string) => string,
  allowDraft?: boolean,
): boolean {
  const missing = missingRequiredFields(values, root);
  if (missing.length === 0) return false;
  const names = missing.map((d) => d.key).join(', ');
  if (allowMissingRequired(allowDraft)) {
    warn(`${action} "${slug}" with unset required field(s): ${names} (allowed via --allow-missing-required).`);
    printRequiredHints(missing, fix);
    return false;
  }
  error(`Cannot ${action} "${slug}": required custom field(s) unset — ${names}. This project requires them on every task.`);
  printRequiredHints(missing, fix);
  error('Set them, or pass --allow-missing-required (or DREAMCONTEXT_ALLOW_MISSING_REQUIRED=1) for a draft.');
  process.exitCode = 1;
  return true;
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
    .option('--objective <slug>', 'Filter by objective (task serves the given roadmap objective)')
    .option('-g, --group-by <field>', `Group output by ${GROUP_BY_FIELDS.join('|')}`)
    .option('--long', 'Show tags + version inline in human output')
    .option('--tags', 'List distinct tags with counts (respects -s/--all; ignores other filters)')
    .option('--json', 'Emit the filtered tasks as JSON (flat array)')
    .action(async (opts: {
      status?: string; all?: boolean; tag?: string[]; anyTag?: string[];
      version?: string; priority?: string; feature?: string; objective?: string;
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
        objective: opts.objective,
      };
      const matched = await backend.list(filter);

      if (opts.json) {
        console.log(JSON.stringify(matched, null, 2));
        return;
      }

      if (matched.length === 0) {
        const total = (await backend.list({ all: true })).length;
        const narrowed = (opts.tag && opts.tag.length > 0) || (opts.anyTag && opts.anyTag.length > 0)
          || opts.version || opts.priority || opts.feature || opts.objective;
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
    .option('--start <date>', 'Planned start date (YYYY-MM-DD)')
    .option('--due <date>', 'Due/end date (YYYY-MM-DD)')
    .option('--objectives <slugs>', 'Comma-separated roadmap objective slugs this task serves (many-to-many)')
    .option('--feature <name>', 'Feature PRD this task belongs to (sets related_feature + the feature\'s related_tasks)')
    .option('--field <key=value...>', 'Set a declared custom field (repeatable): --field team=platform --field story_points=8')
    .option('--allow-missing-required', 'Create even when required custom fields are unset (intentional draft)')
    .action(async (name: string, opts: { description?: string; priority?: string; urgency?: string; status?: string; tags?: string; why?: string; version?: string; person?: string; reach?: string; impact?: string; confidence?: string; effort?: string; start?: string; due?: string; objectives?: string; feature?: string; field?: string[]; allowMissingRequired?: boolean }) => {
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
          const resolved = await resolvePersonSlug(backend, opts.person);
          if ('abort' in resolved) return;
          const personTag = `person:${resolved.slug}`;
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

      if (opts.due !== undefined && !isCalendarDate(opts.due)) {
        error('Due date must be a valid YYYY-MM-DD.');
        return;
      }
      if (opts.start !== undefined && !isCalendarDate(opts.start)) {
        error('Start date must be a valid YYYY-MM-DD.');
        return;
      }
      if (opts.start && opts.due && opts.start > opts.due) {
        error(`Start date (${opts.start}) cannot be after the due date (${opts.due}).`);
        return;
      }

      let objectives: string[] | undefined;
      if (opts.objectives !== undefined) {
        const parsed = parseObjectiveSlugs(opts.objectives);
        if (parsed === null) return;
        if (parsed.length > 0) objectives = parsed;
      }

      // Resolve --feature BEFORE creating so an unknown/ambiguous reference
      // refuses the link up front instead of persisting a dangling slug.
      let feature: { slug: string } | null = null;
      if (opts.feature !== undefined) {
        const resolved = resolveFeature(ensureContextRoot(), opts.feature);
        if (!resolved.ok) {
          error(resolved.reason === 'ambiguous'
            ? `Ambiguous feature "${opts.feature}". Did you mean: ${resolved.candidates.join(', ')}?`
            : `Unknown feature: "${opts.feature}". Check: ls _dream_context/knowledge/features/`);
          return;
        }
        feature = { slug: resolved.slug };
      }

      // --field key=value pairs → custom_fields, validated against the override.
      let customFields: Record<string, string | number> | undefined;
      if (opts.field && opts.field.length > 0) {
        const defs = loadTaskOverride(ensureContextRoot())?.customFields ?? [];
        customFields = {};
        for (const pair of opts.field) {
          const eq = pair.indexOf('=');
          if (eq === -1) { error(`--field expects key=value, got "${pair}".`); return; }
          const rawKey = pair.slice(0, eq).trim();
          const rawVal = pair.slice(eq + 1).trim();
          const def = defs.find((d) => d.key === rawKey || d.key === fieldKey(rawKey));
          if (defs.length > 0 && !def) {
            error(`No custom field "${rawKey}" declared in overrides/task.md (declared: ${defs.map((d) => d.key).join(', ') || '(none)'}).`);
            return;
          }
          const coerced = coerceCustomFieldValue(def, rawVal);
          if (!coerced.ok) { error(coerced.message); return; }
          customFields[def?.key ?? fieldKey(rawKey)] = coerced.value;
        }
      }

      // Hard gate: refuse to create when a REQUIRED custom field is unset
      // (escape with --allow-missing-required for an intentional draft).
      if (blockOnMissingRequired('create', slug, customFields, ensureContextRoot(),
          (k) => `--field ${k}="<value>"`, opts.allowMissingRequired)) return;

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
          start_date: opts.start ?? null,
          due_date: opts.due ?? null,
          ...(objectives ? { objectives } : {}),
          ...(customFields ? { custom_fields: customFields } : {}),
          variant: 'cli',
        });
      } catch (err) {
        if (err instanceof TaskBackendError && err.code === 'already_exists') {
          error(`Task already exists: ${slug}.md`);
          return;
        }
        throw err;
      }
      if (feature) {
        applyTaskFeatureLink(ensureContextRoot(), slug, feature);
      }
      success(`Task created: ${slug}.md`);
      if (feature) {
        console.log(chalk.dim(`  feature: ${feature.slug} (related_tasks updated)`));
      }
      // Assignment nudges — links are how the brain graph, roadmap rollups, and
      // feature freshness stay real. Nudge, never block: not every task fits.
      if (!feature && opts.feature === undefined && anyFeaturesExist(ensureContextRoot())) {
        console.log(chalk.dim(`  ○ no feature link — if this task builds a feature PRD: dreamcontext tasks feature ${slug} <feature>`));
      }
      if (!objectives && listObjectives(ensureContextRoot()).length > 0) {
        console.log(chalk.dim(`  ○ no objective link — if this task serves a roadmap objective: dreamcontext tasks objectives ${slug} <a,b>`));
      }
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

  // Delete a task (remote backends propagate the deletion on sync)
  tasks
    .command('delete')
    .argument('<name>', 'Task slug or name')
    .description('Delete a task (propagates to the remote backend on sync)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error('Refusing to delete without --yes in a non-interactive session.');
          process.exitCode = 1;
          return;
        }
        const answer = (await promptInput({ message: `Delete task "${slug}"? Type the slug to confirm:` })).trim();
        if (answer !== slug) {
          error('Confirmation did not match — nothing deleted.');
          return;
        }
      }

      await backend.delete(slug);
      success(`Task deleted: ${slug}${backend.name !== 'local' ? ' (remote deletion on next sync)' : ''}`);
    });

  // Rename a task — the slug-safe way (#77). Renaming changes the name-derived
  // slug; doing it by hand and re-syncing used to DUPLICATE the remote task
  // (reconciliation joined on slug, not the stable dcId). This rewrites the
  // name + renames the file + migrates the sync ledger in place, so the next
  // sync UPDATES the same remote task instead of creating a duplicate.
  tasks
    .command('rename')
    .argument('<name>', 'Current task slug or name')
    .argument('<new-name>', 'The new task name')
    .description('Rename a task (file + slug + remote mapping) — never duplicates the remote task')
    .action(async (name: string, newName: string) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      try {
        const newSlug = await backend.rename(slug, newName);
        if (newSlug === slug) {
          success(`Renamed (name only, slug unchanged): ${slug}`);
        } else {
          success(
            `Renamed: ${slug} → ${newSlug}` +
            (backend.name !== 'local' ? ' (same remote task updated on next sync — no duplicate)' : ''),
          );
        }
      } catch (err) {
        if (err instanceof TaskBackendError) {
          error(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  // Planned START date on existing tasks (synced to the remote backend)
  tasks
    .command('start')
    .argument('<name>', 'Task slug or name')
    .argument('<date>', 'YYYY-MM-DD, or "clear" to remove')
    .description('Set or clear a task planned start date (the range start)')
    .action(async (name: string, date: string) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;
      await setTaskDate(backend, slug, 'start_date', date);
    });

  // DUE/end date on existing tasks (synced to the remote backend)
  tasks
    .command('due')
    .argument('<name>', 'Task slug or name')
    .argument('<date>', 'YYYY-MM-DD, or "clear" to remove')
    .description('Set or clear a task due/end date (the range end)')
    .action(async (name: string, date: string) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;
      await setTaskDate(backend, slug, 'due_date', date);
    });

  // VERSION (sprint/milestone) on existing tasks (synced to the remote backend)
  // Parity with status/due/feature (#184). Its absence was a real gap, not an
  // omission of convenience: a task whose version failed to round-trip through a
  // cloud backend drops off the sprint board, and with no verb here the only way
  // to heal it was a hand-rolled PATCH against the running dashboard server.
  tasks
    .command('version')
    .argument('<name>', 'Task slug or name')
    .argument('[version]', 'Version/sprint to SET, or "clear" / omit to print')
    .description('Print, set, or clear the version (sprint/milestone) a task belongs to')
    .action(async (name: string, versionRef: string | undefined) => {
      const backend = getTaskBackend();
      const root = ensureContextRoot();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;
      const task = await backend.get(slug);
      if (!task) {
        error(`Task not found: ${name}`);
        return;
      }

      if (versionRef === undefined) {
        if (task.version) {
          console.log(`${slug} → version: ${task.version}`);
        } else {
          console.log(chalk.dim(`No version on ${slug}. Set: dreamcontext tasks version ${slug} <version>`));
        }
        return;
      }

      if (versionRef.trim().toLowerCase() === 'clear') {
        await backend.updateFields(slug, { version: null, updated_at: today() });
        success(`Cleared version on ${slug}`);
        return;
      }

      // Fold against the known versions so a lowercased round-trip (or a typed
      // "s5") resolves to the canonical spelling the board filters by, rather
      // than writing a second near-identical version string.
      const known = getExistingReleases(root).map((r) => r.version).filter(Boolean);
      const match = known.find((k) => foldAscii(k) === foldAscii(versionRef.trim()));
      const resolved = match ?? versionRef.trim();
      await backend.updateFields(slug, { version: resolved, updated_at: today() });
      if (match) {
        success(`${slug} → version: ${resolved}`);
      } else {
        // Not a hard error: BACKLOG and ad-hoc sprints are legitimate values that
        // never appear in RELEASES.json. But an unregistered version is exactly
        // what silently hides a task from the board, so say so.
        success(`${slug} → version: ${resolved}`);
        console.log(chalk.dim(
          `Note: "${resolved}" is not in RELEASES.json${known.length > 0 ? ` (known: ${known.join(', ')})` : ''}. ` +
          `It will not match a sprint bucket on the board. Register it with: ` +
          `dreamcontext core releases add --ver "${resolved}" --status planning --summary "..." --yes`,
        ));
      }
    });

  // User-defined custom fields (declared in overrides/task.md; synced to the remote backend)
  tasks
    .command('field')
    .argument('<name>', 'Task slug or name')
    .argument('<key>', 'Custom field key (as declared in overrides/task.md)')
    .argument('[value]', 'Value to set, or "clear" / omit to clear')
    .description('Set or clear a user-defined custom field (synced to the remote backend)')
    .action(async (name: string, key: string, value: string | undefined) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;
      await setCustomField(backend, slug, key, value);
    });

  // Objectives on existing tasks (many-to-many link to roadmap objectives; local-only)
  tasks
    .command('objectives')
    .argument('<name>', 'Task slug or name')
    .argument('[slugs]', 'Comma-separated objective slugs to SET, or "clear" / omit to print')
    .description('Print, set, or clear the roadmap objectives a task serves (local-only field)')
    .action(async (name: string, slugs: string | undefined) => {
      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;
      const task = await backend.get(slug);
      if (!task) {
        error(`Task not found: ${name}`);
        return;
      }

      if (slugs === undefined) {
        if (task.objectives.length === 0) {
          console.log(chalk.dim(`No objectives on ${slug}. Set: dreamcontext tasks objectives ${slug} <a,b>`));
        } else {
          console.log(`${slug} serves: ${task.objectives.join(', ')}`);
        }
        return;
      }

      if (slugs.trim().toLowerCase() === 'clear') {
        await backend.updateFields(slug, { objectives: [], updated_at: today() });
        success(`Cleared objectives on ${slug}`);
        return;
      }

      const parsed = parseObjectiveSlugs(slugs);
      if (parsed === null) return;
      if (parsed.length === 0) {
        error('No objective slugs given — pass a comma-separated list, or "clear".');
        return;
      }
      await backend.updateFields(slug, { objectives: parsed, updated_at: today() });
      success(`${slug} now serves: ${parsed.join(', ')} (rollups update on next \`dreamcontext roadmap\`)`);
    });

  // Feature link on existing tasks (single-valued; bidirectional with the
  // feature's related_tasks via the link engine — both sides always agree).
  tasks
    .command('feature')
    .argument('<name>', 'Task slug or name')
    .argument('[feature]', 'Feature slug/name to SET, or "clear" / omit to print')
    .description('Print, set, or clear the feature this task belongs to (keeps the feature\'s related_tasks in sync)')
    .action(async (name: string, featureRef: string | undefined) => {
      const backend = getTaskBackend();
      const root = ensureContextRoot();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;
      const task = await backend.get(slug);
      if (!task) {
        error(`Task not found: ${name}`);
        return;
      }

      if (featureRef === undefined) {
        if (task.related_feature) {
          console.log(`${slug} → feature: ${task.related_feature}`);
        } else {
          console.log(chalk.dim(`No feature on ${slug}. Set: dreamcontext tasks feature ${slug} <feature>`));
        }
        return;
      }

      if (featureRef.trim().toLowerCase() === 'clear') {
        const result = applyTaskFeatureLink(root, slug, null);
        await backend.updateFields(slug, { related_feature: null, updated_at: today() });
        success(`Cleared feature on ${slug}${result.removedFrom.length > 0 ? ` (removed from related_tasks of: ${result.removedFrom.join(', ')})` : ''}`);
        return;
      }

      const resolved = resolveFeature(root, featureRef);
      if (!resolved.ok) {
        error(resolved.reason === 'ambiguous'
          ? `Ambiguous feature "${featureRef}". Did you mean: ${resolved.candidates.join(', ')}?`
          : `Unknown feature: "${featureRef}". Check: ls _dream_context/knowledge/features/`);
        return;
      }
      const result = applyTaskFeatureLink(root, slug, { slug: resolved.slug });
      await backend.updateFields(slug, { related_feature: resolved.slug, updated_at: today() });
      const notes: string[] = [];
      if (result.addedTo) notes.push(`added to ${result.addedTo}'s related_tasks`);
      if (result.removedFrom.length > 0) notes.push(`removed from: ${result.removedFrom.join(', ')}`);
      success(`${slug} → feature: ${resolved.slug}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`);
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
        // Canonicalize person:<slug> assignments to a real member slug so we
        // never record an unmappable assignee (silently dropped on push, which
        // makes the remote default the assignee to the API-token owner).
        const addTags: string[] = [];
        for (const t of given) {
          if (t.startsWith('person:')) {
            const raw = t.slice('person:'.length).trim();
            if (!raw) {
              error('Empty assignee: `person:` needs a slug, e.g. `person:emrecan-tetik` (see `dreamcontext tasks members`).');
              return;
            }
            const resolved = await resolvePersonSlug(backend, raw);
            if ('abort' in resolved) return;
            addTags.push(`person:${resolved.slug}`);
          } else {
            addTags.push(t);
          }
        }
        next = [...task.tags];
        for (const t of addTags) {
          if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
        }
        // A person tag is an assignment — only one person tag at a time.
        const persons = next.filter((t) => t.startsWith('person:'));
        if (persons.length > 1) {
          const keep = addTags.filter((t) => t.startsWith('person:')).pop() ?? persons[persons.length - 1];
          next = next.filter((t) => !t.startsWith('person:') || t === keep);
        }
      }

      const hadDue = (await backend.get(slug))?.due_date ?? null;
      const updated = await backend.updateFields(slug, { tags: next, updated_at: today() });
      success(`Tags on ${slug}: ${updated.tags.length > 0 ? updated.tags.join(', ') : '(none)'}`);
      if (hadDue && updated.due_date === null && next.some((t) => t.toLowerCase() === 'backlog')) {
        console.log(chalk.dim('  due date cleared — backlog tasks are undated by rule.'));
      }
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

      // Hard gate: can't mark a task done with required custom fields empty.
      const current = await backend.get(slug);
      if (blockOnMissingRequired('complete', slug, current?.custom_fields, ensureContextRoot(),
          (k) => `dreamcontext tasks field ${slug} ${k} "<value>"`)) return;

      await backend.complete(slug, summary);
      success(`Task completed: ${slug}`);
    });

  // Change status (todo, in_progress, in_review, completed)
  tasks
    .command('status')
    .argument('<name>')
    .argument('<new-status>', 'todo, in_progress, in_review, or completed')
    .argument('[reason...]', 'Optional reason for the status change')
    .description('Change a task\'s status (logs the change; stamps start_date on first in_progress if unset)')
    .action(async (name: string, newStatus: string, reasonParts: string[]) => {
      const validStatuses = ['todo', 'in_progress', 'in_review', 'completed'];
      if (!validStatuses.includes(newStatus)) {
        error(`Status must be one of: ${validStatuses.join(', ')}`);
        return;
      }

      const backend = getTaskBackend();
      const slug = await resolveTaskSlug(backend, name);
      if (!slug) return;

      // Hard gate: can't move a task to a ready/done state with required fields empty.
      if (newStatus === 'completed' || newStatus === 'in_review') {
        const cur = await backend.get(slug);
        if (blockOnMissingRequired(newStatus === 'completed' ? 'complete' : 'move to in_review', slug, cur?.custom_fields, ensureContextRoot(),
            (k) => `dreamcontext tasks field ${slug} ${k} "<value>"`)) return;
      }

      const reason = reasonParts.join(' ').trim();
      const headerLabel = newStatus === 'completed' ? 'Completed' : `Status → ${newStatus}`;
      const logContent = reason
        ? `### ${today()} - ${headerLabel}\n- ${reason}`
        : `### ${today()} - ${headerLabel}`;

      await backend.addChangelog(slug, logContent, { fallbackAppend: true });

      // Auto-stamp the real start date the first time work actually begins (see
      // shouldStampStartDate). Only fetch the task on the transition that can
      // stamp, so other status changes stay a single write.
      const now = today();
      const before = newStatus === 'in_progress' ? await backend.get(slug) : null;
      const startStamped = shouldStampStartDate(newStatus, before?.start_date);
      await backend.updateFields(slug, {
        status: newStatus,
        updated_at: now,
        ...(startStamped ? { start_date: now } : {}),
      });
      success(`Task ${slug} → ${newStatus}`);
      if (startStamped) {
        console.log(chalk.dim(`  start date set to ${now} (work started).`));
      }
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
    .option('--reconcile', 'Also heal pre-existing drift below the sync watermark: re-pull assignees (#78) and version (#184) for every mapped task')
    .option('--refresh-meta', "Force a refresh of the cached remote statuses/members/fields instead of the hourly throttle — use after changing statuses in the provider's UI (#184)")
    .option('--json', 'Emit the sync report as JSON')
    .action(async (direction: string | undefined, opts: { hook?: boolean; reconcile?: boolean; refreshMeta?: boolean; json?: boolean }) => {
      const dir = (direction ?? 'both') as 'push' | 'pull' | 'both';
      if (!['push', 'pull', 'both'].includes(dir)) {
        error('Direction must be one of: push, pull, both');
        return;
      }
      const syncOpts = { reconcile: !!opts.reconcile, refreshMeta: !!opts.refreshMeta };
      try {
        const root = ensureContextRoot();
        const backend = getTaskBackend(root);
        const report = opts.hook
          ? await Promise.race([
              backend.sync(dir, syncOpts),
              new Promise<null>((resolveTimeout) => {
                const t = setTimeout(() => resolveTimeout(null), 15000);
                (t as unknown as { unref?: () => void }).unref?.();
              }),
            ])
          : await backend.sync(dir, syncOpts);
        if (report === null) {
          // Hook-mode timeout: report and exit clean — git must never block.
          console.log(chalk.dim('tasks sync: timed out (hook mode) — skipped.'));
          return;
        }
        // C2 (github-cloud-collaboration-brain-repo-sync M3): this command IS
        // the documented remedy for the "task mirrors are out of date" brain
        // session-start advisory — a sync that actually RAN (not lock-skipped)
        // clears the persisted flag so running exactly what the advisory says
        // resolves the nag instead of re-surfacing it every session.
        if (report.skipped !== 'locked') {
          writeBrainLocal(dirname(root), { needsTaskSync: false });
        }
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (report.skipped === 'locked') {
          console.log(chalk.dim('Another sync is already running for this project — skipped. Try again in a moment.'));
          return;
        }
        if (report.noop) {
          console.log(chalk.dim(`Task backend is "${report.backend}" — nothing to sync.`));
          return;
        }
        const deletedPart = report.deleted > 0 ? `, deleted ${report.deleted}` : '';
        const reconciledPart = report.reconciled > 0 ? `, reconciled ${report.reconciled}` : '';
        success(`Sync (${report.direction}): pushed ${report.pushed}, pulled ${report.pulled}, created ${report.created}${deletedPart}, comments ${report.commentsAdded}${reconciledPart}`);
        if (syncOpts.reconcile && report.reconciled === 0) {
          console.log(chalk.dim('  reconcile: no assignee drift found — local already matches the remote.'));
        }
        if (report.pendingQueue > 0) {
          console.log(chalk.yellow(`  ${report.pendingQueue} queued op(s) pending (offline?) — will replay on next sync.`));
        }
        for (const c of report.conflicts) {
          console.log(chalk.yellow(`  conflict: ${c.slug} (${c.reason}) — local copy saved to ${c.savedTo}`));
        }
        for (const e of report.errors) {
          console.log(chalk.red(`  error: ${e}`));
        }
        for (const w of report.warnings) {
          console.log(chalk.yellow(`  warning: ${w}`));
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

  // Provision the recommended remote structure (custom fields)
  tasks
    .command('provision')
    .description('Create the recommended fields on the remote task container (urgency, summary, RICE, …)')
    .action(async () => {
      const backend = getTaskBackend();
      if (!backend.provisionRemote) {
        console.log(chalk.dim(`Task backend is "${backend.name}" — nothing to provision.`));
        return;
      }
      try {
        const result = await backend.provisionRemote();
        if (result.created.length > 0) success(`Created remote fields: ${result.created.join(', ')}`);
        if (result.existing.length > 0) console.log(chalk.dim(`  Already present: ${result.existing.join(', ')}`));
        for (const e of result.errors) error(e);
        if (result.created.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim('All recommended fields already exist.'));
        }
        if (result.backfilled > 0) {
          console.log(chalk.dim(`  Backfilled ${result.backfilled} value(s) onto already-synced tasks.`));
        }
      } catch (err) {
        error(`Provision failed: ${(err as Error).message ?? err}`);
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
  // (the default checks stay LOCAL-ONLY by design — issue #11; the optional
  //  `--remote` assignee-drift probe is the one network check, opt-in — #78)
  tasks
    .command('doctor')
    .argument('[name]', 'Task name (omit to check every task)')
    .description('Validate Workflow flowchart is in sync with Acceptance Criteria')
    .option('--remote', 'Also check the remote backend for assignee drift (requires a token; #78)')
    .action(async (name: string | undefined, opts: { remote?: boolean }) => {
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

      // Opt-in remote probe (#78): assignee drift between the remote and local
      // person tags. Best-effort — a missing token / offline remote prints a
      // skip note rather than failing the local checks above.
      if (opts.remote) {
        console.log();
        console.log(header('Remote assignee drift'));
        const backend = getTaskBackend();
        if (typeof backend.detectAssigneeDrift !== 'function') {
          console.log(chalk.dim(`  Backend "${backend.name}" has no remote assignees — nothing to check.`));
          return;
        }
        try {
          const drifts = await backend.detectAssigneeDrift();
          if (drifts.length === 0) {
            success('No assignee drift — local person tags match the remote.');
          } else {
            for (const d of drifts) {
              const localTxt = d.local.length ? d.local.join(', ') : '(unassigned)';
              const remoteTxt = d.remote.length ? d.remote.join(', ') : '(unassigned)';
              console.log(`  ${chalk.yellow('drift')}   ${d.slug}: local [${localTxt}] → remote [${remoteTxt}]`);
            }
            console.log();
            console.log(
              chalk.yellow(`  ${drifts.length} task(s) have remote assignee drift. `) +
              `Run ${chalk.cyan('dreamcontext tasks sync --reconcile')} to heal them.`,
            );
          }
        } catch (err) {
          console.log(chalk.dim(`  Skipped (remote unreachable): ${(err as Error).message ?? err}`));
        }
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
