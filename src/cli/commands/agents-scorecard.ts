import type { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, header, success } from '../../lib/format.js';
import { isAgentSession } from '../../lib/owner-guard-cli.js';
import {
  addCriterion, clearGoal, rateRun, rateableRuns, removeCriterion, setGoal, trendOf, undoLesson, useLesson,
} from '../../lib/agents/scorecard-ops.js';
import { ScorecardRefused, activeCriteria, readScorecard, runKeyFor, startFresh } from '../../lib/agents/scorecard.js';
import { checkRun, draftLesson, spawnScorecardJob } from '../../lib/agents/scorecard-judge.js';

/**
 * `agents rate` and `agents scorecard …` (plan uye-karnesi C4). Inside an agent session every write
 * but `rate` is refused (the owner sets his lines, goal and lessons himself), and `rate` needs his
 * words (`--quote`). `check` and `draft` are the runner's and the server's detached spawns; from an
 * agent session they run only as the first attempt for that run and note.
 */

function refuse(err: unknown): void {
  if (err instanceof ScorecardRefused) error(`${err.message} (${err.code})`);
  else error((err as Error)?.message ?? String(err));
  process.exitCode = 1;
}

function ownerOnly(what: string): boolean {
  if (!isAgentSession()) return false;
  error(`${what} is the owner's step: he does it on the member's Scorecard card. (invalid_args)`);
  process.exitCode = 1;
  return true;
}

function stars(n: number | null): string {
  return n === null ? '' : '★'.repeat(n) + '☆'.repeat(5 - n);
}

export function registerScorecardCommands(agents: Command): void {
  agents
    .command('rate <member>')
    .description("Rate one of a member's finished runs, 1-5 stars, with an optional note that becomes a lesson. --last: its newest finished run (with --quote: the newest one that ended before the quoted words were said). From an agent session it needs --quote with the owner's exact words, and one quote rates one run. After the Super asked him about a job (its event line said rate=ask run=<key>), --run <key> takes his answer from this conversation since that ask, so a one-word answer (\"Dört.\") is his words. --judged (agent session, with --quote and --run): the stars are your reading of his correction; on a run he rated himself his stars stay (kept_owner_stars). A note from an agent on a run that already has his note is kept beside it as a correction, never in its place.")
    .option('--run <key>', 'The run, as `<routine>::<runId>` (from `agents scorecard show`)')
    .option('--last', 'Its newest finished run')
    .requiredOption('--stars <n>', '1 to 5; 0 clears the rating (only from his own terminal, never an agent session)')
    .option('--note <text>', 'His words on what to keep or change: they become one lesson the member follows. Left out, the run keeps its note; --note "" clears it')
    .option('--quote <words>', "The owner's exact words (required from an agent session)")
    .option('--judged', "The stars are the Super's reading of his correction, not his number (agent session, with --quote and --run)")
    .option('--json', 'Emit as JSON')
    .action((member: string, opts: { run?: string; last?: boolean; stars: string; note?: string; quote?: string; judged?: boolean; json?: boolean }) => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const n = Number.parseInt(opts.stars, 10);
      if (!Number.isInteger(n) || n < 0 || n > 5 || (!opts.run && !opts.last)) {
        error('Give --stars 1-5 (0 clears) and --run <key> or --last. (invalid_args)');
        process.exitCode = 1;
        return;
      }
      const agent = isAgentSession();
      try {
        const r = rateRun(projectRoot, member, {
          run: opts.run, last: opts.last, stars: n === 0 ? null : n, note: opts.note,
          by: agent ? 'session' : 'owner', ...(opts.quote ? { quote: opts.quote } : {}),
          ...(opts.judged ? { judged: true } : {}),
        });
        if (r.draft) spawnScorecardJob({ kind: 'draft', projectRoot, member, run: r.runKey, ...(r.slot ? { slot: r.slot } : {}) });
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        const kept = r.keptOwnerStars ? ' · his own stars stay (kept_owner_stars)' : '';
        const lesson = r.draft ? (r.slot ? ' · his words are kept beside his note and becoming a lesson' : ' · its note is becoming a lesson') : '';
        success(r.rating ? `Rated ${r.rating.title} ${stars(r.rating.stars)}${kept}${lesson}.` : 'Rating cleared.');
      } catch (err) {
        refuse(err);
      }
    });

  const sc = agents.command('scorecard').description("A member's scorecard: ratings, the owner's lines, lessons, checks and goal");

  sc.command('show <member>')
    .description('Print the scorecard')
    .option('--json', 'Emit as JSON')
    .action((member: string, opts: { json?: boolean }) => {
      const projectRoot = dirname(ensureContextRoot());
      try {
        const { card, damaged, scope } = readScorecard(projectRoot, member);
        const runs = rateableRuns(projectRoot, member, { maxSessions: 20 }).runs;
        if (opts.json) { console.log(JSON.stringify({ card, damaged: damaged ?? null, trend: trendOf(card), runs: runs.map((r) => ({ key: r.key, title: r.title, startedAt: r.startedAt, status: r.status })) }, null, 2)); return; }
        if (damaged) console.log(chalk.yellow(`The scorecard file could not be read; a copy was kept as ${damaged}.`));
        const t = trendOf(card);
        console.log(header(`Scorecard · ${member}`));
        console.log(t.average === null ? '  No ratings yet' : `  ${t.average}★ over the last ${Math.min(10, t.count)} rated runs${t.before !== null ? ` (two weeks ago: ${t.before})` : ''}`);
        const crit = activeCriteria(card);
        if (crit.length) { console.log(chalk.bold('  What good looks like')); for (const c of crit) console.log(`   ${c.id}  ${c.text}`); }
        const lessons = card.lessons.filter((l) => l.status === 'active' || l.status === 'held');
        if (lessons.length) { console.log(chalk.bold('  Learned from your ratings')); for (const l of lessons) console.log(`   ${l.id}  ${l.status === 'held' ? chalk.yellow('[waits] ') : ''}${l.text}`); }
        console.log(chalk.bold('  Recent runs'));
        for (const r of runs) {
          const rating = card.ratings[runKeyFor(scope, r.key)];
          console.log(`   ${r.key}  ${r.title}  ${rating ? stars(rating.stars) : chalk.dim('not rated')}`);
        }
      } catch (err) {
        refuse(err);
      }
    });

  const criteria = sc.command('criteria').description("The owner's lines of what good work looks like");
  criteria.command('add <member> <text>').description('Add a line').action((member: string, text: string) => {
    if (ownerOnly('Adding a line')) return;
    try { const id = addCriterion(dirname(ensureContextRoot()), member, text); success(`Added ${id}.`); } catch (err) { refuse(err); }
  });
  criteria.command('remove <member> <id>').description('Remove a line').action((member: string, id: string) => {
    if (ownerOnly('Removing a line')) return;
    try { removeCriterion(dirname(ensureContextRoot()), member, id); success(`Removed ${id}.`); } catch (err) { refuse(err); }
  });

  const lesson = sc.command('lesson').description('The lessons his notes became');
  lesson.command('undo <member> <id>').description('Take a lesson out of every later run and chat').action((member: string, id: string) => {
    if (ownerOnly('Undoing a lesson')) return;
    try { undoLesson(dirname(ensureContextRoot()), member, id); success(`Undid ${id}.`); } catch (err) { refuse(err); }
  });
  lesson.command('use <member> <id>').description('Use a lesson that waits for a look').action((member: string, id: string) => {
    if (ownerOnly('Using a lesson that waits')) return;
    try { useLesson(dirname(ensureContextRoot()), member, id); success(`${id} is in use.`); } catch (err) { refuse(err); }
  });

  const goal = sc.command('goal').description("The member's optional goal: one Lab insight");
  goal.command('set <member> <insight>')
    .description('Link a Lab insight as the goal')
    .requiredOption('--target <n>', 'The value to reach')
    .option('--baseline <n>', 'Where it starts (default: its latest value)')
    .action((member: string, insight: string, opts: { target: string; baseline?: string }) => {
      if (ownerOnly('Setting a goal')) return;
      try {
        const g = setGoal(dirname(ensureContextRoot()), member, { insight, target: Number(opts.target), baseline: opts.baseline !== undefined ? Number(opts.baseline) : null });
        success(`Goal: ${insight} from ${g.baseline} to ${g.target}.`);
      } catch (err) { refuse(err); }
    });
  goal.command('clear <member>').description('Remove the goal').action((member: string) => {
    if (ownerOnly('Removing the goal')) return;
    try { clearGoal(dirname(ensureContextRoot()), member); success('Goal removed.'); } catch (err) { refuse(err); }
  });

  sc.command('fresh <member>').description('Move an unreadable scorecard file aside and start fresh').action((member: string) => {
    if (ownerOnly('Starting fresh')) return;
    try {
      const r = startFresh(dirname(ensureContextRoot()), member);
      success(r.movedTo ? `Moved aside as ${r.movedTo}.` : 'Nothing to move: the scorecard reads fine.');
    } catch (err) { refuse(err); }
  });

  // The detached model work (hidden): the runner's check and the rating's lesson draft.
  sc.command('check <member>', { hidden: true })
    .requiredOption('--run <key>', 'The run')
    .action(async (member: string, opts: { run: string }) => {
      try {
        // It reads the run from disk, the same text whoever started it (D11).
        const out = await checkRun(dirname(ensureContextRoot()), member, opts.run, { firstOnly: isAgentSession() });
        console.log(out);
      } catch (err) { refuse(err); }
    });
  sc.command('draft <member>', { hidden: true })
    .requiredOption('--run <key>', 'The run')
    .option('--slot <slot>', "A correction's lesson slot (c:<id>); absent: the note's")
    .action(async (member: string, opts: { run: string; slot?: string }) => {
      try {
        const out = await draftLesson(dirname(ensureContextRoot()), member, opts.run, { firstOnly: isAgentSession(), ...(opts.slot ? { slot: opts.slot } : {}) });
        console.log(out);
      } catch (err) { refuse(err); }
    });
}
