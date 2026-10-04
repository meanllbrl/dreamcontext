/**
 * Transport 2 apply + the backup store both transports use for Roll back.
 *
 * - Every path goes through the shared guard ({@link ./paths.ts}); parents are lstat- and
 *   realpath-checked at write time; symlinks are written last and only when their target
 *   resolves inside the root.
 * - Files land via temp + fsync + rename, the sha256 and size verified before the rename;
 *   only the exec bit is honoured; the mtime is set.
 * - Compare-and-write: the target must still hold what the plan expected (or already hold
 *   the incoming content, which counts as done), otherwise the incoming copy goes to the
 *   conflicts folder (`policy: 'conflict'`, the laptop) or overwrites (`'overwrite'`, the
 *   cloud mirror).
 * - Backup-before-overwrite into `trips/<trip>/backup/<scope>/` with an fsynced ledger,
 *   so Roll back restores exactly what the return touched and nothing else.
 * - The non-git three-way rule against the trip-start manifest ({@link planNonGitReturn}).
 *
 * Pure fs + stream functions: no server imports, no module state, no uid assumption.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, utimesSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PathGuardError, checkRelPath, detectCollisions, ensureSafeParents, freeConflictTarget, fsyncDir, leafState, resweepRoot, sweepEscapingSymlinks, type OwnedLink, type ResweepResult,
  symlinkTargetInside, tempSibling,
} from './paths.js';
import {
  isNeverTravel, isSecretClass, manifestFromJSON, manifestToJSON, sameContent, sha256Of, type Manifest, type ManifestEntry,
} from './manifest.js';
import { readPack, type PackRecord } from './pack.js';
import { backupDir, conflictsDir, type OpHandlers } from './journal.js';

// ---------------------------------------------------------------- backup store

type LedgerAction = 'created' | 'overwritten' | 'deleted';

/**
 * What a CREATED path will hold once the Return wrote it: Roll back removes it only when it
 * still holds exactly that (a crash before the write, or an owner edit after it, keeps it).
 * `sha256` = the content (file) or link target (symlink); `gitBlob` = the git blob id
 * written by checkout-index (a receiver filter that changed the bytes keeps the file).
 */
export type CreatedExpect = { sha256: string } | { gitBlob: string; fmt: 'sha1' | 'sha256' };

interface LedgerEntry { path: string; action: LedgerAction; at?: number; expect?: CreatedExpect; refine?: boolean }

export const CHANGED_SINCE_WRITE_REASON = 'changed since the Return wrote it, kept';

/** Current content of a file (bytes) or symlink (target), or null when absent/other. */
function currentBytes(abs: string): Buffer | null {
  let st;
  try { st = lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) return Buffer.from(readlinkSync(abs));
  if (st.isFile()) return readFileSync(abs);
  return null;
}

function holdsExpected(abs: string, exp: CreatedExpect | undefined): boolean {
  if (!exp) return false; // no record of what was written: never remove
  const b = currentBytes(abs);
  if (!b) return false;
  if ('sha256' in exp) return createHash('sha256').update(b).digest('hex') === exp.sha256;
  return createHash(exp.fmt === 'sha256' ? 'sha256' : 'sha1').update(`blob ${b.length}\0`).update(b).digest('hex') === exp.gitBlob;
}

/**
 * Backup ledger for one scope (a root id, or a git checkout id) of one trip. Order of
 * operations for every write the return makes: copy the current file into `files/` (once
 * per path: the first copy is the original) → append + fsync a ledger line → write.
 * {@link BackupStore.restore} replays the ledger: originals come back, created paths go.
 *
 * One store = one ATTEMPT. A successful restore moves the whole store aside to an
 * attempt-stamped name (`<dir>.attempt-<ts>-<rand>`, never deleted), so a retried Return
 * starts with an empty ledger: its backups are the laptop state at THAT attempt, and a
 * second Roll back restores that state, not the first attempt's.
 */
export class BackupStore {
  readonly filesDir: string;
  readonly ledgerPath: string;

  constructor(readonly dir: string) {
    this.filesDir = join(dir, 'files');
    this.ledgerPath = join(dir, 'ledger.jsonl');
  }

  private append(path: string, action: LedgerAction, expect?: CreatedExpect): void {
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(this.ledgerPath, 'a', 0o600);
    try {
      writeSync(fd, JSON.stringify({ path, action, at: Date.now(), ...(expect ? { expect } : {}) }) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Record that `rel` is about to be created (it did not exist), with what it will hold. */
  recordCreate(rel: string, expect: CreatedExpect): void {
    this.append(rel, 'created', expect);
  }

  /**
   * Replace what a CREATED path is expected to hold with the sha256 of the bytes actually on
   * disk right after the write (a checkout through an eol/autocrlf conversion never matches
   * the git blob id). Appended after the write: a crash before it keeps the blob-id record.
   */
  refineCreate(rel: string, expect: { sha256: string }): void {
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(this.ledgerPath, 'a', 0o600);
    try {
      writeSync(fd, JSON.stringify({ path: rel, action: 'created', at: Date.now(), expect, refine: true }) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Copy the current `root/rel` (file or symlink) into the store, then record it. */
  saveBefore(root: string, rel: string, action: 'overwritten' | 'deleted'): void {
    const src = join(root, ...rel.split('/'));
    mkdirSync(this.filesDir, { recursive: true });
    const dest = ensureSafeParents(this.filesDir, rel, { create: true });
    if (!existsSyncNoFollow(dest)) {
      const st = lstatSync(src);
      const tmp = tempSibling(dest);
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), tmp);
      else {
        copyFileSync(src, tmp);
        chmodSync(tmp, st.mode & 0o777);
        utimesSync(tmp, st.atime, st.mtime);
      }
      renameSync(tmp, dest);
      fsyncDir(dirname(dest));
    }
    this.append(rel, action);
  }

  entries(): LedgerEntry[] {
    let text = '';
    try { text = readFileSync(this.ledgerPath, 'utf8'); } catch { return []; }
    const out: LedgerEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (checkRelPath(e.path).ok && ['created', 'overwritten', 'deleted'].includes(e.action)) out.push(e);
      } catch { /* a torn last line: the write after it never happened */ }
    }
    return out;
  }

  /** Undo everything recorded, newest path state first. Idempotent. */
  restore(root: string): { restored: string[]; removed: string[]; kept: Conflict[] } {
    const first = this.firstActions();
    const restored: string[] = [];
    const removed: string[] = [];
    const kept: Conflict[] = [];
    // Deepest paths first so a created directory chain empties before its parents.
    const paths = [...first.keys()].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
    for (const rel of paths) {
      const r = this.undoPath(root, rel, first.get(rel)!);
      if (r === 'restored') restored.push(rel);
      else if (r === 'removed') removed.push(rel);
      else if (r === 'kept') kept.push({ path: rel, reason: CHANGED_SINCE_WRITE_REASON });
    }
    // This attempt is undone: move it aside (kept forever) so the next attempt starts empty.
    if (existsSyncNoFollow(this.dir)) {
      renameSync(this.dir, `${this.dir}.attempt-${Date.now()}-${randomBytes(4).toString('hex')}`);
    }
    return { restored, removed, kept };
  }

  /**
   * Links THIS attempt wrote under `root` (created or overwritten, and still symlinks on
   * disk), for {@link resweepRoot}. `order` = write time, then ledger position.
   */
  ownedLinks(root: string): OwnedLink[] {
    const out: OwnedLink[] = [];
    this.entries().forEach((e, i) => {
      if (e.action === 'deleted') return;
      try {
        if (!lstatSync(join(root, ...e.path.split('/'))).isSymbolicLink()) return;
      } catch {
        return;
      }
      out.push({ rel: e.path, order: (e.at ?? 0) * 1e6 + i, undo: () => this.restoreOne(root, e.path) });
    });
    return out;
  }

  /** Undo ONE path: its original comes back, or it is removed when the ledger says created. */
  restoreOne(root: string, rel: string): void {
    const action = this.firstActions().get(rel);
    if (action) this.undoPath(root, rel, action);
  }

  private firstActions(): Map<string, LedgerEntry> {
    const first = new Map<string, LedgerEntry>();
    for (const e of this.entries()) {
      const f = first.get(e.path);
      if (!f) { if (!e.refine) first.set(e.path, e); continue; }
      // A refinement of the create record: what the file actually held after the write.
      if (e.refine && f.action === 'created' && e.expect) first.set(e.path, { ...f, expect: e.expect });
    }
    return first;
  }

  private undoPath(root: string, rel: string, entry: LedgerEntry): 'restored' | 'removed' | 'kept' | null {
    const action = entry.action;
    {
      if (action === 'created') {
        const abs = ensureSafeParents(root, rel, { create: false });
        const state = existsSyncNoFollow(abs) ? leafState(abs) : 'absent';
        if (state === 'file' || state === 'symlink') {
          // Only what the Return itself wrote is removed; anything else stays and is listed.
          if (!holdsExpected(abs, entry.expect)) return 'kept';
          rmSync(abs, { force: true });
          pruneEmptyParents(root, rel);
          return 'removed';
        }
        return null;
      }
      const saved = join(this.filesDir, ...rel.split('/'));
      if (!existsSyncNoFollow(saved)) return null;
      const abs = ensureSafeParents(root, rel, { create: true });
      const state = existsSyncNoFollow(abs) ? leafState(abs) : 'absent';
      if (state === 'dir' || state === 'other' || state === 'differentSpelling') {
        throw new PathGuardError('restore_blocked', rel, `cannot restore ${rel}: something else is in its place`);
      }
      const st = lstatSync(saved);
      const tmp = tempSibling(abs);
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(saved), tmp);
      else {
        copyFileSync(saved, tmp);
        chmodSync(tmp, st.mode & 0o777);
        utimesSync(tmp, st.atime, st.mtime);
      }
      renameSync(tmp, abs);
      return 'restored';
    }
  }
}

function existsSyncNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Remove now-empty parent dirs of `rel` up to (not including) the root. */
export function pruneEmptyParents(root: string, rel: string): void {
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    try {
      rmdirSync(join(root, ...parts.slice(0, i)));
    } catch {
      return; // not empty (or gone): stop
    }
  }
}

// ---------------------------------------------------------------- three-way plan

export interface Conflict { path: string; reason: string }

export interface NonGitPlan {
  /** Cloud version lands on the laptop. */
  write: string[];
  /**
   * Deletions to apply. Only {@link planMirror} (go, laptop → cloud) fills it; D20: a
   * Return plan ({@link planNonGitReturn}) never deletes anything on the laptop.
   */
  delete: string[];
  /** Laptop keeps its state; the cloud copy (when it has one) goes to conflicts/. */
  conflicts: Conflict[];
  /** Never applied (dreamcontext's own credentials, guard-refused paths). */
  refused: Conflict[];
  /**
   * Secret-class paths in `write`/`delete` where the CLOUD WINS (D16): applied even when
   * the laptop copy changed too, with no compare-and-write against the laptop. Absent in
   * plans made before D16 (treated as empty).
   */
  cloudWins?: string[];
  /**
   * D16: secret-class paths ABSENT in the cloud. The cloud wipes the secret class on every
   * Return, so absence means "wiped", never "deleted": the laptop copy is left untouched
   * and the name is reported as not returned.
   */
  notReturned?: string[];
  /**
   * D20: non-git paths present at trip start and absent in the cloud. Listed in the receipt
   * as 'deleted on the phone, kept here'; the laptop copy is untouched (the owner deletes it
   * by hand).
   */
  deletedInCloud?: string[];
}

export const DELETED_IN_CLOUD_REASON = 'deleted on the phone, kept here';

/**
 * The non-git three-way rule (AC8) against the TRIP-START manifest:
 *  - D20: the plan NEVER deletes on the laptop. A path present at trip start and absent in
 *    the cloud (deleted on the phone, wiped, unreadable, not sent, replaced by a refused
 *    link, …) goes to `deletedInCloud` and the laptop copy is untouched;
 *  - only the cloud changed a path → apply the cloud's version;
 *  - both changed it (to different content), the cloud deleted what the laptop modified,
 *    or the laptop deleted what the cloud changed → the laptop keeps its state, the cloud
 *    copy goes to conflicts;
 *  - D16: a secret-class file (`.env*`, `*.pem`, …) PRESENT and changed in the cloud COMES
 *    HOME and the cloud wins, even over a laptop change (no conflicts parking); the laptop
 *    copy is backed up first by the apply. Listed in `cloudWins`. One ABSENT in the cloud
 *    (wiped) never deletes the laptop copy: listed in `notReturned`;
 *  - dreamcontext's own credential files never travel and are refused.
 */
export function planNonGitReturn(
  start: Manifest,
  laptopNow: Manifest,
  cloud: Manifest,
  /**
   * Paths the CLOUD's walk/selection refused or could not send (its `refused` list). Belt
   * and braces (D19 amended): such a path is NEVER read as "deleted in the cloud"; it is
   * listed in `refused` and the laptop copy stays untouched. REQUIRED (pass [] when none).
   */
  cloudRefused: Iterable<string>,
): NonGitPlan {
  const notSent = [...cloudRefused];
  // A refused cloud DIR (unreadable) covers everything under it.
  const isNotSent = (p: string) => notSent.some((r) => r === '.' || p === r || p.startsWith(r + '/'));
  const plan: NonGitPlan = { write: [], delete: [], conflicts: [], refused: [], cloudWins: [], notReturned: [], deletedInCloud: [] };
  const all = new Set([...start.keys(), ...laptopNow.keys(), ...cloud.keys()]);
  for (const p of [...all].sort()) {
    const s = start.get(p);
    const l = laptopNow.get(p);
    const c = cloud.get(p);
    const cloudChanged = !sameContent(s, c);
    if (!cloudChanged) continue;
    if (isNeverTravel(p)) { plan.refused.push({ path: p, reason: 'dreamcontext credential file never travels' }); continue; }
    const c2 = checkRelPath(p);
    if (!c2.ok) { plan.refused.push({ path: p, reason: `path refused (${c2.reason})` }); continue; }
    if (!c && isNotSent(p)) { plan.refused.push({ path: p, reason: 'not sent by the cloud; laptop copy kept' }); continue; }
    if (c?.type === 'symlink' && !symlinkTargetInside(p, c.linkTarget ?? '')) {
      // D18/D19: a non-canonical or escaping cloud link is never written; the laptop keeps its own.
      plan.refused.push({ path: p, reason: 'symlink target escapes the root' });
      continue;
    }
    if (isSecretClass(p)) {
      if (!c) { if (l) plan.notReturned!.push(p); continue; } // wiped, not deleted
      if (sameContent(l, c)) continue; // already what the cloud has
      plan.write.push(p);
      plan.cloudWins!.push(p);
      continue;
    }
    if (!c) {
      // D20: never a deletion. Kept here (whether or not the laptop changed it).
      if (l) plan.deletedInCloud!.push(p);
      continue;
    }
    const laptopChanged = !sameContent(s, l);
    if (laptopChanged) {
      if (sameContent(l, c)) continue; // converged on both sides
      plan.conflicts.push({ path: p, reason: !l ? 'deleted on the laptop, changed in the cloud' : 'changed on both sides' });
      continue;
    }
    plan.write.push(p);
  }
  // Case/normalization collisions across the incoming set and against the laptop's paths
  // (nothing is deleted on Return, so every laptop path keeps its spelling).
  const coll = detectCollisions(plan.write, laptopNow.keys(), []);
  for (const [p, reason] of coll.conflicts) plan.conflicts.push({ path: p, reason });
  plan.write = coll.ok;
  plan.cloudWins = plan.cloudWins!.filter((p) => !coll.conflicts.has(p));
  return plan;
}

/** Mirror plan (the cloud receiving at go): make `receiverNow` equal `incoming`. */
export function planMirror(receiverNow: Manifest, incoming: Manifest): NonGitPlan {
  const plan: NonGitPlan = { write: [], delete: [], conflicts: [], refused: [] };
  for (const [p, e] of incoming) {
    if (isNeverTravel(p)) { plan.refused.push({ path: p, reason: 'dreamcontext credential file never travels' }); continue; }
    if (!sameContent(receiverNow.get(p), e)) plan.write.push(p);
  }
  for (const p of receiverNow.keys()) if (!incoming.has(p) && !isNeverTravel(p)) plan.delete.push(p);
  const coll = detectCollisions(plan.write, receiverNow.keys(), plan.delete);
  for (const [p, reason] of coll.conflicts) plan.conflicts.push({ path: p, reason });
  plan.write = coll.ok.sort();
  plan.delete.sort();
  return plan;
}

// ---------------------------------------------------------------- apply

export interface ApplyContext {
  /** Absolute local root (derived by the caller from the laptop's go manifest by root id). */
  root: string;
  plan: NonGitPlan;
  /** What the receiver held when the plan was made (compare-and-write). */
  expected: Manifest;
  /** The sender's manifest: every pack record must match its entry exactly. */
  incoming: Manifest;
  conflictsDir: string;
  backup: BackupStore;
  policy: 'conflict' | 'overwrite';
  /** Decompressed cap for this pack: the trip estimate (required, no default). */
  maxBytes: number;
}

export interface ApplyResult {
  written: string[];
  deleted: string[];
  conflicts: Conflict[];
  /** Already held the incoming content (a replay after a crash). */
  alreadyDone: string[];
  refused: Conflict[];
  /**
   * Secret-class paths this apply wrote or deleted (D16), by NAME only: the receipt reads
   * this and never gets contents or diffs.
   */
  secrets: string[];
  /** D16: secret-class names the cloud no longer had (wiped); laptop copies untouched. */
  notReturned: string[];
  /** D20: non-git paths the cloud no longer has; kept here, listed for the receipt. */
  deletedInCloud: string[];
}

/** The receiver's current entry for `rel` (no hashing unless it is a regular file). */
async function currentEntry(root: string, rel: string): Promise<ManifestEntry | undefined | 'blocked'> {
  let abs: string;
  try {
    abs = ensureSafeParents(root, rel, { create: false });
  } catch {
    return 'blocked';
  }
  const state = leafState(abs);
  if (state === 'absent') return undefined;
  if (state === 'dir' || state === 'other' || state === 'differentSpelling') return 'blocked';
  const st = lstatSync(abs);
  if (state === 'symlink') {
    const t = readlinkSync(abs);
    return { path: rel, type: 'symlink', size: Buffer.byteLength(t), mode: 0o120777, mtimeMs: Math.trunc(st.mtimeMs), sha256: sha256Of(t), linkTarget: t };
  }
  const h = createHash('sha256');
  for await (const c of createReadStream(abs)) h.update(c as Buffer);
  return { path: rel, type: 'file', size: st.size, mode: st.mode & 0o777, mtimeMs: Math.trunc(st.mtimeMs), sha256: h.digest('hex') };
}

function newFileMode(entry: ManifestEntry, existingMode: number | null): number {
  const exec = (entry.mode & 0o111) !== 0;
  // Only the exec bit is honoured; never grant group/other access the receiver did not
  // already have (a new file is private unless the sender's was readable by others).
  const base = existingMode !== null ? existingMode & 0o666 : (entry.mode & 0o044 ? 0o644 : 0o600);
  return exec ? base | ((base & 0o444) >> 2) : base;
}

async function streamToTemp(
  abs: string,
  body: AsyncIterable<Buffer>,
  entry: ManifestEntry,
  mode: number,
): Promise<string> {
  const tmp = tempSibling(abs);
  const fd = openSync(tmp, 'wx', 0o600);
  const h = createHash('sha256');
  let n = 0;
  try {
    for await (const chunk of body) {
      h.update(chunk);
      n += chunk.length;
      let off = 0;
      while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
    }
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  if (n !== entry.size || h.digest('hex') !== entry.sha256) {
    rmSync(tmp, { force: true });
    throw new PathGuardError('sha256_mismatch', entry.path, `pack body for ${entry.path} does not match its sha256/size`);
  }
  chmodSync(tmp, mode);
  const t = new Date(entry.mtimeMs);
  utimesSync(tmp, t, t);
  return tmp;
}

async function writeConflictCopy(conflictsDir: string, rel: string, body: AsyncIterable<Buffer> | null, entry: ManifestEntry): Promise<void> {
  mkdirSync(conflictsDir, { recursive: true });
  const abs = freeConflictTarget(conflictsDir, rel);
  const data: AsyncIterable<Buffer> = body ?? (async function* () { yield Buffer.from(entry.linkTarget ?? ''); })();
  const asFile: ManifestEntry = entry.type === 'symlink'
    ? { ...entry, type: 'file', size: Buffer.byteLength(entry.linkTarget ?? ''), mode: 0o600 }
    : entry;
  const tmp = await streamToTemp(abs, data, asFile, 0o600);
  renameSync(tmp, abs);
}

/**
 * Apply one root's pack (opened by `openPack`, e.g. a file under `trips/<trip>/`) under
 * the plan. Idempotent: a re-run after a crash finds already-written targets holding the
 * incoming content and counts them as done.
 */
export async function applyPack(openPack: () => NodeJS.ReadableStream, ctx: ApplyContext): Promise<ApplyResult> {
  const res: ApplyResult = { written: [], deleted: [], conflicts: [], alreadyDone: [], refused: [...ctx.plan.refused], secrets: [], notReturned: [...(ctx.plan.notReturned ?? [])], deletedInCloud: [...(ctx.plan.deletedInCloud ?? [])] };
  // D16: secret-class paths where the cloud wins (no compare-and-write against the laptop).
  const cloudWins = new Set(ctx.plan.cloudWins ?? []);
  const mustMatch = (rel: string) => ctx.policy === 'conflict' && !cloudWins.has(rel);
  const writeSet = new Set(ctx.plan.write);
  const conflictSet = new Map(ctx.plan.conflicts.map((c) => [c.path, c.reason]));
  const conflict = (path: string, reason: string) => res.conflicts.push({ path, reason });

  // 1. Deletions first (case-only renames need the old spelling gone before the add).
  for (const rel of ctx.plan.delete) {
    if (ctx.policy === 'conflict') {
      // D20 hard guard: the laptop side never deletes a non-git file, whatever the plan says.
      if (!res.deletedInCloud.includes(rel)) res.deletedInCloud.push(rel);
      continue;
    }
    if (isNeverTravel(rel)) { res.refused.push({ path: rel, reason: 'dreamcontext credential file never travels' }); continue; }
    const cur = await currentEntry(ctx.root, rel);
    if (cur === undefined) { res.alreadyDone.push(rel); continue; }
    if (cur === 'blocked') { conflict(rel, 'cannot delete: path blocked'); continue; }
    // Only the cloud mirror (policy 'overwrite', go) reaches here: it mirrors the laptop's deletions.
    const abs = ensureSafeParents(ctx.root, rel, { create: false });
    ctx.backup.saveBefore(ctx.root, rel, 'deleted');
    rmSync(abs, { force: true });
    pruneEmptyParents(ctx.root, rel);
    res.deleted.push(rel);
  }

  // 2. Files streamed in order; symlinks deferred to the end.
  const symlinks: ManifestEntry[] = [];
  const seen = new Set<string>();
  const handle = async (rec: PackRecord): Promise<void> => {
    if (rec.kind === 'delete') return; // deletions come from the plan
    const e = rec.entry;
    if (seen.has(e.path)) throw new PathGuardError('duplicate', e.path, `pack lists ${e.path} twice`);
    seen.add(e.path);
    if (isNeverTravel(e.path)) {
      res.refused.push({ path: e.path, reason: 'dreamcontext credential file never travels' });
      writeSet.delete(e.path);
      return;
    }
    const want = ctx.incoming.get(e.path);
    if (!want || !sameContent(want, e) || want.size !== e.size) {
      res.refused.push({ path: e.path, reason: 'pack record does not match the sender manifest' });
      return;
    }
    if (conflictSet.has(e.path)) {
      await writeConflictCopy(ctx.conflictsDir, e.path, e.type === 'file' ? rec.body : null, e);
      conflict(e.path, conflictSet.get(e.path)!);
      conflictSet.delete(e.path);
      return;
    }
    if (!writeSet.has(e.path)) return;
    if (e.type === 'symlink') { symlinks.push(e); return; }
    await applyOne(e, rec.body);
  };

  const applyOne = async (e: ManifestEntry, body: AsyncIterable<Buffer> | null): Promise<void> => {
    const cur = await currentEntry(ctx.root, e.path);
    if (cur !== 'blocked' && sameContent(cur, e)) {
      res.alreadyDone.push(e.path);
      if (cloudWins.has(e.path)) res.secrets.push(e.path); // a replay still reports it
      return;
    }
    const expected = ctx.expected.get(e.path);
    if (ctx.policy === 'conflict' && cur !== undefined && cur !== 'blocked' && expected === undefined) {
      // D20/D19 over D16: the laptop holds something here that is in no manifest (it stayed
      // home under D19, or was never selected): never overwrite it, cloud-wins included.
      await writeConflictCopy(ctx.conflictsDir, e.path, body, e);
      conflict(e.path, 'the laptop copy stayed home; cloud copy kept in conflicts');
      return;
    }
    if (cur === 'blocked' || (mustMatch(e.path) && !sameContent(cur, expected))) {
      await writeConflictCopy(ctx.conflictsDir, e.path, body, e);
      conflict(e.path, cur === 'blocked' ? 'target blocked (directory, other type or different spelling)' : 'changed on the laptop since the plan; kept');
      return;
    }
    if (e.type === 'symlink' && !symlinkTargetInside(e.path, e.linkTarget ?? '')) {
      res.refused.push({ path: e.path, reason: 'symlink target escapes the root' });
      return;
    }
    const abs = ensureSafeParents(ctx.root, e.path, { create: true });
    const existingMode = cur ? (cur.type === 'file' ? cur.mode : null) : null;
    let tmp: string;
    if (e.type === 'symlink') {
      tmp = tempSibling(abs);
      symlinkSync(e.linkTarget!, tmp);
    } else {
      tmp = await streamToTemp(abs, body!, e, newFileMode(e, existingMode));
    }
    try {
      if (cur) ctx.backup.saveBefore(ctx.root, e.path, 'overwritten');
      else ctx.backup.recordCreate(e.path, { sha256: e.sha256 });
      // Re-check the parent chain right before the rename (a planted symlink since).
      ensureSafeParents(ctx.root, e.path, { create: false });
      renameSync(tmp, abs);
      fsyncDir(dirname(abs));
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    res.written.push(e.path);
    if (cloudWins.has(e.path)) res.secrets.push(e.path);
  };

  try {
    await readPack(openPack(), handle, { maxBytes: ctx.maxBytes });

    // 3. Symlinks LAST, after every regular file. One failing link (ENAMETOOLONG, a blocked
    //    conflict copy, …) is refused; it never aborts the phase.
    for (const e of symlinks.sort((a, b) => (a.path < b.path ? -1 : 1))) {
      try {
        await applyOne(e, null);
      } catch (err) {
        res.refused.push({ path: e.path, reason: `symlink not written: ${(err as Error).message}` });
      }
    }
  } finally {
    // ALWAYS (even when the pack or a write threw): a chain of individually-contained links,
    // or a `..` through an existing laptop symlink, can still land outside. Resolve every
    // link this apply placed physically and undo any that escapes.
    const placed = new Set([...res.written, ...res.alreadyDone]);
    const escaped = sweepEscapingSymlinks(ctx.root, symlinks.map((e) => e.path).filter((p) => placed.has(p)), (rel: string) => ctx.backup.restoreOne(ctx.root, rel));
    for (const p of escaped) {
      res.written = res.written.filter((x) => x !== p);
      res.alreadyDone = res.alreadyDone.filter((x) => x !== p);
      res.secrets = res.secrets.filter((x) => x !== p);
      res.refused.push({ path: p, reason: 'symlink resolves outside the root' });
    }
  }

  // Planned writes/conflicts the pack never carried.
  for (const p of writeSet) if (!seen.has(p)) res.refused.push({ path: p, reason: 'missing from the pack' });
  for (const [p, reason] of conflictSet) conflict(p, reason); // cloud deleted / no cloud copy
  return res;
}

// ---------------------------------------------------------------- journal op

export interface FilesApplyParams {
  /** Local root (from the laptop's go manifest by root id). */
  root: string;
  /** Backup/conflicts scope, normally the root id. */
  scope: string;
  /** The downloaded pack under trips/<trip>/ (Return downloads everything first). */
  packPath: string;
  plan: NonGitPlan;
  expected: ManifestEntry[];
  incoming: ManifestEntry[];
  policy: 'conflict' | 'overwrite';
  /** Decompressed cap (the trip estimate): required, there is no default. */
  maxBytes: number;
}

/** Plain-data op params for one root's non-git apply (stored in the journal). */
export function filesApplyParams(p: Omit<FilesApplyParams, 'expected' | 'incoming'> & { expected: Manifest; incoming: Manifest }): FilesApplyParams {
  return { ...p, expected: manifestToJSON(p.expected), incoming: manifestToJSON(p.incoming) };
}

/** Journal handlers for `files.apply` (idempotent apply; undo = restore from the backup store). */
export function fileOpHandlers(o: { tripDir: string }): OpHandlers {
  const store = (scope: string) => new BackupStore(backupDir(o.tripDir, scope));
  return {
    'files.apply': {
      apply: async (op) => {
        const p = op.params as FilesApplyParams;
        return applyPack(() => createReadStream(p.packPath), {
          root: p.root,
          plan: p.plan,
          expected: manifestFromJSON(p.expected),
          incoming: manifestFromJSON(p.incoming),
          conflictsDir: conflictsDir(o.tripDir, p.scope),
          backup: store(p.scope),
          policy: p.policy,
          maxBytes: p.maxBytes,
        });
      },
      // The restore result (restored / removed / KEPT because the owner changed a file since
      // the Return wrote it) rides on the op as `undoResult`, so the Roll back receipt lists it.
      undo: async (op) => {
        const p = op.params as FilesApplyParams;
        return store(p.scope).restore(p.root);
      },
    },
  };
}

/**
 * D18 whole-root re-sweep with this Return's backup ledgers: call it once BOTH transports
 * have finished a root. `linkRels` = every symlink of the root (the new worktree tree's
 * 120000 entries + the non-git manifest's symlinks, pre-existing ones included); `stores`
 * = this Return's backup stores for the root (the non-git scope and the git checkout
 * scope). Only links those ledgers recorded are ever undone (newest first); an escape
 * without them is reported in `escaping` and the laptop is left untouched.
 */
export function resweepRootWithBackups(root: string, linkRels: string[], stores: BackupStore[]): ResweepResult {
  return resweepRoot(root, linkRels, stores.flatMap((s) => s.ownedLinks(root)));
}
