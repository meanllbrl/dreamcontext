import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { createRisks } from '../agents/amendments.js';
import { globalAgentsDir } from '../agents/scope.js';
import { getAgent, listAgentTargets } from '../agents/store.js';
import { gitAvailable } from '../git-sync/git.js';
import { readLocalJson, updateLocalJson } from '../local-store.js';
import { approveAutomation, changedApprovalFields, checkApproval } from './registry.js';
import { listAutomations } from './store.js';
import type { AutomationManifest } from './types.js';

/**
 * THE UPGRADE STEP of "only what arrives from outside asks" (owner 2026-11-07).
 *
 * From this version on, everything this Mac writes to a member, a routine or an instruction is
 * stamped as it is written (`localWriteStamps`). What waited for a card under the old rule (a
 * schedule the Super Agent set up, a member an agent created, a widening edit) is still waiting on
 * this Mac, though, and some of it was never anyone's but this Mac's. This step settles those,
 * ONCE per project per machine, and only with proof:
 *
 *  - every file the target is read from was never delivered by git: no commit in any ref
 *    (branches, remotes, stash) and no index entry has ever held its path, matched without regard
 *    to case and literally (a case-insensitive disk folds `Agents/x.md` into `agents/x.md`), or it
 *    is a global agent's file under `~/.dreamcontext/agents/`, which no brain syncs;
 *  - its text is clean (`createRisks` over prompt, soul and job): the injection guard still asks;
 *  - a CHANGED target moved only fields a local write stamps today (`ADOPTABLE_FIELDS`): a moved
 *    tool, home board, autonomy, read tools, destination or flow keeps its card, as does a change
 *    this Mac cannot name;
 *  - it is this Mac's own (`not_owner` is never touched) and its payload format is current.
 *
 * Anything else keeps its one card: a tracked file, a file git ever held, a risky text, a brain
 * that is not a git repository or has no commit yet (nothing proves where a file came from).
 * Unknown origin is never mass-approved. An approved target is never rewritten, so its stored hash
 * stays exactly what it was. Git missing or the brain not a repository: the step backs off for
 * {@link RETRY_MS} (no dialog every minute); a merge in progress: it tries again at the next pass.
 */

const MARKER = 'approval-adopted.json';
/** Bump only with a reason: a new version re-runs the step once on every machine. */
const ADOPT_VERSION = 1;
/** How long a "cannot tell yet" (git missing, not a repository) waits before the next try. */
const RETRY_MS = 6 * 60 * 60 * 1000;
/** Every git call is bounded: a hung git must never stall the tick. */
const GIT_TIMEOUT_MS = 5_000;

/** The reviewed fields a write made on this Mac stamps today, whoever made it. A change that moved
 *  any other field (or one this Mac cannot name) is not adopted. */
const ADOPTABLE_FIELDS: ReadonlySet<string> = new Set(['prompt', 'soul', 'job', 'model', 'effort', 'timeoutMinutes', 'learning']);

interface AdoptMarker {
  version?: number;
  at?: string;
  adopted?: string[];
  /** Set while the step could not run (git missing, not a repository): no try before it. */
  retryAfter?: string;
}

export interface AdoptResult {
  /** `<kind>:<slug>` of every target approved by this pass. */
  adopted: string[];
  /** True when the step ran (or had run) to its end for this project. */
  done: boolean;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, windowsHide: true,
  });
}

type Readiness = { ok: true; top: string } | { ok: false; retry: 'later' | 'next-pass' };

/** Can git answer for this brain, right now? A merge in progress holds teammates' files in the
 *  index with no local commit; a repository with no commit yet proves nothing. */
function gitReadiness(projectRoot: string): Readiness {
  if (!gitAvailable()) return { ok: false, retry: 'later' };
  let top: string;
  try {
    if (git(['rev-parse', '--is-inside-work-tree'], projectRoot).trim() !== 'true') return { ok: false, retry: 'later' };
    top = git(['rev-parse', '--show-toplevel'], projectRoot).trim();
  } catch {
    return { ok: false, retry: 'later' };
  }
  try {
    git(['rev-parse', '--verify', '-q', 'HEAD'], projectRoot);
  } catch {
    return { ok: false, retry: 'later' };
  }
  try {
    const gitDir = git(['rev-parse', '--absolute-git-dir'], projectRoot).trim();
    for (const f of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
      try { lstatSync(join(gitDir, f)); return { ok: false, retry: 'next-pass' }; } catch { /* absent: fine */ }
    }
  } catch {
    return { ok: false, retry: 'next-pass' };
  }
  return { ok: true, top };
}

function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * True only when git provably never held `file`: a regular file inside this repository, and
 * neither `git log --all` nor the index knows its path, compared case-insensitively and literally
 * from the top. Any error, a path outside the repository, or a symlink is false (fail closed).
 */
function neverInGit(top: string, file: string): boolean {
  try {
    if (!lstatSync(file).isFile()) return false;
  } catch {
    return false;
  }
  const realTop = realOr(top);
  const realFile = realOr(file);
  if (!inside(realTop, realFile)) return false;
  const rel = relative(realTop, realFile).split(sep).join('/');
  if (!rel) return false;
  const spec = `:(top,icase,literal)${rel}`;
  try {
    // The file's own repository must be this one: a nested repository (an old separate brain repo)
    // holds its files out of the outer one's sight, so the outer log would prove nothing.
    if (realOr(git(['rev-parse', '--show-toplevel'], dirname(realFile)).trim()) !== realTop) return false;
    if (git(['log', '--all', '-1', '--format=%H', '--', spec], realTop).trim() !== '') return false;
    if (git(['ls-files', '--cached', '--', spec], realTop).trim() !== '') return false;
    return true;
  } catch {
    return false;
  }
}

/** A global agent's own file: machine-local by construction, never in a brain. */
function globalAgentFile(file: string, home?: string): boolean {
  try {
    if (!lstatSync(file).isFile()) return false;
  } catch {
    return false;
  }
  return inside(realOr(globalAgentsDir(home)), realOr(file));
}

/** Every file `m` is read from: its own, and its agent's for a routine that runs as one. */
function sourceFiles(contextRoot: string, m: AutomationManifest, home?: string): string[] | null {
  const files = [m.path];
  if (m.runKind !== 'agent' && m.agent) {
    const agent = getAgent(contextRoot, m.agent, home);
    if (!agent) return null;
    if (agent.path !== m.path) files.push(agent.path);
  }
  return files;
}

function localOrigin(top: string, contextRoot: string, m: AutomationManifest, home?: string): boolean {
  const files = sourceFiles(contextRoot, m, home);
  if (!files || files.length === 0) return false;
  return files.every((f) => globalAgentFile(f, home) || neverInGit(top, f));
}

function cleanText(m: AutomationManifest): boolean {
  const soul = typeof m.soul === 'string' ? m.soul : '';
  const job = typeof m.job === 'string' ? m.job : '';
  return createRisks(m.prompt ?? '', [soul, job].join('\n')).length === 0;
}

/** A changed target is adopted only when this Mac can name what moved, and all of it is a field a
 *  local write stamps today. */
function adoptableChange(projectRoot: string, m: AutomationManifest, home?: string): boolean {
  const moved = changedApprovalFields(projectRoot, m, home);
  return !!moved && moved.length > 0 && moved.every((f) => ADOPTABLE_FIELDS.has(f));
}

/**
 * Run the step for one project, once. Never throws: a failure leaves the cards as they were and
 * the step runs again at a later pass. `now` and `home` are injected for tests.
 */
export function adoptLocalPending(contextRoot: string, opts: { home?: string; now?: Date } = {}): AdoptResult {
  const projectRoot = dirname(contextRoot);
  const { home } = opts;
  const now = opts.now ?? new Date();
  try {
    const marker = readLocalJson<AdoptMarker>(projectRoot, MARKER, {}, home);
    if (marker.version === ADOPT_VERSION) return { adopted: [], done: true };
    if (marker.retryAfter && Date.parse(marker.retryAfter) > now.getTime()) return { adopted: [], done: false };
    const ready = gitReadiness(projectRoot);
    if (!ready.ok) {
      // Nothing can prove where a file came from, so every card stays. "later": git missing, not a
      // repository, or no commit yet; no marker, so a brain put under git later still gets the step.
      if (ready.retry === 'later') {
        updateLocalJson<AdoptMarker>(projectRoot, MARKER, {}, (cur) => ({ ...cur, retryAfter: new Date(now.getTime() + RETRY_MS).toISOString() }), home);
      }
      return { adopted: [], done: false };
    }
    const targets: AutomationManifest[] = [
      ...listAgentTargets(contextRoot, home),
      ...listAutomations(contextRoot, home).filter((m) => m.runKind !== 'agent'),
    ];
    const adopted: string[] = [];
    for (const m of targets) {
      const verdict = checkApproval(projectRoot, m, home, 'run');
      if (verdict.approved) continue;
      if (verdict.reason === 'manifest-changed') {
        if (!adoptableChange(projectRoot, m, home)) continue;
      } else if (verdict.reason !== 'never-approved') {
        continue;
      }
      if (!cleanText(m)) continue;
      if (!localOrigin(ready.top, contextRoot, m, home)) continue;
      try {
        approveAutomation(projectRoot, m, now, home);
        adopted.push(`${m.runKind === 'agent' ? 'agent' : 'automation'}:${m.slug}`);
      } catch {
        // not this Mac's to approve after all: its card stays
      }
    }
    updateLocalJson<AdoptMarker>(projectRoot, MARKER, {}, () => ({ version: ADOPT_VERSION, at: now.toISOString(), adopted }), home);
    return { adopted, done: true };
  } catch {
    return { adopted: [], done: false };
  }
}
