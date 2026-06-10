import { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import {
  UPSTREAM_REPO,
  FEEDBACK_CATEGORIES,
  isFeedbackCategory,
  collectEnvironment,
  buildIssueBody,
  labelsFor,
  listFeedbackIssues,
  findDuplicate,
  ensureFeedbackLabel,
  createIssue,
  detectGitHubCli,
  type FeedbackCategory,
  type FeedbackInput,
} from '../../lib/feedback.js';
import { header, success, error, warn, info, miniBox } from '../../lib/format.js';

interface FeedbackCliOpts {
  category?: string;
  title?: string;
  scenario?: string;
  expected?: string;
  gap?: string;
  repro?: string;
  proposal?: string;
  dryRun?: boolean;
  yes?: boolean;
  /** commander maps `--no-dedup` to `dedup: false` (defaults true). */
  dedup?: boolean;
}

/**
 * Print the guidance an agent should relay to its user when GitHub access is
 * not ready. Covers: no gh binary, gh present but unauthenticated, and the
 * no-account-at-all case.
 */
function printAccessGuidance(installed: boolean): void {
  console.log(header('GitHub access required to file feedback'));
  console.log();
  if (!installed) {
    console.log('The GitHub CLI (' + chalk.cyan('gh') + ') is not installed. To file feedback to ' + chalk.cyan(UPSTREAM_REPO) + ':');
    console.log();
    console.log('  1. Install gh:   ' + chalk.dim('https://cli.github.com  (brew install gh)'));
    console.log('  2. Sign in:      ' + chalk.cyan('gh auth login'));
  } else {
    console.log(chalk.cyan('gh') + ' is installed but you are not signed in.');
    console.log();
    console.log('  • Sign in:       ' + chalk.cyan('gh auth login'));
  }
  console.log();
  console.log(chalk.bold('No GitHub account yet?'));
  console.log('  dreamcontext files feedback as GitHub issues, so you need a (free) account.');
  console.log('  Create one at ' + chalk.cyan('https://github.com/signup') + ', then run ' + chalk.cyan('gh auth login') + '.');
  console.log();
  info('Re-run ' + chalk.cyan('dreamcontext feedback') + ' once you are signed in.');
}

function renderPreview(input: FeedbackInput, body: string): void {
  console.log(header('Feedback issue preview'));
  console.log();
  console.log(miniBox([
    `repo:     ${UPSTREAM_REPO}`,
    `title:    ${input.title}`,
    `labels:   ${labelsFor(input.category).join(', ')}`,
  ], { color: 'magenta' }));
  console.log();
  console.log(chalk.dim('─── body ───'));
  console.log(body);
  console.log(chalk.dim('────────────'));
  console.log();
}

export function registerFeedbackCommand(program: Command): void {
  program
    .command('feedback')
    .description(`File a structured feedback issue to ${UPSTREAM_REPO}`)
    .option('-c, --category <category>', `Category: ${FEEDBACK_CATEGORIES.join(' | ')}`)
    .option('-t, --title <title>', 'Issue title (concise, specific)')
    .option('-s, --scenario <text>', 'What the agent was doing when it hit the gap')
    .option('-e, --expected <text>', 'What dreamcontext should have done')
    .option('-g, --gap <text>', 'What was missing, broken, or surprising')
    .option('-r, --repro <text>', 'Reproduction steps or exact commands')
    .option('-p, --proposal <text>', 'Proposed improvement (command, behavior, doc, fix)')
    .option('--dry-run', 'Render the issue without filing it (use this to show the user a draft)')
    .option('-y, --yes', 'Skip the interactive confirmation and file immediately')
    .option('--no-dedup', 'Skip the duplicate-issue check')
    .addHelpText('after', `
Examples:
  ${chalk.dim('# Render a draft to show the user (no network write):')}
  dreamcontext feedback --dry-run -c missing-cli -t "Add \`tasks reopen\`" \\
    -s "User asked to reopen a completed task; no CLI path exists." \\
    -p "Add a 'tasks reopen <id>' command that flips status back to todo."

  ${chalk.dim('# File after the user approved the draft:')}
  dreamcontext feedback --yes -c missing-cli -t "Add \`tasks reopen\`" -s "..." -p "..."
`)
    .action(async (opts: FeedbackCliOpts) => {
      // ── Validate inputs ──────────────────────────────────────────────────
      const category = (opts.category ?? 'other').trim();
      if (!isFeedbackCategory(category)) {
        error(`Unknown category: ${category}`, `Valid: ${FEEDBACK_CATEGORIES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      if (!opts.title || !opts.title.trim()) {
        error('A --title is required.', 'Keep it concise and specific, e.g. "Add `tasks reopen` command".');
        process.exitCode = 1;
        return;
      }
      if (!opts.scenario || !opts.scenario.trim()) {
        error('A --scenario is required.', 'Describe what the agent was doing when it hit the gap.');
        process.exitCode = 1;
        return;
      }

      const input: FeedbackInput = {
        category: category as FeedbackCategory,
        title: opts.title.trim(),
        scenario: opts.scenario,
        expected: opts.expected,
        gap: opts.gap,
        repro: opts.repro,
        proposal: opts.proposal,
      };
      const body = buildIssueBody(input, collectEnvironment());

      // ── Dry run: render and stop (no GitHub access needed) ──────────────
      if (opts.dryRun) {
        renderPreview(input, body);
        info('Dry run — nothing was filed. Re-run with ' + chalk.cyan('--yes') + ' to file after the user approves.');
        return;
      }

      // ── Verify GitHub access ────────────────────────────────────────────
      const gh = detectGitHubCli();
      if (!gh.installed || !gh.authenticated) {
        printAccessGuidance(gh.installed);
        process.exitCode = 1;
        return;
      }

      renderPreview(input, body);
      if (gh.account) info(`Filing as GitHub user ${chalk.cyan(gh.account)} → ${chalk.cyan(UPSTREAM_REPO)}`);

      // ── Duplicate check ─────────────────────────────────────────────────
      if (opts.dedup !== false) {
        const existing = listFeedbackIssues();
        const dup = findDuplicate(input.title, existing);
        if (dup) {
          warn(`A similar open issue already exists: #${dup.number} — ${dup.title}`);
          console.log('  ' + chalk.cyan(dup.url));
          if (!opts.yes) {
            const proceed = await confirm({ message: 'File anyway?', default: false }).catch(() => false);
            if (!proceed) {
              info('Skipped — consider commenting on the existing issue instead.');
              return;
            }
          }
        }
      }

      // ── Confirm (unless --yes) ──────────────────────────────────────────
      if (!opts.yes) {
        const proceed = await confirm({
          message: `File this issue to ${UPSTREAM_REPO}?`,
          default: true,
        }).catch(() => false);
        if (!proceed) {
          info('Cancelled — nothing was filed.');
          return;
        }
      }

      // ── File ────────────────────────────────────────────────────────────
      ensureFeedbackLabel();
      const result = createIssue(input, body);
      if (result.ok) {
        success('Feedback filed.');
        if (result.url) console.log('  ' + chalk.cyan(result.url));
      } else {
        error('Failed to file feedback.', result.error);
        process.exitCode = 1;
      }
    });
}
