/**
 * The BACK DOORS of app data in git (app-veri-ortak plan r6, K4, K5). App data enters and leaves
 * git only through the exchange layer (data-exchange.ts): the general stage never touches
 * `apps/`, and `stageOutbound` force-adds exactly the owner-approved shared paths. These gates
 * catch whatever got past it: a hand-made commit (`git add -f` + `git commit`), or a broken or
 * hostile remote commit.
 *
 *  - {@link appDataPushRefusals}: every commit the push would send is checked for the `apps/`
 *    entries it INTRODUCES (`diff-tree -c`: a merge only by its resolution, so a teammate's file
 *    that came in through the merge is never held). Each must pass K4 (blob mode, name, DB,
 *    size), lie in this Mac's shared set, and a delete must have a tombstone. Otherwise the push
 *    waits (`app_data_held`). Git that cannot answer holds it too. All four push paths use it.
 *  - {@link incomingAppDataRefusals}: before a pull, `apps/` or `apps/<slug>` arriving as
 *    anything but a folder, a symlink or submodule, a letter-case twin, a K4 breach (any part,
 *    DB, file size, the app and brain totals) stops the pull; local data is unchanged.
 *
 * Also home to {@link appShareView}, this Mac's answer for one app folder: does a path LAND here
 * (this Mac's declaration calls it shared) and is it SENT from here (approved too, sync on).
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { raiseInboxRow } from '../owner-inbox.js';
import { homedir } from 'node:os';
import { brainPrefix } from '../agents/agent-sync.js';
import * as git from '../git-sync/git.js';
import { APP_SLUG_RE } from './bundle.js';
import { APPS_DATA_FOLDER, foldName } from './data-dir.js';
import { readConsent, type Consent } from './data-consent.js';
import { listConflicts } from './data-conflicts.js';
import { listTombstones } from './data-deletes.js';
import {
  APP_SHARED_MAX_BYTES, BRAIN_SHARED_MAX_BYTES, FILE_MAX_BYTES, brainShareMode, declMatches,
  isDbName, isSqliteHead, pathNameRefusal, type DataDecl,
} from './data-share.js';
import { readManifest } from './manifest.js';
import { listApps, type AppRecord } from './registry.js';

// ─── paths ─────────────────────────────────────────────────────────────────────────

/** `:(top,icase)<prefix>apps`, or null when the brain is not in a git repo. */
export function appsPathspec(gitCwd: string, contextRoot: string): string | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  return prefix === null ? null : `:(top,icase)${prefix}${APPS_DATA_FOLDER}`;
}

/** The general stage's exclusion: `:(top,icase,exclude)<prefix>apps` (K5), or null outside git. */
export function appsExcludeSpec(gitCwd: string, contextRoot: string): string | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  return prefix === null ? null : `:(top,icase,exclude)${prefix}${APPS_DATA_FOLDER}`;
}

/** `<prefix>apps/<slug>/<rel>` split in its exact letter case, or null when it is not that shape. */
export function splitAppPath(prefix: string, repoPath: string): { slug: string; rel: string } | null {
  const head = `${prefix}${APPS_DATA_FOLDER}/`;
  if (!repoPath.startsWith(head)) return null;
  const rest = repoPath.slice(head.length).split('/');
  if (rest.length < 2 || !APP_SLUG_RE.test(rest[0])) return null;
  const rel = rest.slice(1).join('/');
  return rel ? { slug: rest[0], rel } : null;
}

/** Is `repoPath` under the brain's `apps/`, any letter case? */
export function underApps(prefix: string, repoPath: string): boolean {
  const head = foldName(`${prefix}${APPS_DATA_FOLDER}`);
  const p = foldName(repoPath);
  return p === head || p.startsWith(`${head}/`);
}

// ─── what the general stage may not leave in the index ─────────────────────────────

/**
 * App data stays in the index only through the exchange layer's own add (`stageOutbound`). Where
 * that stage did not run (an in-tree brain, a scope other than full-repo `all`, cloud sync off),
 * whatever got staged under `<prefix>apps` (a hand `git add -f`, `git add -A --force`) is taken
 * out again after the general stage, the `superStagePass` shape, so the sync's own commit never
 * seals app data into the code repo. `keepHead`: entries go back to HEAD's instead of out (a
 * full-repo brain, where HEAD's entries are the team's data and absence is never a delete). The
 * caller never runs it while a merge is open. Never throws; returns the paths it changed.
 */
export function dropStagedAppData(gitCwd: string, contextRoot: string, opts: { keepHead?: boolean; home?: string } = {}): string[] {
  let prefix: string | null;
  try { prefix = brainPrefix(gitCwd, contextRoot); } catch { return []; }
  if (prefix === null) return [];
  const top = git.topLevel(gitCwd);
  if (!top) return [];
  const spec = `:(top,icase)${prefix}${APPS_DATA_FOLDER}`;
  let changed: string[] = [];
  try {
    changed = opts.keepHead ? git.stagedPaths(top, [spec]) : git.indexPaths(top, [spec]);
    if (!changed.length) return [];
    if (opts.keepHead) git.resetIndexToHead(top, [spec]);
    else git.removeFromIndexForce(top, [spec]);
  } catch {
    try { git.removeFromIndexForce(top, [spec]); } catch { /* the push gate still holds it in full-repo */ }
  }
  try {
    const slug = splitAppPath(prefix, changed[0])?.slug ?? 'apps';
    raiseInboxRow(dirname(contextRoot), {
      kind: 'app-data-held', ref: changed[0], agent: null,
      title: `App data was staged by hand (${changed.slice(0, 2).join(', ')}${changed.length > 2 ? ` +${changed.length - 2}` : ''}); it was left out of the sync commit. Only the owner-approved shared data goes, through the sync.`,
      actions: ['dismiss'], dedupeKey: `app-data:${slug}:staged_by_hand`,
    }, opts.home);
  } catch { /* the row is a courtesy */ }
  return changed;
}

// ─── this Mac's view of one app folder ─────────────────────────────────────────────

/**
 * The per-machine state key of a team folder no app of this Mac owns (Apps "Takımın app'i"): its
 * pull record and conflict store hang off it. Stable for (project, slug).
 */
export function teamHash(projectRoot: string, slug: string): string {
  let root = projectRoot;
  try { root = realpathSync.native(projectRoot); } catch { /* lexical */ }
  return `t-${createHash('sha256').update(`${root}\0${slug}`).digest('hex').slice(0, 40)}`;
}

export interface AppShareView {
  slug: string;
  /** This Mac's registered app of that slug in this project, or null ("not installed"). */
  rec: AppRecord | null;
  /** `rec.hash`, or the team folder's {@link teamHash}. */
  hash: string;
  decl: DataDecl | null;
  consent: Consent | null;
  /** This Mac's declaration calls `rel` shared and the owner neither declined nor excluded it. */
  lands(rel: string): boolean;
  /** {@link lands} AND approved here AND the brain is full-repo with cloud sync on. */
  sends(rel: string): boolean;
  /** Paths held as `conflict` (a team copy waits for a human). */
  conflicts: Set<string>;
}

export interface ShareViewOpts { home: string; mode?: { fullRepo: boolean; cloudSyncOn: boolean } }

/** This Mac's answer for `apps/<slug>/` of this project. Never throws. */
export function appShareView(projectRoot: string, slug: string, opts: ShareViewOpts): AppShareView {
  let rec: AppRecord | null = null;
  try { rec = listApps(opts.home, projectRoot).find((a) => a.slug === slug) ?? null; } catch { rec = null; }
  let decl: DataDecl | null = null;
  if (rec) {
    try { const m = readManifest(rec.root); decl = m.ok ? m.manifest.data : null; } catch { decl = null; }
  }
  const hash = rec ? rec.hash : teamHash(projectRoot, slug);
  let consent: Consent | null = null;
  try { consent = rec ? readConsent(opts.home, hash) : null; } catch { consent = null; }
  let conflicts = new Set<string>();
  try { conflicts = new Set(listConflicts(opts.home, hash).filter((c) => c.kind === 'conflict').map((c) => c.path)); } catch { /* none */ }
  let modeOn: boolean | null = null;
  const on = (): boolean => {
    if (modeOn === null) {
      const m = opts.mode ?? brainShareMode(projectRoot);
      modeOn = m.fullRepo && m.cloudSyncOn;
    }
    return modeOn;
  };
  const excluded = consent?.excluded ?? [];
  const declined = consent?.declined === true;
  const lands = (rel: string): boolean => {
    if (!decl || declined) return false;
    if (excluded.some((x) => declMatches(x, rel))) return false;
    if (decl.local.some((x) => declMatches(x.path, rel))) return false;
    return decl.shared.some((x) => declMatches(x.path, rel));
  };
  const approved = new Set(consent?.approved ?? []);
  const sends = (rel: string): boolean => {
    if (!lands(rel) || !on()) return false;
    return decl!.shared.some((x) => approved.has(x.path) && declMatches(x.path, rel));
  };
  return { slug, rec, hash, decl, consent, lands, sends, conflicts };
}

// ─── the push gate ─────────────────────────────────────────────────────────────────

export interface AppDataRefusal { path: string; rule: string }

const PLAIN_MODES = new Set(['100644', '100755']);

/** K4 on one blob of `apps/<slug>/<rel>`: mode, name, DB (name and magic), size. Null = passes.
 *  THROWS when git cannot read the blob. Shared by the push gate, the pull gate and the settle plan. */
export function teamBlobRefusal(top: string, rel: string, mode: string, sha: string): string | null {
  if (!PLAIN_MODES.has(mode)) return 'not_plain';
  if (pathNameRefusal(rel)) return 'name';
  if (isDbName(rel)) return 'db_file';
  const size = git.blobSize(top, sha);
  if (size > FILE_MAX_BYTES) return 'too_big';
  const head = git.readBlob(top, sha);
  if (head === null) throw new Error(`blob ${sha} unreadable`);
  if (isSqliteHead(head.subarray(0, 16))) return 'db_file';
  return null;
}

/**
 * Every `apps/` entry a commit of the push range introduces that this Mac may not send, with the
 * rule. THROWS when git cannot answer (the caller holds the push: fail closed).
 */
export function appDataPushRefusals(gitCwd: string, contextRoot: string, remoteRef: string | null, opts: { home: string; mode?: { fullRepo: boolean; cloudSyncOn: boolean } }): AppDataRefusal[] {
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (prefix === null) return [];
  const top = git.topLevel(gitCwd);
  if (!top) throw new Error('no git top folder');
  const projectRoot = realpathSync.native(`${contextRoot}/..`);
  const spec = `:(top,icase)${prefix}${APPS_DATA_FOLDER}`;
  const ref = remoteRef && git.revParse(gitCwd, remoteRef) ? remoteRef : null;
  const views = new Map<string, AppShareView>();
  const view = (slug: string): AppShareView => {
    let v = views.get(slug);
    if (!v) { v = appShareView(projectRoot, slug, opts); views.set(slug, v); }
    return v;
  };
  const out: AppDataRefusal[] = [];
  const seen = new Set<string>();
  const refuse = (path: string, rule: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, rule });
  };
  for (const c of git.commitsToPush(gitCwd, ref)) {
    for (const e of git.introducedEntries(top, c, [spec])) {
      const at = splitAppPath(prefix, e.path);
      if (!at) { refuse(e.path, 'name'); continue; }
      const v = view(at.slug);
      if (e.deleted) {
        if (!listTombstones(opts.home, v.hash).some((t) => t.path === at.rel)) refuse(e.path, 'delete_without_tombstone');
        continue;
      }
      const bad = teamBlobRefusal(top, at.rel, e.mode, e.sha);
      if (bad) { refuse(e.path, bad); continue; }
      // A path held `conflict` (a teammate's copy waits for a human) is refused only when the tip
      // this push would leave carries a copy other than the team's: then mine would go over
      // theirs. A commit of the range that carried mine BEFORE the conflict existed (sent while
      // approved, then superseded by a merge whose result is the team's copy) is history, not
      // an overwrite: the team's copy stays on top.
      if (v.conflicts.has(at.rel)) {
        const tip = git.blobId(top, `HEAD:${e.path}`);
        const team = ref ? git.blobId(top, `${ref}:${e.path}`) : null;
        if (tip !== team) { refuse(e.path, 'conflict'); continue; }
      }
      if (!v.sends(at.rel)) refuse(e.path, 'not_shared_here');
    }
  }
  return out;
}

/**
 * The push gate in the sync engine's shape: the first refusal as `<path> (<rule>)`, or null.
 * THROWS when git cannot answer.
 */
export function appDataInPushRange(gitCwd: string, contextRoot: string, remoteRef: string | null, opts: { home: string; mode?: { fullRepo: boolean; cloudSyncOn: boolean } } = { home: homedir() }): string | null {
  const r = appDataPushRefusals(gitCwd, contextRoot, remoteRef, opts);
  if (!r.length) return null;
  return `${r[0].path} (${r[0].rule})${r.length > 1 ? ` +${r.length - 1}` : ''}`;
}

// ─── the pull gate ─────────────────────────────────────────────────────────────────

/**
 * Every incoming `apps/` entry of `HEAD...remoteRef` that stops the pull, with the rule; null
 * when git cannot answer (the caller skips the pull). Deletions pass (K6 decides about them).
 */
export function incomingAppDataRefusals(gitCwd: string, contextRoot: string, remoteRef: string): AppDataRefusal[] | null {
  let prefix: string | null;
  try { prefix = brainPrefix(gitCwd, contextRoot); } catch { return null; }
  if (prefix === null) return [];
  const top = git.topLevel(gitCwd);
  if (!top) return null;
  const spec = `:(top,icase)${prefix}${APPS_DATA_FOLDER}`;
  const appsDir = `${prefix}${APPS_DATA_FOLDER}`;
  const out: AppDataRefusal[] = [];
  try {
    const entries = git.rawEntries(top, `HEAD...${remoteRef}`, [spec]);
    if (!entries.length) return [];
    for (const e of entries) {
      if (e.newMode === '000000') continue;
      if (!e.path.startsWith(prefix)) { out.push({ path: e.path, rule: 'case' }); continue; }
      const rest = e.path.slice(prefix.length).split('/');
      if (rest[0] !== APPS_DATA_FOLDER) { out.push({ path: e.path, rule: 'case' }); continue; }
      if (rest.length < 3) { out.push({ path: e.path, rule: 'not_folder' }); continue; }
      if (!APP_SLUG_RE.test(rest[1])) { out.push({ path: e.path, rule: 'name' }); continue; }
      const bad = teamBlobRefusal(top, rest.slice(2).join('/'), e.newMode, e.newSha ?? '');
      if (bad) out.push({ path: e.path, rule: bad });
    }
    // A letter-case twin: a path folding equal to a different one, in the team's tree or against ours.
    const theirs = git.treeEntriesLong(top, remoteRef, appsDir);
    let ours: git.LongTreeEntry[] = [];
    try { ours = git.treeEntriesLong(top, 'HEAD', appsDir); } catch { ours = []; }
    const folded = new Map<string, string>();
    for (const t of [...ours, ...theirs]) {
      const f = foldName(t.path);
      const was = folded.get(f);
      if (was !== undefined && was !== t.path && theirs.some((x) => x.path === t.path)) out.push({ path: t.path, rule: 'case' });
      else if (was === undefined) folded.set(f, t.path);
    }
    // The totals, on the tree the pull would leave: per app, and the brain's.
    const perApp = new Map<string, number>();
    let brain = 0;
    for (const t of theirs) {
      const at = splitAppPath(prefix, t.path);
      if (!at) continue;
      perApp.set(at.slug, (perApp.get(at.slug) ?? 0) + t.size);
      brain += t.size;
    }
    for (const [slug, bytes] of perApp) if (bytes > APP_SHARED_MAX_BYTES) out.push({ path: `${appsDir}/${slug}`, rule: 'over_cap' });
    if (brain > BRAIN_SHARED_MAX_BYTES) out.push({ path: appsDir, rule: 'over_cap' });
  } catch {
    return null;
  }
  return out;
}

/** The pull gate in the sync engine's shape: the refused paths, or null when git cannot answer. */
export function incomingAppData(gitCwd: string, contextRoot: string, remoteRef: string): string[] | null {
  const r = incomingAppDataRefusals(gitCwd, contextRoot, remoteRef);
  return r === null ? null : r.map((x) => `${x.path} (${x.rule})`);
}

export const APP_DATA_HELD_NOTE = "Held the push (app_data_held): a commit holds app data under _dream_context/apps/ that this Mac does not share with the team (not approved here, excluded, local, a file that may not go, or a delete the app did not make). Take it out of the unpushed commit (git rm --cached <path>, then git commit --amend, or approve it on the Apps page if it is the team's) and sync again.";
export const APP_DATA_PULL_NOTE = "Skipped the pull: the team's update carries app data under _dream_context/apps/ that may not come in (a symlink, a database, a file over 5 MB, a dotted or instruction name, a letter-case twin, or over the size limit). Your app data is unchanged; ask whoever pushed it to remove it.";
