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

  recordMapping(entry: TaskMapEntry): void {
    const map = this.readMap().filter((e) => e.slug !== entry.slug);
    map.push(entry);
    map.sort((a, b) => a.slug.localeCompare(b.slug));
    writeJson(this.mapPath, map);
  }

  removeMapping(slug: string): void {
    writeJson(this.mapPath, this.readMap().filter((e) => e.slug !== slug));
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
