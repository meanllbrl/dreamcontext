import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, header } from '../../lib/format.js';
import { today } from '../../lib/id.js';
import {
  createObjective,
  updateObjective,
  updateObjectiveMetric,
  deleteObjective,
  addDependency,
  removeDependency,
  getObjective,
  listObjectives,
  ObjectiveError,
  OBJECTIVE_STATUSES,
  type ObjectiveStatus,
} from '../../lib/objectives-store.js';
import {
  buildRoadmapModel,
  transitiveDependents,
  type RoadmapModel,
  type RoadmapObjective,
} from '../../lib/roadmap-model.js';

/**
 * `dreamcontext roadmap` — the PO-authored OKR objective board (task_uO60nZRt).
 *
 * The builder (roadmap-model.ts) is pure; this command renders it:
 *   roadmap            → text board to stdout + regenerate knowledge/roadmap/board.md
 *   roadmap --json     → the typed RoadmapModel verbatim (query surface, no writes)
 *   roadmap objective  → CRUD + dependency wiring (write-time cycle guard)
 */

const STATUS_ICON: Record<ObjectiveStatus, string> = {
  done: '🟢',
  active: '🔵',
  review: '🟡',
  not_started: '⚪',
};

function fmtDates(o: RoadmapObjective): string {
  const parts: string[] = [];
  if (o.target_date) parts.push(`target ${o.target_date}`);
  if (o.forecast_end) {
    parts.push(`forecast ${o.forecast_end}${o.slipping ? ' 🔴 SLIPPING' : o.slipping === false ? ' ✓ on track' : ''}`);
  } else {
    parts.push('forecast — (unforecastable: no dated member tasks)');
  }
  return parts.join(' · ');
}

/** Compact number: drop trailing zeros so 2000 → "2000", 43.5 → "43.5". */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function progressLabel(o: RoadmapObjective): string {
  const p = o.progress;
  if (p.source === 'metric' && p.metric) {
    const m = p.metric;
    const unit = m.unit ? `${m.unit} ` : '';
    return `${unit}${fmtNum(m.current)}/${fmtNum(m.target)} ${m.label} (${p.pct}%)`;
  }
  return p.pct === null ? 'no tasks yet' : `${p.done}/${p.total} done (${p.pct}%)`;
}

function objectiveLine(o: RoadmapObjective): string {
  const pct = progressLabel(o);
  const deps = o.depends_on.length > 0 ? ` · deps: ${o.depends_on.join(', ')}` : '';
  const override = o.status_source === 'override' ? ' [status set by PO]' : '';
  return `${STATUS_ICON[o.status]} **${o.slug}** — ${o.title} · ${pct} · ${fmtDates(o)}${deps}${override}`;
}

function taskLine(t: RoadmapObjective['tasks'][number]): string {
  const range = t.start_date || t.due_date
    ? ` · ${t.start_date ?? '…'} → ${t.due_date ?? '…'}`
    : '';
  const ver = t.version ? ` · ${t.version}` : '';
  return `  - ${t.slug} (${t.status})${ver}${range}`;
}

/** Markdown render of the board — consumed by board.md AND (uncolored) stdout. */
export function renderRoadmapBoard(model: RoadmapModel): string {
  const lines: string[] = [];
  if (model.objectives.length === 0) {
    lines.push('_No objectives yet. Create one:_ `dreamcontext roadmap objective create <slug> --title "..."`');
  }
  for (const o of model.objectives) {
    lines.push(`### ${objectiveLine(o)}`);
    if (o.feature) lines.push(`  Feature: [[${o.feature}]]`);
    if (o.dependents.length > 0) lines.push(`  Unblocks: ${o.dependents.join(', ')}`);
    for (const t of o.tasks) lines.push(taskLine(t));
    lines.push('');
  }
  if (model.warnings.length > 0) {
    lines.push('#### Warnings');
    for (const w of model.warnings) lines.push(`- ⚠ ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Write the auto-generated board to knowledge/roadmap/board.md (indexed + recallable). */
export function writeRoadmapBoard(contextRoot: string, model: RoadmapModel): string {
  const path = join(contextRoot, 'knowledge', 'roadmap', 'board.md');
  mkdirSync(dirname(path), { recursive: true });
  const slipping = model.objectives.filter((o) => o.slipping === true).map((o) => o.slug);
  const content = [
    '---',
    'name: roadmap-board',
    'description: >-',
    `  AUTO-GENERATED objective board (${model.objectives.length} objective(s)`
      + `${slipping.length > 0 ? `, SLIPPING: ${slipping.join(', ')}` : ', none slipping'}).`,
    '  Regenerate with `dreamcontext roadmap` — do not edit by hand.',
    'tags:',
    "  - 'topic:roadmap'",
    "  - 'topic:pm'",
    'pinned: false',
    `date: '${model.generated_at}'`,
    '---',
    '',
    '# Roadmap Board',
    '',
    `> Auto-generated ${model.generated_at} by \`dreamcontext roadmap\`. Objectives live in`
      + ' `core/objectives/`; task links live in each task\'s `objectives:` frontmatter.',
    '',
    renderRoadmapBoard(model),
  ].join('\n');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function printBoard(model: RoadmapModel): void {
  console.log(header('Roadmap — Objectives'));
  if (model.objectives.length === 0) {
    console.log(chalk.dim('  No objectives yet. Create one:'));
    console.log(chalk.dim('  dreamcontext roadmap objective create <slug> --title "..." [--target YYYY-MM-DD]'));
    return;
  }
  for (const o of model.objectives) {
    console.log(`  ${objectiveLine(o).replace(/\*\*/g, '')}`);
    for (const t of o.tasks) console.log(chalk.dim(`  ${taskLine(t)}`));
    if (o.dependents.length > 0) console.log(chalk.dim(`    unblocks: ${o.dependents.join(', ')}`));
  }
  if (model.warnings.length > 0) {
    console.log();
    for (const w of model.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
  }
}

/** Parse a required numeric CLI flag; throws a clean ObjectiveError on garbage. */
function parseNum(value: string, flag: string): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n)) throw new ObjectiveError(`${flag} must be a number, got "${value}".`);
  return n;
}

/** Assemble a metric from `objective create` flags, or null when --metric is absent. */
function buildMetricFromCreateOpts(opts: {
  metric?: string; metricTarget?: string; metricBaseline?: string; metricCurrent?: string; metricUnit?: string;
}) {
  if (opts.metric === undefined) return null;
  if (opts.metricTarget === undefined) {
    throw new ObjectiveError('--metric requires --metric-target (the value that means 100% done).');
  }
  const baseline = opts.metricBaseline !== undefined ? parseNum(opts.metricBaseline, '--metric-baseline') : 0;
  const target = parseNum(opts.metricTarget, '--metric-target');
  const current = opts.metricCurrent !== undefined ? parseNum(opts.metricCurrent, '--metric-current') : baseline;
  return {
    label: opts.metric,
    unit: opts.metricUnit && opts.metricUnit.trim() ? opts.metricUnit.trim() : null,
    baseline,
    target,
    current,
  };
}

function handleObjectiveError(err: unknown): never | void {
  if (err instanceof ObjectiveError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  throw err;
}

export function registerRoadmapCommand(program: Command): void {
  const roadmap = program
    .command('roadmap')
    .description('PO-authored objective board: rollups, dependency cascade, target vs forecast')
    .option('--json', 'Emit the typed RoadmapModel as JSON (no board.md write)')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const model = buildRoadmapModel(root);
      if (opts.json) {
        console.log(JSON.stringify(model, null, 2));
        return;
      }
      printBoard(model);
      const path = writeRoadmapBoard(root, model);
      console.log();
      success(`Board written: ${path.replace(dirname(root) + '/', '')}`);
    });

  const objective = roadmap
    .command('objective')
    .description('Manage objectives (create/list/show/edit/delete/depend)');

  objective
    .command('create')
    .argument('<slug>', 'Kebab-case objective slug (e.g. increase-retention-20)')
    .description('Create an objective in core/objectives/<slug>.md')
    .requiredOption('--title <title>', 'One-line outcome statement')
    .option('--target <date>', 'Target date the PO commits to (YYYY-MM-DD)')
    .option('--depends-on <slugs>', 'Comma-separated slugs this objective depends on')
    .option('--feature <slug>', 'Backing feature PRD slug (optional)')
    .option('--metric <label>', 'Track by a Key Result metric instead of tasks (e.g. "MRR")')
    .option('--metric-target <n>', 'The metric value that means 100% done (required with --metric)')
    .option('--metric-baseline <n>', 'Where the metric started (default 0)')
    .option('--metric-current <n>', 'Current metric value (default = baseline)')
    .option('--metric-unit <unit>', 'Metric display unit (e.g. "USD")')
    .option('--why <text>', 'Why this outcome matters (seeds the ## Why section)')
    .action((slug: string, opts: {
      title: string; target?: string; dependsOn?: string; feature?: string; why?: string;
      metric?: string; metricTarget?: string; metricBaseline?: string; metricCurrent?: string; metricUnit?: string;
    }) => {
      try {
        const metric = buildMetricFromCreateOpts(opts);
        const o = createObjective(ensureContextRoot(), {
          slug,
          title: opts.title,
          target_date: opts.target ?? null,
          depends_on: opts.dependsOn ? opts.dependsOn.split(',').map((s) => s.trim()).filter(Boolean) : [],
          feature: opts.feature ?? null,
          metric,
          why: opts.why,
        });
        success(`Objective created: core/objectives/${o.slug}.md`);
      } catch (err) {
        handleObjectiveError(err);
      }
    });

  objective
    .command('list')
    .description('List objectives with rollup progress, status, and forecast')
    .option('--json', 'Emit as JSON (same objective shape as roadmap --json)')
    .action((opts: { json?: boolean }) => {
      const model = buildRoadmapModel(ensureContextRoot());
      if (opts.json) {
        console.log(JSON.stringify(model.objectives, null, 2));
        return;
      }
      printBoard(model);
    });

  objective
    .command('show')
    .argument('<slug>', 'Objective slug')
    .description('Show one objective: members, dependencies, dependents, cascade impact')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const model = buildRoadmapModel(root);
      const o = model.objectives.find((x) => x.slug === slug);
      if (!o) {
        error(`Objective not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const impact = transitiveDependents(model, slug);
      if (opts.json) {
        console.log(JSON.stringify({ ...o, transitive_dependents: impact }, null, 2));
        return;
      }
      console.log(header(`Objective: ${slug}`));
      console.log(`  ${objectiveLine(o).replace(/\*\*/g, '')}`);
      if (o.feature) console.log(`  feature: ${o.feature}`);
      console.log(`  depends on: ${o.depends_on.join(', ') || '(none)'}`);
      console.log(`  unblocks (direct): ${o.dependents.join(', ') || '(none)'}`);
      console.log(`  if this slips, so do: ${impact.join(', ') || '(nothing — no dependents)'}`);
      console.log(`  member tasks (${o.tasks.length}):`);
      for (const t of o.tasks) console.log(chalk.dim(`  ${taskLine(t)}`));
      const file = getObjective(root, slug);
      if (file) console.log(chalk.dim(`\n  file: core/objectives/${slug}.md`));
    });

  objective
    .command('edit')
    .argument('<slug>', 'Objective slug')
    .description('Update an objective (title / target / feature / manual status override)')
    .option('--title <title>', 'New title')
    .option('--target <date>', 'New target date (YYYY-MM-DD), or "clear"')
    .option('--feature <slug>', 'Backing feature slug, or "clear"')
    .option('--status <status>', `Manual override: ${OBJECTIVE_STATUSES.join('|')}, or "clear" (back to computed)`)
    .action((slug: string, opts: { title?: string; target?: string; feature?: string; status?: string }) => {
      if (opts.title === undefined && opts.target === undefined && opts.feature === undefined && opts.status === undefined) {
        error('Nothing to change — pass --title, --target, --feature, or --status.');
        process.exitCode = 1;
        return;
      }
      try {
        const patch: Parameters<typeof updateObjective>[2] = {};
        if (opts.title !== undefined) patch.title = opts.title;
        if (opts.target !== undefined) patch.target_date = opts.target === 'clear' ? null : opts.target;
        if (opts.feature !== undefined) patch.feature = opts.feature === 'clear' ? null : opts.feature;
        if (opts.status !== undefined) patch.status = opts.status === 'clear' ? null : (opts.status as ObjectiveStatus);
        updateObjective(ensureContextRoot(), slug, patch);
        success(`Objective updated: ${slug}`);
      } catch (err) {
        handleObjectiveError(err);
      }
    });

  objective
    .command('metric')
    .argument('<slug>', 'Objective slug')
    .description('Set/update the Key Result metric that drives progress (e.g. MRR). --current is the common nudge.')
    .option('--current <n>', 'Latest observed value (the number that moves over time)')
    .option('--target <n>', 'The value that means 100% done')
    .option('--baseline <n>', 'Where the metric started (progress is measured from here)')
    .option('--label <label>', 'What the number measures (e.g. "MRR")')
    .option('--unit <unit>', 'Display unit (e.g. "USD"), or "clear" to drop it')
    .option('--clear', 'Remove the metric entirely — objective goes back to task-based progress')
    .action((slug: string, opts: {
      current?: string; target?: string; baseline?: string; label?: string; unit?: string; clear?: boolean;
    }) => {
      try {
        const root = ensureContextRoot();
        if (opts.clear) {
          updateObjective(root, slug, { metric: null });
          success(`Metric cleared on ${slug} — progress is task-based again.`);
          return;
        }
        if (opts.current === undefined && opts.target === undefined && opts.baseline === undefined
            && opts.label === undefined && opts.unit === undefined) {
          error('Nothing to change — pass --current, --target, --baseline, --label, --unit, or --clear.');
          process.exitCode = 1;
          return;
        }
        const patch: Parameters<typeof updateObjectiveMetric>[2] = {};
        if (opts.current !== undefined) patch.current = parseNum(opts.current, '--current');
        if (opts.target !== undefined) patch.target = parseNum(opts.target, '--target');
        if (opts.baseline !== undefined) patch.baseline = parseNum(opts.baseline, '--baseline');
        if (opts.label !== undefined) patch.label = opts.label;
        if (opts.unit !== undefined) patch.unit = opts.unit === 'clear' ? null : opts.unit;
        const o = updateObjectiveMetric(root, slug, patch);
        const m = o.metric!;
        const model = buildRoadmapModel(root);
        const pct = model.objectives.find((x) => x.slug === slug)?.progress.pct ?? 0;
        success(`${slug} · ${m.label}: ${m.current}/${m.target}${m.unit ? ` ${m.unit}` : ''} (${pct}%)`);
      } catch (err) {
        handleObjectiveError(err);
      }
    });

  objective
    .command('delete')
    .argument('<slug>', 'Objective slug')
    .description('Delete an objective (removes it from other objectives\' depends_on too)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (slug: string, opts: { yes?: boolean }) => {
      const root = ensureContextRoot();
      if (!getObjective(root, slug)) {
        error(`Objective not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error('Refusing to delete without --yes in a non-interactive session.');
          process.exitCode = 1;
          return;
        }
        const { promptInput } = await import('../../lib/prompt.js');
        const answer = (await promptInput({ message: `Delete objective "${slug}"? Type the slug to confirm:` })).trim();
        if (answer !== slug) {
          error('Confirmation did not match — nothing deleted.');
          return;
        }
      }
      try {
        deleteObjective(root, slug);
        success(`Objective deleted: ${slug} (task objectives: references to it are now warnings in the board)`);
      } catch (err) {
        handleObjectiveError(err);
      }
    });

  objective
    .command('depend')
    .argument('<slug>', 'The objective that depends on another')
    .argument('<on>', 'The objective it depends on')
    .description('Add a dependency edge (rejected at write time if it would create a cycle)')
    .action((slug: string, on: string) => {
      try {
        addDependency(ensureContextRoot(), slug, on);
        success(`${slug} now depends on ${on} — its forecast inherits ${on}'s slips.`);
      } catch (err) {
        handleObjectiveError(err);
      }
    });

  objective
    .command('undepend')
    .argument('<slug>', 'The objective to detach')
    .argument('<on>', 'The dependency to remove')
    .description('Remove a dependency edge')
    .action((slug: string, on: string) => {
      try {
        removeDependency(ensureContextRoot(), slug, on);
        success(`${slug} no longer depends on ${on}.`);
      } catch (err) {
        handleObjectiveError(err);
      }
    });
}
