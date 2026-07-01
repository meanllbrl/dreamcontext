import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFLICTS_DIR_REL, TASKS_LOCK_REL, TASKS_MAP_REL, TASKS_QUEUE_REL, TASKS_SYNC_REL } from './paths.js';

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

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export class SyncLedger {
  constructor(private readonly contextRoot: string) {}

  private get mapPath(): string { return join(this.contextRoot, TASKS_MAP_REL); }
  private get syncPath(): string { return join(this.contextRoot, TASKS_SYNC_REL); }
  private get queuePath(): string { return join(this.contextRoot, TASKS_QUEUE_REL); }

  conflictsDir(): string { return join(this.contextRoot, CONFLICTS_DIR_REL); }

  // ── id-map (committed) ──
  readMap(): TaskMapEntry[] {
    return readJson<TaskMapEntry[]>(this.mapPath, []);
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
