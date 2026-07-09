import { Command } from 'commander';
import chalk from 'chalk';
import { dirname } from 'node:path';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, success, error, warn, info, formatTable } from '../../lib/format.js';
import {
  linkRepo,
  unlinkRepo,
  cloneLinkedRepo,
  resolveLinkedRepos,
  LinkedRepoError,
} from '../../lib/linked-repos.js';

/**
 * `dreamcontext link …` — the linked-repos CLI. One shared brain governs bare
 * CODE repos (products) that live in separate GitHub repos, cloned at arbitrary
 * local paths per machine. `link` is a PURE GROUP (no parent positional action),
 * so a repo named `clone` is only ever an argument, never confused with the verb.
 *
 * The top-level `links` / `unlink` aliases are registered as SEPARATE commands
 * (not commander `.alias`) that call the SAME impl functions, so both entry
 * points behave identically.
 */

/** Shared impl: list linked repos with present/missing + resolved path. */
function runLinkLs(): void {
  const projectRoot = dirname(ensureContextRoot());
  const repos = resolveLinkedRepos(projectRoot);
  if (repos.length === 0) {
    console.log(chalk.dim('(no linked repos)'));
    info(chalk.dim('Add one with `dreamcontext link add <name> <path>`.'));
    return;
  }
  console.log(header('Linked Repos'));
  const rows = repos.map((r) => [
    r.name,
    r.gitRemoteUrl,
    r.present ? 'present' : 'missing',
    r.present ? (r.path ?? '') : `(dc link clone ${r.name})`,
  ]);
  console.log(formatTable(['Name', 'URL', 'Status', 'Local path'], rows, { statusCol: 2 }));
}

/** Shared impl: remove a linked repo config entry (leaves the home registry intact). */
function runLinkRm(name: string): void {
  const projectRoot = dirname(ensureContextRoot());
  if (unlinkRepo(projectRoot, name)) {
    success(`Unlinked "${name}" (the local path stays registered on this machine).`);
  } else {
    info(`No linked repo named "${name}".`);
    process.exitCode = 1;
  }
}

export function registerLinkCommand(program: Command): void {
  const link = program
    .command('link')
    .description('Govern bare code repos: bind, clone, list, and unlink linked repos');

  link
    .command('add <name> <path>')
    .description('Bind a local checkout of a linked repo (records name+URL shared, path machine-local)')
    .option('--url <url>', 'Explicit GitHub URL (required when the repo has no origin)')
    .action((name: string, path: string, opts: { url?: string }) => {
      const projectRoot = dirname(ensureContextRoot());
      try {
        const entry = linkRepo(projectRoot, name, path, { url: opts.url });
        success(`Linked "${entry.name}" → ${entry.gitRemoteUrl}`);
        const [resolved] = resolveLinkedRepos(projectRoot).filter((r) => r.name === name);
        if (resolved?.path) info(`Local path: ${resolved.path}`);
      } catch (err) {
        error(err instanceof LinkedRepoError ? err.message : `Unexpected error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  link
    .command('clone <name>')
    .description('Clone a MISSING linked repo (trust-gated — the URL is team-writable)')
    .option('--dir <dir>', 'Parent directory for the clone (default: alongside the project)')
    .option('--yes', 'Confirm the clone (required — see the trust warning)')
    .action(async (name: string, opts: { dir?: string; yes?: boolean }) => {
      const projectRoot = dirname(ensureContextRoot());
      warn('This URL comes from the shared config and could have been set by any teammate.');
      info('dreamcontext clones it over HTTPS with transport hardening (ext:: refused, options terminated).');
      if (!opts.yes) {
        error('Refusing to clone without confirmation. Re-run with --yes once you trust the URL.');
        process.exitCode = 1;
        return;
      }
      try {
        const dest = await cloneLinkedRepo(projectRoot, name, { dir: opts.dir, confirmed: true });
        success(`Cloned "${name}" → ${dest}`);
      } catch (err) {
        error(err instanceof LinkedRepoError ? err.message : `Clone failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  link
    .command('ls')
    .description('List linked repos with present/missing status and the resolved local path')
    .action(runLinkLs);

  link
    .command('rm <name>')
    .description('Unlink a repo (removes the shared config entry; keeps the machine-local path)')
    .action(runLinkRm);

  // Top-level aliases — SEPARATE commands calling the SAME impl (not `.alias`),
  // so `links` and `unlink <name>` behave exactly like `link ls` / `link rm`.
  program
    .command('links')
    .description('List linked repos (alias for `link ls`)')
    .action(runLinkLs);

  program
    .command('unlink <name>')
    .description('Unlink a repo (alias for `link rm`)')
    .action(runLinkRm);
}
