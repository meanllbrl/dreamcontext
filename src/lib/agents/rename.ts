import { renameOrForgetAgentTaskJobs } from './task-jobs.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import * as git from '../git-sync/git.js';
import { renameAgentStage } from '../local-store.js';
import { safeVaultPath, safeWriteTarget } from '../vault-read.js';
import { renameApprovals } from '../automations/registry.js';
import { AutomationError } from '../automations/types.js';
import { readAssignmentLedger, renameOrForgetAgentAssignments } from './assignment-ledger.js';
import { updateFrontmatterFields } from '../frontmatter.js';
import { withTaskFileLock } from '../task-file-lock.js';
import { brainPrefix, createdLocally, moveFileAcross, recordCreatedLocally, renameInAgentSyncRecords, renameOrForgetThreadLedger } from './agent-sync.js';
import { currentLogin, ownedBy } from './owner.js';
import { isSafeAutomationSlug, parseManifestFrontmatter } from './slot.js';
import { AGENTS_DIR } from './types.js';

/**
 * Rename ONE machine's copy of an agent or automation (B1-8): the same-slug collision, where a
 * teammate's member keeps the name and this machine's moves to `<slug>-<n>`.
 *
 * It moves the manifest, the approval registry entry, the M0 entries, and ONLY this machine's own
 * files under threads, output and cache, i.e. paths absent from the incoming commit's tree
 * (`git ls-tree -r <remoteSha>`): a path tracked there belongs to the teammate and is never moved.
 * `.active` moves only when its `by` is this login. Every move is lstat + realpath-inside-vault
 * (symlinks refused, as M2). Refused while that slug's run lock is held or a merge is open.
 */

export interface RenameOptions {
  home?: string;
  /** The incoming commit: its tree says which files are the teammate's. */
  remoteSha?: string;
  /** Install this file as the renamed manifest (a parked copy) instead of moving `<from>.md`. */
  manifestSource?: string;
  kind?: 'agent' | 'automation';
  /** The manifest is already in place as `<to>.md` (an interrupted rename resuming): redo the rest. */
  resume?: boolean;
}

function insideVault(contextRoot: string, abs: string): boolean {
  try {
    const root = realpathSync(contextRoot);
    const real = realpathSync(abs);
    const rel = relative(root, real);
    return rel !== '' && !rel.startsWith('..') && !rel.split(sep).includes('..');
  } catch {
    return false;
  }
}

function movable(contextRoot: string, abs: string): boolean {
  try {
    return lstatSync(abs).isFile() && insideVault(contextRoot, abs);
  } catch {
    return false;
  }
}

function moveFile(contextRoot: string, fromAbs: string, toAbs: string): boolean {
  if (!movable(contextRoot, fromAbs) || existsSync(toAbs) || !safeWriteTarget(contextRoot, toAbs)) return false;
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  return true;
}

function lockHeld(contextRoot: string, slug: string): boolean {
  try {
    const info = JSON.parse(readFileSync(join(contextRoot, 'automations', 'cache', `.${slug}.lock`), 'utf-8')) as { pid?: unknown };
    if (typeof info.pid !== 'number') return true;
    try { process.kill(info.pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  } catch {
    return false;
  }
}

/** Rename this machine's `from` to `to`. Throws `AutomationError` when refused. */
export function renameAgentLocal(contextRoot: string, from: string, to: string, opts: RenameOptions = {}): void {
  if (!isSafeAutomationSlug(from) || !isSafeAutomationSlug(to)) throw new AutomationError(`Cannot rename "${from}" to "${to}".`);
  const gitCwd = dirname(contextRoot);
  const inRepo = git.isGitRepo(gitCwd);
  if (inRepo && git.hasMergeHead(gitCwd)) throw new AutomationError(`A brain merge is still open; ${from} is renamed once it commits.`);
  if (lockHeld(contextRoot, from)) throw new AutomationError(`${from} is running here; it is renamed after the run.`);

  const prefix = (inRepo ? brainPrefix(gitCwd, contextRoot) : null) ?? '_dream_context/';
  const theirs = new Set(opts.remoteSha && inRepo ? git.treePaths(gitCwd, opts.remoteSha) : []);
  const isTheirs = (brainRel: string): boolean => theirs.has(`${prefix}${brainRel}`);
  const kind = opts.kind ?? (existsSync(join(contextRoot, AGENTS_DIR, `${from}.md`)) ? 'agent' : 'automation');
  const manifestDir = kind === 'agent' ? AGENTS_DIR : 'automations';
  const toManifest = join(contextRoot, manifestDir, `${to}.md`);
  if (!opts.resume && existsSync(toManifest)) throw new AutomationError(`"${to}" is already taken.`);
  if (!safeWriteTarget(contextRoot, toManifest)) throw new AutomationError(`Refusing to write "${to}" through a symlink.`);

  // 1. The manifest: a parked copy, or this machine's own `<from>.md` when it is not the teammate's.
  //    Every later step is idempotent, so a resumed rename redoes them all.
  if (opts.resume) {
    if (!existsSync(toManifest)) throw new AutomationError(`"${to}" is not in place to resume.`);
  } else if (opts.manifestSource) {
    mkdirSync(dirname(toManifest), { recursive: true });
    moveFileAcross(opts.manifestSource, toManifest);
  } else {
    const fromRel = `${manifestDir}/${from}.md`;
    if (isTheirs(fromRel)) throw new AutomationError(`${from} is the teammate's file; nothing of yours to rename.`);
    if (!moveFile(contextRoot, join(contextRoot, fromRel), toManifest)) throw new AutomationError(`${from} could not be moved.`);
  }
  recordCreatedLocally(contextRoot, `${manifestDir}/${to}.md`, opts.home);

  // 2. This machine's own files under threads, output and cache (never a path the remote tracks).
  for (const sub of ['threads', 'output']) {
    const dir = join(contextRoot, 'automations', sub, from);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      const rel = `automations/${sub}/${from}/${name}`;
      if (isTheirs(rel)) continue;
      moveFile(contextRoot, join(dir, name), join(contextRoot, 'automations', sub, to, name));
    }
    try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* still holds the teammate's files */ }
  }
  const cacheRel = `automations/cache/${from}.json`;
  if (!isTheirs(cacheRel)) moveFile(contextRoot, join(contextRoot, cacheRel), join(contextRoot, 'automations', 'cache', `${to}.json`));

  // 3. `.active` only when this login wrote it.
  const activeFrom = join(contextRoot, AGENTS_DIR, '.active', `${from}.json`);
  if (movable(contextRoot, activeFrom) && !isTheirs(`agents/.active/${from}.json`)) {
    try {
      const rec = JSON.parse(readFileSync(activeFrom, 'utf-8')) as { by?: unknown };
      if (typeof rec.by === 'string' && ownedBy(rec.by, currentLogin())) {
        moveFile(contextRoot, activeFrom, join(contextRoot, AGENTS_DIR, '.active', `${to}.json`));
      }
    } catch { /* an unreadable .active is ignored by every reader anyway */ }
  }

  // 4. This machine's routines bound to the renamed agent follow it (never the teammate's).
  if (kind === 'agent') {
    let names: string[] = [];
    try { names = readdirSync(join(contextRoot, 'automations')).filter((n) => n.endsWith('.md')); } catch { names = []; }
    for (const name of names) {
      const rel = `automations/${name}`;
      if (isTheirs(rel) && !createdLocally(contextRoot, rel, opts.home)) continue;
      const abs = join(contextRoot, rel);
      if (!movable(contextRoot, abs)) continue;
      try {
        const raw = readFileSync(abs, 'utf-8');
        if (parseManifestFrontmatter(raw).data.agent !== from) continue;
        writeFileSync(abs, raw.replace(/^agent:\s*["']?[a-z0-9-]+["']?\s*$/m, `agent: ${to}`), 'utf-8');
      } catch { /* left bound to the old name: it composes from a placeholder and stays blocked */ }
    }
  }

  // 5. The machine-local records.
  const projectRoot = gitCwd;
  renameApprovals(projectRoot, from, to, kind === 'agent' ? 'agent' : 'automation', opts.home);
  renameAgentStage(projectRoot, from, to, opts.home);
  renameOrForgetAssignmentsSafe(projectRoot, from, to, opts.home);
  renameOrForgetThreadLedger(contextRoot, from, to, opts.home);
  // The created-here sets, the ids watched for replacement and the adopted pattern follow too, so
  // the teammate's file now at `<from>.md` never reads as "yours, replaced through sync".
  renameInAgentSyncRecords(contextRoot, `${manifestDir}/${from}.md`, `${manifestDir}/${to}.md`, from, to, opts.home);
  // Tasks this machine assigned to it now name it by its new name.
  if (kind === 'agent') retargetAssignedTasks(contextRoot, to, from, opts.home);
}

/** Rewrite `agent:` / `reviewer:` on the tasks this machine's ledger holds for the renamed agent
 *  (the ledger already moved to `to`). Only this machine's own assignments; never a hand edit. */
function retargetAssignedTasks(contextRoot: string, to: string, from: string, home?: string): void {
  for (const rec of readAssignmentLedger(gitCwdOf(contextRoot), home).records) {
    if (rec.agent !== to) continue;
    const rel = join('state', `${rec.taskSlug}.md`);
    const abs = safeVaultPath(contextRoot, rel);
    if (!abs) continue;
    const field = rec.role === 'doer' ? 'agent' : 'reviewer';
    try {
      withTaskFileLock(contextRoot, rec.taskSlug, () => {
        const data = parseManifestFrontmatter(readFileSync(abs, 'utf-8')).data;
        if (data[field] === from) updateFrontmatterFields(abs, { [field]: to });
      });
    } catch {
      // the task keeps the old name; the next scan raises a row instead of starting anything
    }
  }
}

function gitCwdOf(contextRoot: string): string {
  return dirname(contextRoot);
}

function renameOrForgetAssignmentsSafe(projectRoot: string, from: string, to: string, home?: string): void {
  try { renameOrForgetAgentAssignments(projectRoot, from, to, home); } catch { /* see the ledger */ }
  renameOrForgetAgentTaskJobs(projectRoot, from, to, home);
}
