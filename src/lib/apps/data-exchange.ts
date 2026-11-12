/**
 * THE one module through which app data touches git (app-veri-ortak plan r6, K5, K6, K7).
 *
 * The one invariant: git's general operations (the sync's stage, the merge) never touch `apps/`.
 * App data enters and leaves the index only here, in four steps the sync engine calls:
 *
 *  - OUTBOUND {@link stageOutbound}: each registered app's shared set (data-share.ts `sharedSet`:
 *    declared shared ∩ owner-approved − local − excluded, K4 passed, no open conflict) is
 *    force-added where it changed or is new; a tombstoned (K6) tracked shared path is
 *    `git rm --cached`. Nothing else under `apps/` is touched in the index. In-tree brains and a
 *    brain with cloud sync off stage nothing (the mode condition).
 *  - BEFORE A NEW MERGE {@link prepareAppPull} (+ {@link parkBeforeMerge}): the pull record is
 *    written FIRST (every door of the app closes on it: `appPullHeld`), the running backend is
 *    stopped through the server, the data is backed up, and every incoming path whose disk state
 *    differs from HEAD (or an untracked local file in the way) is MOVED to the park, so git never
 *    stops the merge with "would be overwritten". The record goes `merged` before the merge runs.
 *  - THE DECISION {@link planSettle}: right after the merge, per touched path, by THIS Mac's
 *    declaration; written into the record, touching neither disk nor index, so `git merge --abort`
 *    always runs clean.
 *  - AFTER THE MERGE ENDED {@link finishAppPull}: only with no MERGE_HEAD (checked here, never
 *    trusted from `abortMerge`). Committed (the merge sha is an ancestor of HEAD): the plan is
 *    applied and the park put back; aborted: only the park goes back (the team's copy never
 *    landed). Then the record goes and the app's doors open.
 *
 * Crash recovery {@link recoverAppPulls} runs only while this process holds the brain lock, so a
 * live sync's record is never touched. The rule (K5 "Kural"), per `apps/<slug>/<path>` the merge
 * touched: installed + shared here → the team's copy lands (mine parked or both committed → mine
 * back, theirs to the conflict store, the path `conflict`); installed + not shared here → the
 * team's copy goes off disk into the store (it stays in the index and the commit; absence is not
 * a delete), mine back; not installed → it lands (mine parked → mine back, theirs stored).
 */

import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, appendFileSync, renameSync, unlinkSync, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { brainPrefix, moveFileAcross } from '../agents/agent-sync.js';
import * as git from '../git-sync/git.js';
import { acquireBrainLock, releaseBrainLock } from '../git-sync/brain-repo.js';
import { readConflictReport } from '../git-sync/conflict-report.js';
import { raiseInboxRow } from '../owner-inbox.js';
import { pauseForSync, resumeAfterSync, type SyncPauseResult } from './client.js';
import { backupAppData, BEFORE_TEAM_PULL, type BackupResult } from './data-backup.js';
import {
  addConflict, appPullHeld, clearKeptOut, containedPath, dropConflictEntries, listConflicts, listKeptOut, listPullRecords, markKeptOut, newStamp, parkDir, parkTarget, pullDir,
  readPullRecord, removePullRecord, writePullRecord,
  type AppPullCtx, type ConflictKind, type FinishAppPullFn, type PlanEntry, type PullRecord, type RecoverAppPullsFn,
} from './data-conflicts.js';
import { capStones, clearTombstones, listTombstones, markSent, setBlocked } from './data-deletes.js';
import { APPS_DATA_FOLDER, checkAppDataChain, ensureAppDataDir, ensureAppsMergeAttributes } from './data-dir.js';
import { appShareView, splitAppPath, teamBlobRefusal, teamHash, type AppShareView } from './data-stage.js';
import { brainShareMode, pathNameRefusal, sharedSet, SHARED_WARN_BYTES, teamSharedBytes, type DataMode, type Held } from './data-share.js';
import { listApps, type AppRecord } from './registry.js';

export type { AppPullCtx } from './data-conflicts.js';

/** {@link AppPullCtx} plus test seams: the brain's share mode instead of its config. */
export interface ExchangeCtx extends AppPullCtx {
  mode?: { fullRepo: boolean; cloudSyncOn: boolean };
}

/** git's empty tree: the base of a pull into a repo with no history in common. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ─── shared plumbing ───────────────────────────────────────────────────────────────

interface Brain { top: string; prefix: string; appsDir: string }

/** The repo top and the brain's prefix there, or null when the brain is not in a git repo. */
function brainOf(ctx: AppPullCtx): Brain | null {
  let prefix: string | null;
  try { prefix = brainPrefix(ctx.gitCwd, ctx.contextRoot); } catch { return null; }
  if (prefix === null) return null;
  const top = git.topLevel(ctx.gitCwd);
  if (!top) return null;
  return { top, prefix, appsDir: `${prefix}${APPS_DATA_FOLDER}` };
}

const repoPathOf = (b: Brain, slug: string, rel: string): string => `${b.appsDir}/${slug}/${rel}`;
const dirSpec = (b: Brain, slug: string): string => `:(top,literal)${b.appsDir}/${slug}/`;

function nowOf(ctx: AppPullCtx): number {
  return ctx.nowMs ?? Date.now();
}

function viewOf(ctx: ExchangeCtx, slug: string): AppShareView {
  return appShareView(ctx.projectRoot, slug, { home: ctx.home, ...(ctx.mode ? { mode: ctx.mode } : {}) });
}

function appsHere(ctx: AppPullCtx): AppRecord[] {
  try { return listApps(ctx.home, ctx.projectRoot); } catch { return []; }
}

/** One owner-inbox row per real refusal, deduped `app-data:<slug>:<reason>`. Never throws. */
function inboxRow(ctx: AppPullCtx, slug: string, reason: string, title: string): void {
  try {
    raiseInboxRow(ctx.projectRoot, {
      kind: 'app-data-held', ref: `apps/${slug}`, agent: null, title: title.slice(0, 300),
      actions: ['dismiss'], dedupeKey: `app-data:${slug}:${reason}`,
    }, ctx.home);
  } catch { /* the row is a courtesy */ }
}

/** One line in `~/.dreamcontext/apps/pull/recover.log`. Never throws. */
function logLine(ctx: AppPullCtx, line: string): void {
  try {
    mkdirSync(pullDir(ctx.home), { recursive: true, mode: 0o700 });
    appendFileSync(join(pullDir(ctx.home), 'recover.log'), `${new Date(nowOf(ctx)).toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* best effort */ }
}

function lstatOrNull(p: string): Stats | null {
  try { return lstatSync(p); } catch { return null; }
}

/** Make the folders of `absFile` under `base`, every existing step a real folder (no link followed). */
function mkdirsUnder(base: string, absFile: string): void {
  const root = resolve(base);
  const parts = relative(root, dirname(absFile)).split(sep).filter(Boolean);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    try { mkdirSync(cur, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a real folder`);
  }
}

/**
 * Write the blob `spec` at `abs` atomically (streamed by git into a temp beside it, then a
 * rename), so a blob of any size never sits in memory; a link or file there is replaced.
 */
function writeBlobAtomic(top: string, spec: string, abs: string): void {
  const tmp = join(dirname(abs), `.dc-pull-${randomBytes(4).toString('hex')}`);
  try {
    git.writeBlobToFile(top, spec, tmp);
    chmodSync(tmp, 0o644);
    const st = lstatOrNull(abs);
    if (st && (st.isSymbolicLink() || st.isFile())) rmSync(abs, { force: true });
    renameSync(tmp, abs);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* never made */ }
    throw e;
  }
}

/**
 * Keep the team's blob `spec` in the conflict store, streamed through a temp file in the pull
 * folder (never whole in memory). False when the blob is absent or the store refused.
 */
function storeBlob(ctx: AppPullCtx, top: string, spec: string, hash: string, rel: string, kind: ConflictKind): boolean {
  if (!git.blobId(top, spec)) return false;
  mkdirSync(pullDir(ctx.home), { recursive: true, mode: 0o700 });
  const tmp = join(pullDir(ctx.home), `.blob-${randomBytes(6).toString('hex')}`);
  try {
    git.writeBlobToFile(top, spec, tmp);
    return addConflict(ctx.home, hash, rel, kind, { file: tmp }, nowOf(ctx)).ok;
  } catch {
    return false;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* never made */ }
  }
}

/** Remove now-empty folders from `start` up to (not including) `stop`. */
function pruneEmpty(start: string, stop: string): void {
  let cur = start;
  const end = resolve(stop);
  while (resolve(cur).startsWith(end + sep)) {
    try { if (readdirSync(cur).length) return; rmdirSync(cur); } catch { return; }
    cur = dirname(cur);
  }
}

// ─── OUTBOUND ──────────────────────────────────────────────────────────────────────

/** Held reasons worth a row in the owner inbox (the others are routine or have their own row). */
const REAL_REFUSALS = new Set(['db_file', 'name', 'not_plain', 'host_limit']);

export interface OutboundApp {
  slug: string;
  hash: string;
  mode: DataMode;
  /** Repo-relative paths force-added (or that would be, dry run). */
  add: string[];
  /** Repo-relative paths `git rm --cached` for a tombstone. */
  remove: string[];
  held: Held[];
  /** More than the per-sync cap of unapproved deletes: none of those sent, the owner is asked. */
  deletesAsked: boolean;
}

/**
 * `ran`: the outbound stage owned the index this time (full-repo, cloud sync on, no merge open).
 * When it did not, the caller drops whatever got staged under `apps/` (data-stage.ts
 * `dropStagedAppData`), so app data stays in the index only through this stage's own add.
 */
export interface OutboundResult { add: string[]; remove: string[]; apps: OutboundApp[]; notes: string[]; ran: boolean }

/**
 * OUTBOUND (K5): put this Mac's shared app data into the index; nothing else under `apps/` is
 * touched. `dryRun`: compute only (feeds {@link pendingSharedAppFiles}). Never runs while a merge
 * is open (MERGE_HEAD) or while an app's pull record exists. THROWS only when git refuses the add.
 */
export function stageOutbound(ctx: ExchangeCtx, opts: { dryRun?: boolean } = {}): OutboundResult {
  const out: OutboundResult = { add: [], remove: [], apps: [], notes: [], ran: false };
  const b = brainOf(ctx);
  if (!b) return out;
  if (git.mergeHeadSha(b.top)) return out;
  const mode = ctx.mode ?? brainShareMode(ctx.projectRoot);
  if (!mode.fullRepo || !mode.cloudSyncOn) return out;
  out.ran = true;
  const nowMs = nowOf(ctx);
  const sent: { hash: string; paths: string[] }[] = [];
  for (const rec of appsHere(ctx)) {
    if (appPullHeld(ctx.home, rec.hash)) continue;
    if (!checkAppDataChain(ctx.projectRoot, rec.slug).ok) continue;
    const dataDir = join(b.top, b.appsDir, rec.slug);
    const view = viewOf({ ...ctx, mode }, rec.slug);
    const ss = sharedSet({ projectRoot: ctx.projectRoot, home: ctx.home }, rec, view.decl, view.consent, { mode, dataDir, nowMs });
    const app: OutboundApp = { slug: rec.slug, hash: rec.hash, mode: ss.mode, add: [], remove: [], held: ss.held, deletesAsked: false };
    out.apps.push(app);
    if (ss.mode !== 'shared') {
      // Nothing is sent from this app now: none of its stones waits for the owner.
      judgeStones(ctx, rec.hash, listTombstones(ctx.home, rec.hash, nowMs).map((t) => t.path), nowMs);
      continue;
    }
    const idx = new Map(git.indexEntries(b.top, [dirSpec(b, rec.slug)]).filter((e) => e.stage === 0).map((e) => [e.path, e]));
    const changed = new Set(git.changedInWorktree(b.top, [dirSpec(b, rec.slug)]));
    app.add = ss.paths.map((rel) => repoPathOf(b, rec.slug, rel)).filter((p) => !idx.has(p) || changed.has(p));
    // Which stones this sync can send: the path is tracked, shared from here, and not back on disk.
    // The others are BLOCKED in the store (data-deletes.ts), so the set the owner is shown and
    // approves (`waitingDeletes`) is exactly the set this count calls waiting.
    const all = listTombstones(ctx.home, rec.hash, nowMs);
    const sendable = (t: { path: string }) => idx.has(repoPathOf(b, rec.slug, t.path)) && view.sends(t.path) && !lstatOrNull(join(dataDir, t.path));
    judgeStones(ctx, rec.hash, all.filter((t) => !sendable(t)).map((t) => t.path), nowMs);
    // Approved stones go past the cap; the waiting ones go all together or wait for the owner.
    const cap = capStones(listTombstones(ctx.home, rec.hash, nowMs).filter(sendable));
    app.remove = cap.send.map((rel) => repoPathOf(b, rec.slug, rel));
    app.deletesAsked = cap.ask;
    out.add.push(...app.add);
    out.remove.push(...app.remove);
    // The ask is raised on the dry run too: held deletes leave the tree clean, so a sync that has
    // nothing else to send never stages, and the owner must still hear about them.
    if (cap.ask) {
      out.notes.push(`${rec.name}: ${cap.waiting} deletes waiting for the owner; none of them were sent.`);
      inboxRow(ctx, rec.slug, 'too_many_deletes',
        `${rec.name}: ${cap.waiting} silme ekibe gitmeyi bekliyor; Claude'dan listeyi göstermesini iste (dreamcontext apps data deletes ${rec.slug}), gördüğün sayıyla onayla. / ${cap.waiting} deletes are waiting to go to the team; ask Claude to show them (dreamcontext apps data deletes ${rec.slug}), then approve the number you were shown.`);
    }
    if (opts.dryRun) continue;
    if (cap.send.length) sent.push({ hash: rec.hash, paths: cap.send });
    for (const h of ss.held) {
      if (!REAL_REFUSALS.has(h.reason)) continue;
      inboxRow(ctx, rec.slug, h.reason, h.reason === 'host_limit'
        ? `${rec.name}: ${h.path} stays on this Mac: it is over 100 MB, and GitHub refuses any single file this big. Everything else keeps syncing. Ask Claude to move it to a local folder or split it.`
        : `${rec.name}: ${h.path} stays on this Mac (${h.reason}). Shared app data must be a plain file, not a database, with no dotted or instruction name.`);
    }
  }
  if (!opts.dryRun) {
    if (out.add.length) git.forceAddExact(b.top, out.add);
    if (out.remove.length) git.removeCachedExact(b.top, out.remove);
    // The deletes are staged: their 30-day expiry starts now (a stone never sent never expires).
    for (const x of sent) { try { markSent(ctx.home, x.hash, x.paths, nowMs); } catch { /* the stone stays unsent: it waits */ } }
  }
  return out;
}

/** Record the sync's verdict on an app's stones (data-deletes.ts `setBlocked`). Never throws. */
function judgeStones(ctx: AppPullCtx, hash: string, blockedPaths: string[], nowMs: number): void {
  if (!listTombstones(ctx.home, hash, nowMs).length) return;
  try { setBlocked(ctx.home, hash, blockedPaths, nowMs); } catch { /* the store is busy: the next sync judges */ }
}

/** The `apps/` paths {@link stageOutbound} would add or remove now (its dry run). Never throws. */
export function pendingSharedAppFiles(ctx: AppPullCtx): string[] {
  try {
    const r = stageOutbound(ctx, { dryRun: true });
    return [...r.add, ...r.remove];
  } catch {
    return [];
  }
}

/** After a push reached the remote: drop the tombstones whose path HEAD no longer has. Never throws. */
export function afterAppDataPush(ctx: AppPullCtx): void {
  const b = brainOf(ctx);
  if (!b) return;
  for (const rec of appsHere(ctx)) {
    try {
      const stones = listTombstones(ctx.home, rec.hash, nowOf(ctx));
      const delivered = stones.filter((t) => git.blobId(b.top, `HEAD:${repoPathOf(b, rec.slug, t.path)}`) === null).map((t) => t.path);
      clearTombstones(ctx.home, rec.hash, delivered, nowOf(ctx));
    } catch { /* the next push */ }
  }
}

// ─── THE TEAM'S FILES A LATE APPROVAL MISSED ───────────────────────────────────────

const PLAIN_BLOB_MODES = new Set(['100644', '100755']);

/** What a late approval did to one app: team files brought back, my own files held as two versions. */
export interface RestoredApp {
  slug: string;
  /** Data-folder-relative team files now on this Mac. */
  paths: string[];
  /** My own file differs from the team's at a path just approved: both kept, the owner picks. */
  twoVersions?: string[];
  /** Too much to bring back inline (the Share click): the next sync brings it. */
  deferred?: boolean;
}

/**
 * Create `abs` from the blob `spec` only if nothing is there: streamed into a temp beside it, then
 * hard-linked into place (`link` refuses an existing name), so a file the running app wrote in the
 * meantime is never replaced. False when something got there first. THROWS on any other failure.
 */
function createBlobNoClobber(top: string, spec: string, abs: string, mode: string): boolean {
  const tmp = join(dirname(abs), `.dc-pull-${randomBytes(4).toString('hex')}`);
  try {
    git.writeBlobToFile(top, spec, tmp);
    chmodSync(tmp, mode === '100755' ? 0o755 : 0o644);
    try { linkSync(tmp, abs); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    return true;
  } finally {
    try { unlinkSync(tmp); } catch { /* never made */ }
  }
}

/**
 * A Mac that took the team's files in while its copy of the app did not accept them (an older
 * manifest with no `data`, "Keep it local", an excluded part) has them in git but not on disk:
 * the pull rule took them off (`store_theirs`, `local_path`). Once the owner approved such a
 * path here (`sends`: in the live shared set, so the app deletes it only through
 * `dc.data.remove`, which leaves a tombstone), the team's copy comes back from HEAD: a tracked
 * file of a registered app, its index entry still HEAD's, no tombstone (a delete the app made
 * stays a delete), no open conflict, passing the pull gate's K4 (plain blob, name, DB).
 *
 * Nothing of mine is ever overwritten. A path with a file of mine on it:
 * - the same bytes as the team's: nothing to do (a stored `local_path` copy of it is dropped);
 * - different bytes, and a stored team copy says the team's came in while the path was not
 *   shared here (`local_path`, `not_installed`): it becomes a `conflict` holding HEAD's copy, so
 *   the outbound stage holds it and the owner picks (`apps data resolve`). It is never sent as a
 *   plain edit over the team's.
 * A file is created only if still absent at the last moment ({@link createBlobNoClobber}): the app
 * may be running. A path not approved here is never brought back: there the app deletes with its
 * own code (`not_shared`), and that stays. Never during an open merge or an app's pull, and only
 * where team data moves (full-repo, cloud sync on). `opts.maxBytes`: an app whose files to bring
 * back weigh more is left for the next sync (`deferred`; the Share click runs on the server's
 * loop). The sync calls it under the brain lock, BEFORE its outbound stage; the owner's Share
 * click calls it through {@link restoreTeamFilesLocked}. Never throws.
 */
export function restoreTeamFiles(ctx: ExchangeCtx, opts: { maxBytes?: number } = {}): RestoredApp[] {
  const out: RestoredApp[] = [];
  const b = brainOf(ctx);
  if (!b) return out;
  try {
    if (git.mergeHeadSha(b.top)) return out;
    const mode = ctx.mode ?? brainShareMode(ctx.projectRoot);
    if (!mode.fullRepo || !mode.cloudSyncOn) return out;
    const nowMs = nowOf(ctx);
    for (const rec of appsHere(ctx)) {
      try {
        if (appPullHeld(ctx.home, rec.hash)) continue;
        if (!checkAppDataChain(ctx.projectRoot, rec.slug).ok) continue;
        const view = viewOf({ ...ctx, mode }, rec.slug);
        if (!view.decl) continue;
        const files = git.treeEntriesLong(b.top, 'HEAD', `${b.appsDir}/${rec.slug}`);
        if (!files.length) {
          // The team has no file of this app: a kept-out mark protects nothing any more.
          clearKeptOut(ctx.home, rec.hash, [...listKeptOut(ctx.home, rec.hash)].filter((p) => view.sends(p)));
          continue;
        }
        const idx = new Map(git.indexEntries(b.top, [dirSpec(b, rec.slug)]).filter((e) => e.stage === 0).map((e) => [e.path, e.sha]));
        const stones = new Set(listTombstones(ctx.home, rec.hash, nowMs).map((t) => t.path));
        const stored = new Map(listConflicts(ctx.home, rec.hash).map((c) => [c.path, c.kind]));
        const keptOut = listKeptOut(ctx.home, rec.hash);
        const inHead = new Set<string>();
        const dataDir = ensureAppDataDir(ctx.projectRoot, rec.slug);
        const want: { rel: string; abs: string; sha: string; mode: string; size: number }[] = [];
        const same: string[] = [];
        const twoVersions: string[] = [];
        for (const f of files) {
          const at = splitAppPath(b.prefix, f.path);
          if (at && at.slug === rec.slug) inHead.add(at.rel);
          if (!at || at.slug !== rec.slug || f.type !== 'blob' || !PLAIN_BLOB_MODES.has(f.mode)) continue;
          if (idx.get(f.path) !== f.sha) continue; // the index moved off HEAD: not this step's to touch
          if (!view.sends(at.rel) || view.conflicts.has(at.rel) || stones.has(at.rel)) continue;
          const abs = containedPath(dataDir, at.rel);
          if (!abs) continue;
          let gate: string | null;
          try { gate = teamBlobRefusal(b.top, at.rel, f.mode, f.sha); } catch { gate = 'unreadable'; }
          if (gate) continue;
          const there = lstatOrNull(abs);
          if (there) {
            if (!there.isFile()) continue; // a link or a folder: never ours to touch
            if (git.hashFile(b.top, abs) === f.sha) { same.push(at.rel); continue; }
            // The kept-out record (uncapped) says the team's copy came in while this path was not
            // shared here; a stored copy of an older version says the same.
            const kind = stored.get(at.rel);
            if (keptOut.has(at.rel) || kind === 'local_path' || kind === 'not_installed') twoVersions.push(at.rel);
            continue; // a file of mine: never overwritten
          }
          try { mkdirsUnder(dataDir, abs); } catch { continue; } // a link or a file where a folder goes
          want.push({ rel: at.rel, abs, sha: f.sha, mode: f.mode, size: f.size });
        }
        // Mine differs from the team's: the team's copy (HEAD's, not the older stored one) waits as a conflict.
        // A store that fails keeps the kept-out mark, and the shared set holds a marked path
        // (`conflict`) all the same: never sent, retried at the next sync.
        const held = twoVersions.filter((rel) => {
          const f = files.find((x) => splitAppPath(b.prefix, x.path)?.rel === rel)!;
          return storeBlob(ctx, b.top, f.sha, rec.hash, rel, 'conflict');
        });
        clearKeptOut(ctx.home, rec.hash, held);
        // A mark for a path the team no longer has protects nothing: a file of mine there is new.
        clearKeptOut(ctx.home, rec.hash, [...keptOut].filter((p) => !inHead.has(p) && view.sends(p)));
        const planned = want.reduce((n, w) => n + w.size, 0);
        if (opts.maxBytes !== undefined && planned > opts.maxBytes) {
          out.push({ slug: rec.slug, paths: [], deferred: true, ...(held.length ? { twoVersions: held } : {}) });
          logLine(ctx, `${rec.slug}: ${want.length} team file(s) to bring back weigh ${planned} bytes; the next sync brings them`);
          continue;
        }
        const paths: string[] = [];
        for (const w of want) {
          try { if (createBlobNoClobber(b.top, w.sha, w.abs, w.mode)) paths.push(w.rel); } catch (e) {
            logLine(ctx, `${rec.slug}: ${w.rel} could not come back (${(e as Error).message}); retried at the next sync`);
          }
        }
        // A stored team copy the disk now holds byte for byte says nothing any more.
        dropConflictEntries(ctx.home, rec.hash, [...paths, ...same], ['local_path', 'not_installed']);
        clearKeptOut(ctx.home, rec.hash, [...paths, ...same]);
        if (!paths.length && !held.length) continue;
        out.push({ slug: rec.slug, paths, ...(held.length ? { twoVersions: held } : {}) });
        if (paths.length) {
          logLine(ctx, `${rec.slug}: ${paths.length} team file(s) shared before this Mac approved brought back from HEAD`);
          inboxRow(ctx, rec.slug, 'restored', `From the team: ${rec.name}: ${paths.length} file${paths.length === 1 ? '' : 's'} the team shared before you approved ${paths.length === 1 ? 'is' : 'are'} now on this Mac.`);
        }
        if (held.length) {
          logLine(ctx, `${rec.slug}: ${held.length} file(s) of mine differ from the team's at paths just approved: both versions kept`);
          inboxRow(ctx, rec.slug, 'two_versions', `${rec.name}: ${held.length} file${held.length === 1 ? '' : 's'} on this Mac differ${held.length === 1 ? 's' : ''} from the team's copy shared before you approved. Both versions are kept and nothing is sent until you pick one on the app's page.`);
        }
      } catch (e) {
        logLine(ctx, `${rec.slug}: bringing the team's files back failed (${(e as Error).message}); retried at the next sync`);
      }
    }
  } catch { /* git could not answer: the next sync tries again */ }
  return out;
}

/**
 * {@link restoreTeamFiles} from outside a sync (the owner's Share click): only while no sync
 * holds the brain lock; a held lock skips it (that sync, or the next, brings the files). Runs on
 * the server's loop, so it brings back at most {@link SHARED_WARN_BYTES} inline; more is left to
 * the next sync. Never throws.
 */
export function restoreTeamFilesLocked(ctx: ExchangeCtx): RestoredApp[] {
  try {
    if (!acquireBrainLock(ctx.contextRoot, nowOf(ctx))) return [];
  } catch { return []; }
  try {
    return restoreTeamFiles(ctx, { maxBytes: SHARED_WARN_BYTES });
  } finally {
    try { releaseBrainLock(ctx.contextRoot); } catch { /* stale lock: its TTL frees it */ }
  }
}

// ─── LARGE shared data: a warning, never a refusal ─────────────────────────────────

/**
 * The size of one app's shared data in the team once this Mac's next sync went: HEAD's team
 * files of `apps/<slug>/` with this Mac's shared copies over them ({@link teamSharedBytes}).
 * `mine`: the app's `sharedSet` sizes. Null when git cannot answer. Never throws.
 */
export function teamAppBytes(ctx: AppPullCtx, slug: string, mine: readonly { rel: string; size: number }[]): number | null {
  const b = brainOf(ctx);
  if (!b) return null;
  try {
    const team = git.treeEntriesLong(b.top, 'HEAD', `${b.appsDir}/${slug}`)
      .map((f) => ({ rel: splitAppPath(b.prefix, f.path)?.rel ?? '', size: f.size }))
      .filter((f) => f.rel);
    return teamSharedBytes(team, mine);
  } catch { return null; }
}

/**
 * Every registered app of this project that this Mac shares and whose team data is over {@link SHARED_WARN_BYTES}:
 * the sync's and the CLI's warning line. Never throws.
 */
export function largeSharedApps(ctx: ExchangeCtx): { slug: string; name: string; bytes: number }[] {
  const out: { slug: string; name: string; bytes: number }[] = [];
  const b = brainOf(ctx);
  if (!b) return out;
  const mode = ctx.mode ?? brainShareMode(ctx.projectRoot);
  if (!mode.fullRepo || !mode.cloudSyncOn) return out;
  for (const rec of appsHere(ctx)) {
    try {
      const view = viewOf({ ...ctx, mode }, rec.slug);
      const ss = sharedSet({ projectRoot: ctx.projectRoot, home: ctx.home }, rec, view.decl, view.consent, { mode });
      if (ss.mode !== 'shared') continue; // only where this Mac shares it (a local app is never told it syncs)
      const bytes = teamAppBytes(ctx, rec.slug, ss.sizes);
      if (bytes !== null && bytes > SHARED_WARN_BYTES) out.push({ slug: rec.slug, name: rec.name, bytes });
    } catch { /* not counted */ }
  }
  return out;
}

// ─── BEFORE A NEW MERGE ────────────────────────────────────────────────────────────

export interface PullDeps {
  /** Stop the app's running backend through the server (wave 1 client `pauseForSync`). */
  pause?: (slug: string) => Promise<SyncPauseResult>;
  /** Let it come back once the record is gone (`resumeAfterSync`). */
  resume?: (slug: string) => Promise<boolean>;
  backup?: (home: string, hash: string, dataDir: string, opts: { reason: string }) => Promise<BackupResult>;
}

export type PreparedPull =
  | { ok: true; hashes: string[]; paused: string[]; notes: string[] }
  | { ok: false; note: string };

const NOTHING: PreparedPull = { ok: true, hashes: [], paused: [], notes: [] };

/**
 * Before a NEW merge of `remoteRef` (K7 the async wrapper's first half): for every app folder the
 * incoming range touches, the pull record (`parked`) is written, the backend stopped, the data
 * backed up, the path parked, and the record moved to `merged` (BEFORE the merge runs). Any
 * failure puts everything back, removes the records and returns `ok: false` with the note (the
 * pull is skipped; data unchanged). The caller merges, calls {@link planSettle} per hash, and in
 * `finally` {@link finishAppPull} per hash.
 */
export async function prepareAppPull(ctx: ExchangeCtx, remoteRef: string, deps: PullDeps = {}): Promise<PreparedPull> {
  const b = brainOf(ctx);
  if (!b) return NOTHING;
  const pause = deps.pause ?? ((slug: string) => pauseForSync(slug, { cwd: ctx.projectRoot, home: ctx.home }));
  const resume = deps.resume ?? ((slug: string) => resumeAfterSync(slug, { cwd: ctx.projectRoot, home: ctx.home }));
  const backup = deps.backup ?? backupAppData;
  if (git.mergeHeadSha(b.top)) return { ok: false, note: 'Skipped the pull: a merge is already open.' };
  if (ensureAppsMergeAttributes(ctx.gitCwd, ctx.contextRoot) === 'failed') {
    return { ok: false, note: 'Skipped the pull: the line that keeps git from text-merging app data could not be written to .git/info/attributes. It is retried at the next sync.' };
  }
  const remoteSha = git.revParse(b.top, remoteRef);
  if (!remoteSha) return NOTHING;
  const preHead = git.revParse(b.top, 'HEAD');
  let touched: string[];
  try {
    const spec = `:(top,icase)${b.appsDir}`;
    touched = preHead ? git.diffNames(b.top, `${preHead}...${remoteSha}`, [spec]) : git.diffNames(b.top, `${EMPTY_TREE}..${remoteSha}`, [spec]);
  } catch {
    return { ok: false, note: "Skipped the pull: could not check which app data the team's update touches. It is retried at the next sync." };
  }
  const bySlug = new Map<string, string[]>();
  for (const p of touched) {
    const at = splitAppPath(b.prefix, p);
    if (!at) continue;
    bySlug.set(at.slug, [...(bySlug.get(at.slug) ?? []), p]);
  }
  if (!bySlug.size) return NOTHING;

  const views = [...bySlug.keys()].sort().map((slug) => viewOf(ctx, slug));
  for (const v of views) {
    if (appPullHeld(ctx.home, v.hash)) {
      return { ok: false, note: `Skipped the pull: an earlier team pull of the app ${v.slug} has not finished yet (finish the open merge with /dream-sync, or run sync again). Its data is unchanged.` };
    }
  }

  const created: AppShareView[] = [];
  const paused: string[] = [];
  const rollback = async (note: string): Promise<PreparedPull> => {
    for (const v of created.slice().reverse()) {
      const read = readPullRecord(ctx.home, v.hash);
      if (read?.ok) {
        const left = putBack(ctx, b, read.rec);
        if (left.length) { logLine(ctx, `rollback of ${v.slug}: ${left.length} parked paths could not go back; record kept`); continue; }
      }
      try { removePullRecord(ctx.home, v.hash); } catch { /* left: the app stays closed, recovery finishes it */ }
    }
    for (const slug of paused) await resume(slug).catch(() => false);
    return { ok: false, note };
  };

  const at = new Date(nowOf(ctx)).toISOString();
  for (const v of views) {
    const rec: PullRecord = { v: 1, hash: v.hash, slug: v.slug, preHead, mergeHead: remoteSha, phase: 'parked', parked: [], plan: null, at };
    try { writePullRecord(ctx.home, rec); } catch {
      return rollback(`Skipped the pull: the pull record of ${v.slug} could not be written. Its data is unchanged.`);
    }
    created.push(v);
  }
  // The record exists: the backend can no longer start. Stop the running one.
  for (const v of created) {
    if (!v.rec) continue;
    let r: SyncPauseResult;
    try { r = await pause(v.slug); } catch { r = 'unknown'; }
    if (r === 'unknown') return rollback(`Skipped the pull: the app ${v.slug} could not be paused in time (is dreamcontext busy?). Its data is unchanged; the pull is retried at the next sync.`);
    if (r === 'stopped') paused.push(v.slug);
  }
  for (const v of created) {
    if (!v.rec) continue;
    try {
      const dataDir = join(b.top, b.appsDir, v.slug);
      if (existsSync(dataDir)) await backup(ctx.home, v.hash, dataDir, { reason: BEFORE_TEAM_PULL });
    } catch { /* the park and the commits keep the data; the backup is extra */ }
  }
  for (const v of created) {
    const read = readPullRecord(ctx.home, v.hash);
    if (!read?.ok) return rollback(`Skipped the pull: the pull record of ${v.slug} could not be read back. Its data is unchanged.`);
    const parked = parkBeforeMerge(ctx, read.rec, bySlug.get(v.slug) ?? []);
    if (!parked.ok) return rollback(parked.note);
  }
  for (const v of created) {
    const read = readPullRecord(ctx.home, v.hash);
    if (!read?.ok) return rollback(`Skipped the pull: the pull record of ${v.slug} could not be read back. Its data is unchanged.`);
    try { writePullRecord(ctx.home, { ...read.rec, phase: 'merged' }); } catch {
      return rollback(`Skipped the pull: the pull record of ${v.slug} could not be advanced. Its data is unchanged.`);
    }
  }
  return { ok: true, hashes: created.map((v) => v.hash), paused, notes: [] };
}

/**
 * Set this Mac's unsent copy of every incoming path aside (K5), only with no MERGE_HEAD: a path
 * whose disk state differs from HEAD, or an untracked local file where the team adds one. A path
 * missing from disk is not moved but recorded in `absent` (mine = no file). The record is written
 * before each move; a tracked path goes back to HEAD (`checkout HEAD`). A path that cannot be
 * parked fails the whole park (the caller puts everything back).
 */
export function parkBeforeMerge(ctx: AppPullCtx, rec: PullRecord, repoPaths: string[]): { ok: true; rec: PullRecord } | { ok: false; note: string } {
  const b = brainOf(ctx);
  if (!b) return { ok: true, rec };
  if (git.mergeHeadSha(b.top)) return { ok: false, note: 'Skipped the pull: a merge is already open.' };
  const stamp = newStamp(nowOf(ctx));
  const toCheckout: string[] = [];
  const fail = (p: string, why: string) => ({ ok: false as const, note: `Skipped the pull: ${p} could not be set aside before the team's copy arrives (${why}). Your app data is unchanged; it is retried at the next sync.` });
  // "Mine" is what this disk holds now. Every incoming path absent from it is recorded BEFORE any
  // move, so putting mine back there means removing the file, never writing HEAD's blob (which may
  // be a teammate's copy this Mac took off a local path at an earlier pull).
  const absent = [...repoPaths].sort()
    .map((p) => splitAppPath(b.prefix, p))
    .filter((at): at is { slug: string; rel: string } => !!at && at.slug === rec.slug && !pathNameRefusal(at.rel))
    .filter((at) => !lstatOrNull(join(b.top, repoPathOf(b, at.slug, at.rel))))
    .map((at) => at.rel);
  rec = { ...rec, absent: [...new Set([...(rec.absent ?? []), ...absent])] };
  try { writePullRecord(ctx.home, rec); } catch { return fail(repoPaths[0] ?? rec.slug, 'the record could not be written'); }
  for (const p of [...repoPaths].sort()) {
    const at = splitAppPath(b.prefix, p);
    if (!at || at.slug !== rec.slug) continue;
    const abs = join(b.top, p);
    const st = lstatOrNull(abs);
    if (!st) continue;
    const headBlob = rec.preHead ? git.blobId(b.top, `${rec.preHead}:${p}`) : null;
    if (headBlob && st.isFile() && git.hashFile(b.top, abs) === headBlob) continue;
    if (st.isDirectory()) return fail(p, 'a folder is there');
    if (pathNameRefusal(at.rel)) return fail(p, 'its name may not be kept');
    const stash = `${stamp}/${at.rel}`;
    const target = parkTarget(ctx.home, rec.hash, stash);
    if (!target) return fail(p, 'no park path');
    rec = { ...rec, parked: [...rec.parked, { path: at.rel, stash, tracked: !!headBlob }] };
    try { writePullRecord(ctx.home, rec); } catch { return fail(p, 'the record could not be written'); }
    try {
      mkdirsUnder(parkDir(ctx.home, rec.hash), target);
      if (st.isSymbolicLink()) renameSync(abs, target);
      else moveFileAcross(abs, target);
    } catch (e) {
      rec = { ...rec, parked: rec.parked.filter((x) => x.stash !== stash) };
      try { writePullRecord(ctx.home, rec); } catch { /* the stash is missing: putBack skips it */ }
      return fail(p, (e as NodeJS.ErrnoException).code ?? 'move failed');
    }
    if (headBlob) toCheckout.push(p);
  }
  if (toCheckout.length && rec.preHead) {
    try { git.checkoutExact(b.top, rec.preHead, toCheckout); } catch { return fail(toCheckout[0], 'git could not restore HEAD\'s copy'); }
  }
  return { ok: true, rec };
}

/**
 * Put every parked copy back into the data folder, overwriting what the merge left there. Returns
 * the entries that could not go back (kept in the park).
 */
function putBack(ctx: AppPullCtx, b: Brain, rec: PullRecord): PullRecord['parked'] {
  if (!rec.parked.length) return [];
  let dataDir: string;
  try { dataDir = ensureAppDataDir(ctx.projectRoot, rec.slug); } catch { return rec.parked; }
  void b;
  const left: PullRecord['parked'] = [];
  for (const p of rec.parked) {
    const src = parkTarget(ctx.home, rec.hash, p.stash);
    const dst = containedPath(dataDir, p.path);
    if (!src || !dst) { left.push(p); continue; }
    if (!lstatOrNull(src)) { logLine(ctx, `${rec.slug}: parked ${p.path} missing from the park; nothing to put back`); continue; }
    try {
      mkdirsUnder(dataDir, dst);
      const there = lstatOrNull(dst);
      if (there?.isDirectory()) { left.push(p); continue; }
      if (there) rmSync(dst, { force: true });
      if (lstatSync(src).isSymbolicLink()) renameSync(src, dst);
      else moveFileAcross(src, dst);
      pruneEmpty(dirname(src), parkDir(ctx.home, rec.hash));
    } catch {
      left.push(p);
    }
  }
  return left;
}

// ─── THE DECISION ──────────────────────────────────────────────────────────────────

interface ComputedPlan { plan: PlanEntry[]; strip: string[] }

/**
 * The K5 rule for one record, from git objects only: what the team changed (`base..mergeHead`
 * under the app folder, by `ls-tree`/`diff --raw`), judged by this Mac's declaration and the pull
 * gate's K4 classification. `strip`: team paths whose name cannot even be recorded (a manual
 * pull past the gate), taken off disk at apply time. THROWS when git cannot answer.
 */
function computePlan(ctx: ExchangeCtx, b: Brain, rec: PullRecord): ComputedPlan {
  if (!rec.mergeHead) return { plan: [], strip: [] };
  const base = rec.preHead ? git.mergeBase(b.top, rec.preHead, rec.mergeHead) : null;
  const entries = git.rawEntries(b.top, `${base ?? EMPTY_TREE}..${rec.mergeHead}`, [dirSpec(b, rec.slug)]);
  const view = viewOf(ctx, rec.slug);
  const installed = !!view.rec;
  const parked = new Set(rec.parked.map((p) => p.path));
  const plan: PlanEntry[] = [];
  const strip: string[] = [];
  for (const e of entries) {
    const at = splitAppPath(b.prefix, e.path);
    if (!at || at.slug !== rec.slug) continue;
    const rel = at.rel;
    if (pathNameRefusal(rel)) { if (e.newMode !== '000000') strip.push(e.path); continue; }
    if (e.newMode === '000000') {
      const keepMine = installed && !view.lands(rel);
      plan.push(keepMine ? { path: rel, action: 'delete_ok', reason: 'keep_mine' } : { path: rel, action: 'delete_ok' });
      continue;
    }
    let gate: string | null;
    try { gate = teamBlobRefusal(b.top, rel, e.newMode, e.newSha ?? ''); } catch { gate = 'not_plain'; }
    if (gate) { plan.push({ path: rel, action: 'store_theirs', reason: gate }); continue; }
    const mine = rec.preHead ? git.blobId(b.top, `${rec.preHead}:${e.path}`) : null;
    const baseBlob = base ? git.blobId(b.top, `${base}:${e.path}`) : null;
    const bothChanged = !!mine && mine !== baseBlob && mine !== e.newSha;
    const minePending = parked.has(rel) || bothChanged;
    if (installed) {
      if (view.lands(rel)) plan.push(minePending ? { path: rel, action: 'mine_back_theirs_stored', reason: 'conflict' } : { path: rel, action: 'land' });
      else plan.push({ path: rel, action: 'store_theirs', reason: 'local_path' });
    } else {
      plan.push(minePending ? { path: rel, action: 'mine_back_theirs_stored', reason: 'not_installed' } : { path: rel, action: 'land' });
    }
  }
  return { plan, strip };
}

/**
 * THE DECISION (K5), right after the merge: the plan goes into the record; neither disk nor
 * index is touched, so `git merge --abort` always runs clean. Returns the plan, or null when the
 * record is missing, corrupt or not `merged`.
 */
export function planSettle(ctx: ExchangeCtx, hash: string): PlanEntry[] | null {
  const read = readPullRecord(ctx.home, hash);
  if (!read?.ok || read.rec.phase !== 'merged') return null;
  const b = brainOf(ctx);
  if (!b) return null;
  let computed: ComputedPlan;
  try { computed = computePlan(ctx, b, read.rec); } catch { return null; }
  try { writePullRecord(ctx.home, { ...read.rec, plan: computed.plan }); } catch { return null; }
  return computed.plan;
}

// ─── AFTER THE MERGE ENDED ─────────────────────────────────────────────────────────

const STORE_KINDS = new Set<ConflictKind>(['conflict', 'local_path', 'not_installed']);

/**
 * What this Mac's DISK held at `rel` before the merge ("mine" is never assumed to be HEAD's blob):
 *  - `parked`: a copy that differed from HEAD, set aside; `putBack` restores it.
 *  - `absent`: no file (recorded by `parkBeforeMerge`): mine back = remove the file.
 *  - `head`: the park ran and found the disk equal to HEAD^1: mine back = that blob.
 *  - `unknown`: the park never ran (a manual `git pull` past a `parked` record): only a file that
 *    is exactly the team's copy is taken away; nothing is ever written.
 */
type MineState = 'parked' | 'absent' | 'head' | 'unknown';
function mineState(rec: PullRecord, rel: string): MineState {
  if (rec.parked.some((p) => p.path === rel)) return 'parked';
  if (rec.absent === undefined) return 'unknown';
  return rec.absent.includes(rel) ? 'absent' : 'head';
}

/** Remove a file or link at `abs` (never a folder). */
function removeEntry(abs: string): void {
  const there = lstatOrNull(abs);
  if (there && !there.isDirectory()) rmSync(abs, { force: true });
}

/**
 * THE one place that puts "mine" back on disk for a path the team's copy may not stay on (every
 * plan action that keeps mine: `store_theirs`, `mine_back_theirs_stored`, `delete_ok` keep_mine;
 * the ls-tree plan of a manual pull; an aborted merge).
 */
function mineBack(b: Brain, rec: PullRecord, dataDir: string, rel: string, abs: string): void {
  const p = repoPathOf(b, rec.slug, rel);
  switch (mineState(rec, rel)) {
    case 'parked':
      return; // putBack
    case 'absent':
      removeEntry(abs);
      return;
    case 'head': {
      const spec = rec.preHead ? `${rec.preHead}:${p}` : null;
      if (spec && git.blobId(b.top, spec)) { mkdirsUnder(dataDir, abs); writeBlobAtomic(b.top, spec, abs); } else removeEntry(abs);
      return;
    }
    case 'unknown': {
      const there = lstatOrNull(abs);
      if (!there || there.isDirectory()) return;
      if (there.isSymbolicLink()) { rmSync(abs, { force: true }); return; }
      const theirs = rec.mergeHead ? git.blobId(b.top, `${rec.mergeHead}:${p}`) : null;
      if (theirs && git.hashFile(b.top, abs) === theirs) rmSync(abs, { force: true });
      return;
    }
  }
}

/** Apply a committed pull's plan to disk and the conflict store. Returns counts for the inbox. */
function applyPlan(ctx: AppPullCtx, b: Brain, rec: PullRecord, plan: PlanEntry[], strip: string[], dataDir: string): { changed: number; deleted: number; twins: number; stored: number } {
  const counts = { changed: 0, deleted: 0, twins: 0, stored: 0 };
  for (const p of strip) {
    const at = splitAppPath(b.prefix, p);
    const abs = at ? join(dataDir, at.rel) : null;
    const there = abs ? lstatOrNull(abs) : null;
    if (abs && there && !there.isDirectory()) { try { rmSync(abs, { force: true }); } catch { /* left */ } }
  }
  for (const e of plan) {
    const p = repoPathOf(b, rec.slug, e.path);
    const abs = containedPath(dataDir, e.path);
    if (!abs) continue;
    try {
      switch (e.action) {
        case 'land':
          counts.changed++;
          break;
        case 'delete_ok':
          counts.deleted++;
          if (e.reason === 'keep_mine') mineBack(b, rec, dataDir, e.path, abs);
          break;
        case 'store_theirs': {
          counts.changed++;
          const kind: ConflictKind = STORE_KINDS.has(e.reason as ConflictKind) ? e.reason as ConflictKind : 'local_path';
          if (kind !== 'conflict') markKeptOut(ctx.home, rec.hash, [e.path]); // before the store: outlives it
          if (e.reason !== 'not_plain' && storeBlob(ctx, b.top, `${rec.mergeHead}:${p}`, rec.hash, e.path, kind)) counts.stored++;
          mineBack(b, rec, dataDir, e.path, abs);
          break;
        }
        case 'mine_back_theirs_stored': {
          counts.changed++;
          counts.twins++;
          const kind: ConflictKind = e.reason === 'not_installed' ? 'not_installed' : 'conflict';
          if (kind === 'not_installed') markKeptOut(ctx.home, rec.hash, [e.path]);
          if (storeBlob(ctx, b.top, `${rec.mergeHead}:${p}`, rec.hash, e.path, kind)) counts.stored++;
          mineBack(b, rec, dataDir, e.path, abs);
          break;
        }
      }
    } catch (err) {
      logLine(ctx, `${rec.slug}: ${e.action} ${e.path} failed (${(err as Error).message})`);
    }
  }
  return counts;
}

/**
 * AFTER THE MERGE ENDED (K5): only with no MERGE_HEAD (checked here). Committed (`mergeHead` an
 * ancestor of HEAD): the plan (or, for a record still `parked`, a plan computed now from
 * `preHead..mergeHead`: a manual `git pull`) is applied and the park put back; aborted: only the
 * park goes back. The record goes last; a park that cannot go back keeps it (`finished`).
 */
export const finishAppPull: FinishAppPullFn = (ctx, hash) => {
  const read = readPullRecord(ctx.home, hash);
  if (read === null) return { done: true };
  if (!read.ok) {
    inboxRow(ctx, hash.slice(0, 40), 'record_corrupt', 'A team pull record of an app could not be read; the app stays paused until it is checked (~/.dreamcontext/apps/pull/).');
    return { done: false, note: 'the pull record is corrupt; kept, never applied' };
  }
  let rec = read.rec;
  const b = brainOf(ctx);
  if (!b) return { done: false, note: 'the brain is not in a git repo' };
  if (git.mergeHeadSha(b.top)) return { done: false, note: 'the team merge is still open' };
  if (rec.phase !== 'finished') {
    const head = git.revParse(b.top, 'HEAD');
    const committed = !!rec.mergeHead && !!head && git.isAncestor(b.top, rec.mergeHead, head);
    if (committed) {
      let computed: ComputedPlan;
      try {
        computed = rec.phase === 'parked' || rec.plan === null ? computePlan(ctx, b, rec) : { plan: rec.plan, strip: [] };
      } catch {
        return { done: false, note: 'git could not answer what the merge changed; retried at the next sync' };
      }
      if (computed.plan.length || computed.strip.length) {
        let dataDir: string;
        try { dataDir = ensureAppDataDir(ctx.projectRoot, rec.slug); } catch (e) {
          inboxRow(ctx, rec.slug, 'data_folder', `The team's data for ${rec.slug} could not be settled: ${(e as Error).message}`);
          return { done: false, note: (e as Error).message };
        }
        const c = applyPlan(ctx, b, rec, computed.plan, computed.strip, dataDir);
        if (c.changed || c.deleted) {
          const name = appsHere(ctx).find((a) => a.hash === rec.hash)?.name ?? rec.slug;
          inboxRow(ctx, rec.slug, 'pulled', `From the team: ${name}: ${c.changed} file${c.changed === 1 ? '' : 's'} changed, ${c.deleted} deleted${c.twins ? `; ${c.twins} with two versions, yours kept in place` : ''}.`);
        }
      }
    } else if (rec.absent?.length) {
      // Aborted: the team's copy never landed, but `merge --abort` writes HEAD's copy back over a
      // path the merge had touched. Mine was no file there: it goes again.
      let dataDir: string | null = null;
      try { dataDir = ensureAppDataDir(ctx.projectRoot, rec.slug); } catch { dataDir = null; }
      if (dataDir) {
        for (const rel of rec.absent) {
          const abs = containedPath(dataDir, rel);
          if (abs) { try { mineBack(b, rec, dataDir, rel, abs); } catch { /* left; logged nowhere worse than before */ } }
        }
      }
    }
    rec = { ...rec, phase: 'finished', plan: null };
    try { writePullRecord(ctx.home, rec); } catch { /* putBack below still runs; a retry re-applies idempotently */ }
  }
  const left = putBack(ctx, b, rec);
  if (left.length) {
    try { writePullRecord(ctx.home, { ...rec, parked: left }); } catch { /* kept as it was */ }
    inboxRow(ctx, rec.slug, 'park_left', `${left.length} of your ${rec.slug} files are still set aside (~/.dreamcontext/apps/park/); the app stays paused until they go back.`);
    return { done: false, note: `${left.length} parked paths could not go back` };
  }
  try { removePullRecord(ctx.home, hash); } catch { return { done: false, note: 'the pull record could not be removed' }; }
  return { done: true };
};

/** Does this record belong to THIS project (a registered app here, or this project's team folder)? */
function recordHere(ctx: AppPullCtx, hash: string, slug: string | null, apps: AppRecord[]): boolean {
  if (apps.some((a) => a.hash === hash)) return true;
  return slug !== null && teamHash(ctx.projectRoot, slug) === hash;
}

/** {@link planSettle} for every hash of a prepared pull. Never throws. */
export function settleAppPulls(ctx: ExchangeCtx, hashes: string[]): void {
  for (const h of hashes) { try { planSettle(ctx, h); } catch { /* finish computes it */ } }
}

/**
 * {@link finishAppPull} for the given hashes, or every record of this project. Returns the slugs
 * whose record is gone (their apps may open again) and the notes. Never throws.
 */
export function finishAppPulls(ctx: AppPullCtx, hashes?: string[]): { finished: string[]; notes: string[] } {
  const out = { finished: [] as string[], notes: [] as string[] };
  if (!brainOf(ctx)) return out;
  const apps = appsHere(ctx);
  const list = hashes ?? listPullRecords(ctx.home)
    .filter((r) => recordHere(ctx, r.hash, r.read.ok ? r.read.rec.slug : null, apps))
    .map((r) => r.hash);
  for (const h of list) {
    const read = readPullRecord(ctx.home, h);
    const slug = read?.ok ? read.rec.slug : h;
    try {
      const r = finishAppPull(ctx, h);
      if (r.done) out.finished.push(slug); else if (r.note) out.notes.push(`${slug}: ${r.note}`);
    } catch (e) {
      out.notes.push(`${slug}: ${(e as Error).message}`);
    }
  }
  return out;
}

// ─── crash recovery (only under the brain lock) ────────────────────────────────────

/**
 * Recovery with the brain lock ALREADY held by this process (the sync engine, before its
 * "merge in progress" guard). Our own crashed merge (MERGE_HEAD == a record's `mergeHead`, phase
 * `merged`, no deferred agent report) is aborted, the abort verified, and the pull finished (the
 * park goes back). A deferred merge waits for the agent; an unknown MERGE_HEAD is the user's.
 * With no merge open, every record of this project is finished.
 */
export function recoverAppPullsHeld(ctx: AppPullCtx): { recovered: string[]; skipped: null; notes: string[] } {
  const res = { recovered: [] as string[], skipped: null, notes: [] as string[] };
  const b = brainOf(ctx);
  if (!b) return res;
  const apps = appsHere(ctx);
  const records = listPullRecords(ctx.home).filter((r) => recordHere(ctx, r.hash, r.read.ok ? r.read.rec.slug : null, apps));
  if (!records.length) return res;
  const mh = git.mergeHeadSha(b.top);
  if (mh) {
    const ours = records.find((r) => r.read.ok && r.read.rec.mergeHead === mh && r.read.rec.phase === 'merged');
    let report: unknown = null;
    try { report = readConflictReport(ctx.contextRoot); } catch { report = null; }
    if (!ours || report) {
      res.notes.push(ours ? 'A team merge waits for /dream-sync; its apps stay paused until it is finished.' : 'A merge that dreamcontext did not start is open (finish it with git merge --continue or --abort); the paused apps wait for it.');
      return res;
    }
    logLine(ctx, `merge --abort of our own crashed merge ${mh} (${ours.read.ok ? ours.read.rec.slug : ours.hash})`);
    try { git.abortMergeStrict(b.top); } catch (e) { logLine(ctx, `merge --abort failed: ${(e as Error).message}`); }
    if (git.mergeHeadSha(b.top)) {
      res.notes.push('Our crashed team merge could not be aborted; its apps stay paused.');
      return res;
    }
  }
  const fin = finishAppPulls(ctx, records.map((r) => r.hash));
  res.recovered.push(...fin.finished);
  res.notes.push(...fin.notes);
  return res;
}

/**
 * Crash recovery from outside a sync (server start): takes the brain lock (its holder's PID is
 * checked for life), recovers, releases. Locked = a live sync owns the records: skipped, logged.
 */
export const recoverAppPulls: RecoverAppPullsFn = (ctx) => {
  if (!acquireBrainLock(ctx.contextRoot, nowOf(ctx))) {
    logLine(ctx, `recovery skipped: the brain lock of ${ctx.contextRoot} is held`);
    return { recovered: [], skipped: 'locked', notes: ['The brain is syncing; app pull recovery is retried later.'] };
  }
  try {
    return recoverAppPullsHeld(ctx);
  } finally {
    releaseBrainLock(ctx.contextRoot);
  }
};

// ─── install onto a team folder ────────────────────────────────────────────────────

/**
 * An app installed onto a team folder under the same slug (wave 2 lane B, install.ts): the K5
 * rule as if it had just been pulled. Team files on paths the installed manifest does not call
 * `shared` leave the data folder for the conflict store (`local_path`), so after Kur no team file
 * sits on a local path. A file whose content is not the team's (mine) stays, the team's copy
 * stored beside it (`local_path`). Never throws.
 */
export function applyPullRuleForInstall(ctx: AppPullCtx, slug: string, hash: string): { stored: string[] } {
  const stored: string[] = [];
  const b = brainOf(ctx);
  if (!b) return { stored };
  let files: git.LongTreeEntry[];
  try { files = git.treeEntriesLong(b.top, 'HEAD', `${b.appsDir}/${slug}`); } catch { return { stored }; }
  if (!files.length) return { stored };
  const view = viewOf(ctx, slug);
  const dataDir = join(b.top, b.appsDir, slug);
  if (!checkAppDataChain(ctx.projectRoot, slug).ok) return { stored };
  for (const f of files) {
    const at = splitAppPath(b.prefix, f.path);
    if (!at || at.slug !== slug || view.lands(at.rel)) continue;
    const abs = containedPath(dataDir, at.rel);
    if (!abs) continue;
    const there = lstatOrNull(abs);
    if (!there || there.isDirectory()) continue;
    const isBlob = f.type === 'blob';
    const plain = isBlob && (f.mode === '100644' || f.mode === '100755');
    const mine = there.isFile() && isBlob && git.hashFile(b.top, abs) !== f.sha;
    markKeptOut(ctx.home, hash, [at.rel]); // before the store: outlives it
    // The team's copy is stored either way: when mine stays, it is what tells a later approval
    // of this path that the two differ (held as two versions, never sent over the team's).
    if (plain && storeBlob(ctx, b.top, f.sha, hash, at.rel, 'local_path')) stored.push(at.rel);
    if (mine) continue; // mine, not the team's: it stays
    try { rmSync(abs, { force: true }); pruneEmpty(dirname(abs), dataDir); } catch { /* left */ }
  }
  return { stored };
}
