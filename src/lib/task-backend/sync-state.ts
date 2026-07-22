import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFLICTS_DIR_REL, TASKS_LOCK_REL, TASKS_MAP_REL, TASKS_QUEUE_REL, TASKS_SYNC_REL } from './paths.js';
import { TaskBackendError } from './types.js';
import { splitConflictMarkers } from './conflict-markers.js';
import { foldAscii } from '../fold-ascii.js';

/**
 * Ledger split — issue #11 (backend-neutral names):
 *   COMMITTED  state/.tasks-map.json   { slug, dcId, backend, remoteId }
 *   GITIGNORED state/.tasks-sync.json  watermarks, base snapshots, local hashes
 *   GITIGNORED state/.tasks-queue.json offline write-ahead queue (op-id keyed)
 */

export interface TaskMapEntry {
  slug: string;
  dcId: string;
  backend: string;
  remoteId: string;
}

export interface BaseSnapshot {
  hash: string;
  body: string;
}

export interface TaskSyncEntry {
  /** REMOTE server time (epoch ms) of the last successful sync — the watermark. */
  last_synced_at: number;
  /** Body captured at the last successful sync — the base for 3-way merges. */
  base_snapshot?: BaseSnapshot;
  /** Hash of the local mirror file at last sync (hand-edit detection). */
  localHash?: string;
  /** Local wall-clock ms of the last LOCAL mutation (LWW comparisons use server time; this orders local edits only). */
  lastLocalChangeAt?: number;
  /** True while local changes await a push. */
  pendingPush?: boolean;
}

export interface SyncStateFile {
  /** Global PULL watermark: max remote date_updated seen (server time, epoch ms). */
  watermark: number | null;
  tasks: Record<string, TaskSyncEntry>;
  /**
   * Opaque identity of the remote container every derived cache below describes,
   * minted by the backend that owns it. Without it the caches are unattributed and
   * silently survive a target switch (#184); `adoptContainer()` makes them honest.
   */
  container?: string;
  /**
   * Remote container members, keyed by ascii-folded slug — refreshed
   * best-effort on each sync. Derived data (gitignored with the rest),
   * so assignee mapping needs no manual config.
   */
  members?: Record<string, CachedMember>;
  /** The remote container's status set — status pushes map against it. */
  listStatuses?: string[];
  /** The remote container's custom field definitions (the field bridge). */
  customFields?: Array<Record<string, unknown>>;
  /** Local-clock throttles (request-budget only — never used for merge logic). */
  lastMetaRefreshAt?: number;
  lastReconcileAt?: number;
  lastLabelProvisionAt?: number;
  /**
   * Local-image → hosted-asset bridge (GitHub task images). Push uploads a local
   * image once and rewrites the wire reference to the hosted URL; pull maps that
   * URL back to the canonical local path so the reference never churns the merge.
   */
  assets?: AssetBridgeEntry[];
  /** True once the dedicated assets branch is known to exist (avoids re-checking). */
  assetsBranchReady?: boolean;
  /**
   * Set the moment the sync target changes (`adoptContainer` detects a switch) and
   * cleared only after the FIRST authoritative deletion-reconciliation pass against
   * the new container. While it is set, the deletion sweep treats a map entry that
   * is absent from the remote as a STALE MAPPING from the old container — it keeps
   * the local mirror and drops only the mapping (re-created in the new container by
   * push) — never as a remote deletion. Persisted (not just an in-memory flag) so a
   * switch sync whose pull fails half-way can't leave a later sync mistaking the
   * still-stale map for a mass remote deletion and nuking every mirror.
   */
  pendingContainerRemap?: boolean;
}

export interface AssetBridgeEntry {
  /** The exact LOCAL destination as authored in the task body (round-trip key). */
  localUrl: string;
  /** sha1 hex of the file bytes — the content address + upload-dedup key. */
  contentSha: string;
  /** Repo-relative path the bytes were committed to on the assets branch. */
  remotePath: string;
  /** The hosted URL that renders in a GitHub issue. */
  remoteUrl: string;
}

export interface CachedMember {
  id: string;
  name: string;
  email?: string;
}

export type QueueOpKind = 'create' | 'push' | 'delete';

export interface QueueOp {
  /** Stable op id — replay is idempotent per id. */
  id: string;
  kind: QueueOpKind;
  slug: string;
  /** Local wall-clock ms when enqueued (ordering only). */
  ts: number;
  /** Delete ops carry the remote id (the map entry is dropped at delete time). */
  remoteId?: string;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Strict read for the COMMITTED id-map only (`readJson` above stays lenient —
 * it backs the gitignored per-machine caches, where falling back to a default
 * on a corrupt read is harmless). The committed map is different: a two-machine
 * git conflict on it can leave literal `<<<<<<<` markers in the checked-out
 * bytes, and `JSON.parse` on marker text either throws or — worse — parses far
 * enough to look like a small, "valid" array. Either way, silently returning an
 * empty/partial map here is the exact failure that let a conflict-markered map
 * get clobbered with only-new entries (#204). So this throws instead of falling
 * back — see the `readMap()` doc below for the full contract.
 */
function readMapStrict(path: string): TaskMapEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim() === '') return [];
  if (splitConflictMarkers(raw) !== null) {
    throw new TaskBackendError(
      'corrupt_ledger',
      `${TASKS_MAP_REL} has unresolved merge conflict markers — run \`dreamcontext tasks dedup\` to heal, or resolve the markers manually.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TaskBackendError('corrupt_ledger', `${TASKS_MAP_REL} is not valid JSON: ${(err as Error).message}`);
  }
  return Array.isArray(parsed) ? (parsed as TaskMapEntry[]) : [];
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Total order used to pick a canonical entry deterministically, independent of side order. */
function entryOrderKey(e: TaskMapEntry): string {
  return `${e.slug}|${JSON.stringify(e)}`;
}

/**
 * Order-independent, LOSSLESS union of two (or more) committed-map sides — the
 * merge primitive behind `mergeTasksMapJson` (git-sync/semantic-merge.ts) and
 * `healConflictedMap` below. Byte-stable regardless of which side is passed
 * first: same input set, same output, always.
 *
 * Three passes:
 *  1. Collapse to ONE entry per `remoteId` (a rename/relabel of the same real
 *     remote task never gets two rows) — the canonical survivor is picked by
 *     `entryOrderKey`, not "whichever side came first".
 *  2. Resolve `slug` collisions across entries that now carry DISTINCT
 *     `remoteId`s — two genuinely different real remote tasks that transiently
 *     share a name-derived slug. Neither is dropped: the walk is ordered by
 *     `dcId` ascending (tiebreak `remoteId`) — the SAME total order
 *     `mergeTaskMd` uses to pick its keeper for the matching `state/<slug>.md`
 *     add/add (git-sync/semantic-merge.ts) — so the map's bare-slug winner and
 *     the file's keeper agree by construction, with no cross-file lookup
 *     needed. The loser(s) are re-slugged to `<slug>-2`, `<slug>-3`, … (first
 *     free), which the next pull's vanished-mirror branch materializes as a
 *     real file rather than a lost mapping. An entry missing `dcId` (only
 *     possible via external corruption — `recordMapping` always writes one)
 *     sorts by `remoteId` alone so the walk stays deterministic.
 *  3. Sort the result by `slug` for a stable committed file.
 */
export function unionTaskMap(sides: TaskMapEntry[][]): TaskMapEntry[] {
  const byRemoteId = new Map<string, TaskMapEntry>();
  for (const side of sides) {
    for (const entry of side) {
      const existing = byRemoteId.get(entry.remoteId);
      if (!existing || entryOrderKey(entry) < entryOrderKey(existing)) {
        byRemoteId.set(entry.remoteId, entry);
      }
    }
  }

  const ordered = [...byRemoteId.values()].sort((a, b) => {
    const ak = a.dcId || '';
    const bk = b.dcId || '';
    if (ak !== bk) return ak.localeCompare(bk);
    return a.remoteId.localeCompare(b.remoteId);
  });

  const used = new Set<string>();
  const resolved: TaskMapEntry[] = [];
  for (const entry of ordered) {
    let slug = entry.slug;
    let n = 1;
    while (used.has(slug)) {
      n += 1;
      slug = `${entry.slug}-${n}`;
    }
    used.add(slug);
    resolved.push(slug === entry.slug ? entry : { ...entry, slug });
  }

  return resolved.sort((a, b) => a.slug.localeCompare(b.slug));
}

export class SyncLedger {
  constructor(private readonly contextRoot: string) {}

  private get mapPath(): string { return join(this.contextRoot, TASKS_MAP_REL); }
  private get syncPath(): string { return join(this.contextRoot, TASKS_SYNC_REL); }
  private get queuePath(): string { return join(this.contextRoot, TASKS_QUEUE_REL); }

  conflictsDir(): string { return join(this.contextRoot, CONFLICTS_DIR_REL); }

  // ── id-map (committed) ──
  /**
   * Read the committed id-map. STRICT: a parse failure or unresolved conflict
   * markers throws `TaskBackendError('corrupt_ledger', …)` rather than
   * silently returning an empty map. A silent `[]` here is exactly what let
   * `recordMapping` (below) rewrite a conflict-markered map as valid JSON
   * containing only new entries, permanently orphaning every canonical
   * mapping (#204). A missing file is NOT corruption — a project mid-first-
   * sync has no map yet — so that case still returns `[]`.
   *
   * PRECONDITION every `.find()`-based lookup below (`remoteIdFor`,
   * `slugForRemoteId`, `entryForDcId`) assumes: no two entries share a `slug`.
   * `readMap` does not enforce this itself — the map can only violate it after
   * external corruption (hand-edit, a double-push race) — `tasks dedup` is the
   * repair path that restores it, via `rewriteMap` (one whole-map write, never
   * a sequence of per-entry writes that could leave the violation half-fixed).
   */
  readMap(): TaskMapEntry[] {
    return readMapStrict(this.mapPath);
  }

  remoteIdFor(slug: string): string | null {
    return this.readMap().find((e) => e.slug === slug)?.remoteId ?? null;
  }

  slugForRemoteId(remoteId: string): string | null {
    return this.readMap().find((e) => e.remoteId === remoteId)?.slug ?? null;
  }

  /**
   * Look up a mapping by the STABLE dcId (the task's `id:` frontmatter), not the
   * name-derived slug. This is the rename-safe join key: a task's slug changes
   * when it is renamed, but its dcId never does — so reconciliation must key on
   * dcId to avoid re-creating a renamed task as a duplicate remote task (#77).
   */
  entryForDcId(dcId: string): TaskMapEntry | null {
    if (!dcId) return null;
    return this.readMap().find((e) => e.dcId === dcId) ?? null;
  }

  recordMapping(entry: TaskMapEntry): void {
    const map = this.readMap().filter((e) => e.slug !== entry.slug);
    map.push(entry);
    map.sort((a, b) => a.slug.localeCompare(b.slug));
    writeJson(this.mapPath, map);
  }

  removeMapping(slug: string): void {
    writeJson(this.mapPath, this.readMap().filter((e) => e.slug !== slug));
  }

  /**
   * Re-key every ledger record for a RENAMED task from `oldSlug` to `newSlug`,
   * preserving its stable identity (dcId / backend / remoteId), its sync state
   * (base snapshot, watermark, localHash — so the rename pushes as an UPDATE and
   * the 3-way merge keeps its base), and any queued write-ahead ops. This is the
   * surgery that lets a rename update the SAME remote task instead of duplicating
   * it (#77). No-op when the slug is unchanged or nothing is mapped under it.
   */
  migrateSlug(oldSlug: string, newSlug: string): void {
    if (!oldSlug || !newSlug || oldSlug === newSlug) return;

    // Committed id-map: move the entry (keep dcId/backend/remoteId), drop any
    // stale record sitting on the target slug so we never leave a duplicate.
    const map = this.readMap();
    const entry = map.find((e) => e.slug === oldSlug);
    if (entry) {
      const next = map.filter((e) => e.slug !== oldSlug && e.slug !== newSlug);
      next.push({ ...entry, slug: newSlug });
      next.sort((a, b) => a.slug.localeCompare(b.slug));
      writeJson(this.mapPath, next);
    }

    // Sync state: the renamed task's history (base snapshot/watermark/hash) is
    // authoritative — carry it onto the new slug and drop the old key.
    const state = this.readSyncState();
    if (state.tasks[oldSlug]) {
      state.tasks[newSlug] = state.tasks[oldSlug];
      delete state.tasks[oldSlug];
      this.writeSyncState(state);
    }

    // Write-ahead queue: re-key any pending ops so they replay under the new slug.
    const queue = this.readQueue();
    if (queue.some((q) => q.slug === oldSlug)) {
      writeJson(this.queuePath, queue.map((q) => (q.slug === oldSlug ? { ...q, slug: newSlug } : q)));
    }
  }

  /**
   * If the committed map carries git conflict markers, parse both
   * reconstructed sides (tolerantly — a side that fails to parse contributes
   * nothing rather than aborting the heal) and rewrite marker-free JSON: the
   * lossless union of both sides, never a clobber. Returns `true` iff it
   * healed; `false` when the file is absent or already marker-free (no-op).
   * LOCAL ONLY — never touches the remote.
   */
  healConflictedMap(): boolean {
    if (!existsSync(this.mapPath)) return false;
    const raw = readFileSync(this.mapPath, 'utf-8');
    const split = splitConflictMarkers(raw);
    if (split === null) return false;
    const parseSide = (s: string): TaskMapEntry[] => {
      try {
        const parsed = JSON.parse(s || '[]');
        return Array.isArray(parsed) ? (parsed as TaskMapEntry[]) : [];
      } catch {
        return [];
      }
    };
    this.rewriteMap(unionTaskMap([parseSide(split.ours), parseSide(split.theirs)]));
    return true;
  }

  /**
   * Replace the ENTIRE committed map in ONE write, sorted by slug. The
   * loss-safe primitive for multi-entry repairs (e.g. `tasks dedup`'s
   * dcId↔remoteId cross-wiring fix): callers compute the fully-repaired array
   * in memory and hand it over in one call, so no intermediate write can
   * clobber a sibling entry the way incremental `recordMapping`/`migrateSlug`
   * calls could (each filters by ONE slug and would dangle or delete another
   * entry mid-sequence for a multi-entry repair). "Atomic" here means one
   * whole-array write — not crash-atomic (no fsync/rename); same durability
   * semantics as the existing `writeJson`.
   */
  rewriteMap(entries: TaskMapEntry[]): void {
    writeJson(this.mapPath, [...entries].sort((a, b) => a.slug.localeCompare(b.slug)));
  }

  removeTaskSync(slug: string): void {
    const state = this.readSyncState();
    delete state.tasks[slug];
    this.writeSyncState(state);
  }

  /** Remote ids with a delete op awaiting replay (pull must not resurrect them). */
  pendingDeleteRemoteIds(): Set<string> {
    return new Set(
      this.readQueue()
        .filter((q) => q.kind === 'delete' && q.remoteId)
        .map((q) => q.remoteId!),
    );
  }

  // ── sync state (gitignored) ──
  readSyncState(): SyncStateFile {
    return readJson<SyncStateFile>(this.syncPath, { watermark: null, tasks: {} });
  }

  writeSyncState(state: SyncStateFile): void {
    writeJson(this.syncPath, state);
  }

  taskSync(slug: string): TaskSyncEntry | null {
    return this.readSyncState().tasks[slug] ?? null;
  }

  updateTaskSync(slug: string, patch: Partial<TaskSyncEntry>): void {
    const state = this.readSyncState();
    const existing: TaskSyncEntry = state.tasks[slug] ?? { last_synced_at: 0 };
    state.tasks[slug] = { ...existing, ...patch };
    this.writeSyncState(state);
  }

  readMembers(): Record<string, CachedMember> {
    return this.readSyncState().members ?? {};
  }

  /**
   * Bind the derived caches to the remote container they describe, dropping them
   * when the target has moved. `listStatuses`/`members`/`customFields` are only
   * meaningful for ONE container, but nothing recorded which — so repointing the
   * target left a cache describing the OLD container, and every status push mapped
   * against a status set the new one does not have, silently falling back to its
   * first open status (#184).
   *
   * The backend passes an opaque key identifying its current target; only it knows
   * what addresses a container. Checking provenance here, at READ time, covers
   * every way the target can move — the migrate/keep CLI paths, the dashboard's
   * config PATCH, or a hand-edited config — rather than trusting each writer to
   * remember to invalidate. One of those writers already did (by dropping the
   * whole ledger via `reset()`), which is exactly why the bug hid for so long:
   * the path everyone tested was the one path that happened to be safe.
   *
   * The pull watermark goes too. It timestamps the OLD container's update axis,
   * so carrying it over silently skips anything in the new container untouched
   * since — invisible scope-loss rather than a visible error. Dropping it costs
   * one full pull, which is what a fresh ledger already does.
   *
   * Returns the previous container when this is a genuine switch, so the caller
   * can surface it. A first-ever stamp is not a switch (`from: null`).
   */
  adoptContainer(container: string): { switched: boolean; from: string | null } {
    const state = this.readSyncState();
    const from = state.container ?? null;
    if (from === container) return { switched: false, from };

    // A first-ever stamp is an ADOPTION, not a switch: an unstamped ledger is
    // simply one written before this field existed, and its caches almost
    // certainly describe the container we are about to record. Invalidating here
    // would make every existing project pay a full re-pull on upgrade to fix a
    // problem it does not have — and the hourly meta refresh re-validates the
    // caches on its own anyway. Only a CHANGE of container proves staleness.
    if (from !== null) {
      delete state.listStatuses;
      delete state.customFields;
      delete state.members;
      delete state.lastMetaRefreshAt;
      delete state.lastLabelProvisionAt;
      state.watermark = null;
      // The committed id-map still binds every local slug to the OLD container's
      // remote ids, none of which exist in the new one — so the deletion sweep
      // would read the switch as a mass remote deletion. Mark the remap intent so
      // the sweep keeps those mirrors (and re-creates them in the new container)
      // instead. Persisted, so a switch sync that dies before reconciling can't
      // leave a later sync deleting the still-stale map.
      state.pendingContainerRemap = true;
    }
    state.container = container;
    this.writeSyncState(state);
    return { switched: from !== null, from };
  }

  /** True while a target switch still needs its stale mappings reconciled. */
  pendingContainerRemap(): boolean {
    return this.readSyncState().pendingContainerRemap === true;
  }

  /** Clear the remap intent after an authoritative reconciliation pass. */
  clearPendingContainerRemap(): void {
    const state = this.readSyncState();
    if (state.pendingContainerRemap === undefined) return;
    delete state.pendingContainerRemap;
    this.writeSyncState(state);
  }

  /**
   * Drop the pull watermark so the next sync re-reads the container in full.
   * Returns true only when it actually changed something.
   *
   * This is the #185 SELF-HEAL. A ledger written before that fix can carry a
   * watermark that our own PUSH advanced — past a collaborator's older, unpulled
   * change. That change is then excluded from every future delta pull, forever
   * and silently. Fixing the push stops NEW poisoning but cannot un-hide what is
   * already hidden: the watermark on disk still says "I have everything up to T"
   * when we never did. Only a full re-read can recover it, so upgrading has to
   * clear it once.
   *
   * Cheap and safe: the echo gate makes the re-read a no-op for everything
   * already current, and a null watermark is exactly the state a fresh ledger
   * starts in.
   */
  resetPullWatermark(): boolean {
    const state = this.readSyncState();
    if (state.watermark === null || state.watermark === undefined) return false;
    state.watermark = null;
    this.writeSyncState(state);
    return true;
  }

  readListStatuses(): string[] {
    return this.readSyncState().listStatuses ?? [];
  }

  readCustomFields<T = Record<string, unknown>>(): T[] {
    return (this.readSyncState().customFields ?? []) as T[];
  }

  writeCustomFields(fields: Array<Record<string, unknown>>): void {
    const state = this.readSyncState();
    state.customFields = fields;
    this.writeSyncState(state);
  }

  writeListStatuses(statuses: string[]): void {
    const state = this.readSyncState();
    state.listStatuses = statuses;
    this.writeSyncState(state);
  }

  writeMembers(members: Record<string, CachedMember>): void {
    const state = this.readSyncState();
    state.members = members;
    this.writeSyncState(state);
  }

  readThrottle(key: 'lastMetaRefreshAt' | 'lastReconcileAt' | 'lastLabelProvisionAt'): number | null {
    return this.readSyncState()[key] ?? null;
  }

  writeThrottle(key: 'lastMetaRefreshAt' | 'lastReconcileAt' | 'lastLabelProvisionAt', at: number): void {
    const state = this.readSyncState();
    state[key] = at;
    this.writeSyncState(state);
  }

  // ── Image-asset bridge (GitHub task images) ──
  readAssets(): AssetBridgeEntry[] {
    return this.readSyncState().assets ?? [];
  }

  /** Bridge entry for a local image destination as authored in a body. */
  assetForLocalUrl(localUrl: string): AssetBridgeEntry | null {
    return this.readAssets().find((a) => a.localUrl === localUrl) ?? null;
  }

  /** Bridge entry for already-uploaded bytes (content hash) — the upload-dedup key. */
  assetForContentSha(contentSha: string): AssetBridgeEntry | null {
    return this.readAssets().find((a) => a.contentSha === contentSha) ?? null;
  }

  /** Canonical local destination for a hosted asset URL — pull's reverse map. */
  localUrlForRemoteUrl(remoteUrl: string): string | null {
    return this.readAssets().find((a) => a.remoteUrl === remoteUrl)?.localUrl ?? null;
  }

  /** Upsert a bridge entry, keyed by the authored local destination. */
  recordAsset(entry: AssetBridgeEntry): void {
    const state = this.readSyncState();
    const assets = (state.assets ?? []).filter((a) => a.localUrl !== entry.localUrl);
    assets.push(entry);
    assets.sort((a, b) => a.localUrl.localeCompare(b.localUrl));
    state.assets = assets;
    this.writeSyncState(state);
  }

  assetsBranchReady(): boolean {
    return this.readSyncState().assetsBranchReady === true;
  }

  markAssetsBranchReady(): void {
    const state = this.readSyncState();
    state.assetsBranchReady = true;
    this.writeSyncState(state);
  }

  /** Advance the global pull watermark (server time, monotonic). */
  advanceWatermark(serverTimeMs: number | null): void {
    if (serverTimeMs === null) return;
    const state = this.readSyncState();
    if (state.watermark === null || serverTimeMs > state.watermark) {
      state.watermark = serverTimeMs;
      this.writeSyncState(state);
    }
  }

  // ── write-ahead queue (gitignored) ──
  readQueue(): QueueOp[] {
    return readJson<QueueOp[]>(this.queuePath, []);
  }

  enqueue(op: QueueOp): void {
    const queue = this.readQueue();
    // Idempotent by id; and one pending op per (kind, slug) is enough — the
    // push engine syncs whole tasks, not individual edits.
    if (queue.some((q) => q.id === op.id)) return;
    if (queue.some((q) => q.kind === op.kind && q.slug === op.slug)) return;
    queue.push(op);
    writeJson(this.queuePath, queue);
  }

  /** Remove every op for `slug` enqueued at or before `upToTs`. */
  dequeueFor(slug: string, upToTs: number): void {
    const queue = this.readQueue().filter((q) => !(q.slug === slug && q.ts <= upToTs));
    writeJson(this.queuePath, queue);
  }

  /**
   * Reset the ledger for a LIST MIGRATION: back up the committed id-map,
   * then drop map + sync state + queue so the next sync recreates every
   * local task in the new container. Mirror files are untouched.
   */
  reset(): { backupPath: string | null } {
    let backupPath: string | null = null;
    if (existsSync(this.mapPath)) {
      backupPath = this.mapPath.replace(/\.json$/, `.backup-${Date.now()}.json`);
      writeFileSync(backupPath, readFileSync(this.mapPath));
      rmSync(this.mapPath);
    }
    if (existsSync(this.syncPath)) rmSync(this.syncPath);
    if (existsSync(this.queuePath)) rmSync(this.queuePath);
    return { backupPath };
  }

  private get lockPath(): string { return join(this.contextRoot, TASKS_LOCK_REL); }

  /**
   * SYNC LOCK — at most one sync engine per project at a time. Sync fires
   * from several places (manual CLI, git hooks, post-sleep, the dashboard
   * button); the ledger files are read-modify-write JSON, so two concurrent
   * engines could lose updates, double-replay queue ops, or duplicate
   * remote creates. The lock file is created atomically (`wx`); a crashed
   * process can't wedge things — locks older than `staleMs` are broken
   * (JSON timestamp first, file mtime as the fallback for garbage content).
   */
  acquireSyncLock(nowMs: number, staleMs: number): boolean {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    const tryCreate = (): boolean => {
      try {
        writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, at: nowMs }) + '\n', { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    };
    if (tryCreate()) return true;

    // Lock exists — held, or left behind by a dead process?
    let heldSince: number | null = null;
    try {
      const info = JSON.parse(readFileSync(this.lockPath, 'utf-8'));
      if (typeof info.at === 'number') heldSince = info.at;
    } catch { /* unreadable → fall back to mtime below */ }
    if (heldSince === null) {
      try {
        heldSince = statSync(this.lockPath).mtimeMs;
      } catch {
        return tryCreate(); // vanished between checks — race resolved by wx
      }
    }
    if (nowMs - heldSince <= staleMs) return false; // genuinely held

    // Stale: break it, then re-race atomically.
    try { rmSync(this.lockPath, { force: true }); } catch { /* best-effort */ }
    return tryCreate();
  }

  releaseSyncLock(): void {
    try { rmSync(this.lockPath, { force: true }); } catch { /* already gone */ }
  }

  queuedSlugs(): string[] {
    return [...new Set(this.readQueue().map((q) => q.slug))];
  }
}

/**
 * Heal RENAMED tasks in the ledger before a sync runs (#77). Provider-agnostic:
 * it speaks only ledger + the `{slug, dcId}` of the live task files, so it works
 * identically for every remote backend and never touches wire shapes.
 *
 * A rename changes a task's name-derived slug but never its stable dcId. Without
 * this pass, the map still points the remote task at the OLD slug, so push would
 * re-create it as a duplicate and pull's "vanished mirror" branch could resurrect
 * the old file. Here we detect a map entry whose slug no longer has a file but
 * whose dcId matches a live file under a new slug, and migrate the entry in place.
 *
 * Non-destructive and idempotent: a stale slug whose dcId has no live file is left
 * alone (that is a deletion, reconciled elsewhere), and a rename whose target slug
 * is ALREADY mapped is skipped (never clobber an existing mapping — that residue is
 * an old duplicate for manual/`--reconcile` cleanup, not something to auto-merge).
 *
 * @returns the `{ from, to }` slug migrations applied (for logging / reporting).
 */
export function reconcileRenamedTasks(
  ledger: SyncLedger,
  liveTasks: Array<{ slug: string; dcId: string }>,
): Array<{ from: string; to: string }> {
  const map = ledger.readMap();
  if (map.length === 0) return [];

  const liveSlugs = new Set(liveTasks.map((t) => t.slug));
  const liveByDcId = new Map<string, string>();
  for (const t of liveTasks) {
    if (t.dcId && !liveByDcId.has(t.dcId)) liveByDcId.set(t.dcId, t.slug);
  }
  const mapSlugs = new Set(map.map((e) => e.slug));

  const migrations: Array<{ from: string; to: string }> = [];
  for (const entry of map) {
    if (liveSlugs.has(entry.slug)) continue; // slug still has a file — valid
    const newSlug = liveByDcId.get(entry.dcId);
    if (!newSlug || newSlug === entry.slug) continue; // no rename (deletion, etc.)
    if (mapSlugs.has(newSlug)) continue; // target already mapped — don't clobber
    ledger.migrateSlug(entry.slug, newSlug);
    mapSlugs.delete(entry.slug);
    mapSlugs.add(newSlug);
    migrations.push({ from: entry.slug, to: newSlug });
  }
  return migrations;
}

/** The `{ slug, dcId, name }` a pull-side match needs from a live local task file. */
export interface LocalTaskDescriptor {
  slug: string;
  dcId: string;
  name: string;
}

/** The `{ remoteId, name }` a pull-side match needs from the incoming remote task. */
export interface RemoteMatchInput {
  remoteId: string;
  name: string;
}

/**
 * Re-link an incoming remote task to an existing local mirror when the
 * committed map lost the entry (e.g. after a team-merge conflict on
 * `.tasks-map.json`) — the pull-side fallback that stops a missing mapping
 * from minting a fresh `-N` duplicate mirror (#204). Matches by fold-ascii
 * exact name equality against tasks NOT already claimed by a DIFFERENT
 * `remoteId` in the map — a local task whose name genuinely collides with a
 * different remote task must still fall through to the caller's normal `-N`
 * creation, never be silently re-linked to the wrong remote id. Deterministic
 * on ties: the lexicographically-smallest candidate slug.
 */
export function matchLocalTaskForRemote(
  ledger: SyncLedger,
  liveTasks: LocalTaskDescriptor[],
  remote: RemoteMatchInput,
): LocalTaskDescriptor | null {
  const claimed = new Set(
    ledger.readMap()
      .filter((e) => e.remoteId !== remote.remoteId)
      .map((e) => e.slug),
  );
  const target = foldAscii(remote.name);
  const candidates = liveTasks
    .filter((t) => foldAscii(t.name) === target && !claimed.has(t.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return candidates[0] ?? null;
}
