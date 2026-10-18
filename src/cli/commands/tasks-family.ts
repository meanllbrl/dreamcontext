import type { Command } from 'commander';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, success } from '../../lib/format.js';
import { today } from '../../lib/id.js';
import { getTaskBackend, type TaskBackend } from '../../lib/task-backend/index.js';
import { linkTaskToParent } from '../../lib/task-parent-link.js';
import { bindSession, unbindSession } from '../../lib/session-task.js';
import { isSafeSessionId } from '../../lib/transcript-locate.js';
import { buildContextPacket, PACKET_CAP, PACKET_JOURNAL_ENTRIES } from '../../lib/task-context-packet.js';

/**
 * The sub-task verbs that do not need the rest of `tasks.ts`: `tasks parent`
 * (link / move / detach) here; `tasks create --parent` and the close, cancel
 * and delete guards live next to their commands in tasks.ts.
 */

async function resolve(backend: TaskBackend, name: string): Promise<string | null> {
  const res = await backend.resolveSlug(name);
  if (res.kind === 'match') return res.slug;
  if (res.kind === 'ambiguous') error(`Ambiguous task name "${name}". Did you mean: ${res.candidates.join(', ')}?`);
  error(`Task not found: ${name}`);
  process.exitCode = 1;
  return null;
}

export function registerTaskFamilyCommands(tasks: Command): void {
  tasks
    .command('bind')
    .argument('<task>', 'Task name or slug')
    .description('Bind this Claude session to a task: after a compaction its context packet is delivered again (needs CLAUDE_CODE_SESSION_ID)')
    .action(async (name: string) => {
      const root = ensureContextRoot();
      const session = (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim();
      if (!isSafeSessionId(session)) {
        error('No Claude session here (CLAUDE_CODE_SESSION_ID is unset or invalid); a binding belongs to a session.');
        process.exitCode = 1;
        return;
      }
      const slug = await resolve(getTaskBackend(), name);
      if (!slug) return;
      if (!bindSession(root, session, slug, 'cli')) {
        error(`Could not bind this session to ${slug}.`);
        process.exitCode = 1;
        return;
      }
      success(`This session is bound to ${slug}.`);
    });

  tasks
    .command('unbind')
    .description('Clear this Claude session\'s task binding')
    .action(() => {
      const session = (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim();
      if (isSafeSessionId(session)) unbindSession(ensureContextRoot(), session);
      success('This session is not bound to a task.');
    });

  tasks
    .command('show')
    .argument('<task>', 'Task name or slug')
    .description('Print the task\'s context packet: its parent\'s card and siblings first, then its card, then its latest journal entries (what an agent reads before working it)')
    .option('--json', 'Emit { slug, parent, chars, cut, text } as JSON')
    .option('--cap <chars>', `Character cap (default ${PACKET_CAP}; the parent's Why and decisions and this task's criteria are never cut)`)
    .option('--entries <n>', `Journal entries to include (default ${PACKET_JOURNAL_ENTRIES})`)
    .action(async (name: string, opts: { json?: boolean; cap?: string; entries?: string }) => {
      const root = ensureContextRoot();
      const backend = getTaskBackend();
      const slug = await resolve(backend, name);
      if (!slug) return;
      const cap = opts.cap !== undefined ? Number(opts.cap) : undefined;
      const entries = opts.entries !== undefined ? Number(opts.entries) : undefined;
      if ((cap !== undefined && !(cap > 0)) || (entries !== undefined && !(entries >= 0))) {
        error('--cap must be a positive number and --entries a number ≥ 0.');
        process.exitCode = 1;
        return;
      }
      const packet = buildContextPacket(root, slug, { ...(cap ? { cap } : {}), ...(entries !== undefined ? { journalEntries: entries } : {}) });
      if (!packet) {
        error(`Task not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        const { nonce: _n, ...rest } = packet;
        console.log(JSON.stringify(rest, null, 2));
        return;
      }
      process.stdout.write(packet.text);
    });

  tasks
    .command('parent')
    .argument('<task>', 'The task to place')
    .argument('<parent>', 'Its parent task, or "clear" to make it top-level')
    .description('Make a task a sub-task of a parent (two levels only; inherits objectives and feature when it has none), or clear it')
    .action(async (name: string, parentName: string) => {
      const root = ensureContextRoot();
      const backend = getTaskBackend();
      const slug = await resolve(backend, name);
      if (!slug) return;
      const task = await backend.get(slug);
      if (!task) return;

      if (parentName === 'clear') {
        if (!task.parent_task) {
          success(`${slug} has no parent.`);
          return;
        }
        const was = task.parent_task;
        await backend.addJournal(slug, { kind: 'log', body: `- detached from ${was}` });
        await backend.updateFields(slug, { parent_task: null, updated_at: today() });
        success(`${slug} is top-level again (was under ${was}).`);
        return;
      }

      const parentSlug = await resolve(backend, parentName);
      if (!parentSlug) return;
      const linked = await linkTaskToParent(root, backend, slug, parentSlug);
      if (!linked.ok) {
        error(linked.reason);
        process.exitCode = 1;
        return;
      }
      if (linked.already) {
        success(`${slug} is already a sub-task of ${linked.parent}.`);
        return;
      }
      const from = linked.was ? ` (moved from ${linked.was})` : '';
      success(`${slug} is now a sub-task of ${linked.parent}${from}.`);
      if (linked.inherited.length > 0) console.log(chalk.dim(`  inherited: ${linked.inherited.join(', ')}`));
    });
}
