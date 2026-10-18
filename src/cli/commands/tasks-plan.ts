import type { Command } from 'commander';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, info, success } from '../../lib/format.js';
import { getTaskBackend, type TaskBackend } from '../../lib/task-backend/index.js';
import { planTask, rankTask } from '../../lib/task-plan.js';

/**
 * Planning verbs: `tasks plan` puts a task (and, for a parent, its open
 * children) into a cycle or a queue; `tasks rank` orders it inside its bucket.
 * Neither writes priority, urgency or a version. The moves themselves live in
 * lib/task-plan.ts, shared with the dashboard routes.
 */

export { applyPlacement, describePlacement, syncParentPlacements } from '../../lib/task-plan.js';

async function resolve(backend: TaskBackend, name: string): Promise<string | null> {
  const res = await backend.resolveSlug(name);
  if (res.kind === 'match') return res.slug;
  if (res.kind === 'ambiguous') error(`Ambiguous task name "${name}". Did you mean: ${res.candidates.join(', ')}?`);
  error(`Task not found: ${name}`);
  process.exitCode = 1;
  return null;
}

export function registerTaskPlanCommands(tasks: Command): void {
  tasks
    .command('plan')
    .argument('<task>', 'Task name or slug')
    .argument('<target>', 'now (the active cycle) | next | later | a cycle id (cy_…) or number')
    .description('Plan a task into a cycle or a queue (Now / Next / Later). A parent brings its open sub-tasks with it')
    .action(async (name: string, targetRef: string) => {
      const root = ensureContextRoot();
      const backend = getTaskBackend();
      const slug = await resolve(backend, name);
      if (!slug) return;
      const r = await planTask(root, backend, slug, targetRef);
      if (!r.ok) {
        error(r.message);
        process.exitCode = 1;
        return;
      }
      if (r.selfMoved.length === 0 && r.kidMoves.length === 0) {
        info(`${slug} is already in ${r.where}.`);
        return;
      }
      success(`${slug} → ${r.where}${r.kidMoves.length > 0 ? ` (with ${r.kidMoves.length} open sub-task(s))` : ''}.`);
      if (r.parent) info(`Shown under its parent ${r.parent}.`);
    });

  tasks
    .command('rank')
    .argument('<task>', 'Task name or slug')
    .option('--before <task>', 'Place it just before this task (same cycle or queue)')
    .option('--after <task>', 'Place it just after this task (same cycle or queue)')
    .description('Order a task inside its cycle or queue (importance is rank, not priority)')
    .action(async (name: string, opts: { before?: string; after?: string }) => {
      if ((opts.before ? 1 : 0) + (opts.after ? 1 : 0) !== 1) {
        error('Give exactly one of --before <task> or --after <task>.');
        process.exitCode = 1;
        return;
      }
      const root = ensureContextRoot();
      const backend = getTaskBackend();
      const slug = await resolve(backend, name);
      if (!slug) return;
      const anchor = await resolve(backend, (opts.before ?? opts.after)!);
      if (!anchor) return;
      const r = await rankTask(root, backend, slug, opts.after ? { after: anchor } : { before: anchor });
      if (!r.ok) {
        error(r.message);
        process.exitCode = 1;
        return;
      }
      if (r.changed === 0) { info(`${slug} is already ${opts.before ? 'before' : 'after'} ${anchor}.`); return; }
      success(`${slug} ranked ${opts.before ? 'before' : 'after'} ${anchor} (${r.position} of ${r.of}).`);
    });
}
