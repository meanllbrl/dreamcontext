import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import fg from 'fast-glob';
import { readSetupConfig, updateSetupConfig } from '../setup-config.js';
import { localDir, readLocalJson, updateLocalJson } from '../local-store.js';
import { readMachineIdentity } from '../machine-id.js';
import * as git from '../git-sync/git.js';
import { scrubContent, type ScrubHit } from '../git-sync/scrub.js';
import { listPeople } from '../people-store.js';
import { closeInboxRows, listInboxRows, raiseInboxRow } from '../owner-inbox.js';
import { currentLogin, machineOwner, MACHINE_OWNER_PREFIX, ownedBy, parseOwner, UNOWNED } from './owner.js';
import { parseManifestFrontmatter } from './slot.js';
import { AGENTS_DIR } from './types.js';
import { readActive, writeActiveHere } from './active.js';
import { safeWriteTarget } from '../vault-read.js';

/**
 * Agents and automations ride the EXISTING brain sync (AI Team v2, wave B1). No new sync path:
 * the session-start pull, the after-sleep push and dream-sync carry them as plain text. This
 * module holds what makes that safe:
 *
 *  - the brain-level switch `agentSync` (shared config, ORed on merge, never written false) and
 *    each machine's own confirmation of the migration notice (M0, never in the brain);
 *  - the privacy block: every machine keeps its private agent files out of git through
 *    `.git/info/exclude` (machine-local); only a machine whose owner confirmed agent sync HERE
 *    force-adds its own agent files when it stages, so no pushed `.gitignore` can publish them;
 *  - the staging pass (M3): every sync unstages agent/automation files carrying a secret, with the
 *    brain sync's own scrub rules, and raises an owner-inbox row until the secret is gone;
 *  - the pull-collision guard and the pending restores: a teammate's NEW file landing where this
 *    machine holds an untracked one of the same name parks the local one in M0 and restores it,
 *    renamed, once the merge commits;
 *  - owner stamping (the every-run migration) and the thread-entry ledger.
 */

// ─── The switch and this machine's confirmation ──────────────────────────────────────────────

const LOCAL_FILE = 'agent-sync.json';

interface AgentSyncLocal {
  /** When this machine's owner confirmed the migration notice HERE. */
  confirmedAt?: string;
  /** Brain-relative manifest paths created on this machine (seeded by the migration). */
  createdLocally: string[];
  /** Manifests this machine came to own at migration: feeds only the "replaced through sync" row. */
  ownedAtMigration: string[];
  /** The `id` each created-here manifest had when last seen, to catch a replacement by sync. */
  knownIds?: Record<string, string>;
}

const EMPTY_LOCAL: AgentSyncLocal = { createdLocally: [], ownedAtMigration: [] };

function cleanLocal(v: AgentSyncLocal): AgentSyncLocal {
  const strs = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
  return {
    ...(typeof v.confirmedAt === 'string' ? { confirmedAt: v.confirmedAt } : {}),
    createdLocally: strs(v.createdLocally),
    ownedAtMigration: strs(v.ownedAtMigration),
    knownIds: v.knownIds && typeof v.knownIds === 'object' ? v.knownIds : {},
  };
}

export function readAgentSyncLocal(projectRoot: string, home?: string): AgentSyncLocal {
  return cleanLocal(readLocalJson<AgentSyncLocal>(projectRoot, LOCAL_FILE, EMPTY_LOCAL, home));
}

function updateAgentSyncLocal(projectRoot: string, home: string | undefined, mutate: (cur: AgentSyncLocal) => AgentSyncLocal): void {
  updateLocalJson<AgentSyncLocal>(projectRoot, LOCAL_FILE, EMPTY_LOCAL, (cur) => mutate(cleanLocal(cur)), home);
}

export interface AgentSyncState {
  /** The brain's switch (`state/.config.json` `agentSync`). */
  switchOn: boolean;
  /** This machine's owner confirmed the notice here. */
  confirmedHere: boolean;
  /** Both: this machine's agents ride the sync. */
  active: boolean;
}

export function agentSyncSwitchOn(contextRoot: string): boolean {
  return readSetupConfig(dirname(contextRoot))?.agentSync === true;
}

export function agentSyncState(contextRoot: string, home?: string): AgentSyncState {
  const switchOn = agentSyncSwitchOn(contextRoot);
  const confirmedHere = !!readAgentSyncLocal(dirname(contextRoot), home).confirmedAt;
  return { switchOn, confirmedHere, active: switchOn && confirmedHere };
}

// ─── Which paths are agent paths ──────────────────────────────────────────────────────────────

/** Brain-relative private patterns (as `.gitignore` lines). Cache entries are NOT here: they stay
 *  local forever, in the tracked ignore. */
export const AGENT_PRIVATE_ENTRIES = ['agents/*.md', 'automations/*.md', 'automations/output/*/*', 'automations/threads/*/*'];
export const AGENT_PRIVATE_ENTRIES_ROOT = AGENT_PRIVATE_ENTRIES.map((e) => `_dream_context/${e}`);

const AGENT_PATH_RE = /^(?:_dream_context\/)?(agents|automations)\/(.+)$/;

/** True for a repo- or brain-relative path under `agents/` or `automations/` (cache included). */
export function isAgentPath(relPath: string): boolean {
  return AGENT_PATH_RE.test(relPath.replace(/\\/g, '/'));
}

/** The slug a path under agents/ or automations/ belongs to, or null. */
export function slugOfAgentPath(relPath: string): string | null {
  const m = relPath.replace(/\\/g, '/').match(AGENT_PATH_RE);
  if (!m) return null;
  const rest = m[2];
  const top = rest.match(/^([a-z0-9][a-z0-9-]*)\.md$/);
  if (top) return top[1];
  const nested = rest.match(/^(?:threads|output|\.active)\/([a-z0-9][a-z0-9-]*)(?:\/|\.json$)/);
  if (nested) return nested[1];
  const cache = rest.match(/^cache\/\.?([a-z0-9][a-z0-9-]*)\./);
  return cache ? cache[1] : null;
}

function isManifestPath(relPath: string): boolean {
  return /^(?:_dream_context\/)?(?:agents|automations)\/[a-z0-9][a-z0-9-]*\.md$/.test(relPath.replace(/\\/g, '/'));
}

// ─── The privacy block in .git/info/exclude ───────────────────────────────────────────────────

const EXCLUDE_BEGIN = '# >>> dreamcontext: agent files stay on this machine unless agent sync is confirmed here';
const EXCLUDE_END = '# <<< dreamcontext agents';
/** Never synced, on any machine: the run lock, the in-flight sidecar, the cache record. */
const LOCAL_ONLY_ENTRIES = ['automations/cache/*.lock', 'automations/cache/*.run.json', 'automations/cache/*.run.json.tmp', 'automations/cache/*.json', 'agents/.active/*.tmp'];

/** The brain folder's path inside its git repo (`_dream_context/`), real paths compared. */
export function brainPrefix(gitCwd: string, contextRoot: string): string | null {
  const top = git.topLevel(gitCwd);
  if (!top) return null;
  let rel: string;
  try {
    // git prints the real path (`/private/var/…` on macOS): compare real paths, in the on-disk
    // letter case (native), composed (NFC) as git prints every path it lists.
    rel = relative(realpathSync.native(top), realpathSync.native(contextRoot)).normalize('NFC');
  } catch {
    return null;
  }
  if (rel.startsWith('..')) return null;
  return rel ? `${rel.split(sep).join('/')}/` : '';
}

/**
 * Keep the machine-local privacy block in `.git/info/exclude`: every private agent pattern and
 * every local-only cache pattern, on every machine. The tracked `.gitignore` is never edited for
 * agent sync (two machines editing it would conflict, and the project-root one is a code file):
 * a machine whose owner confirmed agent sync instead force-adds its own agent files in the
 * staging pass (`agentStagePass`), which no ignore rule can stop. A pushed `.gitignore` without
 * the old lines therefore never publishes an unconfirmed machine's agents. Idempotent; best effort.
 */
export function applyAgentPrivacy(contextRoot: string): void {
  const gitCwd = dirname(contextRoot);
  if (!git.isGitRepo(gitCwd)) return;
  const path = git.gitPathFor(gitCwd, 'info/exclude');
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (!path || prefix === null) return;
  let text = '';
  try { text = readFileSync(path, 'utf-8'); } catch { text = ''; }
  const block = [EXCLUDE_BEGIN, ...[...AGENT_PRIVATE_ENTRIES, ...LOCAL_ONLY_ENTRIES].map((e) => `/${prefix}${e}`), EXCLUDE_END].join('\n');
  const start = text.indexOf(EXCLUDE_BEGIN);
  const end = start === -1 ? -1 : text.indexOf(EXCLUDE_END, start);
  const without = start === -1 || end === -1 ? text : `${text.slice(0, start)}${text.slice(end + EXCLUDE_END.length).replace(/^\n/, '')}`;
  const next = `${without.replace(/\n*$/, '')}${without.trim() ? '\n' : ''}${block}\n`;
  if (next === text) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, 'utf-8');
  } catch {
    // an unwritable git dir keeps the tracked ignore lines as the only privacy
  }
}

/** True for a brain-relative path matching a local-only pattern. */
function isLocalOnly(brainRel: string): boolean {
  return /^automations\/cache\//.test(brainRel) || /^agents\/\.active\/.*\.tmp$/.test(brainRel);
}

/** The brain-relative shapes this machine force-adds once agent sync is confirmed here. */
const FORCE_ADD_RE = /^(?:agents\/[a-z0-9][a-z0-9-]*\.md|agents\/\.active\/[a-z0-9][a-z0-9-]*\.json|automations\/[a-z0-9][a-z0-9-]*\.md|automations\/(?:output|threads)\/[a-z0-9][a-z0-9-]*\/[^/]+)$/;

/**
 * On a machine where agent sync is confirmed: stage (`git add -f`) this machine's agent and
 * automation files that an ignore rule holds back (the tracked `.gitignore` lines every version
 * writes, and the privacy block). Cache files never. Returns the repo-relative paths added.
 */
function forceAddOwnAgentFiles(gitCwd: string, contextRoot: string): string[] {
  const add = ownAgentFilesToAdd(gitCwd, contextRoot);
  for (const p of add) git.forceAddPath(gitCwd, p);
  return add;
}

function ownAgentFilesToAdd(gitCwd: string, contextRoot: string): string[] {
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (prefix === null) return [];
  const ignored = git.ignoredUntracked(gitCwd, [`${prefix}agents`, `${prefix}automations`]);
  return ignored.filter((p) => p.startsWith(prefix) && !isLocalOnly(p.slice(prefix.length)) && FORCE_ADD_RE.test(p.slice(prefix.length)));
}

/**
 * The agent files this machine would force-add right now (agent sync confirmed here), as extra
 * "dirty" paths: an ignored file never shows in `git status`, and a sync that sees no change would
 * never stage it. `[]` when this machine is not active. Never throws.
 */
export function pendingOwnAgentFiles(gitCwd: string, contextRoot: string, home?: string): string[] {
  try {
    if (!agentSyncState(contextRoot, home).active || git.hasMergeHead(gitCwd) || nestedBrainPrefix(gitCwd, contextRoot) !== null) return [];
    // A file held back for a secret is not a change to send: counting it would make every sync
    // see a dirty tree (and an on-open pull with checkpoints off would skip forever).
    const held = heldSecretPaths(contextRoot, home);
    return ownAgentFilesToAdd(gitCwd, contextRoot).filter((p) => !held.has(p));
  } catch {
    return [];
  }
}

// ─── The migration notice: preview, turn on, confirm here ─────────────────────────────────────

export interface AgentSyncPreview {
  /** Brain-relative files that would start to sync from this machine. */
  files: string[];
  /** Scrub hits in them (redacted). A BLOCK hit never pushes; a WARN pushes once confirmed. */
  hits: ScrubHit[];
}

/** Every private file this machine holds (untracked or ignored) under agents/ and automations/. */
function localPrivateFiles(contextRoot: string): string[] {
  const gitCwd = dirname(contextRoot);
  const prefix = brainPrefix(gitCwd, contextRoot) ?? '_dream_context/';
  const tracked = new Set(git.isGitRepo(gitCwd) ? git.treePaths(gitCwd, 'HEAD') : []);
  const out: string[] = [];
  const patterns = ['agents/*.md', 'automations/*.md', 'automations/output/*/*', 'automations/threads/*/*'];
  for (const rel of fg.sync(patterns, { cwd: contextRoot, onlyFiles: true, dot: false, followSymbolicLinks: false })) {
    if (!tracked.has(`${prefix}${rel}`)) out.push(rel);
  }
  return out.sort();
}

export function agentSyncPreview(contextRoot: string): AgentSyncPreview {
  const files = localPrivateFiles(contextRoot);
  const hits: ScrubHit[] = [];
  for (const rel of files) {
    let text: string;
    try {
      if (!lstatSync(join(contextRoot, rel)).isFile()) continue;
      text = readFileSync(join(contextRoot, rel), 'utf-8');
    } catch { continue; }
    hits.push(...scrubContent(rel, text));
  }
  return { files, hits };
}

/** Turn the brain's switch on. Never writes it false (there is no off). */
export function turnOnAgentSync(contextRoot: string): void {
  if (agentSyncSwitchOn(contextRoot)) return;
  updateSetupConfig(dirname(contextRoot), { agentSync: true });
}

/**
 * This machine's owner confirmed the notice HERE: rename this machine's own thread day files to
 * `<day>-<machineId>.md`, seed the thread-entry ledger from them, record the confirmation (M0)
 * and claim this machine's own agents (`.active`). From the next sync on, the staging pass
 * force-adds this machine's agent files. The switch must be on (the notice turns it on first).
 * Idempotent.
 */
export function confirmAgentSyncHere(contextRoot: string, home?: string, now: Date = new Date()): { renamed: number } {
  turnOnAgentSync(contextRoot);
  const projectRoot = dirname(contextRoot);
  // Seeds the created-locally set from git state (files untracked here were made here).
  stampOwners(contextRoot, home);
  const renamed = renameLocalThreadDays(contextRoot, home);
  seedThreadLedger(contextRoot, home);
  updateAgentSyncLocal(projectRoot, home, (cur) => ({ ...cur, confirmedAt: cur.confirmedAt ?? now.toISOString() }));
  applyAgentPrivacy(contextRoot);
  claimCreatedAgents(contextRoot, home, now);
  return { renamed };
}

/**
 * The agents CREATED on this machine run here: claim each one that nobody has claimed yet
 * (`agents/.active/<slug>.json`), so the owner's other machines see where it runs.
 */
function claimCreatedAgents(contextRoot: string, home: string | undefined, now: Date): void {
  const created = new Set(readAgentSyncLocal(dirname(contextRoot), home).createdLocally);
  for (const rel of manifestFiles(contextRoot)) {
    if (!rel.startsWith('agents/') || !created.has(rel)) continue;
    try {
      const owner = parseOwner(parseManifestFrontmatter(readFileSync(join(contextRoot, rel), 'utf-8')).data.owner);
      const slug = basename(rel, '.md');
      if (!ownedBy(owner) || readActive(contextRoot, slug, owner, now)) continue;
      writeActiveHere(contextRoot, slug, owner, home, now);
    } catch {
      // unclaimed: it runs wherever its owner starts it, as before
    }
  }
}

/** Rename this machine's untracked legacy day files `<day>.md` to `<day>-<machineId>.md`. */
function renameLocalThreadDays(contextRoot: string, home?: string): number {
  const id = readMachineIdentity(home).id;
  const gitCwd = dirname(contextRoot);
  const prefix = brainPrefix(gitCwd, contextRoot) ?? '_dream_context/';
  const tracked = new Set(git.isGitRepo(gitCwd) ? git.treePaths(gitCwd, 'HEAD') : []);
  let n = 0;
  for (const rel of fg.sync('automations/threads/*/*.md', { cwd: contextRoot, onlyFiles: true, followSymbolicLinks: false })) {
    const m = basename(rel).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m || tracked.has(`${prefix}${rel}`)) continue;
    const to = join(contextRoot, dirname(rel), `${m[1]}-${id}.md`);
    if (existsSync(to)) continue;
    try {
      if (!lstatSync(join(contextRoot, rel)).isFile()) continue;
      renameSync(join(contextRoot, rel), to);
      n++;
    } catch {
      // stays under its old name; the reader takes both
    }
  }
  return n;
}

// ─── M3: the staging pass of every brain sync ─────────────────────────────────────────────────

export interface StagePassResult {
  /** Paths unstaged this pass (repo-relative). */
  held: string[];
  /** The hits that held them (redacted). */
  hits: ScrubHit[];
}

/**
 * Called right after every `git add -A` of a brain sync, before its scrub. For each staged path
 * under agents/ or automations/: a BLOCK hit is unstaged (`git restore --staged`, tracked or new,
 * on every pass: the remote keeps its last clean version, and the file syncs again once the secret
 * is gone); on a machine where the switch is on but the notice is not confirmed, a
 * `generic-secret-assignment` WARN on this machine's own edit is unstaged too. Inside an open merge
 * only this machine's own edits are touched: a path whose staged content equals MERGE_HEAD's is
 * incoming, and an incoming secret keeps today's `blocked-scrub`. Raises one owner-inbox row per
 * held path and closes the rows of paths no longer held. A project in a subfolder of its repo
 * holds every agent path (agents never sync there). Never throws.
 */
export function agentStagePass(gitCwd: string, contextRoot: string, opts: { home?: string } = {}): StagePassResult {
  const held: string[] = [];
  const hits: ScrubHit[] = [];
  try {
    const nested = nestedBrainPrefix(gitCwd, contextRoot);
    if (nested !== null) {
      // git resolves the folders from the brain itself: no path spelling to compare.
      const top = git.topLevel(gitCwd) ?? gitCwd;
      for (const path of git.stagedPaths(contextRoot, [':(icase)agents', ':(icase)automations'])) {
        git.restoreStaged(top, path);
        held.push(path);
      }
      return { held, hits };
    }
    const { switchOn, confirmedHere } = agentSyncState(contextRoot, opts.home);
    if (switchOn && confirmedHere && !git.hasMergeHead(gitCwd)) forceAddOwnAgentFiles(gitCwd, contextRoot);
    let staged = git.stagedPaths(gitCwd).filter(isAgentPath);
    if (staged.length === 0) {
      closeStaleSecretRows(dirname(contextRoot), held, opts.home);
      return { held, hits };
    }
    const inMerge = git.hasMergeHead(gitCwd);
    // Not confirmed here: this machine's own agent files never leave it, whatever an ignore rule
    // says (a teammate's `.gitignore` negation beats `.git/info/exclude`). A path tracked by
    // neither HEAD nor the incoming merge is this machine's private file; a legacy-shared member
    // (`shared: true`) keeps publishing as before.
    if (!(switchOn && confirmedHere)) {
      const shared = legacySharedKeys(gitCwd, contextRoot, inMerge, opts.home);
      for (const path of staged) {
        if (git.blobId(gitCwd, `HEAD:${path}`) !== null) continue;
        if (inMerge && git.blobId(gitCwd, `MERGE_HEAD:${path}`) !== null) continue;
        const key = legacyShareKey(path);
        if (key && shared.has(key)) continue;
        git.restoreStaged(gitCwd, path);
      }
      staged = git.stagedPaths(gitCwd).filter(isAgentPath);
    }
    const holdWarnAssignments = switchOn && !confirmedHere;
    for (const path of staged) {
      if (inMerge) {
        const mine = git.blobId(gitCwd, `:${path}`);
        const theirs = git.blobId(gitCwd, `MERGE_HEAD:${path}`);
        if (mine !== null && mine === theirs) continue; // incoming: never unstaged here
      }
      const text = git.showSpec(gitCwd, `:${path}`);
      if (text === null) continue; // a deletion carries no secret
      const found = scrubContent(path, text);
      const holding = found.filter((h) => h.severity === 'block' || (holdWarnAssignments && h.rule === 'generic-secret-assignment'));
      if (holding.length === 0) continue;
      git.restoreStaged(gitCwd, path);
      held.push(path);
      hits.push(...holding);
    }
    const projectRoot = dirname(contextRoot);
    for (const path of held) {
      const slug = slugOfAgentPath(path);
      const rule = hits.find((h) => h.file === path)?.rule ?? 'secret';
      raiseInboxRow(projectRoot, {
        kind: 'secret-held',
        ref: path,
        agent: slug,
        title: `${path} looks like it holds a secret (${rule}), so it stays on this machine. Remove it and it syncs again.`,
        actions: ['dismiss'],
        dedupeKey: `secret-held:${path}`,
      }, opts.home);
    }
    closeStaleSecretRows(projectRoot, held, opts.home);
  } catch {
    // the brain sync's own scrub still runs after this pass
  }
  return { held, hits };
}

function closeStaleSecretRows(projectRoot: string, held: string[], home?: string): void {
  const keep = new Set(held);
  closeInboxRows(projectRoot, (r) => r.kind === 'secret-held' && !keep.has(r.ref), home);
}

/** `<folder>:<slug>` for a path under agents/ or automations/: what a `shared: true` manifest in
 *  that folder publishes (agents/<s>.md covers agents/ only; automations/<s>.md covers its file,
 *  threads and output). */
function legacyShareKey(relPath: string): string | null {
  const m = relPath.replace(/\\/g, '/').match(AGENT_PATH_RE);
  const slug = slugOfAgentPath(relPath);
  return m && slug ? `${m[1]}:${slug}` : null;
}

/**
 * What this machine publishes the old way: `shared: true` honoured only on a manifest this machine
 * created or owned at migration (M0), or one no sync brought (tracked by neither HEAD nor the
 * incoming merge); never on one a teammate pushed (a pushed `shared: true` with a guessed slug
 * would otherwise publish this machine's private files of that name).
 */
function legacySharedKeys(gitCwd: string, contextRoot: string, inMerge: boolean, home?: string): Set<string> {
  const out = new Set<string>();
  const local = readAgentSyncLocal(dirname(contextRoot), home);
  const mine = new Set([...local.createdLocally, ...local.ownedAtMigration]);
  const prefix = brainPrefix(gitCwd, contextRoot) ?? '_dream_context/';
  const neverSynced = (rel: string): boolean =>
    git.blobId(gitCwd, `HEAD:${prefix}${rel}`) === null && !(inMerge && git.blobId(gitCwd, `MERGE_HEAD:${prefix}${rel}`) !== null);
  for (const rel of manifestFiles(contextRoot)) {
    if (!mine.has(rel) && !neverSynced(rel)) continue;
    try {
      const abs = join(contextRoot, rel);
      if (!lstatSync(abs).isFile()) continue;
      const key = legacyShareKey(rel);
      if (key && parseManifestFrontmatter(readFileSync(abs, 'utf-8')).data.shared === true) out.add(key);
    } catch {
      // unreadable: not shared
    }
  }
  return out;
}

/** Repo-relative paths held back for a secret right now (their open owner-inbox rows). */
export function heldSecretPaths(contextRoot: string, home?: string): Set<string> {
  const out = new Set<string>();
  try {
    const gitCwd = dirname(contextRoot);
    for (const r of listInboxRows(gitCwd, home)) {
      if (r.kind !== 'secret-held') continue;
      // Still holding a secret? Once it is gone the file is a change again, so the next staging
      // pass sends it and closes the row.
      let text: string;
      try {
        if (!lstatSync(join(gitCwd, r.ref)).isFile()) continue;
        text = readFileSync(join(gitCwd, r.ref), 'utf-8');
      } catch { continue; }
      if (scrubContent(r.ref, text).some((h) => h.severity === 'block' || h.rule === 'generic-secret-assignment')) out.add(r.ref);
    }
  } catch {
    // nothing held: the staging pass decides again
  }
  return out;
}

/** WARN hits under agents/ and automations/ are reported but never count toward strict: an
 *  incoming agent output with a home path must not abort a teammate's headless pull. */
export function strictWarns(warns: readonly ScrubHit[]): ScrubHit[] {
  return warns.filter((w) => !isAgentPath(w.file));
}

// ─── The pull-collision guard and the pending restores ───────────────────────────────────────

export interface PendingRestore {
  /** The name it is being restored under, written before the restore moves anything. */
  to?: string;
  /** Repo-relative path the incoming file takes. */
  path: string;
  slug: string;
  /** Absolute path of the parked copy in M0. */
  backup: string;
  /** The remote commit the merge brought in. */
  remoteSha: string;
  at: string;
}

const RESTORES_FILE = 'agent-restores.json';

interface RestoresFile {
  pending: PendingRestore[];
}

export function readPendingRestores(projectRoot: string, home?: string): PendingRestore[] {
  const f = readLocalJson<RestoresFile>(projectRoot, RESTORES_FILE, { pending: [] }, home);
  return Array.isArray(f.pending) ? f.pending.filter((p) => p && typeof p.path === 'string' && typeof p.backup === 'string') : [];
}

function runLockHeld(contextRoot: string, slug: string): boolean {
  const lock = join(contextRoot, 'automations', 'cache', `.${slug}.lock`);
  try {
    const info = JSON.parse(readFileSync(lock, 'utf-8')) as { pid?: unknown };
    if (typeof info.pid !== 'number') return true;
    try {
      process.kill(info.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  } catch {
    return false;
  }
}

function setPendingTarget(projectRoot: string, backup: string, to: string, home?: string): void {
  updateLocalJson<RestoresFile>(projectRoot, RESTORES_FILE, { pending: [] }, (cur) => ({
    pending: (Array.isArray(cur.pending) ? cur.pending : []).map((p) => (p.backup === backup ? { ...p, to } : p)),
  }), home);
}

/**
 * Move one file, across volumes too: the M0 store lives in the home folder, a project may live on
 * another disk, and `rename` cannot cross devices (EXDEV). Falls back to copy, flush, then unlink;
 * the source goes only once the copy is complete.
 */
export function moveFileAcross(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
    const fd = openSync(to, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    unlinkSync(from);
  }
}

export type GuardResult = { ok: true; parked: PendingRestore[] } | { ok: false; note: string };

/**
 * Before a pull's merge: incoming ADDED paths under agents/ and automations/ that exist here as
 * untracked or ignored files are MOVED (not copied, so git never refuses the merge) to M0 as a
 * pending restore; the record is written before the move. Runs under the brain sync lock, like
 * the merge and the resolution. A local run of a colliding slug holding its run lock skips the
 * pull with a note (retried next time).
 */
export function guardPullCollisions(gitCwd: string, contextRoot: string, remoteRef: string, home?: string, now: Date = new Date()): GuardResult {
  const parked: PendingRestore[] = [];
  // A symlink (or a submodule) under agents/ or automations/ is never taken in, nor anything
  // but a folder where the brain, agents/ or automations/ is: once checked out, a writer or a
  // reader of this machine could be steered outside the vault through it (M2), and git deletes
  // the ignored private files of a folder it replaces. The pull waits; a guard that cannot
  // answer skips it too.
  const refused = refusedShapes(gitCwd, contextRoot, remoteRef);
  if (refused === null) {
    return { ok: false, note: 'Skipped the pull: could not check what the team\'s update does to agents/ and automations/. It is retried at the next sync.' };
  }
  if (refused.length > 0 && nestedBrainPrefix(gitCwd, contextRoot) !== null) {
    return { ok: false, note: `Skipped the pull: the team's update changes agent files (${refused.slice(0, 3).join(', ')}), and agents only sync when the project is the top folder of its git repository.` };
  }
  if (refused.length > 0) {
    return { ok: false, note: `Skipped the pull: the team's update turns ${refused.slice(0, 3).join(', ')} into a symlink, a submodule or a file, which is never taken in. Ask whoever pushed it to remove it.` };
  }
  try {
    const incoming = git.addedPaths(gitCwd, `HEAD...${remoteRef}`).filter(isAgentPath);
    if (incoming.length === 0) return { ok: true, parked };
    const remoteSha = git.revParse(gitCwd, remoteRef) ?? '';
    const collisions = incoming.filter((p) => {
      const abs = join(gitCwd, p);
      if (!existsSync(abs)) return false;
      return git.blobId(gitCwd, `HEAD:${p}`) === null; // untracked or ignored here
    });
    if (collisions.length === 0) return { ok: true, parked };
    for (const p of collisions) {
      const slug = slugOfAgentPath(p);
      if (slug && runLockHeld(contextRoot, slug)) {
        return { ok: false, note: `Skipped the pull: ${slug} is running here and a teammate's ${slug} is arriving. It is retried at the next sync.` };
      }
    }
    const projectRoot = dirname(contextRoot);
    const dir = join(localDir(projectRoot, home), 'restores');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const p of collisions) {
      const abs = join(gitCwd, p);
      try {
        if (!lstatSync(abs).isFile()) continue; // never follow or move a link
      } catch { continue; }
      const rec: PendingRestore = {
        path: p,
        slug: slugOfAgentPath(p) ?? basename(p),
        backup: join(dir, `${now.getTime()}-${randomBytes(4).toString('hex')}-${basename(p)}`),
        remoteSha,
        at: now.toISOString(),
      };
      updateLocalJson<RestoresFile>(projectRoot, RESTORES_FILE, { pending: [] }, (cur) => ({
        pending: [...(Array.isArray(cur.pending) ? cur.pending : []), rec],
      }), home);
      try {
        moveFileAcross(abs, rec.backup);
      } catch {
        // Could not park it: take the record back and skip the pull, never let the merge refuse.
        updateLocalJson<RestoresFile>(projectRoot, RESTORES_FILE, { pending: [] }, (cur) => ({
          pending: (Array.isArray(cur.pending) ? cur.pending : []).filter((p) => p.backup !== rec.backup),
        }), home);
        return { ok: false, note: `Skipped the pull: ${p} could not be set aside before a teammate's file of the same name arrives. It is retried at the next sync.` };
      }
      parked.push(rec);
      raiseInboxRow(projectRoot, {
        kind: 'parked',
        ref: rec.slug,
        agent: rec.slug,
        title: `${rec.slug} is parked until the brain merge finishes: a teammate's ${rec.slug} arrived with the same name.`,
        actions: ['dismiss'],
        dedupeKey: `parked:${rec.slug}`,
      }, home);
    }
  } catch {
    // a guard that cannot run leaves git to refuse the merge, which aborts it cleanly
  }
  return { ok: true, parked };
}

/**
 * The brain's path from its repo's top folder when that is not `_dream_context/` (the project is
 * a subfolder of its repo), else null. The brain sync reads every path as `_dream_context/…`
 * from the top, so in that layout agent files never sync: the staging pass holds them all and a
 * pull that touches them is skipped (parking cannot run there).
 */
function nestedBrainPrefix(gitCwd: string, contextRoot: string): string | null {
  const prefix = brainPrefix(gitCwd, contextRoot);
  return prefix !== null && prefix !== '_dream_context/' ? prefix : null;
}

/**
 * Paths the remote side of a pull would turn into something other than what agent files may
 * live in: a symlink or submodule under agents/ or automations/, a file where this machine has a
 * folder under them (git deletes the ignored private files of a folder it replaces), a non-folder
 * at the brain folder, any folder above it, agents/ or automations/, and any spelling of those that
 * differs only in letter case (a case-insensitive disk checks it out over the real folder). In a
 * nested layout, any incoming change under agents/ or automations/. Git runs from the repo's top
 * folder, where every path below is rooted. Null when git cannot answer.
 */
function refusedShapes(gitCwd: string, contextRoot: string, remoteRef: string): string[] | null {
  try {
    const top = git.topLevel(gitCwd);
    if (!top) return null;
    const prefix = brainPrefix(gitCwd, contextRoot) ?? '_dream_context/';
    const nested = nestedBrainPrefix(gitCwd, contextRoot) !== null;
    const same = (a: string, b: string): boolean => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
    const parts = [...prefix.split('/').filter(Boolean), 'agents'];
    const out: string[] = [];
    // Each guarded folder, from the top down: in its parent, every entry named like it in any
    // letter case must be exactly it, and a folder.
    const guarded = [...parts.map((_, i) => parts.slice(0, i + 1)), [...prefix.split('/').filter(Boolean), 'automations']];
    for (const segs of guarded) {
      const parent = segs.slice(0, -1).join('/');
      const name = segs[segs.length - 1];
      for (const child of git.treeChildren(top, remoteRef, parent)) {
        if (!same(child.name, name)) continue;
        if (child.name.normalize('NFC') !== name.normalize('NFC') || child.mode !== '040000') out.push(parent ? `${parent}/${child.name}` : child.name);
      }
    }
    const roots = [`${prefix}agents`, `${prefix}automations`];
    for (const e of git.rawEntries(top, `HEAD...${remoteRef}`, roots.map((r) => `:(icase)${r}`))) {
      if (e.newMode === '000000') continue;
      const exact = roots.some((r) => e.path === r || e.path.startsWith(`${r}/`));
      if (!exact || nested || e.newMode === '120000' || e.newMode === '160000' || isLocalFolder(join(top, e.path))) out.push(e.path);
    }
    return [...new Set(out)];
  } catch {
    return null;
  }
}

function isLocalFolder(abs: string): boolean {
  try {
    return lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** The first `<slug>-<n>` free in this vault (agents and automations, files and parked restores). */
export function firstFreeSlug(contextRoot: string, slug: string): string {
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}`;
    if (!existsSync(join(contextRoot, AGENTS_DIR, `${candidate}.md`)) && !existsSync(join(contextRoot, 'automations', `${candidate}.md`))) {
      return candidate;
    }
  }
  return `${slug}-${randomBytes(3).toString('hex')}`;
}

/**
 * Resolve every pending restore. Called at the end of every sync call (after `--continue` and
 * `--resume` too) and at session start, under the brain sync lock:
 *  - merge committed (the path is in HEAD, no MERGE_HEAD): the parked copy comes back RENAMED
 *    through `renameAgentLocal`, with one row;
 *  - merge aborted, blocked or failed (path not in HEAD, no MERGE_HEAD): the parked copy moves back
 *    to its original path, where the next pull's guard catches it again;
 *  - MERGE_HEAD still set: stays pending.
 * Returns human notes. Never throws.
 */
export async function resolvePendingRestores(gitCwd: string, contextRoot: string, home?: string): Promise<string[]> {
  const projectRoot = dirname(contextRoot);
  const pending = readPendingRestores(projectRoot, home);
  if (pending.length === 0) return [];
  if (git.hasMergeHead(gitCwd)) return [];
  const notes: string[] = [];
  const { renameAgentLocal } = await import('./rename.js');
  // Agents first, then routines (a routine follows its renamed agent), then outputs (they follow
  // their member's new name).
  const rank = (p: PendingRestore): number => (!isManifestPath(p.path) ? 2 : /(?:^|\/)agents\//.test(p.path) ? 0 : 1);
  const ordered = [...pending].sort((a, b) => rank(a) - rank(b));
  const renamedTo = new Map<string, string>();
  const done = new Set<string>();
  for (const rec of ordered) {
    try {
      if (!existsSync(rec.backup)) {
        // An interrupted rename: its manifest is in place as <to>, the rest is redone.
        const dir = rank(rec) === 0 ? AGENTS_DIR : 'automations';
        if (rec.to && isManifestPath(rec.path) && existsSync(join(contextRoot, dir, `${rec.to}.md`))) {
          renameAgentLocal(contextRoot, rec.slug, rec.to, { home, remoteSha: rec.remoteSha, kind: rank(rec) === 0 ? 'agent' : 'automation', resume: true });
          renamedTo.set(rec.slug, rec.to);
        }
        done.add(rec.backup);
        continue;
      }
      const committed = git.blobId(gitCwd, `HEAD:${rec.path}`) !== null;
      if (!committed) {
        const abs = join(gitCwd, rec.path);
        // Never through a symlink a teammate committed (M2): it stays parked until that is gone.
        if (!safeWriteTarget(contextRoot, abs)) continue;
        if (!existsSync(abs)) {
          mkdirSync(dirname(abs), { recursive: true });
          moveFileAcross(rec.backup, abs);
        }
        done.add(rec.backup);
        continue;
      }
      if (isManifestPath(rec.path)) {
        const to = rec.to ?? renamedTo.get(rec.slug) ?? firstFreeSlug(contextRoot, rec.slug);
        // The new name is written BEFORE anything moves, so a crash mid-rename resumes (above).
        if (!rec.to) setPendingTarget(projectRoot, rec.backup, to, home);
        const kind = rank(rec) === 0 ? 'agent' : 'automation';
        renameAgentLocal(contextRoot, rec.slug, to, { home, remoteSha: rec.remoteSha, manifestSource: rec.backup, kind });
        if (kind === 'automation') rebindToRenamed(join(contextRoot, 'automations', `${to}.md`), renamedTo);
        renamedTo.set(rec.slug, to);
        notes.push(`${rec.slug} on this machine is now ${to}: a teammate's ${rec.slug} arrived with the same name.`);
      } else {
        // A non-manifest copy (a same-named output) is restored under the renamed slug, never at
        // its original path, which HEAD now tracks for the teammate.
        const to = renamedTo.get(rec.slug);
        const rel = rec.path.replace(/\\/g, '/');
        const target = to
          ? rel.replace(new RegExp(`/(threads|output)/${rec.slug}/`), `/$1/${to}/`)
          : rel.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${readMachineIdentity(home).id}${ext}`);
        const abs = join(gitCwd, target);
        if (!safeWriteTarget(contextRoot, abs)) continue;
        if (!existsSync(abs)) {
          mkdirSync(dirname(abs), { recursive: true });
          moveFileAcross(rec.backup, abs);
        }
      }
      done.add(rec.backup);
    } catch {
      // stays pending; the next sync tries again
    }
  }
  if (renamedTo.size > 0) {
    // ONE row for the whole resolution, naming both sides of every rename.
    const pairs = [...renamedTo].map(([from, to]) => `${from} → ${to}`).join(', ');
    raiseInboxRow(projectRoot, {
      kind: 'renamed',
      ref: [...renamedTo.values()][0],
      agent: [...renamedTo.values()][0],
      title: `A teammate's member arrived with the same name and kept it, so yours ${renamedTo.size === 1 ? 'was' : 'were'} renamed: ${pairs}.`,
      actions: ['dismiss'],
      dedupeKey: `renamed:${pairs}`,
    }, home);
  }
  if (done.size > 0) {
    updateLocalJson<RestoresFile>(projectRoot, RESTORES_FILE, { pending: [] }, (cur) => ({
      pending: (Array.isArray(cur.pending) ? cur.pending : []).filter((p) => !done.has(p.backup)),
    }), home);
    const still = new Set(readPendingRestores(projectRoot, home).map((p) => p.slug));
    closeInboxRows(projectRoot, (r) => r.kind === 'parked' && !still.has(r.ref), home);
  }
  return notes;
}

/** A restored routine whose agent was renamed in the same resolution follows it. */
function rebindToRenamed(path: string, renamedTo: Map<string, string>): void {
  try {
    if (!lstatSync(path).isFile()) return;
    const raw = readFileSync(path, 'utf-8');
    const agent = parseManifestFrontmatter(raw).data.agent;
    const to = typeof agent === 'string' ? renamedTo.get(agent.trim()) : undefined;
    if (to) writeFileSync(path, raw.replace(/^agent:.*$/m, `agent: ${to}`), 'utf-8');
  } catch {
    // left bound to the teammate's agent: its hash matches nothing here, so it stays blocked
  }
}

// ─── Owner stamping (the every-run migration) ─────────────────────────────────────────────────

/** A GitHub login from a commit author email: `<id>+<login>@users.noreply.github.com` or
 *  `<login>@users.noreply.github.com` (what the brain sync commits as), else the roster person
 *  whose emails include it and whose `githubLogin` is known. */
export function loginFromEmail(contextRoot: string, email: string | null): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  const noreply = e.match(/^(?:\d+\+)?([a-z0-9](?:[a-z0-9-]{0,38}))@users\.noreply\.github\.com$/);
  if (noreply) return noreply[1];
  try {
    const config = readSetupConfig(dirname(contextRoot));
    for (const p of listPeople(contextRoot)) {
      if (!(p.emails ?? []).some((x) => x.toLowerCase() === e)) continue;
      const login = config?.peopleIdentity?.[p.slug]?.githubLogin;
      if (login && login.trim()) return login.trim();
    }
  } catch {
    // an unreadable roster resolves nobody
  }
  return null;
}

function manifestFiles(contextRoot: string): string[] {
  return fg.sync(['agents/*.md', 'automations/*.md'], { cwd: contextRoot, onlyFiles: true, followSymbolicLinks: false }).sort();
}

function patchOwnerLine(abs: string, owner: string): boolean {
  try {
    if (!lstatSync(abs).isFile()) return false;
    const raw = readFileSync(abs, 'utf-8');
    const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!m) return false;
    const body = m[2];
    const line = `owner: ${JSON.stringify(owner)}`;
    const next = /^owner:.*$/m.test(body) ? body.replace(/^owner:.*$/m, line) : `${body}\n${line}`;
    writeFileSync(abs, raw.replace(m[0], `${m[1]}${next}${m[3]}`), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export interface StampResult {
  stamped: string[];
  unowned: string[];
}

/**
 * Stamp `owner:` on every agent and automation manifest that has none (B1-3), on every upgraded
 * machine whether or not the switch is on. Byte-surgical: only the `owner:` line is added, so no
 * hash and no other key moves.
 *  - untracked or ignored here (created here): this machine's identity; seeds the created-locally set;
 *  - already tracked (a `shared: true` file): the login of the person who authored the commit
 *    that ADDED it, so every machine computes the same answer and concurrent stamping merges equal;
 *    `unowned` when that cannot be worked out (read-only everywhere, listed in the notice);
 *  - `machine:<this id>` on a file created here, once someone has signed in: the login.
 */
export function stampOwners(contextRoot: string, home?: string): StampResult {
  const projectRoot = dirname(contextRoot);
  const gitCwd = projectRoot;
  const inRepo = git.isGitRepo(gitCwd);
  const prefix = inRepo ? (brainPrefix(gitCwd, contextRoot) ?? '_dream_context/') : '_dream_context/';
  const tracked = new Set(inRepo ? git.treePaths(gitCwd, 'HEAD') : []);
  const login = currentLogin();
  const signedIn = !login.startsWith(MACHINE_OWNER_PREFIX);
  const mine = machineOwner();
  const local = readAgentSyncLocal(projectRoot, home);
  const created = new Set(local.createdLocally);
  const ownedAtMigration = new Set(local.ownedAtMigration);
  const stamped: string[] = [];
  const unowned: string[] = [];
  const myEmail = inRepo ? git.configuredEmail(gitCwd)?.toLowerCase() ?? null : null;
  /** Who added a tracked file: the login its commit email names, else this machine's login when
   *  the commit was made with this machine's own git identity, else nobody. */
  const resolveAdder = (rel: string): string | null => {
    const email = git.addAuthorEmail(gitCwd, `${prefix}${rel}`);
    const named = loginFromEmail(contextRoot, email);
    if (named) return named;
    return email && myEmail && email.toLowerCase() === myEmail ? login : null;
  };
  for (const rel of manifestFiles(contextRoot)) {
    const abs = join(contextRoot, rel);
    let data: Record<string, unknown>;
    try {
      if (!lstatSync(abs).isFile()) continue;
      data = parseManifestFrontmatter(readFileSync(abs, 'utf-8')).data;
    } catch { continue; }
    const owner = parseOwner(data.owner);
    const isTracked = tracked.has(`${prefix}${rel}`);
    // `unowned` is never final: a later run that can name the adder stamps them.
    if (owner === UNOWNED && isTracked) {
      const now = resolveAdder(rel);
      if (now && patchOwnerLine(abs, now)) {
        stamped.push(abs);
        if (ownedBy(now, login)) ownedAtMigration.add(rel);
        continue;
      }
    }
    if (owner) {
      if (owner === UNOWNED) unowned.push(rel);
      // Stamped at create (or by an earlier run) and never synced: made on this machine.
      if (!isTracked && ownedBy(owner, login)) created.add(rel);
      if (signedIn && owner === mine && created.has(rel) && patchOwnerLine(abs, login)) stamped.push(abs);
      continue;
    }
    let next: string;
    if (!isTracked) {
      next = login;
      created.add(rel);
    } else {
      // A commit made with this machine's own git identity names this machine's login, so a
      // single-machine user keeps their own shared routines; nobody nameable → unowned, which a
      // later run re-resolves (above) and the migration notice lists.
      next = resolveAdder(rel) ?? UNOWNED;
      if (next === UNOWNED) unowned.push(rel);
      else if (ownedBy(next, login)) ownedAtMigration.add(rel);
    }
    if (patchOwnerLine(abs, next)) stamped.push(abs);
  }
  if (created.size !== local.createdLocally.length || ownedAtMigration.size !== local.ownedAtMigration.length) {
    try {
      updateAgentSyncLocal(projectRoot, home, (cur) => ({
        ...cur,
        createdLocally: [...new Set([...cur.createdLocally, ...created])].sort(),
        ownedAtMigration: [...new Set([...cur.ownedAtMigration, ...ownedAtMigration])].sort(),
      }));
    } catch {
      // the sets are recomputed next run
    }
  }
  return { stamped, unowned };
}

/** Record that THIS machine created the manifest at `rel` (brain-relative), at create. */
export function recordCreatedLocally(contextRoot: string, rel: string, home?: string): void {
  try {
    updateAgentSyncLocal(dirname(contextRoot), home, (cur) => ({
      ...cur,
      createdLocally: [...new Set([...cur.createdLocally, rel.split(sep).join('/')])].sort(),
    }));
  } catch {
    // the stamping migration seeds it from git state next run
  }
}

/** Whether `rel` (brain-relative) was created on this machine. */
export function createdLocally(contextRoot: string, rel: string, home?: string): boolean {
  return readAgentSyncLocal(dirname(contextRoot), home).createdLocally.includes(rel.split(sep).join('/'));
}

/**
 * A manifest created here (or owned here at migration) that came back from a sync with another
 * `id` or `owner` was REPLACED by a teammate: one row "replaced through sync by <login>". The
 * approval hash and the owner check already stop it from running. Called after every pull.
 */
export function detectReplacedManifests(contextRoot: string, home?: string): void {
  const projectRoot = dirname(contextRoot);
  try {
    const local = readAgentSyncLocal(projectRoot, home);
    const watch = [...new Set([...local.createdLocally, ...local.ownedAtMigration])];
    const known = { ...(local.knownIds ?? {}) };
    const login = currentLogin();
    let changed = false;
    for (const rel of watch) {
      const abs = join(contextRoot, rel);
      let data: Record<string, unknown>;
      try {
        if (!lstatSync(abs).isFile()) continue;
        data = parseManifestFrontmatter(readFileSync(abs, 'utf-8')).data;
      } catch { continue; }
      const id = typeof data.id === 'string' ? data.id : '';
      const owner = parseOwner(data.owner);
      const prev = known[rel];
      if ((prev && id && prev !== id) || (owner && !ownedBy(owner, login))) {
        raiseInboxRow(projectRoot, {
          kind: 'replaced-by-sync',
          ref: rel,
          agent: basename(rel, '.md'),
          title: `${basename(rel, '.md')} was replaced through sync by ${owner ?? 'a teammate'}. It does not run until you look at it.`,
          actions: ['dismiss'],
          dedupeKey: `replaced:${rel}:${id}:${owner ?? ''}`,
        }, home);
      }
      if (id && prev !== id && !prev) { known[rel] = id; changed = true; }
    }
    if (changed) updateAgentSyncLocal(projectRoot, home, (cur) => ({ ...cur, knownIds: known }));
  } catch {
    // a missed row is raised at the next pull
  }
}

// ─── The thread-entry ledger (B1-6): history reads only what this machine wrote ──────────────

const THREAD_LEDGER_FILE = 'agent-thread-entries.json';
/** Entry ids older than this fall out of the ledger: history never reads past 14 days. */
const THREAD_LEDGER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

interface ThreadLedger {
  entries: Record<string, Record<string, string>>;
}

/** Record an entry THIS machine appended (slug, id, at). Only once agent sync is confirmed here:
 *  before that, threads are local-only and every entry is this machine's. Never throws. */
export function recordThreadEntryHere(contextRoot: string, slug: string, id: string, at: string, home?: string): void {
  try {
    if (!agentSyncState(contextRoot, home).active) return;
    const cutoff = Date.now() - THREAD_LEDGER_KEEP_MS;
    updateLocalJson<ThreadLedger>(dirname(contextRoot), THREAD_LEDGER_FILE, { entries: {} }, (cur) => {
      const entries = cur.entries && typeof cur.entries === 'object' ? { ...cur.entries } : {};
      const forSlug = { ...(entries[slug] ?? {}) };
      forSlug[id] = at;
      for (const [k, v] of Object.entries(forSlug)) {
        if (!(Date.parse(v) >= cutoff)) delete forSlug[k];
      }
      entries[slug] = forSlug;
      return { entries };
    }, home);
  } catch {
    // an unrecorded entry is only missing from this agent's history block
  }
}

/** The entry ids this machine wrote for `slug`, or null while agent sync is not confirmed here
 *  (every entry is this machine's then, so the caller does not filter). */
export function threadEntriesHere(contextRoot: string, slug: string, home?: string): Set<string> | null {
  // Until this machine confirms, its own threads never sync and none of a teammate's can reach its
  // agents' folders through its own files: every entry is this machine's. The ledger, seeded at
  // confirm from this machine's own day files, takes over from there.
  if (!agentSyncState(contextRoot, home).active) return null;
  const led = readLocalJson<ThreadLedger>(dirname(contextRoot), THREAD_LEDGER_FILE, { entries: {} }, home);
  return new Set(Object.keys(led.entries?.[slug] ?? {}));
}

/** Seed the ledger from this machine's own thread files (untracked here): at confirm, before any
 *  teammate's thread can arrive for one of this machine's agents. */
export function seedThreadLedger(contextRoot: string, home?: string): void {
  try {
    const gitCwd = dirname(contextRoot);
    const prefix = brainPrefix(gitCwd, contextRoot) ?? '_dream_context/';
    const tracked = new Set(git.isGitRepo(gitCwd) ? git.treePaths(gitCwd, 'HEAD') : []);
    const id = readMachineIdentity(home).id;
    const seeds: Record<string, Record<string, string>> = {};
    for (const dir of safeReaddir(join(contextRoot, 'automations', 'threads'))) {
      for (const name of safeReaddir(join(contextRoot, 'automations', 'threads', dir))) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})(?:-([0-9a-f]{12}))?\.md$/);
        if (!m || (m[2] && m[2] !== id)) continue;
        const rel = `automations/threads/${dir}/${name}`;
        if (tracked.has(`${prefix}${rel}`) && !m[2]) continue;
        let raw: string;
        try {
          if (!lstatSync(join(contextRoot, rel)).isFile()) continue;
          raw = readFileSync(join(contextRoot, rel), 'utf-8');
        } catch { continue; }
        for (const hit of raw.matchAll(/"id":"([^"]+)","runId":"[^"]*","kind":"[^"]*"(?:,"event":"[^"]*")?,"at":"([^"]+)"/g)) {
          (seeds[dir] ??= {})[hit[1]] = hit[2];
        }
      }
    }
    if (Object.keys(seeds).length === 0) return;
    updateLocalJson<ThreadLedger>(dirname(contextRoot), THREAD_LEDGER_FILE, { entries: {} }, (cur) => {
      const entries = cur.entries && typeof cur.entries === 'object' ? { ...cur.entries } : {};
      for (const [slug, ids] of Object.entries(seeds)) entries[slug] = { ...(entries[slug] ?? {}), ...ids };
      return { entries };
    }, home);
  } catch {
    // history starts from the next entry this machine writes
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Move an agent's ledger entries to a new slug (rename) or drop them (delete). Never throws. */
export function renameOrForgetThreadLedger(contextRoot: string, from: string, to: string | null, home?: string): void {
  try {
    const led = readLocalJson<ThreadLedger>(dirname(contextRoot), THREAD_LEDGER_FILE, { entries: {} }, home);
    if (!led.entries?.[from]) return;
    updateLocalJson<ThreadLedger>(dirname(contextRoot), THREAD_LEDGER_FILE, { entries: {} }, (cur) => {
      const entries = { ...(cur.entries ?? {}) };
      const moved = entries[from];
      delete entries[from];
      if (to && moved) entries[to] = { ...(entries[to] ?? {}), ...moved };
      return { entries };
    }, home);
  } catch {
    // stale ids only name entries that no longer exist under that slug
  }
}

/**
 * A rename moves this machine's records: `fromRel` leaves the created-here and owned-at-migration
 * sets (the file at that path is now the teammate's) and `toRel` takes its place; the watched id
 * and the adopted pattern move from `from` to `to`. Never throws.
 */
export function renameInAgentSyncRecords(contextRoot: string, fromRel: string, toRel: string, from: string, to: string, home?: string): void {
  const projectRoot = dirname(contextRoot);
  try {
    updateAgentSyncLocal(projectRoot, home, (cur) => {
      const swap = (list: string[]): string[] => (list.includes(fromRel) ? [...new Set([...list.filter((r) => r !== fromRel), toRel])].sort() : list);
      const knownIds = { ...(cur.knownIds ?? {}) };
      if (knownIds[fromRel]) { knownIds[toRel] = knownIds[fromRel]; delete knownIds[fromRel]; }
      return { ...cur, createdLocally: swap(cur.createdLocally), ownedAtMigration: swap(cur.ownedAtMigration), knownIds };
    });
  } catch {
    // a stale entry raises at most one "replaced" row, which the owner dismisses
  }
  try {
    const f = readLocalJson<PatternFile>(projectRoot, PATTERN_FILE, { adopted: {} }, home);
    if (f.adopted?.[from]) {
      updateLocalJson<PatternFile>(projectRoot, PATTERN_FILE, { adopted: {} }, (cur) => {
        const adopted = { ...(cur.adopted ?? {}) };
        if (adopted[from] && !adopted[to]) adopted[to] = adopted[from];
        delete adopted[from];
        return { adopted };
      }, home);
    }
  } catch {
    // the renamed agent adopts its own pattern again at its next run
  }
}

// ─── The adopted pattern (B1-6): the effective `## Pattern` is this machine's copy ───────────

const PATTERN_FILE = 'agent-patterns.json';

interface PatternFile {
  adopted: Record<string, { text: string; at: string }>;
}

/** The pattern this machine adopted for `slug`, or null when it never adopted one. */
export function adoptedPattern(contextRoot: string, slug: string, home?: string): string | null {
  const f = readLocalJson<PatternFile>(dirname(contextRoot), PATTERN_FILE, { adopted: {} }, home);
  const e = f.adopted?.[slug];
  return e && typeof e.text === 'string' ? e.text : null;
}

/** Adopt `text` as `slug`'s effective pattern on this machine (a local write, or the owner's
 *  "adopt" on the inbox row). */
export function adoptPattern(contextRoot: string, slug: string, text: string, home?: string, now: Date = new Date()): void {
  updateLocalJson<PatternFile>(dirname(contextRoot), PATTERN_FILE, { adopted: {} }, (cur) => ({
    adopted: { ...(cur.adopted ?? {}), [slug]: { text, at: now.toISOString() } },
  }), home);
  closeInboxRows(dirname(contextRoot), (r) => r.kind === 'adopt-pattern' && r.agent === slug, home);
}

/**
 * The pattern a run of `slug` reads. With the switch off: the file's (it is local-only). With it on:
 * this machine's adopted copy; the file's text when it equals that copy (or when nothing was ever
 * adopted and the file was created here, which adopts it); otherwise the adopted copy (or none) and
 * an "adopt?" row, since the file's text came from elsewhere.
 */
export function effectivePattern(contextRoot: string, slug: string, filePattern: string, home?: string): string {
  if (!agentSyncSwitchOn(contextRoot)) return filePattern;
  const adopted = adoptedPattern(contextRoot, slug, home);
  if (adopted === filePattern) return filePattern;
  if (adopted === null && !filePattern.trim()) return filePattern;
  if (adopted === null && (createdLocally(contextRoot, `agents/${slug}.md`, home) || createdLocally(contextRoot, `automations/${slug}.md`, home))) {
    try { adoptPattern(contextRoot, slug, filePattern, home); } catch { /* adopted next run */ }
    return filePattern;
  }
  try {
    raiseInboxRow(dirname(contextRoot), {
      kind: 'adopt-pattern',
      ref: slug,
      agent: slug,
      title: `${slug}'s learned pattern changed on another machine. It is not used here until you adopt it.`,
      actions: ['adopt', 'dismiss'],
      dedupeKey: `adopt-pattern:${slug}`,
    }, home);
  } catch {
    // the row is raised at the next run
  }
  return adopted ?? '';
}

/**
 * Park OUR side of an add/add conflict under agents/ or automations/ (two creators, one slug, two
 * ids): the incoming file keeps the path, ours is written to M0 as a pending restore and comes
 * back renamed once the merge commits (`resolvePendingRestores`). Throws when it cannot park, so
 * the caller leaves the conflict for a human rather than dropping our copy.
 */
export function parkConflictCopy(contextRoot: string, relPath: string, content: string, remoteSha: string, home?: string, now: Date = new Date()): void {
  const projectRoot = dirname(contextRoot);
  const dir = join(localDir(projectRoot, home), 'restores');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rec: PendingRestore = {
    path: relPath,
    slug: slugOfAgentPath(relPath) ?? basename(relPath),
    backup: join(dir, `${now.getTime()}-${randomBytes(4).toString('hex')}-${basename(relPath)}`),
    remoteSha,
    at: now.toISOString(),
  };
  updateLocalJson<RestoresFile>(projectRoot, RESTORES_FILE, { pending: [] }, (cur) => ({
    pending: [...(Array.isArray(cur.pending) ? cur.pending : []), rec],
  }), home);
  writeFileSync(rec.backup, content, { encoding: 'utf-8', mode: 0o600 });
}
