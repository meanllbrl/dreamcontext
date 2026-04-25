import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { error, header, info, success, warn } from '../../../lib/format.js';
import {
  appendLearning, findEntry, listPending, loadByDate, loadIndex, setStatus,
  todayDateString,
  type LearningEntry, type LearningStatus, type LearningType,
} from '../../../lib/marketing/learnings.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';

const VALID_TYPES: LearningType[] = ['recommendation', 'ledger'];
const VALID_STATUSES: LearningStatus[] = ['pending', 'confirmed', 'rejected', 'evergreen'];

export function registerMarketingLearnings(parent: Command): void {
  const cmd = parent
    .command('learnings')
    .description('Performance Monitor learnings ledger (per-day .md + index).');

  cmd
    .command('show')
    .description('Show today\'s (or specified day\'s) learnings file.')
    .option('--date <YYYY-MM-DD>', 'Day to show (default: today UTC)')
    .option('--id <id>', 'Show a single entry by id')
    .action((opts: { date?: string; id?: string }) => {
      if (opts.id) {
        const entry = findEntry(opts.id);
        if (!entry) {
          error(`Learning entry "${opts.id}" not found.`);
          process.exit(1);
        }
        printEntryHeader(entry);
        return;
      }
      const date = opts.date ?? todayDateString();
      console.log(header(`Marketing learnings — ${date}`));
      const md = loadByDate(date);
      if (!md) {
        info(`No learnings recorded for ${date}.`);
        return;
      }
      console.log(md);
    });

  cmd
    .command('append')
    .description('Append a learning entry (Performance Monitor agent only).')
    .requiredOption('--type <recommendation|ledger>', 'Entry type')
    .option('--cohort <id>', 'Associated cohort id')
    .option('--body <text>', 'Body text (mutually exclusive with --body-file)')
    .option('--body-file <path>', 'Read body from file (use - for stdin)')
    .requiredOption('--agent <name>', 'Authoring agent (must be "performance-monitor")')
    .action(async (opts: {
      type: string;
      cohort?: string;
      body?: string;
      bodyFile?: string;
      agent: string;
    }) => {
      if (!VALID_TYPES.includes(opts.type as LearningType)) {
        error(`Invalid --type "${opts.type}". Must be one of: ${VALID_TYPES.join(', ')}.`);
        process.exit(1);
      }
      const body = await resolveBody(opts.body, opts.bodyFile);
      if (!body || !body.trim()) {
        error('Body is required (--body or --body-file).');
        process.exit(1);
      }

      try {
        const entry = await withLock(async () => {
          const run = beginRun('learnings-append', {
            type: opts.type,
            cohort_id: opts.cohort ?? null,
            agent: opts.agent,
          });
          try {
            const e = appendLearning({
              type: opts.type as LearningType,
              cohort_id: opts.cohort ?? null,
              body,
              agent: opts.agent,
            });
            run.succeed({ id: e.id, date_file: e.date_file });
            return e;
          } catch (err) {
            run.fail((err as Error).message);
            throw err;
          }
        });
        success(`Learning ${chalk.cyan(entry.id)} appended (${entry.type}, status=${entry.status}, file=${entry.date_file}.md)`);
      } catch (e) {
        error(`Append failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('status <id> <new-status>')
    .description('Flip a recommendation pending → confirmed | rejected.')
    .action(async (id: string, newStatus: string) => {
      if (!VALID_STATUSES.includes(newStatus as LearningStatus)) {
        error(`Invalid status "${newStatus}". Must be one of: ${VALID_STATUSES.join(', ')}.`);
        process.exit(1);
      }
      try {
        const entry = await withLock(async () => {
          const run = beginRun('learnings-status', { id, status: newStatus });
          try {
            const e = setStatus(id, newStatus as LearningStatus);
            run.succeed({ id: e.id, status: e.status });
            return e;
          } catch (err) {
            run.fail((err as Error).message);
            throw err;
          }
        });
        success(`Learning ${chalk.cyan(entry.id)} → status=${entry.status}`);
      } catch (e) {
        error(`Status flip failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('list-pending')
    .description('List pending Performance Monitor recommendations.')
    .option('--older-than <hours>', 'Only entries older than N hours', (v) => parseInt(v, 10))
    .action((opts: { olderThan?: number }) => {
      const olderThanMs = (opts.olderThan ?? 0) * 60 * 60 * 1000;
      const pending = listPending({ olderThanMs });
      console.log(header('Pending recommendations'));
      if (pending.length === 0) {
        info(opts.olderThan
          ? `No pending recommendations older than ${opts.olderThan}h.`
          : 'No pending recommendations.');
        return;
      }
      for (const e of pending) {
        const ageH = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 3_600_000);
        console.log(`  ${chalk.cyan(e.id)}  ${chalk.dim(`${ageH}h old`)}  ${e.cohort_id ?? chalk.dim('(no cohort)')}  ${e.summary}`);
      }
      console.log();
      warn(`${pending.length} pending. Confirm with: dreamcontext mk learnings status <id> confirmed|rejected`);
    });

  cmd
    .command('list')
    .description('List all entries (newest first).')
    .option('--type <type>', 'Filter by type (recommendation|ledger)')
    .option('--status <status>', 'Filter by status')
    .action((opts: { type?: string; status?: string }) => {
      const idx = loadIndex();
      let entries = [...idx.entries].sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (opts.type) entries = entries.filter((e) => e.type === opts.type);
      if (opts.status) entries = entries.filter((e) => e.status === opts.status);
      console.log(header('Marketing learnings'));
      if (entries.length === 0) {
        info('No learnings yet.');
        return;
      }
      for (const e of entries) {
        console.log(`  ${chalk.cyan(e.id)}  ${chalk.dim(e.type.padEnd(14))}  ${statusColor(e.status)(e.status.padEnd(10))}  ${e.cohort_id ?? chalk.dim('(no cohort)')}  ${e.summary}`);
      }
    });
}

function printEntryHeader(e: LearningEntry): void {
  console.log(header(`${e.type} — ${e.id}`));
  console.log(`  cohort:     ${e.cohort_id ?? chalk.dim('(none)')}`);
  console.log(`  status:     ${statusColor(e.status)(e.status)}`);
  console.log(`  created_at: ${e.created_at}`);
  console.log(`  updated_at: ${e.updated_at}`);
  console.log(`  date_file:  ${e.date_file}.md`);
  console.log();
  console.log(chalk.dim(e.summary));
}

function statusColor(status: LearningStatus): (s: string) => string {
  switch (status) {
    case 'pending': return chalk.yellow;
    case 'confirmed': return chalk.green;
    case 'rejected': return chalk.dim;
    case 'evergreen': return chalk.cyan;
    default: return chalk.white;
  }
}

async function resolveBody(body?: string, bodyFile?: string): Promise<string | null> {
  if (body && bodyFile) {
    throw new Error('--body and --body-file are mutually exclusive.');
  }
  if (body) return body;
  if (bodyFile === '-') return readStdin();
  if (bodyFile) {
    if (!existsSync(bodyFile)) throw new Error(`Body file not found: ${bodyFile}`);
    return readFileSync(bodyFile, 'utf8');
  }
  return null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
