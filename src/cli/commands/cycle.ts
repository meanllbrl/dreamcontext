import type { Command } from 'commander';
import { join } from 'node:path';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, header, info, printable, success, warn } from '../../lib/format.js';
import { today } from '../../lib/id.js';
import { loadStatuses } from '../../lib/overrides.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { loadFamily, type Family, type TaskBrief } from '../../lib/task-parent.js';
import { isCancelled, isDone, type StatusDef } from '../../lib/task-status.js';
import {
  activeCycle,
  carryCount,
  CycleError,
  cycleProgress,
  daysBetween,
  daysLeft,
  newCycle,
  nextPlannedCycle,
  readCycles,
  resolveCycleRef,
  startCycle,
  unresolvedCycleRefs,
  type ClosePlan,
  type CycleView,
} from '../../lib/cycles.js';
import { closableCycle, CloseError, decideClose, executeClose, resumeClose, type CloseAction, type CloseResult } from '../../lib/cycle-close.js';

/**
 * `dreamcontext cycle` — the planning time box. A cycle is a date range with a
 * one-sentence goal; one is active at a time; its number is display-only. The
 * close is a ritual: every unfinished leaf is carried into the next cycle,
 * sent back to the queue, or cancelled, and each carry is counted.
 */

const ACTIONS: readonly CloseAction[] = ['carry', 'back', 'cancel'];

function fail(msg: string): void {
  error(msg);
  process.exitCode = 1;
}

function splitList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function label(c: CycleView): string {
  return `#${c.number}`;
}

function dates(c: CycleView): string {
  return `${c.start} → ${c.end}`;
}

function timing(c: CycleView, now: string): string {
  if (c.status === 'active') return `${daysLeft(c, now)} day(s) left`;
  if (c.status === 'planned') {
    const d = daysBetween(now, c.start);
    return d > 0 ? `starts in ${d} day(s)` : 'ready to start';
  }
  return `closed ${c.closed_at ?? ''}`.trim();
}

function printNotes(notes: string[]): void {
  for (const n of notes) warn(printable(n));
}

/** Leaves in the cycle grouped under their parent (a lone child shows its parent as a header). */
function grouped(family: Family, defs: readonly StatusDef[], cycleId: string): Array<{ parent: TaskBrief | null; leaves: TaskBrief[] }> {
  const groups = new Map<string, { parent: TaskBrief | null; leaves: TaskBrief[] }>();
  for (const b of family.bySlug.values()) {
    if (b.cycle !== cycleId || family.children.get(b.slug)?.length) continue;
    if (isCancelled(defs, b.status)) continue;
    const parentSlug = family.parentOf.get(b.slug) ?? '';
    const g = groups.get(parentSlug) ?? { parent: parentSlug ? family.bySlug.get(parentSlug) ?? null : null, leaves: [] };
    g.leaves.push(b);
    groups.set(parentSlug, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.leaves.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.slug.localeCompare(b.slug));
  return out.sort((a, b) => (a.parent ? 0 : 1) - (b.parent ? 0 : 1) || (a.parent?.slug ?? '').localeCompare(b.parent?.slug ?? ''));
}

function cycleJson(c: CycleView, family: Family, defs: readonly StatusDef[], now: string, all: CycleView[]) {
  const p = cycleProgress(family, defs, c.id);
  return {
    ...c,
    days_left: c.status === 'active' ? daysLeft(c, now) : null,
    progress: c.status === 'closed' && c.result ? c.result : { done: p.done, total: p.total },
    open: p.open.map((b) => ({ slug: b.slug, status: b.status, parent: family.parentOf.get(b.slug) ?? null, carried: carryCount(all, b.slug) })),
  };
}

export function registerCycleCommand(program: Command): void {
  const cycle = program
    .command('cycle')
    .description('Cycles: a dated time box with one goal, one active at a time (apart from the queue and from releases)');

  cycle
    .command('new')
    .description('Open a planned cycle (default length: the last cycle\'s, else tasks.cycleDefaultWeeks, else 1 week)')
    .requiredOption('-g, --goal <sentence>', 'One sentence: what this cycle is for')
    .option('-w, --weeks <n>', 'Length in weeks')
    .option('--end <date>', 'Last day (YYYY-MM-DD, inclusive) instead of --weeks')
    .option('--start <date>', 'First day (default: today, or the day after the last open cycle ends)')
    .option('--json', 'Emit the cycle as JSON')
    .action((opts: { goal: string; weeks?: string; end?: string; start?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      if (opts.weeks !== undefined && opts.end !== undefined) return fail('Give --weeks or --end, not both.');
      const weeks = opts.weeks !== undefined ? Number(opts.weeks) : undefined;
      if (weeks !== undefined && !(weeks > 0)) return fail('--weeks must be a positive number.');
      try {
        const c = newCycle(root, { goal: opts.goal, weeks, end: opts.end, start: opts.start });
        if (opts.json) { console.log(JSON.stringify(c, null, 2)); return; }
        success(`Cycle ${label(c)} planned: ${dates(c)} — ${printable(c.goal)}`);
        info(`Start it with: dreamcontext cycle start ${c.number}`);
      } catch (err) {
        if (err instanceof CycleError) return fail(err.message);
        throw err;
      }
    });

  cycle
    .command('start')
    .argument('<cycle>', 'Cycle number or id')
    .description('Make a planned cycle the active one (refused while another is active)')
    .action((ref: string) => {
      const root = ensureContextRoot();
      try {
        const c = startCycle(root, ref);
        success(`Cycle ${label(c)} is active: ${dates(c)} — ${printable(c.goal)}`);
      } catch (err) {
        if (err instanceof CycleError) return fail(err.message);
        throw err;
      }
    });

  cycle
    .command('list')
    .description('List cycles (number, status, dates, done/total leaves, goal)')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const { cycles, notes } = readCycles(root);
      const defs = loadStatuses(root);
      const family = loadFamily(join(root, 'state'));
      const now = today();
      const unresolved = unresolvedCycleRefs(family, cycles);
      if (opts.json) {
        console.log(JSON.stringify({
          cycles: cycles.map((c) => cycleJson(c, family, defs, now, cycles)),
          not_yet_synced: Object.fromEntries(unresolved),
          notes,
        }, null, 2));
        return;
      }
      printNotes(notes);
      if (cycles.length === 0 && unresolved.size === 0) {
        info('No cycles yet. Open one: dreamcontext cycle new --goal "..."');
        return;
      }
      console.log(header('Cycles'));
      for (const c of [...cycles].reverse()) {
        const p = c.status === 'closed' && c.result ? c.result : cycleProgress(family, defs, c.id);
        const tag = c.status === 'active' ? chalk.green('active ') : c.status === 'planned' ? chalk.cyan('planned') : chalk.dim('closed ');
        console.log(`  ${label(c).padEnd(4)} ${tag} ${dates(c)}  ${String(p.done)}/${String(p.total)}  ${printable(c.goal)}`);
      }
      for (const [id, slugs] of unresolved) {
        console.log(chalk.yellow(`  ${printable(id)} — cycle not yet synced (${slugs.length} task(s)); it resolves when core/CYCLES.json arrives`));
      }
    });

  cycle
    .command('show')
    .argument('[cycle]', 'Cycle number or id (default: the active cycle)')
    .description('Show a cycle: goal, days left, progress over leaves, its work grouped under parents')
    .option('--json', 'Emit JSON')
    .action((ref: string | undefined, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const { cycles, notes } = readCycles(root);
      const c = ref ? resolveCycleRef(cycles, ref) : activeCycle(cycles);
      if (!c) return fail(ref ? `No cycle "${ref}". See: dreamcontext cycle list` : 'No cycle is active. See: dreamcontext cycle list');
      const defs = loadStatuses(root);
      const family = loadFamily(join(root, 'state'));
      const now = today();
      if (opts.json) { console.log(JSON.stringify(cycleJson(c, family, defs, now, cycles), null, 2)); return; }
      printNotes(notes);
      const p = cycleProgress(family, defs, c.id);
      console.log(header(`Cycle ${label(c)} · ${c.status} · ${dates(c)} · ${timing(c, now)}`));
      console.log(`  Goal: ${printable(c.goal)}`);
      const shown = c.status === 'closed' && c.result ? c.result : p;
      console.log(`  Progress: ${shown.done}/${shown.total} leaves done${c.status !== 'closed' ? ` · capacity ${p.total}` : ''}`);
      for (const g of grouped(family, defs, c.id)) {
        console.log(`\n  ${g.parent ? chalk.bold(`${g.parent.slug} — ${printable(g.parent.name)}`) : chalk.dim('(standalone)')}`);
        for (const b of g.leaves) {
          const n = carryCount(cycles, b.slug);
          const mark = isDone(defs, b.status) ? chalk.green('✓') : '·';
          console.log(`    ${mark} [${b.status}] ${b.slug}${n > 0 ? chalk.yellow(`  carried ${n}×`) : ''}`);
        }
      }
      if (c.status === 'closed') {
        for (const k of ['carried', 'backed', 'cancelled'] as const) {
          if (c[k]?.length) console.log(`\n  ${k}: ${printable(c[k]!.join(', '))}`);
        }
      }
    });

  cycle
    .command('close')
    .argument('[cycle]', 'Cycle number or id (default: the active cycle)')
    .description('Close a cycle: every unfinished leaf is carried into the next cycle, sent back to Next, or cancelled')
    .option('--carry <tasks>', 'Carry these into the next cycle (comma list, repeatable)', collect, [])
    .option('--back <tasks>', 'Send these back to the Next queue (comma list, repeatable)', collect, [])
    .option('--cancel <tasks>', 'Cancel these (comma list, repeatable)', collect, [])
    .option('--all <action>', 'carry | back | cancel for every unfinished leaf not named above')
    .option('--into <cycle>', 'The cycle carried work goes into (default: the next planned cycle)')
    .action(async (ref: string | undefined, opts: { carry: string[]; back: string[]; cancel: string[]; all?: string; into?: string }) => {
      const root = ensureContextRoot();
      const stateDir = join(root, 'state');
      let c: CycleView;
      let cycles: CycleView[];
      try {
        ({ cycle: c, cycles } = closableCycle(root, ref));
      } catch (e) {
        if (e instanceof CloseError) return fail(e.message);
        throw e;
      }
      if (opts.all !== undefined && !ACTIONS.includes(opts.all as CloseAction)) return fail('--all must be carry, back or cancel.');

      const defs = loadStatuses(root);
      const family = loadFamily(stateDir);
      let plan: ClosePlan;
      try {
        if (c.closing) {
          // A close that stopped halfway: its decisions were recorded before any
          // card moved, so finish exactly those (the moves are idempotent).
          if ([...opts.carry, ...opts.back, ...opts.cancel].length > 0 || opts.all) {
            warn('Ignoring the flags: finishing the decisions already recorded for this close.');
          }
          plan = resumeClose(root, c, cycles, opts.into);
          info(`Resuming the interrupted close of cycle ${label(c)}.`);
        } else {
          const progress = cycleProgress(family, defs, c.id);
          const openSlugs = new Set(progress.open.map((b) => b.slug));
          const decisions = new Map<string, CloseAction>();
          for (const action of ACTIONS) {
            for (const slug of splitList(opts[action])) {
              if (!openSlugs.has(slug)) {
                return fail(`${slug} is not an unfinished leaf of cycle ${label(c)}. Unfinished: ${[...openSlugs].join(', ') || '(none)'}`);
              }
              if (decisions.has(slug) && decisions.get(slug) !== action) return fail(`${slug} is named for both ${decisions.get(slug)} and ${action}.`);
              decisions.set(slug, action);
            }
          }
          for (const b of progress.open) if (!decisions.has(b.slug) && opts.all) decisions.set(b.slug, opts.all as CloseAction);

          const undecided = progress.open.filter((b) => !decisions.has(b.slug));
          if (undecided.length > 0) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
              error(`Cycle ${label(c)} has ${undecided.length} unfinished leaf/leaves without a decision:`);
              for (const b of undecided) console.log(`  - ${b.slug} [${b.status}]${carryCount(cycles, b.slug) > 0 ? ` (carried ${carryCount(cycles, b.slug)}×)` : ''}`);
              console.log(chalk.dim('  Decide each: --carry <tasks> | --back <tasks> | --cancel <tasks>, or --all carry|back|cancel'));
              process.exitCode = 1;
              return;
            }
            for (const b of undecided) {
              const n = carryCount(cycles, b.slug);
              const action = await select<CloseAction>({
                message: `${b.slug} [${b.status}]${n > 0 ? ` — carried ${n}× already` : ''}`,
                choices: [
                  { value: 'carry', name: 'Carry into the next cycle' },
                  { value: 'back', name: 'Back to the Next queue' },
                  { value: 'cancel', name: 'Cancel' },
                ],
              });
              decisions.set(b.slug, action);
            }
          }
          plan = decideClose(root, c, cycles, family, defs, decisions, opts.into);
        }
      } catch (e) {
        if (e instanceof CloseError) return fail(e.message);
        throw e;
      }

      let closed: CloseResult;
      try {
        closed = await executeClose(root, getTaskBackend(), c, cycles, family, defs, plan);
      } catch (e) {
        if (e instanceof CloseError) return fail(e.message);
        throw e;
      }
      const { carry, back, cancel } = closed.moved;
      const progress = closed.result;
      success(`Cycle ${label(closed.cycle)} closed: ${progress.done}/${progress.total} leaves done` +
        (carry.length ? `, ${carry.length} carried into ${label(closed.into!)}` : '') +
        (back.length ? `, ${back.length} back to Next` : '') +
        (cancel.length ? `, ${cancel.length} cancelled` : '') + '.');
      const next = nextPlannedCycle(readCycles(root).cycles);
      if (next) info(`Next: dreamcontext cycle start ${next.number}`);
    });
}
