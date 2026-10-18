import type { Command } from 'commander';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { listFeatureSlugs } from '../../lib/feature-links.js';
import { error, header, info, success } from '../../lib/format.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { isSafeTaskSlug } from '../../lib/task-backend/local.js';
import { safeResolveInside } from '../../lib/safe-resolve.js';
import {
  BACKLOG_MIGRATION_VERSION,
  BacklogError,
  backlogReport,
  createFamilyParent,
  decideTask,
  pendingRecords,
  SUGGESTED_CHANGES,
  suggestChange,
  type SuggestedChange,
  readBacklogStore,
  type BacklogReport,
  type BacklogTaskRecord,
} from '../../lib/backlog-migration.js';
import { isSelfApprovalEnv } from './agents.js';

/**
 * `dreamcontext migrations backlog` — the agent half of the 0.33.0 task
 * migration (and the owner's way to read or correct it): see what waits,
 * decide each task, create a parent for a family, read the before/after.
 */

function fail(err: unknown): void {
  error(err instanceof BacklogError ? err.message : ((err as Error).message ?? String(err)));
  process.exitCode = 1;
}

/** An agent run records its decisions as the agent's; a person's shell as the owner's. */
function decider(): 'agent' | 'owner' {
  return isSelfApprovalEnv(process.env) ? 'agent' : 'owner';
}

interface CardInfo {
  status: string;
  description: string;
  feature: string | null;
  legacyVersion: string | null;
  parent: string | null;
  place: string;
}

function cardInfo(root: string, slug: string): CardInfo | null {
  if (!isSafeTaskSlug(slug)) return null;
  try {
    const { data } = readFrontmatter<Record<string, unknown>>(safeResolveInside(root, `state/${slug}.md`));
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null);
    const cycle = str(data.cycle);
    return {
      status: String(data.status ?? ''),
      description: (str(data.description) ?? '').replace(/\s+/g, ' '),
      feature: str(data.related_feature),
      legacyVersion: str(data.version),
      parent: str(data.parent_task),
      place: cycle ? `cycle ${cycle}` : data.queue === 'later' ? 'Later' : 'Next',
    };
  } catch {
    return null;
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printCounts(r: BacklogReport): void {
  if (r.before) {
    console.log(`  open        ${r.before.open} → ${r.now.open}`);
    console.log(`  top-level   ${r.before.topLevel} → ${r.now.topLevel}   ${chalk.dim('(standalone open tasks + parents with open work)')}`);
    console.log(`  parents     ${r.before.parents} → ${r.now.parents}`);
  }
  const nowF = r.now.byFeature;
  if (nowF) {
    const was = r.before?.byFeature ? `${r.before.byFeature.groups} → ` : '';
    console.log(`  by feature  ${was}${nowF.groups} groups   ${chalk.dim(`(${nowF.features} features + ${nowF.unlinked} top-level item(s) with none: a board grouped by area)`)}`);
  }
  const o = r.outcomes;
  console.log(`  outcomes    keep ${o.keep} · merge ${o.merge} · cancel ${o.cancel} · waiting ${o.pending}${o.closedMeanwhile ? ` · closed meanwhile ${o.closedMeanwhile}` : ''}`);
  console.log(`  decided by  code ${r.by.code} · agent ${r.by.agent} · owner ${r.by.owner}`);
  console.log(`  proposals   ${r.proposalsWaiting} waiting on the Tasks screen`);
  console.log(`  placement   now ${r.placement.now} · next ${r.placement.next} · later ${r.placement.later}   ${chalk.dim('(leaves and standalone tasks)')}`);
  if (r.retiredReleases.length > 0) console.log(`  retired     planning ${r.retiredReleases.join(', ')}${r.activeVersionRemoved ? ' + state/.active-version.json' : ''}`);
  else if (r.activeVersionRemoved) console.log('  retired     state/.active-version.json');
  if (r.createdParents.length > 0) console.log(`  new parents ${r.createdParents.join(', ')}`);
}

function printRecord(root: string, rec: BacklogTaskRecord, waiting: boolean): void {
  const card = cardInfo(root, rec.slug);
  const bits = [
    card ? `[${card.status}]` : chalk.red('[missing]'),
    card?.feature ? `feature: ${card.feature}` : null,
    card?.legacyVersion ? `was: ${card.legacyVersion}` : null,
    card ? card.place : null,
    card?.parent ? `under: ${card.parent}` : null,
    rec.intent ? chalk.yellow(`interrupted ${rec.intent.outcome}${rec.intent.into ? ` → ${rec.intent.into}` : ''}: decide it the same way to finish`) : null,
  ].filter(Boolean);
  if (waiting) {
    console.log(`  ${chalk.bold(rec.slug)}  ${chalk.dim(bits.join(' · '))}`);
    console.log(`    ${rec.name}`);
    if (card?.description && card.description !== rec.name) {
      console.log(`    ${chalk.dim(card.description.length > 200 ? `${card.description.slice(0, 199)}…` : card.description)}`);
    }
    return;
  }
  const what = rec.outcome === 'merge' ? `merge → ${rec.into}` : rec.outcome ?? 'waiting';
  const sug = rec.suggestion;
  const proposal = sug && !sug.resolved
    ? chalk.yellow(` (suggested: ${sug.change}${sug.target ? ` ${sug.target}` : ''}, waits for the owner)`)
    : sug?.resolved ? chalk.dim(` (suggestion ${sug.change} ${sug.resolved.verdict})`) : '';
  console.log(`  ${rec.slug}  ${chalk.cyan(what)} ${chalk.dim(`by ${rec.by}`)}${proposal}${rec.reason ? chalk.dim(` — ${rec.reason}`) : ''}`);
}

export function registerBacklogMigrationCommands(migrations: Command): void {
  const backlog = migrations
    .command('backlog')
    .description(`The ${BACKLOG_MIGRATION_VERSION} task migration: what waits, decide each open task, group families, before/after`);

  backlog
    .command('show')
    .description('What the migration took stock of: tasks still waiting for an outcome, and every decision so far')
    .option('--pending', 'Only the tasks still waiting for an outcome')
    .option('--json', 'Machine-readable output')
    .action((opts: { pending?: boolean; json?: boolean }) => {
      const root = ensureContextRoot();
      try {
        const store = readBacklogStore(root);
        if (!store) {
          info('Nothing waits: the task migration has not taken stock in this brain (no open tasks, or not run yet).');
          return;
        }
        const waiting = pendingRecords(root, store);
        const waitingSet = new Set(waiting.map((r) => r.slug));
        if (opts.json) {
          const records = (opts.pending ? waiting : Object.values(store.tasks))
            .map((r) => ({ ...r, waiting: waitingSet.has(r.slug), card: cardInfo(root, r.slug) }));
          console.log(JSON.stringify({ report: backlogReport(root), records }, null, 2));
          return;
        }
        const report = backlogReport(root);
        console.log(header(`Task migration ${BACKLOG_MIGRATION_VERSION} — took stock ${store.startedAt.slice(0, 10)}`));
        printCounts(report);
        if (waiting.length === 0) {
          console.log();
          info('Nothing waits: every task the migration took stock of has an outcome.');
        } else {
          const features = listFeatureSlugs(root);
          console.log(`\n${chalk.bold(`Features (the areas a task can belong to, ${features.length})`)}`);
          console.log(features.length > 0 ? `  ${features.join(', ')}` : chalk.dim('  none: this brain has no feature docs, so no task gets one'));
          console.log(`\n${chalk.bold(`Waiting for an outcome (${waiting.length})`)}`);
          for (const r of waiting) printRecord(root, r, true);
        }
        if (!opts.pending) {
          const decided = Object.values(store.tasks).filter((r) => r.outcome !== null);
          if (decided.length > 0) {
            console.log(`\n${chalk.bold(`Decided (${decided.length})`)}`);
            for (const r of decided) printRecord(root, r, false);
          }
        }
      } catch (err) {
        fail(err);
      }
    });

  backlog
    .command('decide')
    .argument('<task>', 'Task slug')
    .argument('<outcome>', 'keep | merge | cancel')
    .option('--parent <slug>', 'keep: put it under this open parent (two levels only)')
    .option('--queue <queue>', 'keep: next | later (only outside a cycle)')
    .option('--into <slug>', 'merge: the task that stays and absorbs this one')
    .option('--feature <slug>', 'keep: the feature (area) its family belongs to; on a parent it reaches its open sub-tasks')
    .option('--reason <text>', 'Why: what you saw on this task (required from an agent; the evidence for a merge or a cancel)')
    .description('Give one open task its outcome: keep (optionally under a parent, linked to a feature, or in Later), merge (cancelled + absorbed_by, never deleted) or cancel')
    .action(async (slug: string, outcome: string, opts: { parent?: string; queue?: string; into?: string; feature?: string; reason?: string }) => {
      const root = ensureContextRoot();
      if (outcome !== 'keep' && outcome !== 'merge' && outcome !== 'cancel') return fail(new Error('Outcome must be keep, merge or cancel.'));
      if (opts.queue !== undefined && opts.queue !== 'next' && opts.queue !== 'later') return fail(new Error('--queue must be next or later.'));
      if (outcome === 'cancel' && !opts.reason?.trim()) return fail(new Error('A cancel needs --reason with the evidence that the work is dead.'));
      const by = decider();
      if (by === 'agent' && !opts.reason?.trim()) return fail(new Error('An agent\'s decision needs --reason: what you saw on THIS task.'));
      try {
        const rec = await decideTask(root, getTaskBackend(), slug, {
          outcome,
          by,
          ...(opts.parent ? { parent: opts.parent } : {}),
          ...(opts.queue ? { queue: opts.queue as 'next' | 'later' } : {}),
          ...(opts.into ? { into: opts.into } : {}),
          ...(opts.feature ? { feature: opts.feature } : {}),
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
        const where = rec.outcome === 'merge' ? ` into ${rec.into}` : '';
        const changed = rec.changes.filter((c) => c.at === rec.decidedAt).map((c) => c.field);
        success(`${slug}: ${rec.outcome}${where} (by ${rec.by})${changed.length ? chalk.dim(` — changed ${changed.join(', ')}`) : ''}`);
      } catch (err) {
        fail(err);
      }
    });

  backlog
    .command('parent')
    .argument('<name>', 'The deliverable, named as an outcome')
    .requiredOption('--why <text>', 'One sentence: what finishing it delivers')
    .requiredOption('--children <slugs>', 'Comma-separated: the two or more open tasks that are its steps')
    .option('--criterion <text>', 'What is observable when the deliverable is done (required; repeat for more)', collect, [])
    .option('--description <text>', 'Short description (defaults to the name)')
    .option('--feature <slug>', 'The feature (area) it belongs to; its steps without one take it')
    .description('Create a parent for a family of open tasks (a deliverable, never an area) and keep each of them under it')
    .action(async (name: string, opts: { why: string; children: string; criterion: string[]; description?: string; feature?: string }) => {
      const root = ensureContextRoot();
      try {
        const out = await createFamilyParent(root, getTaskBackend(), {
          name,
          why: opts.why,
          criteria: opts.criterion,
          children: opts.children.split(','),
          by: decider(),
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.feature ? { feature: opts.feature } : {}),
        });
        success(`Created ${out.slug} and kept ${out.linked.length} task(s) under it: ${out.linked.join(', ')}`);
      } catch (err) {
        fail(err);
      }
    });

  backlog
    .command('propose')
    .argument('<task>', 'Task slug')
    .argument('<change>', `${SUGGESTED_CHANGES.join(' | ')}`)
    .option('--into <slug>', 'merge: the task that would absorb it')
    .option('--parent <slug>', 'parent: the parent it would go under')
    .option('--feature <slug>', 'feature: the feature (area) it would belong to')
    .requiredOption('--why <text>', 'What you saw that makes the change likely')
    .description('Not sure? Keep the task as it is and put the change in front of the owner on the Tasks screen (Proposals)')
    .action(async (slug: string, change: string, opts: { into?: string; parent?: string; feature?: string; why: string }) => {
      const root = ensureContextRoot();
      if (!SUGGESTED_CHANGES.includes(change as SuggestedChange)) return fail(new Error(`The change must be one of: ${SUGGESTED_CHANGES.join(', ')}.`));
      if (opts.into && change !== 'merge') return fail(new Error('--into goes with merge.'));
      if (opts.parent && change !== 'parent') return fail(new Error('--parent goes with parent.'));
      if (opts.feature && change !== 'feature') return fail(new Error('--feature goes with feature.'));
      try {
        const rec = await suggestChange(root, getTaskBackend(), slug, {
          change: change as SuggestedChange,
          target: opts.into ?? opts.parent ?? opts.feature ?? null,
          why: opts.why,
          by: decider(),
        });
        success(`${slug}: kept as it is; the ${change} suggestion waits for the owner on the Tasks screen (${rec.suggestion!.id}).`);
      } catch (err) {
        fail(err);
      }
    });

  backlog
    .command('report')
    .description('Before/after counts: open, top-level, parents, groups by feature, outcomes, proposals waiting, placement')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      try {
        const r = backlogReport(root);
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        if (!r.started) {
          info('The task migration has not taken stock in this brain (no open tasks, or not run yet).');
          return;
        }
        console.log(header(`Task migration ${BACKLOG_MIGRATION_VERSION}`));
        printCounts(r);
      } catch (err) {
        fail(err);
      }
    });
}
