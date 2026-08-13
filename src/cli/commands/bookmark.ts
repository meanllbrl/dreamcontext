import { Command } from 'commander';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readSleepState, writeSleepState } from './sleep.js';
import { generateId } from '../../lib/id.js';
import { success, error, header } from '../../lib/format.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import type { TaskBackend } from '../../lib/task-backend/index.js';
import {
  OPEN_TASK_HINT_LIMIT,
  rankOpenTasks,
  readActiveTaskSlug,
  resolveBookmarkId,
  unlinkedBookmarkHint,
  type OpenTaskRow,
} from '../../lib/bookmark-task-link.js';

const SALIENCE_LABELS: Record<number, string> = {
  1: '★',
  2: '★★',
  3: '★★★',
};

/**
 * Advisory output goes to STDERR and never changes the exit code: a bookmark
 * that lands with a warning is worth more than one an angry exit code talked
 * the agent out of writing. stdout stays the success line alone, so anything
 * parsing it is unaffected.
 */
function advise(lines: string[]): void {
  if (lines.length === 0) return;
  console.error(chalk.yellow('⚠') + ' ' + lines[0]);
  for (const line of lines.slice(1)) console.error(chalk.dim(line));
}

/**
 * Candidate list for a "did you mean" hint. Capped: a one-letter `--task a`
 * prefix-matches most of a mature vault, and a 250-slug wall of text is not a
 * suggestion.
 */
function preview(candidates: string[], max = 8): string {
  const shown = candidates.slice(0, max).join(', ');
  return candidates.length > max ? `${shown}, +${candidates.length - max} more` : shown;
}

/** Escape hatch for scripted/bulk callers that link bookmarks themselves. */
function hintsEnabled(): boolean {
  return process.env.DREAMCONTEXT_BOOKMARK_HINT !== '0';
}

/** Open (non-completed) tasks, most-likely-first, plus the total. Never throws. */
async function openTasks(
  backend: TaskBackend,
): Promise<{ candidates: OpenTaskRow[]; total: number }> {
  try {
    const rows: OpenTaskRow[] = await backend.list();
    const open = rows.filter((t) => String(t.status).toLowerCase() !== 'completed');
    return { candidates: rankOpenTasks(open, OPEN_TASK_HINT_LIMIT), total: open.length };
  } catch {
    return { candidates: [], total: 0 };
  }
}

type LinkVia = 'flag' | 'resolved' | 'active-task' | 'unverified' | null;

interface ResolvedLink {
  /** What gets stored in `task_slug`. */
  slug: string | null;
  via: LinkVia;
  /** stderr advisory lines (unknown / ambiguous `--task` input). */
  warnings: string[];
  /** The raw `--task` value, when it differs from the slug we resolved to. */
  input?: string;
}

/**
 * Decide the bookmark's task address, cheapest signal first:
 *   1. `--task` — verified against the task backend and, when it is a name or a
 *      prefix rather than a slug, resolved the same way every other task verb
 *      resolves one (`tasks log`, `tasks complete`). An input that resolves to
 *      nothing is STORED AS GIVEN and warned about — never silently dropped.
 *   2. `state/.active-task` — the explicit session override, used as an
 *      implicit `--task` and said out loud in the output.
 *   3. nothing — the caller prints the open-task hint.
 *
 * Backend trouble degrades to "store what the user typed, say nothing": task
 * lookup is an ADVISORY layer over `bookmark add` and must never cost a
 * bookmark.
 */
async function resolveTaskLink(root: string, flag?: string): Promise<ResolvedLink> {
  const raw = (flag ?? '').trim();

  if (raw) {
    let backend: TaskBackend;
    try {
      backend = getTaskBackend(root);
    } catch {
      return { slug: raw, via: 'unverified', warnings: [] };
    }

    try {
      if (await backend.get(raw)) return { slug: raw, via: 'flag', warnings: [] };

      const res = await backend.resolveSlug(raw);
      if (res.kind === 'match') {
        return { slug: res.slug, via: 'resolved', warnings: [], input: raw };
      }

      // Unknown or ambiguous: keep the user's value (losing it would be worse
      // than storing an imperfect one) and show what a repair would target.
      const warnings = [`--task "${raw}" matches no task — bookmark saved with that value as-is.`];
      if (res.kind === 'ambiguous') {
        warnings.push(`  Did you mean: ${preview(res.candidates)}`);
      } else {
        const { candidates, total } = await openTasks(backend);
        if (candidates.length > 0) {
          const shown = candidates.map((t) => t.name).join(', ');
          const more = total > candidates.length ? `, +${total - candidates.length} more` : '';
          warnings.push(`  Open tasks: ${shown}${more}`);
        }
      }
      return { slug: raw, via: 'unverified', warnings };
    } catch {
      return { slug: raw, via: 'unverified', warnings: [] };
    }
  }

  const active = readActiveTaskSlug(root);
  if (active) return { slug: active, via: 'active-task', warnings: [] };

  return { slug: null, via: null, warnings: [] };
}

export function registerBookmarkCommand(program: Command): void {
  const bookmark = program
    .command('bookmark')
    .description('Tag important moments for consolidation (awake ripples)');

  // --- add (default) ---
  bookmark
    .command('add')
    .argument('<message...>', 'What to remember')
    .option('-s, --salience <level>', 'Importance level (1=notable, 2=significant, 3=critical)', '2')
    .option('-t, --task <slug>', 'Associated task slug (defaults to state/.active-task when set)')
    .description('Create a bookmark')
    .action(async (messageParts: string[], opts: { salience: string; task?: string }) => {
      const salience = parseInt(opts.salience, 10);
      if (![1, 2, 3].includes(salience)) {
        error('Salience must be 1, 2, or 3.');
        return;
      }

      const message = messageParts.join(' ').trim();
      if (!message) {
        error('Message is required.');
        return;
      }

      const root = ensureContextRoot();
      const link = await resolveTaskLink(root, opts.task);
      const state = readSleepState(root);

      const id = generateId('bm');
      state.bookmarks.unshift({
        id,
        message,
        salience: salience as 1 | 2 | 3,
        created_at: new Date().toISOString(),
        session_id: null, // linked by stop hook later
        task_slug: link.slug,
      });

      writeSleepState(root, state);

      const via = link.via === 'active-task' ? ' via .active-task' : '';
      const taskRef = link.slug ? chalk.dim(` (task: ${link.slug}${via})`) : '';
      success(`${SALIENCE_LABELS[salience]} Bookmarked: ${message}${taskRef}`);
      if (link.via === 'resolved' && link.input) {
        console.log(chalk.dim(`  resolved "${link.input}" → ${link.slug}`));
      }

      advise(link.warnings);

      // The gap this closes: an unaddressed bookmark used to pass in silence,
      // and the miss only surfaced during sleep — in bulk, long after the
      // session that could have answered it ended.
      if (!link.slug && hintsEnabled()) {
        try {
          const { candidates, total } = await openTasks(getTaskBackend(root));
          advise(unlinkedBookmarkHint({ bookmarkId: id, candidates, openCount: total }));
        } catch {
          // no task layer, no advice — the bookmark is already saved
        }
      }
    });

  // --- list ---
  bookmark
    .command('list')
    .description('Show current bookmarks')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);

      if (state.bookmarks.length === 0) {
        console.log(chalk.dim('No bookmarks.'));
        return;
      }

      console.log(header('Bookmarks'));
      for (const b of state.bookmarks) {
        const stars = SALIENCE_LABELS[b.salience] || '★';
        const time = chalk.dim(b.created_at.split('T')[0]);
        // Addressed vs unaddressed is the point of this view — an unlinked
        // bookmark states it rather than merely lacking a tag nobody notices.
        const taskRef = b.task_slug
          ? chalk.cyan(` [${b.task_slug}]`)
          : chalk.yellow(' [no task]');
        console.log(`  ${stars} ${time} ${b.message}${taskRef} ${chalk.dim(b.id)}`);
      }

      const unlinked = state.bookmarks.filter((b) => !b.task_slug).length;
      if (unlinked > 0) {
        console.log(
          chalk.yellow(`\n  ⚠ ${unlinked} of ${state.bookmarks.length} bookmark(s) have no task link.`)
          + chalk.dim('\n    Repair before the next consolidation: dreamcontext bookmark relink <id> --task <slug>'),
        );
      }
    });

  // --- relink ---
  bookmark
    .command('relink')
    .argument('<id>', 'Bookmark id (or a unique prefix) from `bookmark list`')
    .requiredOption('-t, --task <slug>', 'Task to link it to')
    .description('Point an existing bookmark at a task (repairs a missing --task)')
    .action(async (idInput: string, opts: { task: string }) => {
      const root = ensureContextRoot();

      const wanted = opts.task.trim();
      if (!wanted) {
        error('--task requires a task slug.', 'Run `dreamcontext tasks list` to see task slugs.');
        return;
      }

      // Fail fast on a bad id before spending any task-backend I/O on it.
      const match = resolveBookmarkId(readSleepState(root).bookmarks.map((b) => b.id), idInput);
      if (match.kind === 'ambiguous') {
        error(`Ambiguous bookmark id "${idInput}".`, `Did you mean: ${preview(match.candidates)}`);
        return;
      }
      if (match.kind === 'none') {
        error(`No bookmark with id "${idInput}".`, 'Run `dreamcontext bookmark list` to see ids.');
        return;
      }

      // Strict here, unlike `add`: a repair that writes another unverifiable
      // slug repairs nothing, and there is no in-flight bookmark to protect.
      const backend = getTaskBackend(root);
      let slug = wanted;
      if (!(await backend.get(wanted))) {
        const res = await backend.resolveSlug(wanted);
        if (res.kind === 'ambiguous') {
          error(`Ambiguous task "${wanted}".`, `Did you mean: ${preview(res.candidates)}`);
          return;
        }
        if (res.kind === 'none') {
          error(`Task not found: ${wanted}`, 'Run `dreamcontext tasks list` to see task slugs.');
          return;
        }
        slug = res.slug;
      }

      // ─── read-modify-write, with every await already behind us ───
      // `.sleep.json` has no lock and several processes append to it (the Stop
      // hook, a parallel session's `bookmark add`, `sleep done`). Reading it
      // BEFORE the backend round-trip — which is a network call on the ClickUp
      // / GitHub backends — and writing that stale snapshot back afterwards
      // would silently drop whatever landed in between. So the state is read
      // only once the slug is settled, and nothing awaits until it is written.
      const state = readSleepState(root);
      const target = state.bookmarks.find((b) => b.id === match.id);
      if (!target) {
        error(
          `Bookmark ${match.id} is gone — a consolidation cleared it while this ran.`,
          `Re-add it: dreamcontext bookmark add "…" -s 2 --task ${slug}`,
        );
        return;
      }
      const previous = target.task_slug;
      target.task_slug = slug;
      writeSleepState(root, state);

      success(`Relinked ${match.id}: ${previous ?? 'no task'} → ${slug}`);
      console.log(chalk.dim(`  ${target.message}`));
    });

  // --- clear ---
  bookmark
    .command('clear')
    .description('Remove all bookmarks')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      const count = state.bookmarks.length;
      state.bookmarks = [];
      writeSleepState(root, state);
      success(`Cleared ${count} bookmark(s).`);
    });
}
