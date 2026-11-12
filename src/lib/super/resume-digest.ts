import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computePlanState, isCodeLedger, renderNextAction, type Ledger } from '../plan-ledger.js';
import { LOOP_NAME_RE, readLedgerAt, reviewLoopsDir } from '../plan-store.js';
import { childPlaceOf } from './handoff-task.js';
import { handoffDir, readHandoffRecord } from '../context-watch.js';

/**
 * The resume digest of a Super child's hand-over (audit OR-9). A successor used to start at 73K
 * tokens and spend a median 28 tool calls (+87K tokens) re-deriving where the work stood before
 * its first edit. The state it needs is already on disk: the run's START tree (the review loop's
 * ledger), the paths changed since, an open review round, and the command that goes next. The
 * rotation embeds this in the fresh session's first message, so it begins on the stage the
 * previous one left.
 *
 * Read-only and bounded: a few `git` calls (3 s each) in the child's own worktree, every line
 * cut, the whole digest under {@link DIGEST_MAX_CHARS}. Anything unreadable leaves its line out;
 * a digest that cannot be built is the empty string and the prompt reads as before.
 */

export const DIGEST_MAX_CHARS = 1500;
const MAX_PATHS = 20;
const MAX_LINE = 160;
const GIT_MS = 3_000;

const TASK_SLUG = /^[a-z0-9][a-z0-9-]{0,239}$/;

/** One line, no control characters, cut: a path name is a file's, not prose we trust. */
const oneLine = (s: string, n = MAX_LINE): string => {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: GIT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
  } catch { return null; }
}

/** The code review loops of `task` in `worktree` that are still open, newest-opened first. */
function openLoops(worktree: string, task: string): Array<{ ledger: Ledger; next: string }> {
  let dir: string;
  try { dir = reviewLoopsDir(worktree, task); } catch { return []; }
  let names: string[];
  try {
    if (lstatSync(dir).isSymbolicLink()) return [];
    names = readdirSync(dir);
  } catch { return []; }
  const out: Array<{ ledger: Ledger; next: string }> = [];
  for (const name of names) {
    if (!LOOP_NAME_RE.test(name)) continue;
    const r = readLedgerAt(worktree, join(dir, name, 'ledger.json'), name, 'code');
    if (!r.ok || !isCodeLedger(r.ledger)) continue;
    try {
      const state = computePlanState(r.ledger);
      if (state.done || state.abandoned) continue;
      out.push({ ledger: r.ledger, next: renderNextAction(r.ledger, state).split('\n')[0] ?? '' });
    } catch { /* an unreadable ledger leaves the line out */ }
  }
  return out.sort((a, b) => Date.parse(b.ledger.createdAt) - Date.parse(a.ledger.createdAt));
}

/** The commit the run started from when no review loop recorded one: the merge-base with main. */
function mergeBase(worktree: string): string | null {
  for (const ref of ['main', 'origin/main', 'master']) {
    const out = git(worktree, ['merge-base', 'HEAD', ref]);
    if (out && /^[0-9a-f]{7,64}$/.test(out.trim())) return out.trim();
  }
  return null;
}

export interface DigestInput {
  task?: string;
  worktree?: string;
  branch?: string;
}

/** The digest block, or '' when the child has no worktree of its own (nothing to read). */
export function resumeDigest(input: DigestInput): string {
  const place = childPlaceOf(input.worktree, input.branch);
  const worktree = place.worktree;
  if (!worktree || !existsSync(join(worktree, '.git'))) return '';
  const task = input.task && TASK_SLUG.test(input.task) ? input.task : undefined;
  const loops = task ? openLoops(worktree, task) : [];

  const lines: string[] = [];
  const head = git(worktree, ['rev-parse', '--short', 'HEAD'])?.trim();
  const start = loops.find((l) => typeof l.ledger.start === 'string')?.ledger.start ?? mergeBase(worktree);
  if (head || start) {
    lines.push(`- START tree: ${start ? oneLine(start.slice(0, 40)) : 'unknown'}; HEAD now: ${head ? oneLine(head, 40) : 'unknown'}${place.branch ? ` (branch ${place.branch})` : ''}.`);
  }

  const changed: string[] = [];
  const seen = new Set<string>();
  const add = (status: string, path: string): void => {
    const p = oneLine(path);
    if (!p || seen.has(p)) return;
    seen.add(p);
    changed.push(`${status} ${p}`);
  };
  if (start && /^[0-9a-f]{7,64}$/.test(start)) {
    for (const row of (git(worktree, ['diff', '--name-status', '--no-renames', start, 'HEAD']) ?? '').split('\n')) {
      const [st, ...rest] = row.split('\t');
      if (st && rest.length) add(st.charAt(0), rest.join('\t'));
    }
  }
  const uncommitted = new Set<string>();
  for (const row of (git(worktree, ['status', '--porcelain', '--no-renames']) ?? '').split('\n')) {
    if (row.length < 4) continue;
    uncommitted.add(oneLine(row.slice(3)));
    add('~', row.slice(3));
  }
  if (changed.length) {
    const shown = changed.slice(0, MAX_PATHS);
    lines.push(`- Changed paths (${changed.length}${uncommitted.size ? `, ${uncommitted.size} not committed, marked ~` : ''}): ${shown.join('; ')}${changed.length > shown.length ? `; +${changed.length - shown.length} more` : ''}.`);
  } else if (head) {
    lines.push('- Changed paths: none yet.');
  }

  const open = loops[0];
  if (open) {
    const s = computePlanState(open.ledger);
    const crit = s.open.length;
    lines.push(`- Open review: loop ${open.ledger.plan}, round ${s.round}${s.roundComplete ? ' complete' : ' waiting on its reviewers'}, ${crit} finding${crit === 1 ? '' : 's'} open.`);
    if (open.next) lines.push(`- Next command: ${oneLine(open.next, 400)}`);
  } else if (task) {
    lines.push('- Open review: none. Next: the task\'s latest changelog entry names the next step; carry on from it.');
  }

  if (lines.length === 0) return '';
  let out = `Resume digest (read from your worktree ${worktree}, so you need not rediscover it):\n${lines.join('\n')}`;
  if (out.length > DIGEST_MAX_CHARS) out = `${out.slice(0, DIGEST_MAX_CHARS - 1)}…`;
  return out;
}

/**
 * The digest is built where blocking is free: in the child's OWN `tasks handoff` process
 * (handoff-artifacts.ts), right after the record is written, and stored beside the record. The
 * server's result-frame path only reads that small file (no git on the event loop; review r1).
 * The first line names the record's `at`, so a digest of an earlier hand-over is never served.
 */
const digestPath = (contextRoot: string, key: string): string => join(handoffDir(contextRoot), `${key}.digest.txt`);

/** Build and store the digest for the record `key` names. Best-effort: never throws. */
export function storeResumeDigest(contextRoot: string, key: string): void {
  try {
    const rec = readHandoffRecord(contextRoot, key);
    if (!rec || rec.kind === 'super') return;
    const d = resumeDigest({ task: rec.task, worktree: rec.worktree, branch: rec.branch });
    if (!d) return;
    const path = digestPath(contextRoot, key);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `at=${rec.at}\n${d}`, 'utf-8');
    renameSync(tmp, path);
  } catch { /* the digest is a convenience, never a gate on the handoff */ }
}

/** The stored digest for this exact record, or ''. A plain small file; anything else is ignored. */
export function readStoredDigest(contextRoot: string, key: string, at: string): string {
  try {
    const path = digestPath(contextRoot, key);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 4 * DIGEST_MAX_CHARS) return '';
    const text = readFileSync(path, 'utf-8');
    const nl = text.indexOf('\n');
    if (nl < 0 || text.slice(0, nl) !== `at=${at}`) return '';
    return text.slice(nl + 1, nl + 1 + DIGEST_MAX_CHARS + 1).slice(0, DIGEST_MAX_CHARS);
  } catch { return ''; }
}

/** What a fresh SUPER session is told to run first (it replaces the bare `super state`). */
export const SUPER_BRIEF_LINE = 'Start with `dreamcontext super state --brief` (children, open queue, agenda; the plain `super state` adds cards and machine facts, only when you need them).';

/**
 * The kickoff prompt with the digest appended: a Super's successor gets the brief-state line, a
 * child's gets the digest its own hand-over stored. Reads one small file; runs no git.
 */
export function withResumeDigest(prompt: string, record: { kind?: 'super'; at: string }, contextRoot: string, key: string): string {
  if (record.kind === 'super') return `${prompt} ${SUPER_BRIEF_LINE}`;
  const d = readStoredDigest(contextRoot, key, record.at);
  return d ? `${prompt}\n\n${d}` : prompt;
}
