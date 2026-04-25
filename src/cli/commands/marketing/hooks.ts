/**
 * mk hooks — manage marketing-related git hooks.
 *
 *   mk hooks check-staged    Pre-commit guard: blocks staged paths under
 *                            _dream_context/marketing/**\/_assets|_media/**.
 *                            Exit 1 with friendly diagnostics on violation.
 *
 *   mk hooks install         Write a pre-commit launcher into .git/hooks/.
 */
import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import chalk from 'chalk';
import { error, info, success, warn, header } from '../../../lib/format.js';
import { getStagedFiles, findBlockedPaths } from '../../../lib/marketing/git-guard.js';

const HOOK_LAUNCHER = `#!/bin/sh
# dreamcontext marketing — pre-commit binary guard
# Installed by: dreamcontext mk hooks install
# Source: hooks/marketing-binary-guard.sh
if ! command -v dreamcontext >/dev/null 2>&1; then
  echo "dreamcontext: command not found — skipping marketing-binary-guard hook" >&2
  exit 0
fi
exec dreamcontext mk hooks check-staged
`;

const MANAGED_MARKER = 'dreamcontext mk hooks check-staged';

function findGitDir(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    return out.startsWith('/') ? out : join(cwd, out);
  } catch {
    return null;
  }
}

export function registerMarketingHooks(parent: Command): void {
  const hooks = parent.command('hooks').description('Manage marketing-related git hooks (pre-commit binary guard).');

  hooks
    .command('check-staged')
    .description('Pre-commit hook entrypoint: refuses staged paths under marketing _assets/ or _media/.')
    .action(() => {
      const staged = getStagedFiles();
      const blocked = findBlockedPaths(staged);
      if (blocked.length === 0) {
        process.exit(0);
      }
      console.error(chalk.red.bold('✗ Marketing binary guard: refusing to commit binary asset paths.'));
      console.error('');
      for (const p of blocked) {
        console.error(`  ${chalk.red('–')} ${p}`);
      }
      console.error('');
      console.error(chalk.dim('These directories are .gitignore\'d and must never enter git history.'));
      console.error(chalk.dim('If you really need to commit, unstage with: git reset HEAD -- <path>'));
      console.error(chalk.dim('To bypass once (NOT RECOMMENDED): git commit --no-verify'));
      process.exit(1);
    });

  hooks
    .command('install')
    .description('Install the pre-commit launcher into .git/hooks/pre-commit.')
    .option('--force', 'Overwrite an existing pre-commit hook (NOT a managed dreamcontext one).', false)
    .action((opts: { force?: boolean }) => {
      console.log(header('mk hooks install'));
      const gitDir = findGitDir();
      if (!gitDir) {
        error('Not inside a git repository (or `git` is not on PATH).');
        process.exit(1);
      }

      const hooksDir = join(gitDir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      const target = join(hooksDir, 'pre-commit');

      if (existsSync(target)) {
        const existing = readFileSync(target, 'utf-8');
        if (existing.includes(MANAGED_MARKER)) {
          info('pre-commit hook already managed by dreamcontext — refreshing.');
        } else if (!opts.force) {
          error('A pre-commit hook already exists and was not installed by dreamcontext.');
          console.error(chalk.dim(`  Path: ${target}`));
          console.error(chalk.dim('  Use --force to overwrite, or chain manually.'));
          process.exit(1);
        } else {
          warn('Overwriting existing pre-commit hook (--force).');
        }
      }

      writeFileSync(target, HOOK_LAUNCHER, 'utf-8');
      try {
        chmodSync(target, 0o755);
      } catch {
        // chmod can fail on some FS (e.g. mounted Windows shares). Continue.
      }

      // Sanity: confirm exec bit is set on platforms that support it.
      try {
        const st = statSync(target);
        const execMask = 0o111;
        if ((st.mode & execMask) === 0) {
          warn('Could not set exec bit on the hook file. Run `chmod +x .git/hooks/pre-commit` manually.');
        }
      } catch {
        // ignore
      }

      success(`Installed pre-commit hook at ${chalk.dim(target)}`);
      info('Try it: stage a file under marketing/_assets/ then `git commit` — the commit should be refused.');
    });
}
