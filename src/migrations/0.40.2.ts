import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { brainPrefix } from '../lib/agents/agent-sync.js';
import { currentTaskBackend, ensureBrainGitignore, ensureFullRepoGitignore } from '../lib/git-sync/brain-repo.js';
import * as git from '../lib/git-sync/git.js';
import { readSetupConfig } from '../lib/setup-config.js';
import { setAsideForeignRecords } from '../lib/super/record-binding.js';
import { SUPER_LOCAL_PATHSPECS, superPathspecs } from '../lib/super/pull-guard.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.40.2: the Super Agent's record never leaves this Mac (2026-11-03).
 *
 * The owner shared a repo with the brain inside it. It had been set up by a version whose brain
 * `.gitignore` lacked `state/.super-agent.json`, the record was committed, and a friend's clone
 * opened the owner's last spoken question and its card. The ignore list was right on new setups
 * only: `ensureLocalOnlyArtifacts` writes the file when it is absent and never again.
 *
 * `everyRun`, cheap when there is nothing to do:
 *   1. the brain `.gitignore` gains every machine-local line it lacks (and, in full-repo mode, the
 *      project root `.gitignore` its brain lines); when git still does not ignore the record (a
 *      later `!` negation, a teammate's), the Super lines go to the end again, where they win;
 *   2. a Super file git still tracks (main's record and its temp files, `state/.super/`, the
 *      session rosters) leaves the INDEX only (`git rm --cached`): the file stays on disk, and
 *      the owner's next commit carries the removal. A tracked record that is not this Mac's
 *      (`record-binding.ts`) is first set aside as `<file>.foreign-<time>` so it is never read.
 *
 * Never commits, pushes or deletes a file. A git that cannot answer (no repo, a held index lock)
 * is retried on the next update.
 */

export { SUPER_LOCAL_PATHSPECS };

/** The Super lines of the brain `.gitignore`, re-asserted last when a negation beats them. */
const SUPER_GITIGNORE_LINES = ['state/.super-agent.json', 'state/.super-agent.json.*', 'state/.super/', 'state/.agent-sessions.*'];

/** Does git ignore the record? Re-append the Super lines at the end when it does not. */
function reassertSuperIgnore(root: string): string[] {
  let top: string | null;
  try { top = git.topLevel(root); } catch { top = null; }
  const prefix = top ? brainPrefix(root, root) : null;
  if (!top || prefix === null) return [];
  if (git.isIgnored(top, `${prefix}state/.super-agent.json`) !== false) return [];
  const path = join(root, '.gitignore');
  try {
    if (!lstatSync(path).isFile()) return [];
    const current = readFileSync(path, 'utf-8');
    appendFileSync(path, `${current.endsWith('\n') ? '' : '\n'}# dreamcontext: the Super Agent's files stay on this Mac (last, so no negation above wins)\n${SUPER_GITIGNORE_LINES.join('\n')}\n`);
  } catch { return []; }
  return SUPER_GITIGNORE_LINES;
}

export function untrackSuperRecords(root: string): MigrationStepResult {
  const step = 'untrack-super-records';
  const none: MigrationStepResult = { step, filesTouched: [], summary: 'No Super Agent file is tracked by git', detected: true };
  if (!existsSync(join(root, 'state'))) return none;
  let at: ReturnType<typeof superPathspecs>;
  try { at = superPathspecs(root, root); } catch { at = null; }
  if (!at) return none;
  const { top, specs } = at;
  const prefix = brainPrefix(root, root) ?? '';
  let tracked: string[];
  try { tracked = git.indexPaths(top, specs); } catch {
    return { step, filesTouched: [], summary: 'Could not ask git which Super Agent files it tracks; retried on the next update', detected: false, failedCount: 1 };
  }
  if (tracked.length === 0) return none;
  const moved = setAsideForeignRecords(root);
  // `-f`: a live record staged a moment before it changed again is dropped too (index only).
  try { git.removeFromIndexForce(top, specs); } catch {
    return { step, filesTouched: moved, summary: `Git tracks ${tracked.length} Super Agent file(s) but would not drop them from its index (an index.lock held by another git?); retried on the next update`, detected: false, failedCount: 1 };
  }
  const names = tracked.map((p) => relative(prefix || '.', p) || p).join(', ');
  return {
    step,
    filesTouched: [...tracked.map((p) => join(top, p)), ...moved],
    detected: false,
    summary: `Took ${tracked.length} Super Agent file(s) out of git's index, kept on disk (${names}); commit that removal${moved.length ? `. Set aside ${moved.length} record(s) from another Mac or folder` : ''}`,
  };
}

export const migration0402: Migration = {
  version: '0.40.2',
  everyRun: true,
  steps: [
    (root: string): MigrationStepResult => {
      const step = 'brain-gitignore-machine-local';
      const projectRoot = dirname(root);
      let added: string[] = [];
      try { added = ensureBrainGitignore(root, currentTaskBackend(projectRoot)); } catch {
        return { step, filesTouched: [], detected: true, summary: 'The brain .gitignore is not a plain file; left alone' };
      }
      let rootAdded: string[] = [];
      if (readSetupConfig(projectRoot)?.brainRepo?.mode === 'full-repo') rootAdded = ensureFullRepoGitignore(projectRoot, currentTaskBackend(projectRoot));
      added = added.concat(reassertSuperIgnore(root));
      if (added.length === 0 && rootAdded.length === 0) {
        return { step, filesTouched: [], detected: true, summary: 'The .gitignore already keeps every machine-local file out of git' };
      }
      return {
        step,
        filesTouched: [...(added.length ? [join(root, '.gitignore')] : []), ...(rootAdded.length ? [join(projectRoot, '.gitignore')] : [])],
        detected: false,
        summary: `Kept ${added.length + rootAdded.length} machine-local path(s) out of git (${[...added, ...rootAdded].join(', ')})`,
      };
    },
    untrackSuperRecords,
  ],
};
