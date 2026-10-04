/**
 * Transport 1, receiver half (both directions; the laptop at Return is the strict side).
 *
 * Order for one repository (task "Receive"): bundle fetch into the quarantine
 * (`fetchBundle`, git-snapshot.ts) → {@link verifyIncoming} → divergence verdict → either
 * PARK (refs under `refs/handsfree/<trip>/*`, nothing else touched) or: ref backup under
 * `refs/handsfree/backup/<trip>/*` → refs → stash rebuild (messages kept) → per checkout:
 * HEAD (symref to refs/heads/* or a commit id) → working tree (diff-tree prev..new, every
 * path through the shared guard, deletions first, symlinks last, files via
 * `checkout-index` from a temp index, compare-and-write, backup-before-overwrite) →
 * index (`read-tree`, no -u, + `update-index --refresh`).
 *
 * The journal ops at the bottom carry everything computed at plan time, so a crash replay
 * never re-diffs and Roll back restores the pre-return state from the op params, the
 * backup refs and the backup store. Every git call goes through the injected runner.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  GitError, HandsfreeRefusal, assertTripId, emptyTree, git, gitOut, incomingRefFor, isAllowedRef, isWellFormedRef,
  lsTree, objectFormat, readHead, readRefs, readStash, snapIndexRef, snapRefPrefix, snapStashRef, snapWorktreeRef,
  type HeadState, type ObjectFormat, type ProcessRunner, type RepoSnapshot, type StashEntry,
} from './git-snapshot.js';
import {
  checkRelPath, detectCollisions, ensureSafeParents, freeConflictTarget, leafState, sweepEscapingSymlinks, symlinkTargetInside,
  tempSibling,
} from './paths.js';
import { BackupStore, pruneEmptyParents, type Conflict } from './apply.js';
import { backupDir, conflictsDir, type JournalOp, type OpHandlers } from './journal.js';

export const backupRefPrefix = (trip: string) => `refs/handsfree/backup/${assertTripId(trip)}`;
export const parkRefPrefix = (trip: string) => `refs/handsfree/${assertTripId(trip)}`;
export const BASE_REF_PREFIX = 'refs/handsfree/base';

/**
 * D20: a tolerant (recovery) snapshot holds conflict markers as content and a HEAD tree as
 * the index; it is never applied to a working tree. Recovery only ever fetches it into
 * `refs/handsfree/<old-trip>/*` ({@link parkRepo}) and its files into `trips/<old>/orphaned/`.
 */
export const TOLERANT_REFUSAL =
  'a tolerant (recovery) snapshot is never applied to a working tree; recovery only fetches it into refs/handsfree/<old-trip>/* (parkRepo) and trips/<old>/orphaned/';

const ZERO_RE = /^0+$/;

async function gitDir(run: ProcessRunner, cwd: string): Promise<string> {
  return (await gitOut(run, cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
}

async function updateRefs(run: ProcessRunner, cwd: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  await git(run, cwd, ['update-ref', '--stdin'], { input: Buffer.from(lines.join('\n') + '\n') });
}

async function missingObjects(run: ProcessRunner, cwd: string, oids: string[]): Promise<string[]> {
  if (oids.length === 0) return [];
  const out = await gitOut(run, cwd, ['cat-file', '--batch-check'], { input: Buffer.from(oids.join('\n') + '\n') });
  const lines = out.split('\n');
  return oids.filter((_, i) => (lines[i] ?? '').endsWith(' missing'));
}

/** The git blob id of `data` (for symlink targets, which hash-object would follow). */
export function blobOid(fmt: ObjectFormat, data: Buffer): string {
  return createHash(fmt === 'sha256' ? 'sha256' : 'sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

// ---------------------------------------------------------------- verify the quarantine

async function objectTypes(run: ProcessRunner, cwd: string, oids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(oids)];
  const out = new Map<string, string>();
  if (uniq.length === 0) return out;
  const lines = (await gitOut(run, cwd, ['cat-file', '--batch-check=%(objecttype)'], { input: Buffer.from(uniq.join('\n') + '\n') })).split('\n');
  uniq.forEach((o, i) => out.set(o, (lines[i] ?? '').endsWith('missing') ? 'missing' : (lines[i] ?? '').trim()));
  return out;
}

/**
 * Check the fetched quarantine against the sender's (already parsed) snapshot: every ref,
 * snapshot tree and stash entry matches (a ref the bundle omitted because the receiver
 * already had it must point at an object present here, of the right type), every path of
 * every incoming tree passes the shared guard, and no tree has a mode-160000 entry.
 */
export async function verifyIncoming(
  run: ProcessRunner,
  repoPath: string,
  snap: RepoSnapshot,
  fetched: Record<string, string>,
): Promise<void> {
  const trip = snap.trip;
  const bad = (m: string) => new HandsfreeRefusal('bad_snapshot', m);
  const need = new Map<string, string[]>(); // oid → allowed types
  const want = (oid: string, types: string[]) => need.set(oid, types);
  for (const [ref, oid] of Object.entries(snap.refs)) {
    if (ref in fetched && fetched[ref] !== oid) throw bad(`bundle carries ${ref} at ${fetched[ref]}, the snapshot says ${oid}`);
    want(oid, ref.startsWith('refs/tags/') ? ['commit', 'tag'] : ['commit']);
  }
  for (const ref of Object.keys(fetched)) {
    if (isAllowedRef(ref) && !(ref in snap.refs)) throw bad(`bundle carries ${ref}, which the snapshot does not list`);
  }
  snap.stash.forEach((e, i) => {
    const r = snapStashRef(trip, i);
    if (r in fetched && fetched[r] !== e.oid) throw bad(`bundle carries a different stash entry ${i}`);
    want(e.oid, ['commit']);
  });
  const trees: string[] = [];
  for (const c of snap.checkouts) {
    for (const [ref, tree] of [[snapIndexRef(trip, c.checkoutId), c.indexTree], [snapWorktreeRef(trip, c.checkoutId), c.worktreeTree]] as const) {
      if (fetched[ref]) {
        const got = (await gitOut(run, repoPath, ['rev-parse', `${incomingRefFor(trip, ref)}^{tree}`])).trim();
        if (got !== tree) throw bad(`${ref} wraps ${got}, the snapshot says ${tree}`);
      }
      want(tree, ['tree']);
      trees.push(tree);
    }
    if (c.head.kind === 'detached') want(c.head.oid, ['commit']);
    else if (c.head.oid) want(c.head.oid, ['commit']);
  }
  const types = await objectTypes(run, repoPath, [...need.keys()]);
  for (const [oid, allowed] of need) {
    const t = types.get(oid) ?? 'missing';
    if (!allowed.includes(t)) throw bad(`object ${oid} is ${t}, expected ${allowed.join('/')}`);
  }
  for (const tree of new Set(trees)) {
    for (const e of await lsTree(run, repoPath, tree)) {
      if (e.mode === '160000') throw new HandsfreeRefusal('submodule', `incoming tree has a nested repository at ${e.path} (mode 160000)`, e.path);
      const c = checkRelPath(e.path);
      if (!c.ok) throw new HandsfreeRefusal('bad_path', `incoming tree has a refused path ${JSON.stringify(e.path)} (${c.reason})`, e.path);
    }
  }
}

/**
 * Laptop-side re-check (the cloud preflight ran on the untrusted side): incoming
 * `.gitattributes` filter= entries, `.lfsconfig` and `.gitmodules` changes park the repo.
 */
export async function riskyConfigChanges(run: ProcessRunner, repoPath: string, prevTree: string, newTree: string): Promise<string[]> {
  const out = await gitOut(run, repoPath, ['diff-tree', '-r', '-z', '--no-renames', '--raw', prevTree, newTree]);
  const reasons: string[] = [];
  for (const d of parseRawDiff(out)) {
    const base = d.path.split('/').pop()!.toLowerCase();
    if (base === '.lfsconfig') reasons.push(`${d.path} changed (LFS)`);
    else if (base === '.gitmodules') reasons.push(`${d.path} changed (submodules)`);
    else if (base === '.gitattributes' && d.newOid) {
      const text = await gitOut(run, repoPath, ['cat-file', 'blob', d.newOid]);
      if (/(^|\s)filter=/m.test(text)) reasons.push(`${d.path} declares a filter driver`);
    }
  }
  return reasons;
}

// ---------------------------------------------------------------- divergence + park

export type Divergence =
  | { kind: 'clean' }
  | { kind: 'worktree-only'; checkouts: string[] }
  | { kind: 'diverged'; reasons: string[] };

/**
 * The per-repo verdict (laptop at Return): S_now vs the trip-start S. Refs, a HEAD, the
 * stash list or an indexTree changed → diverged (park). Only worktree trees changed →
 * worktree-only (apply, per-path conflicts). Nothing changed → clean.
 */
export function divergence(start: RepoSnapshot, now: RepoSnapshot): Divergence {
  const reasons: string[] = [];
  const refNames = new Set([...Object.keys(start.refs), ...Object.keys(now.refs)]);
  for (const r of [...refNames].sort()) if (start.refs[r] !== now.refs[r]) reasons.push(`ref ${r} changed on the laptop`);
  if (JSON.stringify(start.stash) !== JSON.stringify(now.stash)) reasons.push('stash list changed on the laptop');
  const wt: string[] = [];
  for (const c of start.checkouts) {
    const n = now.checkouts.find((x) => x.checkoutId === c.checkoutId);
    if (!n) { reasons.push(`checkout ${c.path} is gone on the laptop`); continue; }
    if (JSON.stringify(c.head) !== JSON.stringify(n.head)) reasons.push(`HEAD of ${c.path} changed on the laptop`);
    if (c.indexTree !== n.indexTree) reasons.push(`index of ${c.path} changed on the laptop`);
    if (c.worktreeTree !== n.worktreeTree) wt.push(c.checkoutId);
  }
  for (const n of now.checkouts) {
    if (!start.checkouts.some((c) => c.checkoutId === n.checkoutId)) reasons.push(`checkout ${n.path} was added on the laptop`);
  }
  if (reasons.length) return { kind: 'diverged', reasons };
  return wt.length ? { kind: 'worktree-only', checkouts: wt } : { kind: 'clean' };
}

/** Park name for a fetched sender ref: heads/tags/notes keep their shape, snap refs go under snap/. */
export function parkRefFor(trip: string, ref: string): string | null {
  if (isAllowedRef(ref)) return `${parkRefPrefix(trip)}/${ref.slice('refs/'.length)}`;
  const snap = snapRefPrefix(trip) + '/';
  if (ref.startsWith(snap)) return `${parkRefPrefix(trip)}/snap/${ref.slice(snap.length)}`;
  return null;
}

/**
 * PARK a diverged repository: every fetched cloud ref, stash entry and snapshot commit
 * goes under `refs/handsfree/<trip>/*`. Nothing else in the repository is touched.
 */
export async function parkRepo(run: ProcessRunner, repoPath: string, trip: string, fetched: Record<string, string>): Promise<Record<string, string>> {
  const parked: Record<string, string> = {};
  const lines: string[] = [];
  for (const [ref, oid] of Object.entries(fetched)) {
    const to = parkRefFor(trip, ref);
    if (!to || !isWellFormedRef(to)) continue;
    parked[to] = oid;
    lines.push(`update ${to} ${oid}`);
  }
  await updateRefs(run, repoPath, lines);
  return parked;
}

// ---------------------------------------------------------------- refs, stash, HEAD

export interface RefBackup { refs: Record<string, string>; stash: StashEntry[] }

/** Back up the receiver's refs + stash under `refs/handsfree/backup/<trip>/*` BEFORE any ref update. */
export async function backupRefs(run: ProcessRunner, repoPath: string, trip: string): Promise<RefBackup> {
  const prefix = backupRefPrefix(trip);
  const refs = await readRefs(run, repoPath, ['refs/heads', 'refs/tags', 'refs/notes']);
  for (const r of Object.keys(refs)) if (!isAllowedRef(r)) delete refs[r];
  const stash = await readStash(run, repoPath);
  const next: Record<string, string> = {};
  for (const [r, oid] of Object.entries(refs)) next[`${prefix}/${r.slice('refs/'.length)}`] = oid;
  stash.forEach((e, i) => { next[`${prefix}/stash/${i}`] = e.oid; });
  // A second backup in the same trip (a retried Return, a second delta pass) replaces the
  // first: one transaction may not both delete and update a ref, so only stale names go.
  const old = await readRefs(run, repoPath, [prefix + '/']);
  const lines = Object.keys(old).filter((r) => !(r in next)).map((r) => `delete ${r}`);
  for (const [r, oid] of Object.entries(next)) lines.push(`update ${r} ${oid}`);
  await updateRefs(run, repoPath, lines);
  return { refs, stash };
}

/** Make refs/heads|tags|notes/* equal `target` in ONE transaction (absent ones deleted). */
export async function applyRefs(run: ProcessRunner, repoPath: string, target: Record<string, string>): Promise<void> {
  for (const r of Object.keys(target)) if (!isAllowedRef(r)) throw new HandsfreeRefusal('bad_ref', `ref ${r} is not allowed`);
  const missing = await missingObjects(run, repoPath, [...new Set(Object.values(target))]);
  if (missing.length) throw new HandsfreeRefusal('bad_snapshot', `objects missing for refs: ${missing.slice(0, 3).join(', ')}`);
  const cur = await readRefs(run, repoPath, ['refs/heads', 'refs/tags', 'refs/notes']);
  const lines: string[] = [];
  for (const [r, oid] of Object.entries(cur)) if (isAllowedRef(r) && !(r in target)) lines.push(`delete ${r} ${oid}`);
  for (const [r, oid] of Object.entries(target)) if (cur[r] !== oid) lines.push(`update ${r} ${oid}`);
  await updateRefs(run, repoPath, lines);
}

export async function refsEqual(run: ProcessRunner, repoPath: string, target: Record<string, string>): Promise<boolean> {
  const cur = await readRefs(run, repoPath, ['refs/heads', 'refs/tags', 'refs/notes']);
  const keys = new Set([...Object.keys(cur).filter(isAllowedRef), ...Object.keys(target)]);
  return [...keys].every((k) => cur[k] === target[k]);
}

/** One-way remote-tracking refs (the cloud receiving at go): make refs/remotes/* equal. */
export async function applyRemoteRefs(run: ProcessRunner, repoPath: string, target: Record<string, string>): Promise<void> {
  const cur = await readRefs(run, repoPath, ['refs/remotes']);
  const lines: string[] = [];
  for (const [r, oid] of Object.entries(cur)) if (!(r in target) && !r.endsWith('/HEAD')) lines.push(`delete ${r} ${oid}`);
  for (const [r, oid] of Object.entries(target)) {
    if (!r.startsWith('refs/remotes/') || !isWellFormedRef(r)) throw new HandsfreeRefusal('bad_ref', `remote ref ${r} is not allowed`);
    if (cur[r] !== oid) lines.push(`update ${r} ${oid}`);
  }
  await updateRefs(run, repoPath, lines);
}

const sameStash = (a: StashEntry[], b: StashEntry[]) => a.length === b.length && a.every((e, i) => e.oid === b[i].oid && e.message === b[i].message);

/**
 * Rebuild the stash list to `entries` (`stash@{0}` first): clear, then `stash store -m
 * <message> <sha>` oldest first, so order AND messages match.
 */
export async function rebuildStash(run: ProcessRunner, repoPath: string, entries: StashEntry[]): Promise<void> {
  if (sameStash(await readStash(run, repoPath), entries)) return;
  await git(run, repoPath, ['update-ref', '-d', 'refs/stash'], { allowFail: true });
  for (let i = entries.length - 1; i >= 0; i--) {
    await git(run, repoPath, ['stash', 'store', '-m', entries[i].message, entries[i].oid]);
  }
}

export async function stashEqual(run: ProcessRunner, repoPath: string, entries: StashEntry[]): Promise<boolean> {
  return sameStash(await readStash(run, repoPath), entries);
}

/** Set a checkout's HEAD: a symref to refs/heads/* or a detached commit id, nothing else. */
export async function setHead(run: ProcessRunner, checkout: string, head: HeadState): Promise<void> {
  if (head.kind === 'symref') {
    if (!head.ref.startsWith('refs/heads/') || !isWellFormedRef(head.ref)) throw new HandsfreeRefusal('bad_head', `HEAD ${head.ref} is not refs/heads/*`);
    await git(run, checkout, ['symbolic-ref', 'HEAD', head.ref]);
    return;
  }
  if (head.kind !== 'detached' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.oid)) throw new HandsfreeRefusal('bad_head', 'HEAD is neither a symref nor a commit id');
  await git(run, checkout, ['update-ref', '--no-deref', 'HEAD', head.oid]);
}

export async function headEqual(run: ProcessRunner, checkout: string, head: HeadState): Promise<boolean> {
  const cur = await readHead(run, checkout);
  if (cur.kind !== head.kind) return false;
  return cur.kind === 'symref' ? cur.ref === (head as { ref: string }).ref : cur.oid === head.oid;
}

// ---------------------------------------------------------------- index

async function withIndexLockRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let delay = 100;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !(err instanceof GitError) || !/index\.lock/.test(err.stderr)) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 3000);
    }
  }
}

/** `read-tree <indexTree>` (no -u) + `update-index --refresh`; retries while an editor holds index.lock. */
export async function applyIndex(run: ProcessRunner, checkout: string, indexTree: string): Promise<void> {
  for (const e of await lsTree(run, checkout, indexTree)) {
    if (e.mode === '160000') throw new HandsfreeRefusal('submodule', `index tree has a nested repository at ${e.path}`, e.path);
    const c = checkRelPath(e.path);
    if (!c.ok) throw new HandsfreeRefusal('bad_path', `index tree has a refused path ${JSON.stringify(e.path)} (${c.reason})`, e.path);
  }
  await withIndexLockRetry(() => git(run, checkout, ['read-tree', indexTree]));
  await git(run, checkout, ['update-index', '-q', '--refresh'], { allowFail: true });
}

export async function indexEqual(run: ProcessRunner, checkout: string, indexTree: string): Promise<boolean> {
  const r = await git(run, checkout, ['write-tree'], { allowFail: true });
  return r.code === 0 && r.stdout.toString().trim() === indexTree;
}

// ---------------------------------------------------------------- working tree

interface RawDiff { oldMode: string; newMode: string; oldOid: string | null; newOid: string | null; status: string; path: string }

function parseRawDiff(out: string): RawDiff[] {
  const parts = out.split('\0');
  const res: RawDiff[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta.startsWith(':')) break;
    const [oldMode, newMode, oldOid, newOid, status] = meta.slice(1).split(' ');
    res.push({
      oldMode, newMode,
      oldOid: ZERO_RE.test(oldOid) ? null : oldOid,
      newOid: ZERO_RE.test(newOid) ? null : newOid,
      status, path: parts[i + 1],
    });
  }
  return res;
}

export interface WorktreeEntry {
  path: string;
  action: 'delete' | 'file' | 'symlink';
  prevOid: string | null;
  prevMode: string | null;
  newOid: string | null;
  newMode: string | null;
}

export interface WorktreeConflict extends Conflict { newOid: string | null; newMode: string | null }

export interface WorktreePlan {
  /**
   * Origin stamp, set ONLY by {@link planWorktree}: always `false` (a tolerant snapshot is
   * refused before a plan exists). {@link applyWorktreePlan} refuses any plan without it,
   * so a hand-built plan or an old journal op can never land a recovery snapshot.
   */
  fromTolerant: false;
  checkout: string;
  objectFormat: ObjectFormat;
  prevTree: string;
  newTree: string;
  entries: WorktreeEntry[];
  /** Laptop keeps its file; the incoming version goes to conflicts/. */
  conflicts: WorktreeConflict[];
  /** Never written anywhere (shared guard refusal). */
  refused: Conflict[];
  /** Both sides already agree. */
  converged: string[];
}

/**
 * Plan the working-tree apply: `diff-tree -r prev new`, every path through the shared
 * guard, mode 160000 refused, collisions (case / NFC) → conflicts, and — when the
 * receiver's own current worktree tree is given (`nowTree`, the laptop at Return) — every
 * path changed on BOTH sides → conflict (laptop keeps its file).
 */
export async function planWorktree(
  run: ProcessRunner,
  checkout: string,
  o: {
    prevTree: string;
    newTree: string;
    nowTree?: string | null;
    /**
     * REQUIRED: the incoming snapshot's `tolerant` flag. True is refused (D20, see
     * {@link TOLERANT_REFUSAL}); the plan is stamped `fromTolerant: false` otherwise.
     */
    fromTolerant: boolean;
  },
): Promise<WorktreePlan> {
  if (o.fromTolerant !== false) throw new HandsfreeRefusal('bad_snapshot', TOLERANT_REFUSAL);
  const fmt = await objectFormat(run, checkout);
  const plan: WorktreePlan = { fromTolerant: false, checkout, objectFormat: fmt, prevTree: o.prevTree, newTree: o.newTree, entries: [], conflicts: [], refused: [], converged: [] };
  const diff = parseRawDiff(await gitOut(run, checkout, ['diff-tree', '-r', '-z', '--no-renames', '--raw', o.prevTree, o.newTree]));
  const laptop = new Map<string, { oid: string | null; mode: string | null }>();
  if (o.nowTree && o.nowTree !== o.prevTree) {
    for (const d of parseRawDiff(await gitOut(run, checkout, ['diff-tree', '-r', '-z', '--no-renames', '--raw', o.prevTree, o.nowTree]))) {
      laptop.set(d.path, { oid: d.newOid, mode: d.newOid ? d.newMode : null });
    }
  }
  const candidates: WorktreeEntry[] = [];
  for (const d of diff) {
    if (d.newMode === '160000' || d.oldMode === '160000') {
      throw new HandsfreeRefusal('submodule', `"${d.path}" is a nested git repository (mode 160000); it never travels`, d.path);
    }
    const c = checkRelPath(d.path);
    if (!c.ok) { plan.refused.push({ path: d.path, reason: `path refused (${c.reason})` }); continue; }
    const action: WorktreeEntry['action'] = !d.newOid ? 'delete' : d.newMode === '120000' ? 'symlink' : 'file';
    const e: WorktreeEntry = { path: d.path, action, prevOid: d.oldOid, prevMode: d.oldOid ? d.oldMode : null, newOid: d.newOid, newMode: d.newOid ? d.newMode : null };
    const l = laptop.get(d.path);
    if (l) {
      if (l.oid === e.newOid && l.mode === e.newMode) { plan.converged.push(d.path); continue; }
      const reason = !e.newOid ? 'deleted in the cloud, modified on the laptop'
        : !l.oid ? 'deleted on the laptop, changed in the cloud'
          : 'changed on both sides';
      plan.conflicts.push({ path: d.path, reason, newOid: e.newOid, newMode: e.newMode });
      continue;
    }
    candidates.push(e);
  }
  const existing = (await lsTree(run, checkout, o.nowTree ?? o.prevTree)).map((e) => e.path);
  const adds = candidates.filter((e) => e.action !== 'delete').map((e) => e.path);
  const dels = candidates.filter((e) => e.action === 'delete').map((e) => e.path);
  const coll = detectCollisions(adds, existing, dels);
  for (const e of candidates) {
    const reason = coll.conflicts.get(e.path);
    if (reason) plan.conflicts.push({ path: e.path, reason, newOid: e.newOid, newMode: e.newMode });
    else plan.entries.push(e);
  }
  return plan;
}

export interface WorktreeApplyResult {
  written: string[];
  deleted: string[];
  conflicts: Conflict[];
  alreadyDone: string[];
  refused: Conflict[];
  /** Written, but re-hashing (with the receiver's filters) does not give the blob id. */
  verifyMismatch: string[];
}

type CurState = { kind: 'absent' } | { kind: 'blocked' } | { kind: 'file' | 'symlink'; oid: string; exec: boolean };

async function currentStates(run: ProcessRunner, checkout: string, fmt: ObjectFormat, paths: string[]): Promise<Map<string, CurState>> {
  const out = new Map<string, CurState>();
  const files: string[] = [];
  const modes = new Map<string, boolean>();
  for (const p of paths) {
    let abs: string;
    try {
      abs = ensureSafeParents(checkout, p, { create: false });
    } catch {
      out.set(p, { kind: 'blocked' });
      continue;
    }
    const s = leafState(abs);
    if (s === 'absent') out.set(p, { kind: 'absent' });
    else if (s === 'symlink') out.set(p, { kind: 'symlink', oid: blobOid(fmt, Buffer.from(readlinkSync(abs))), exec: false });
    else if (s === 'file') {
      files.push(p);
      modes.set(p, (lstatSync(abs).mode & 0o111) !== 0);
    } else out.set(p, { kind: 'blocked' });
  }
  if (files.length) {
    const hashed = (await gitOut(run, checkout, ['hash-object', '--stdin-paths'], { input: Buffer.from(files.join('\n') + '\n') })).split('\n');
    files.forEach((p, i) => out.set(p, { kind: 'file', oid: hashed[i], exec: modes.get(p)! }));
  }
  return out;
}

function matches(cur: CurState | undefined, oid: string | null, mode: string | null): boolean {
  if (!cur || cur.kind === 'blocked') return false;
  if (!oid) return cur.kind === 'absent';
  if (cur.kind === 'absent') return false;
  if (mode === '120000') return cur.kind === 'symlink' && cur.oid === oid;
  return cur.kind === 'file' && cur.oid === oid && cur.exec === (mode === '100755');
}

async function writeBlobTo(run: ProcessRunner, cwd: string, oid: string, root: string, rel: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  const abs = freeConflictTarget(root, rel);
  const tmp = tempSibling(abs);
  const ws = createWriteStream(tmp, { mode: 0o600 });
  try {
    await git(run, cwd, ['cat-file', 'blob', oid], { stdoutTo: ws });
    await new Promise<void>((res, rej) => { ws.once('error', rej); ws.end(() => res()); });
    renameSync(tmp, abs);
  } catch (err) {
    ws.destroy();
    rmSync(tmp, { force: true });
    throw err;
  }
}

async function checkoutPaths(run: ProcessRunner, checkout: string, tree: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const tmpIndex = join(await gitDir(run, checkout), `handsfree-apply-${process.pid}-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(run, checkout, ['read-tree', tree], { env });
    await git(run, checkout, ['checkout-index', '-f', '-q', '-z', '--stdin'], { env, input: Buffer.from(paths.join('\0') + '\0') });
  } finally {
    rmSync(tmpIndex, { force: true });
    rmSync(tmpIndex + '.lock', { force: true });
  }
}

/**
 * Apply a {@link WorktreePlan} to the checkout. Compare-and-write at write time: a path
 * already holding the new content is done; one still holding the previous content is
 * written (after a backup); anything else is a conflict (`policy: 'conflict'`) or is
 * overwritten (`'overwrite'`, the cloud mirror). Idempotent on replay.
 */
export async function applyWorktreePlan(
  run: ProcessRunner,
  plan: WorktreePlan,
  ctx: { backup: BackupStore; conflictsDir: string; policy: 'conflict' | 'overwrite' },
): Promise<WorktreeApplyResult> {
  // D20: only a plan stamped by planWorktree from a non-tolerant snapshot is ever applied
  // (also covers a hand-built plan and a journal op written before the stamp existed).
  if ((plan as { fromTolerant?: unknown })?.fromTolerant !== false) throw new HandsfreeRefusal('bad_snapshot', TOLERANT_REFUSAL);
  const { checkout } = plan;
  const res: WorktreeApplyResult = { written: [], deleted: [], conflicts: [], alreadyDone: [], refused: [...plan.refused], verifyMismatch: [] };
  const toConflict = async (path: string, reason: string, oid: string | null) => {
    if (oid) await writeBlobTo(run, checkout, oid, ctx.conflictsDir, path);
    res.conflicts.push({ path, reason });
  };
  for (const c of plan.conflicts) await toConflict(c.path, c.reason, c.newOid);

  // Compare-and-write classification at write time.
  const classify = async (entries: WorktreeEntry[]): Promise<WorktreeEntry[]> => {
    const cur = await currentStates(run, checkout, plan.objectFormat, entries.map((e) => e.path));
    const ok: WorktreeEntry[] = [];
    for (const e of entries) {
      const s = cur.get(e.path);
      if (matches(s, e.newOid, e.newMode)) { res.alreadyDone.push(e.path); continue; }
      if (s?.kind === 'blocked') { await toConflict(e.path, 'target blocked (symlinked parent, directory or different spelling)', e.newOid); continue; }
      if (ctx.policy === 'conflict' && !matches(s, e.prevOid, e.prevMode)) {
        await toConflict(e.path, 'changed on the laptop since the snapshot; kept', e.newOid);
        continue;
      }
      ok.push(e);
    }
    return ok;
  };

  // Deletions first, and only then look at additions: a case-only rename's new spelling
  // answers lstat through the old one until the old one is gone.
  for (const e of await classify(plan.entries.filter((x) => x.action === 'delete'))) {
    const abs = ensureSafeParents(checkout, e.path, { create: false });
    ctx.backup.saveBefore(checkout, e.path, 'deleted');
    rmSync(abs, { force: true });
    pruneEmptyParents(checkout, e.path);
    res.deleted.push(e.path);
  }
  const go = await classify(plan.entries.filter((x) => x.action !== 'delete'));

  const created = new Set<string>();
  // Roll back compares a created file with what was really written: the sha256 of the bytes
  // read back right after checkout (an eol/autocrlf filter changes them; LFS is out of scope).
  const refineCreated = (paths: string[]) => {
    for (const rel of paths) {
      if (!created.has(rel)) continue;
      try {
        const abs = ensureSafeParents(checkout, rel, { create: false });
        const st = lstatSync(abs);
        const bytes = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : st.isFile() ? readFileSync(abs) : null;
        if (bytes) ctx.backup.refineCreate(rel, { sha256: createHash('sha256').update(bytes).digest('hex') });
      } catch { /* not written: the blob-id record stands */ }
    }
  };
  const prepare = async (list: WorktreeEntry[]): Promise<string[]> => {
    const ready: string[] = [];
    for (const e of list) {
      let abs: string;
      try {
        abs = ensureSafeParents(checkout, e.path, { create: true });
      } catch (err) {
        await toConflict(e.path, `parent refused: ${(err as Error).message}`, e.newOid);
        continue;
      }
      const st = leafState(abs);
      if (st === 'dir' || st === 'other' || st === 'differentSpelling') {
        await toConflict(e.path, `target is a ${st === 'differentSpelling' ? 'differently spelled path' : st}`, e.newOid);
        continue;
      }
      if (st === 'absent') {
        ctx.backup.recordCreate(e.path, { gitBlob: e.newOid!, fmt: plan.objectFormat });
        created.add(e.path);
      }
      else ctx.backup.saveBefore(checkout, e.path, 'overwritten');
      ready.push(e.path);
    }
    return ready;
  };

  const linkPaths: string[] = [];
  try {
    const files = await prepare(go.filter((x) => x.action === 'file'));
    await checkoutPaths(run, checkout, plan.newTree, files);
    refineCreated(files);
    res.written.push(...files);

    // Symlinks LAST, one at a time: a failing link is refused, it never aborts the phase.
    for (const e of go.filter((x) => x.action === 'symlink')) {
      try {
        const target = await gitOut(run, checkout, ['cat-file', 'blob', e.newOid!]);
        if (!symlinkTargetInside(e.path, target)) { res.refused.push({ path: e.path, reason: 'symlink target escapes the root' }); continue; }
        const ready = await prepare([e]);
        await checkoutPaths(run, checkout, plan.newTree, ready);
        refineCreated(ready);
        linkPaths.push(...ready);
        res.written.push(...ready);
      } catch (err) {
        res.refused.push({ path: e.path, reason: `symlink not written: ${(err as Error).message}` });
      }
    }
  } finally {
    // ALWAYS, even after a throw: chains and `..` through an existing laptop symlink pass the
    // lexical check, so resolve every placed link physically and undo any that escapes.
    const placedLinks = plan.entries.filter((e) => e.action === 'symlink' && (linkPaths.includes(e.path) || res.alreadyDone.includes(e.path))).map((e) => e.path);
    const escaped = sweepEscapingSymlinks(checkout, placedLinks, (rel) => ctx.backup.restoreOne(checkout, rel));
    for (const p of escaped) {
      res.written = res.written.filter((x) => x !== p);
      res.alreadyDone = res.alreadyDone.filter((x) => x !== p);
      res.refused.push({ path: p, reason: 'symlink resolves outside the root' });
    }
  }

  const after = await currentStates(run, checkout, plan.objectFormat, res.written);
  for (const e of go) {
    if (e.action === 'delete' || !res.written.includes(e.path)) continue;
    const s = after.get(e.path);
    if (!s || s.kind === 'absent' || s.kind === 'blocked' || s.oid !== e.newOid) res.verifyMismatch.push(e.path);
  }
  return res;
}

// ---------------------------------------------------------------- worktrees, base, rollback

/**
 * Create a worktree with `--no-checkout` (the filtered writer fills it). The destination
 * MUST come from `allowedNewWorktreePath` (manifest.ts), which applies the go manifest's
 * allowed parents and the [a-z0-9-] leaf rule.
 */
export async function addWorktreeNoCheckout(run: ProcessRunner, repoPath: string, dest: string, commit: string): Promise<void> {
  await git(run, repoPath, ['worktree', 'add', '--no-checkout', '--detach', dest, commit]);
}

/** Replace `refs/handsfree/base/*` (the last agreed snapshot, kept until the next trip seals). */
export async function setBaseRefs(run: ProcessRunner, repoPath: string, refs: Record<string, string>): Promise<void> {
  const old = await readRefs(run, repoPath, [BASE_REF_PREFIX + '/']);
  const lines = Object.keys(old).filter((r) => !(r in refs)).map((r) => `delete ${r}`);
  for (const [r, oid] of Object.entries(refs)) {
    if (!r.startsWith(BASE_REF_PREFIX + '/') || !isWellFormedRef(r)) throw new HandsfreeRefusal('bad_ref', `base ref ${r}`);
    if (old[r] !== oid) lines.push(`update ${r} ${oid}`);
  }
  await updateRefs(run, repoPath, lines);
}

/** Tips the receiver is known to hold (for `createBundle`'s `--not`). */
export async function baseTips(run: ProcessRunner, repoPath: string): Promise<string[]> {
  return [...new Set(Object.values(await readRefs(run, repoPath, [BASE_REF_PREFIX + '/'])))];
}

/** Restore refs + stash from a {@link RefBackup} (Roll back). */
export async function rollbackRefs(run: ProcessRunner, repoPath: string, b: RefBackup): Promise<void> {
  await applyRefs(run, repoPath, b.refs);
  await rebuildStash(run, repoPath, b.stash);
}

// ---------------------------------------------------------------- journal ops

export interface RepoApplyPlan {
  /** Ops for the journal, in order. */
  ops: Array<Pick<JournalOp, 'id' | 'kind' | 'params' | 'writes'>>;
  divergence: Divergence;
  parkReasons: string[];
  /** Incoming checkouts with no local counterpart (wave 2 creates them, then plans again). */
  newCheckouts: string[];
  /** Local checkouts the sender no longer has (reported, never deleted). */
  removedCheckouts: string[];
}

/**
 * Build the journal ops for one repository, computed ONCE (replay never re-diffs).
 *
 * Laptop at Return: `receiverStart` = the laptop's trip-start snapshot, `receiverNow` =
 * a fresh snapshot, `policy: 'conflict'`, `strict: true` (config re-checks).
 * Cloud at go: `receiverStart` = its last agreed snapshot or null (first trip: the empty
 * tree), `receiverNow` = null, `policy: 'overwrite'`.
 */
export async function planRepoApply(
  run: ProcessRunner,
  o: {
    repoPath: string;
    trip: string;
    incoming: RepoSnapshot;
    fetched: Record<string, string>;
    receiverStart: RepoSnapshot | null;
    receiverNow: RepoSnapshot | null;
    /** checkoutId → local checkout path. */
    localCheckouts: Record<string, string>;
    policy: 'conflict' | 'overwrite';
    strict: boolean;
  },
): Promise<RepoApplyPlan> {
  const trip = assertTripId(o.trip);
  if (o.incoming.tolerant) throw new HandsfreeRefusal('bad_snapshot', TOLERANT_REFUSAL);
  const id = (s: string) => `${o.repoPath}#${s}`;
  const parkReasons: string[] = [];
  let div: Divergence = { kind: 'clean' };
  if (o.receiverStart && o.receiverNow) div = divergence(o.receiverStart, o.receiverNow);
  if (div.kind === 'diverged') parkReasons.push(...div.reasons);
  const empty = await emptyTree(run, o.repoPath);
  if (o.strict) {
    for (const c of o.incoming.checkouts) {
      const prev = o.receiverStart?.checkouts.find((x) => x.checkoutId === c.checkoutId)?.worktreeTree ?? empty;
      parkReasons.push(...(await riskyConfigChanges(run, o.repoPath, prev, c.worktreeTree)));
    }
  }
  const newCheckouts = o.incoming.checkouts.filter((c) => !o.localCheckouts[c.checkoutId]).map((c) => c.checkoutId);
  const removedCheckouts = Object.keys(o.localCheckouts).filter((cid) => !o.incoming.checkouts.some((c) => c.checkoutId === cid));

  if (parkReasons.length) {
    // Park EVERY cloud ref, including the ones the bundle omitted (receiver already had them).
    const all: Record<string, string> = { ...o.incoming.refs };
    o.incoming.stash.forEach((e, i) => { all[snapStashRef(trip, i)] = e.oid; });
    for (const c of o.incoming.checkouts) {
      if (c.head.oid) all[`${snapRefPrefix(trip)}/${c.checkoutId}/head`] = c.head.oid;
    }
    Object.assign(all, o.fetched);
    return {
      ops: [{ id: id('park'), kind: 'git.park', writes: false, params: { repoPath: o.repoPath, trip, fetched: all } }],
      divergence: div.kind === 'diverged' ? div : { kind: 'diverged', reasons: parkReasons },
      parkReasons, newCheckouts, removedCheckouts,
    };
  }

  const prevRefs = o.receiverNow?.refs ?? (await readRefs(run, o.repoPath, ['refs/heads', 'refs/tags', 'refs/notes']));
  const prevStash = o.receiverNow?.stash ?? (await readStash(run, o.repoPath));
  const ops: RepoApplyPlan['ops'] = [
    { id: id('backup'), kind: 'git.backup', writes: false, params: { repoPath: o.repoPath, trip } },
    { id: id('refs'), kind: 'git.refs', writes: true, params: { repoPath: o.repoPath, target: o.incoming.refs, prev: prevRefs } },
    { id: id('stash'), kind: 'git.stash', writes: true, params: { repoPath: o.repoPath, target: o.incoming.stash, prev: prevStash } },
  ];
  for (const c of o.incoming.checkouts) {
    const local = o.localCheckouts[c.checkoutId];
    if (!local) continue;
    const startC = o.receiverStart?.checkouts.find((x) => x.checkoutId === c.checkoutId);
    const nowC = o.receiverNow?.checkouts.find((x) => x.checkoutId === c.checkoutId);
    const prevHead = nowC?.head ?? (await readHead(run, local));
    const prevIndex = nowC?.indexTree ?? (await gitOut(run, local, ['write-tree'])).trim();
    const wplan = await planWorktree(run, local, {
      prevTree: startC?.worktreeTree ?? empty,
      newTree: c.worktreeTree,
      nowTree: nowC?.worktreeTree ?? null,
      fromTolerant: o.incoming.tolerant,
    });
    ops.push(
      { id: id(`head:${c.checkoutId}`), kind: 'git.head', writes: true, params: { checkout: local, target: c.head, prev: prevHead } },
      { id: id(`worktree:${c.checkoutId}`), kind: 'git.worktree', writes: true, params: { scope: `git-${c.checkoutId}`, plan: wplan, policy: o.policy } },
      { id: id(`index:${c.checkoutId}`), kind: 'git.index', writes: true, params: { checkout: local, target: c.indexTree, prev: prevIndex } },
    );
  }
  return { ops, divergence: div, parkReasons, newCheckouts, removedCheckouts };
}

/**
 * Journal handlers for the git ops. `tripDir` is `trips/<trip>/` on this machine; backups
 * and conflicts live under it per scope.
 */
export function gitOpHandlers(run: ProcessRunner, o: { tripDir: string }): OpHandlers {
  type P = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = (op: JournalOp) => op.params as P;
  return {
    'git.park': {
      apply: (op) => parkRepo(run, p(op).repoPath, p(op).trip, p(op).fetched),
    },
    'git.backup': {
      apply: (op) => backupRefs(run, p(op).repoPath, p(op).trip),
    },
    'git.refs': {
      isDone: (op) => refsEqual(run, p(op).repoPath, p(op).target),
      apply: (op) => applyRefs(run, p(op).repoPath, p(op).target),
      undo: (op) => applyRefs(run, p(op).repoPath, p(op).prev),
    },
    'git.stash': {
      isDone: (op) => stashEqual(run, p(op).repoPath, p(op).target),
      apply: (op) => rebuildStash(run, p(op).repoPath, p(op).target),
      undo: (op) => rebuildStash(run, p(op).repoPath, p(op).prev),
    },
    'git.head': {
      isDone: (op) => headEqual(run, p(op).checkout, p(op).target),
      apply: (op) => setHead(run, p(op).checkout, p(op).target),
      undo: (op) => setHead(run, p(op).checkout, p(op).prev),
    },
    'git.worktree': {
      apply: (op) => applyWorktreePlan(run, p(op).plan, {
        backup: new BackupStore(backupDir(o.tripDir, p(op).scope)),
        conflictsDir: conflictsDir(o.tripDir, p(op).scope),
        policy: p(op).policy,
      }),
      // The restore result (incl. files KEPT because the owner changed them) becomes the op's
      // `undoResult` for the Roll back receipt.
      undo: async (op) => new BackupStore(backupDir(o.tripDir, p(op).scope)).restore((p(op).plan as WorktreePlan).checkout),
    },
    'git.index': {
      isDone: (op) => indexEqual(run, p(op).checkout, p(op).target),
      apply: (op) => applyIndex(run, p(op).checkout, p(op).target),
      undo: (op) => applyIndex(run, p(op).checkout, p(op).prev),
    },
  };
}
