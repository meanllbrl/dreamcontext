import { existsSync, lstatSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { brainPrefix } from '../lib/agents/agent-sync.js';
import { currentTaskBackend, ensureBrainGitignore, ensureFullRepoGitignore } from '../lib/git-sync/brain-repo.js';
import * as git from '../lib/git-sync/git.js';
import { readSetupConfig } from '../lib/setup-config.js';
import { bindingVerdict } from '../lib/super/record-binding.js';
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
 *      project root `.gitignore` its brain lines);
 *   2. a Super file git still tracks (main's record and its temp files, `state/.super/`, the
 *      session rosters) leaves the INDEX only (`git rm --cached`): the file stays on disk, and
 *      the owner's next commit carries the removal. A tracked record that is not this Mac's
 *      (`record-binding.ts`) is first set aside as `<file>.foreign-<time>` so it is never read.
 *
 * Never commits, pushes or deletes a file. A git that cannot answer (no repo, a held index lock)
 * is retried on the next update.
 */

/** The machine-local Super and session files, brain-relative (git pathspecs). */
export const SUPER_LOCAL_PATHSPECS = [
  'state/.super-agent.json',
  'state/.super-agent.json.*',
  'state/.super',
  'state/.agent-sessions.json',
  'state/.agent-sessions.*',
] as const;

/** Main's record and every member's, as files on disk (read marks and handoffs are not records). */
function recordFiles(root: string): string[] {
  const out = [join(root, 'state', '.super-agent.json')];
  const members = join(root, 'state', '.super', 'members');
  try {
    if (lstatSync(join(root, 'state', '.super')).isDirectory() && lstatSync(members).isDirectory()) {
      for (const name of readdirSync(members)) {
        if (name.endsWith('.json') && !name.endsWith('.read-marks.json')) out.push(join(members, name));
      }
    }
  } catch { /* no members folder */ }
  return out;
}

/** Set aside every record on disk that is not this Mac's. Returns the files moved. */
function setAsideForeignRecords(root: string): string[] {
  const moved: string[] = [];
  for (const file of recordFiles(root)) {
    try {
      if (!lstatSync(file).isFile()) continue;
      let parsed: unknown = null;
      try { parsed = JSON.parse(readFileSync(file, 'utf-8')); } catch { continue; }
      if (bindingVerdict(parsed, root, file) !== 'foreign') continue;
      const to = `${file}.foreign-${Date.now()}`;
      renameSync(file, to);
      moved.push(to);
    } catch { /* gone or unreadable: nothing to set aside */ }
  }
  return moved;
}

export function untrackSuperRecords(root: string): MigrationStepResult {
  const step = 'untrack-super-records';
  const none: MigrationStepResult = { step, filesTouched: [], summary: 'No Super Agent file is tracked by git', detected: true };
  if (!existsSync(join(root, 'state'))) return none;
  let top: string | null;
  try { top = git.topLevel(root); } catch { top = null; }
  if (!top) return none;
  const prefix = brainPrefix(root, root);
  if (prefix === null) return none;
  const specs = SUPER_LOCAL_PATHSPECS.map((p) => `${prefix}${p}`);
  let tracked: string[];
  try { tracked = git.indexPaths(top, specs); } catch {
    return { step, filesTouched: [], summary: 'Could not ask git which Super Agent files it tracks; retried on the next update', detected: false, failedCount: 1 };
  }
  if (tracked.length === 0) return none;
  const moved = setAsideForeignRecords(root);
  try { git.removeFromIndex(top, tracked); } catch {
    return { step, filesTouched: moved, summary: `Git tracks ${tracked.length} Super Agent file(s) but would not drop them from its index (a held lock?); retried on the next update`, detected: false, failedCount: 1 };
  }
  const names = tracked.map((p) => relative(prefix || '.', p) || p).join(', ');
  return {
    step,
    filesTouched: [...tracked.map((p) => join(top!, p)), ...moved],
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
