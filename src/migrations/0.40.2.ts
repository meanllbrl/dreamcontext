import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { brainPrefix } from '../lib/agents/agent-sync.js';
import { currentTaskBackend, ensureBrainGitignore, ensureFullRepoGitignore } from '../lib/git-sync/brain-repo.js';
import * as git from '../lib/git-sync/git.js';
import { readSetupConfig } from '../lib/setup-config.js';
import { setAsideForeignRecords } from '../lib/super/record-binding.js';
import { SUPER_LOCAL_PATHSPECS, isSleepStatePath, superPathspecs } from '../lib/super/pull-guard.js';
import { setAsideForeignSleepLines } from '../lib/super/sleep-foreign.js';
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
 *      session rosters), and since 2026-11-07 every session file (`SESSION_LOCAL_PATHSPECS`:
 *      sleep state, session history, digests, peer mail; the owner's Super agenda reached a teammate
 *      through a committed `state/.sleep.json`) leaves the INDEX only
 *      (`git rm --cached`): the file stays on disk, and
 *      the owner's next commit carries the removal. A tracked record that is not this Mac's
 *      (`record-binding.ts`) is first set aside as `<file>.foreign-<time>` so it is never read.
 *
 * Never commits, pushes or deletes a file. A git that cannot answer (no repo, a held index lock)
 * is retried on the next update.
 */

export { SUPER_LOCAL_PATHSPECS };

/** The Super lines of the brain `.gitignore`, re-asserted last when a negation beats them. */
const SUPER_GITIGNORE_LINES = ['state/.super-agent.json', 'state/.super-agent.json.*', 'state/.super/', 'state/.agent-sessions.*'];

/** The session lines (`SESSION_LOCAL_PATHSPECS`, folders with their slash), re-asserted the same way
 *  (security review, 2026-11-07: a teammate's `!state/.sleep.json` was never countered). */
const SESSION_GITIGNORE_LINES = [
  'state/.sleep.json', 'state/.sleep.json.*', 'state/.sleep-history.json', 'state/.sleep-runs.jsonl',
  'state/.handoff-log.jsonl', 'state/.session-titles.json', 'state/.session-digests/', 'state/.agent-session-map/',
  'state/.active-task', 'state/.tool-handoff/', 'state/.run-sessions/', 'state/.peer-mail/', 'state/.sleepy-chat.json',
];

/** One probe per group: the group's lines go to the end when git does not ignore its probe. */
const REASSERT_GROUPS: { probes: string[]; lines: string[]; comment: string }[] = [
  { probes: ['state/.super-agent.json'], lines: SUPER_GITIGNORE_LINES, comment: "the Super Agent's files stay on this Mac" },
  { probes: ['state/.sleep.json', 'state/.peer-mail/x.json', 'state/.session-digests/x.md'], lines: SESSION_GITIGNORE_LINES, comment: "this Mac's session files (sleep state, history, peer mail) stay on this Mac" },
];

/** Does git ignore the record and the session files? Re-append a group's lines at the end when not. */
function reassertSuperIgnore(root: string): string[] {
  let top: string | null;
  try { top = git.topLevel(root); } catch { top = null; }
  const prefix = top ? brainPrefix(root, root) : null;
  if (!top || prefix === null) return [];
  const path = join(root, '.gitignore');
  const added: string[] = [];
  for (const g of REASSERT_GROUPS) {
    if (g.probes.every((rel) => git.isIgnored(top as string, `${prefix}${rel}`) !== false)) continue;
    try {
      if (!lstatSync(path).isFile()) return added;
      const current = readFileSync(path, 'utf-8');
      appendFileSync(path, `${current.endsWith('\n') ? '' : '\n'}# dreamcontext: ${g.comment} (last, so no negation above wins)\n${g.lines.join('\n')}\n`);
    } catch { return added; }
    added.push(...g.lines);
  }
  return added;
}

export function untrackSuperRecords(root: string): MigrationStepResult {
  const step = 'untrack-super-records';
  const none: MigrationStepResult = { step, filesTouched: [], summary: 'No Super Agent or session file is tracked by git', detected: true };
  if (!existsSync(join(root, 'state'))) return none;
  let at: ReturnType<typeof superPathspecs>;
  try { at = superPathspecs(root, root); } catch { at = null; }
  if (!at) return none;
  const { top, specs } = at;
  const prefix = brainPrefix(root, root) ?? '';
  let tracked: string[];
  try { tracked = git.indexPaths(top, specs); } catch {
    return { step, filesTouched: [], summary: 'Could not ask git which Super Agent and session files it tracks; retried on the next update', detected: false, failedCount: 1 };
  }
  if (tracked.length === 0) return none;
  const moved = setAsideForeignRecords(root);
  // A tracked sleep state holds every Mac's lines that synced into it: this Mac keeps its own.
  const asideSleep = tracked.some(isSleepStatePath) ? setAsideForeignSleepLines(root) : null;
  if (asideSleep) moved.push(asideSleep);
  // `-f`: a live record staged a moment before it changed again is dropped too (index only).
  try { git.removeFromIndexForce(top, specs); } catch {
    return { step, filesTouched: moved, summary: `Git tracks ${tracked.length} Super Agent or session file(s) but would not drop them from its index (an index.lock held by another git?); retried on the next update`, detected: false, failedCount: 1 };
  }
  // A brain that committed its peer mail lists dozens of letters: name a few, count the rest.
  const rel = tracked.map((p) => relative(prefix || '.', p) || p);
  const names = rel.length > 6 ? `${rel.slice(0, 6).join(', ')} and ${rel.length - 6} more` : rel.join(', ');
  return {
    step,
    filesTouched: [...tracked.map((p) => join(top, p)), ...moved],
    detected: false,
    summary: `Took ${tracked.length} Super Agent or session file(s) out of git's index, kept on disk (${names}); commit that removal${moved.length ? `. Set aside ${moved.length} record(s) from another Mac or folder${asideSleep ? ' (other Macs\' sessions out of the sleep state)' : ''}` : ''}`,
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
