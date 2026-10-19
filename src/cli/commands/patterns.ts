import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { loadPatterns, loadPatternsReporting, matchPatterns, syncPatternShims } from '../../lib/patterns.js';
import { success, error, info } from '../../lib/format.js';
import { backfillSessions, ingestSessions, readCorrections } from '../../lib/owner-corrections.js';
import { citedCorrectionIds, LearnError, learnRule, listLearnedItems, openGroups, revertItem } from '../../lib/learned-patterns.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';
import { refuseSelfApproval } from './agents.js';

/**
 * Register the `dreamcontext patterns` command.
 *
 * Subcommands: list (what the vault holds, with the triggers it derived),
 * sync (regenerate the `/` menu shims), match (ask what a given prompt fires).
 *
 * `match` is the debugging surface that makes the automatic half inspectable:
 * when a user says "it didn't pick up my pattern", this answers whether the
 * gate saw it, with the exact keys that did or did not line up.
 */
export function registerPatternsCommand(program: Command): void {
  const patterns = program
    .command('patterns')
    .description('Browse project patterns, sync their "/" entries, and test what a prompt triggers');

  // --- list ---
  patterns
    .command('list', { isDefault: true })
    .description('List every pattern with its "/" name and derived triggers')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const { patterns: docs, skipped } = loadPatternsReporting(root);

      if (opts.json) {
        console.log(JSON.stringify(
          docs.map((p) => ({
            slug: p.slug,
            name: p.name,
            slash: p.slashName,
            description: p.description,
            triggers: [...p.keys].sort(),
            authored: p.authored,
          })),
          null,
          2,
        ));
        return;
      }

      if (docs.length === 0) {
        info('No patterns yet. They live in knowledge/patterns/ — a pattern is a decided way of doing something here.');
        return;
      }

      console.log();
      for (const p of docs) {
        console.log(`  ${chalk.bold(p.name)}  ${chalk.dim(`/${p.slashName}`)}`);
        if (p.description) console.log(`    ${chalk.dim(p.description)}`);
        // A pattern that derives NO keys can never fire, whatever its content —
        // a name written entirely in a non-Latin script folds to nothing, and so
        // does one made only of category words ("best-practices-guide"). Silent
        // in the corpus, so it is loud here.
        if (p.keys.size === 0) {
          console.log(`    ${chalk.yellow('⚠ no triggers could be derived — this pattern can never fire automatically. Add `triggers: [<words a user would say>]` to its frontmatter.')}`);
        } else {
          console.log(`    ${chalk.dim(`triggers: ${[...p.keys].sort().join(', ')}`)}`);
        }
        console.log();
      }
      for (const s of skipped) {
        console.log(`  ${chalk.red('✗')} ${chalk.bold(s.file)}`);
        console.log(`    ${chalk.red(`skipped — ${s.reason}`)}`);
        console.log();
      }
      info(`${docs.length} pattern${docs.length === 1 ? '' : 's'}. Triggers are derived automatically — add \`triggers:\` to a pattern only to teach it a word its name does not contain.`);
    });

  // --- sync ---
  patterns
    .command('sync')
    .description('Regenerate the "/" menu entries from knowledge/patterns/')
    .action(() => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const result = syncPatternShims(projectRoot, root);
      const { patterns, skipped } = loadPatternsReporting(root);
      const total = patterns.length;
      for (const s of skipped) error(`skipped ${s.file} — ${s.reason}`);
      if (result.written.length === 0 && result.removed.length === 0) {
        info(`"/" entries already match the vault (${total} pattern${total === 1 ? '' : 's'}).`);
        return;
      }
      success(`Synced ${total} pattern${total === 1 ? '' : 's'} into the "/" menu.`);
      if (result.written.length > 0) info(`  written: ${result.written.length}`);
      if (result.removed.length > 0) info(`  removed: ${result.removed.length}`);
    });

  // --- match ---
  patterns
    .command('match <prompt...>')
    .description('Show which patterns a prompt would trigger, and why')
    .option('--json', 'Machine-readable output')
    .action((words: string[], opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const prompt = words.join(' ');
      const docs = loadPatterns(root);
      const hits = matchPatterns(prompt, docs);

      if (opts.json) {
        console.log(JSON.stringify(
          hits.map((h) => ({
            slug: h.pattern.slug,
            relPath: h.pattern.relPath,
            score: h.score,
            matched: h.matched,
            distinctive: h.distinctive,
            corroborating: h.corroborating,
          })),
          null,
          2,
        ));
        return;
      }

      if (hits.length === 0) {
        info(`No pattern fires on ${JSON.stringify(prompt)}.`);
        info('That is the intended answer for most prompts — the gate stays silent unless a pattern is genuinely named.');
        return;
      }
      console.log();
      for (const h of hits) {
        console.log(`  ${chalk.bold(h.pattern.name)}  ${chalk.dim(`(score ${h.score})`)}`);
        console.log(`    ${chalk.dim(h.pattern.relPath)}`);
        console.log(`    ${chalk.dim(`matched: ${h.matched.join(', ') || '—'}${h.corroborating.length ? `  ·  supporting: ${h.corroborating.join(', ')}` : ''}`)}`);
        console.log();
      }
    });

  // --- corrections (C7: what the owner keeps correcting) ---
  patterns
    .command('corrections')
    .description('The owner\'s corrections kept across sleeps; --recurring groups the ones said in 2+ sessions, --backfill <days> reads the last days once')
    .option('--recurring', 'Only the groups said in two or more sessions that no learned rule cites yet')
    .option('--backfill [days]', 'Read the owner\'s turns of the last N days (default 7) into the ledger first; skips sessions registered as spawned')
    .option('--json', 'Machine-readable output')
    .action((opts: { recurring?: boolean; backfill?: string | boolean; json?: boolean }) => {
      const root = ensureContextRoot();
      let backfill: { added: number; sessions: number; excluded: Record<string, number> } | null = null;
      if (opts.backfill !== undefined) {
        const days = opts.backfill === true ? 7 : Number(opts.backfill);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          error('--backfill takes a whole number of days, 1 to 90.');
          process.exitCode = 1;
          return;
        }
        let person: string | null = null;
        try { person = resolveActivePerson(root).slug; } catch { /* unresolved: stored as null */ }
        const found = backfillSessions(root, days);
        try {
          const r = ingestSessions(root, found.sessions, person, 'backfill', new Date(), citedCorrectionIds(root));
          backfill = { added: r.added, sessions: found.sessions.length, excluded: { ...found.excluded } };
        } catch (e) {
          error(`Backfill refused: ${(e as Error).message}`);
          process.exitCode = 1;
          return;
        }
      }
      const groups = opts.recurring ? openGroups(root) : null;
      const items = opts.recurring ? null : readCorrections(root);
      if (opts.json) {
        console.log(JSON.stringify({ ...(backfill ? { backfill } : {}), ...(groups ? { groups } : { items }) }, null, 2));
        return;
      }
      if (backfill) {
        const ex = Object.entries(backfill.excluded).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
        success(`Backfill: added ${backfill.added} from ${backfill.sessions} session(s)${ex ? ` (skipped as spawned: ${ex})` : ''}.`);
      }
      if (groups) {
        if (groups.length === 0) { info('No correction said in two or more sessions waits to be learned.'); return; }
        for (const g of groups) {
          console.log(`  ${chalk.bold(g.groupId)}  ${chalk.dim(`${g.ids.length} correction(s), ${g.sessions} session(s)${g.originUnknown ? ', origin unknown' : ''}`)}`);
          console.log(`    ${chalk.dim(`ids: ${g.ids.join(',')}`)}`);
          for (const q of g.quotes) console.log(`    - (${q.date}) ${q.text}`);
        }
        return;
      }
      info(`${items!.length} correction(s) kept.`);
    });

  // --- learn (sleep-product writes a rule from one recurring group) ---
  patterns
    .command('learn <pattern>')
    .description('Write a rule learned from ONE recurring group of the owner\'s corrections into a pattern (quotes and dates kept; the old file archived first)')
    .requiredOption('--from <ids>', 'The correction ids of one group (comma list)')
    .requiredOption('--title <text>', 'What the owner would say')
    .requiredOption('--rule <text>', 'The rule, in the owner\'s terms')
    .option('--replaces <lr_id>', 'Edit this learned block (a contradiction or a narrowing)')
    .option('--edits <paragraph>', 'Replace this exact paragraph of the pattern (a contradiction of its existing text)')
    .action((pattern: string, opts: { from: string; title: string; rule: string; replaces?: string; edits?: string }) => {
      const root = ensureContextRoot();
      try {
        const c = learnRule(root, {
          pattern,
          title: opts.title,
          rule: opts.rule,
          cites: opts.from.split(','),
          ...(opts.replaces ? { replaces: opts.replaces } : {}),
          ...(opts.edits !== undefined ? { edits: opts.edits } : {}),
        });
        success(`Learned ${c.ruleId} in ${c.pattern} (${c.action}${c.archive ? `; the previous file is in ${c.archive}` : ''}).`);
      } catch (e) {
        if (e instanceof LearnError) { error(e.message); process.exitCode = 1; return; }
        throw e;
      }
    });

  // --- learned (what sleep learned; owner reverts from the Inbox) ---
  patterns
    .command('learned')
    .description('Rules sleep learned from the owner\'s corrections, and the task-filing rule changes it made')
    .option('--since <iso>', 'Only changes at or after this time')
    .option('--json', 'Machine-readable output')
    .action((opts: { since?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const items = listLearnedItems(root, opts.since ? { since: opts.since } : {});
      if (opts.json) { console.log(JSON.stringify(items, null, 2)); return; }
      if (items.length === 0) { info('Nothing learned yet.'); return; }
      for (const i of items) {
        console.log(`  ${chalk.bold(i.title)}  ${chalk.dim(`${i.pattern} · ${i.id} · ${i.at.slice(0, 10)}${i.reverted ? ` · reverted ${i.reverted.at.slice(0, 10)}` : ''}`)}`);
        for (const q of i.quotes) console.log(`    - (${q.date}) ${q.text}`);
      }
    });

  // --- revert (owner only) ---
  patterns
    .command('revert <id>')
    .description('Undo a learned change (owner only; the Inbox does the same)')
    .action((id: string) => {
      if (refuseSelfApproval(process.env)) return;
      const root = ensureContextRoot();
      try {
        const item = revertItem(root, id, 'owner');
        success(`Reverted ${item.id} (${item.pattern}).`);
      } catch (e) {
        error((e as Error).message);
        process.exitCode = 1;
      }
    });
}
