import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { generateId } from '../id.js';
import type { SetupConfig } from '../setup-config.js';
import { ApiAdapter } from './api-adapter.js';
import {
  bodyToDescription,
  normalizeEntry,
  priorityToClickUp,
  splitChangelogEntries,
  statusToClickUp,
  tagsToClickUp,
  serverTimeMs,
  type ClickUpTask,
} from './clickup-map.js';
import { clickupMemberMap, resolveActor, resolveActorToken } from './identity.js';
import { LocalTaskBackend } from './local.js';
import { SyncLedger, hashContent } from './sync-state.js';
import type {
  AddChangelogOptions,
  CreateTaskInput,
  InsertSectionOptions,
  SyncDirection,
  SyncReport,
  TaskData,
  UpdateFieldsOptions,
} from './types.js';

/**
 * ClickUp task backend — issue #11.
 *
 * Direct ClickUp REST v2 via the generic ApiAdapter — NO MCP dependency
 * anywhere; works headless (git hooks, post-sleep, cron).
 *
 * Architecture: the gitignored `state/*.md` MIRROR is the read path (so
 * recall.ts + snapshot.ts keep working with ZERO changes), and every local
 * mutation lands in the mirror first + enqueues a write-ahead op. Network I/O
 * happens ONLY inside `sync()` — mutations never block on the network, and an
 * offline session degrades to "pending push" instead of failing.
 */

export interface ClickUpBackendDeps {
  /** Injectable adapter (tests use a mocked transport). */
  adapter?: ApiAdapter;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

export class ClickUpTaskBackend extends LocalTaskBackend {
  readonly name: string = 'clickup';

  protected readonly ledger: SyncLedger;
  private adapterInstance: ApiAdapter | null = null;
  /** Suppresses queue/attribution while sync() writes remote state into the mirror. */
  protected applyingRemote = false;

  constructor(
    protected readonly contextRoot: string,
    protected readonly config: SetupConfig | null,
    protected readonly deps: ClickUpBackendDeps = {},
  ) {
    super(join(contextRoot, 'state'));
    this.ledger = new SyncLedger(contextRoot);
  }

  protected nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  protected get projectRoot(): string {
    return dirname(this.contextRoot);
  }

  protected getAdapter(): ApiAdapter {
    if (this.deps.adapter) return this.deps.adapter;
    if (!this.adapterInstance) {
      const token = resolveActorToken(this.projectRoot, this.contextRoot, this.config);
      if (!token) {
        throw new Error('No ClickUp token configured. Run `dreamcontext config clickup-token`.');
      }
      this.adapterInstance = new ApiAdapter({
        baseUrl: CLICKUP_BASE_URL,
        authHeaders: () => ({ Authorization: token.token }),
        fetchImpl: this.deps.fetchImpl,
        now: this.deps.now,
        sleep: this.deps.sleep,
      });
    }
    return this.adapterInstance;
  }

  protected requireListId(): string {
    const listId = this.config?.clickup?.listId;
    if (!listId) {
      throw new Error('No ClickUp list configured. Run `dreamcontext config clickup-list <teamId> <spaceId> <listId>`.');
    }
    return listId;
  }

  /** Mark a local mutation: pending push + WAL entry (op-id keyed, idempotent). */
  protected recordLocalMutation(slug: string, kind: 'create' | 'push'): void {
    if (this.applyingRemote) return;
    const ts = this.nowMs();
    this.ledger.enqueue({ id: generateId('op'), kind, slug, ts });
    this.ledger.updateTaskSync(slug, { pendingPush: true, lastLocalChangeAt: ts });
  }

  // ── Mutations: mirror-first + WAL ─────────────────────────────────────────

  async create(input: CreateTaskInput): Promise<TaskData> {
    const task = await super.create(input);
    if (!this.applyingRemote) {
      const actor = resolveActor(this.config);
      if (actor) {
        await super.updateFields(task.slug, { created_by: actor, updated_by: actor });
      }
      this.recordLocalMutation(task.slug, 'create');
    }
    return (await super.get(task.slug))!;
  }

  async updateFields(
    slug: string,
    fields: Record<string, unknown>,
    opts?: UpdateFieldsOptions,
  ): Promise<TaskData> {
    let withActor = fields;
    if (!this.applyingRemote) {
      const actor = resolveActor(this.config);
      if (actor && fields.updated_by === undefined) {
        withActor = { ...fields, updated_by: actor };
      }
    }
    const task = await super.updateFields(slug, withActor, opts);
    this.recordLocalMutation(slug, 'push');
    return task;
  }

  async insertSection(
    slug: string,
    sectionName: string,
    content: string,
    opts: InsertSectionOptions,
  ): Promise<void> {
    await super.insertSection(slug, sectionName, content, opts);
    this.recordLocalMutation(slug, 'push');
  }

  async addChangelog(slug: string, entry: string, opts?: AddChangelogOptions): Promise<void> {
    await super.addChangelog(slug, entry, opts);
    this.recordLocalMutation(slug, 'push');
  }

  // ── Sync engine ───────────────────────────────────────────────────────────

  async sync(direction: SyncDirection = 'both'): Promise<SyncReport> {
    const report: SyncReport = {
      backend: this.name,
      direction,
      pushed: 0,
      pulled: 0,
      created: 0,
      commentsAdded: 0,
      conflicts: [],
      pendingQueue: 0,
      errors: [],
      watermark: null,
      noop: false,
    };

    try {
      if (direction === 'pull' || direction === 'both') {
        await this.pullRemote(report);
      }
      if (direction === 'push' || direction === 'both') {
        await this.pushLocal(report);
      }
    } catch (err) {
      // Total failures (missing token/list, auth) — never throw out of sync():
      // hooks and post-sleep depend on sync being unable to break the caller.
      report.errors.push((err as Error).message ?? String(err));
    }

    report.pendingQueue = this.ledger.readQueue().length;
    report.watermark = this.ledger.readSyncState().watermark;
    return report;
  }

  // ── PUSH (local → ClickUp) ────────────────────────────────────────────────

  /**
   * Watermark-based push: collect tasks changed since their last successful
   * sync (WAL slugs ∪ hash drift, which also catches hand edits), then ONE
   * field-level PUT per task (create for unmapped), changelog entries →
   * comments. Idempotent: a re-run right after a successful push sends
   * nothing.
   */
  protected async pushLocal(report: SyncReport): Promise<void> {
    const adapter = this.getAdapter();
    const listId = this.requireListId();

    const state = this.ledger.readSyncState();
    const candidates = new Set(this.ledger.queuedSlugs());
    for (const file of this.taskFiles()) {
      const slug = basename(file, '.md');
      const entry = state.tasks[slug];
      const hash = hashContent(readFileSync(file, 'utf-8'));
      if (!entry?.localHash || entry.localHash !== hash) candidates.add(slug);
    }

    for (const slug of [...candidates].sort()) {
      try {
        await this.pushTask(slug, adapter, listId, report);
      } catch (err) {
        report.errors.push(`push ${slug}: ${(err as Error).message ?? err}`);
      }
    }
  }

  protected async pushTask(
    slug: string,
    adapter: ApiAdapter,
    listId: string,
    report: SyncReport,
  ): Promise<void> {
    const path = this.taskPath(slug);
    if (!existsSync(path)) return;
    const task = (await super.get(slug))!;
    const enqueueCutoff = this.nowMs();

    const entry = this.ledger.taskSync(slug);
    const baseEntries = entry?.base_snapshot
      ? changelogEntriesOfBody(entry.base_snapshot.body)
      : [];
    const currentEntries = splitChangelogEntries(task.changelog);
    const baseNorm = new Set(baseEntries.map(normalizeEntry));
    const newEntries = currentEntries.filter((e) => !baseNorm.has(normalizeEntry(e)));

    const memberMap = clickupMemberMap(this.contextRoot, this.config);
    const assigneeSlug = (task.raw.assignee as string | null | undefined) ?? null;
    const assigneeId = assigneeSlug ? memberMap[assigneeSlug] : undefined;

    const fields = {
      name: task.name,
      description: bodyToDescription(task.body),
      status: statusToClickUp(task.status),
      priority: priorityToClickUp(task.priority),
    };

    let remoteId = this.ledger.remoteIdFor(slug);
    let serverTime: number | null = null;

    if (!remoteId) {
      // CREATE: one POST carries everything (fields + tags + assignees).
      const created = await adapter.request<ClickUpTask>('POST', `/list/${listId}/task`, {
        body: {
          ...fields,
          tags: tagsToClickUp(task.tags, task.version),
          assignees: assigneeId ? [Number(assigneeId)] : [],
        },
      });
      remoteId = created.id;
      this.ledger.recordMapping({ slug, dcId: task.id, backend: this.name, remoteId });
      serverTime = serverTimeMs(created.date_updated);
      report.created++;
    } else {
      // UPDATE: ONE field-level PUT per task (rate-limit friendly by design).
      const updated = await adapter.request<ClickUpTask>('PUT', `/task/${remoteId}`, {
        body: {
          ...fields,
          ...(assigneeId !== undefined ? { assignees: { add: [Number(assigneeId)], rem: [] } } : {}),
        },
      });
      serverTime = serverTimeMs(updated.date_updated);
      report.pushed++;
    }

    // Changelog → comments (union-merged remotely; only entries the remote
    // hasn't seen yet, so re-runs post nothing).
    for (const entryText of newEntries) {
      const comment = await adapter.request<{ id: string; date?: string }>(
        'POST',
        `/task/${remoteId}/comment`,
        { body: { comment_text: entryText } },
      );
      serverTime = serverTimeMs(comment.date) ?? serverTime;
      report.commentsAdded++;
    }

    // Success bookkeeping. last_synced_at is ClickUp SERVER time — never the
    // local clock; when the server omitted it we keep the previous watermark.
    const raw = readFileSync(path, 'utf-8');
    this.ledger.updateTaskSync(slug, {
      last_synced_at: serverTime ?? entry?.last_synced_at ?? 0,
      base_snapshot: { hash: hashContent(raw), body: raw },
      localHash: hashContent(raw),
      pendingPush: false,
    });
    this.ledger.advanceWatermark(serverTime);
    this.ledger.dequeueFor(slug, enqueueCutoff);
  }

  // ── PULL (ClickUp → local) — implemented in M4 ───────────────────────────

  protected async pullRemote(_report: SyncReport): Promise<void> {
    // M4 fills this in (delta pull by date_updated > watermark + merge rules).
  }
}

/** Extract the changelog entries from a stored base-snapshot body. */
function changelogEntriesOfBody(body: string): string[] {
  const lines = body.split('\n');
  const section: string[] = [];
  let inChangelog = false;
  for (const line of lines) {
    const h = line.match(/^(#{2})\s+(.+)$/);
    if (h) {
      inChangelog = h[2].trim().toLowerCase() === 'changelog';
      continue;
    }
    if (inChangelog) section.push(line);
  }
  return splitChangelogEntries(section.join('\n'));
}

/**
 * Factory used by getTaskBackend(). Always returns the backend when
 * taskBackend=clickup — mirror reads/writes work offline; only sync() needs
 * the token/list and reports (never throws) when they are missing.
 */
export function createClickUpBackend(
  contextRoot: string,
  config: SetupConfig | null,
  deps: ClickUpBackendDeps = {},
): ClickUpTaskBackend {
  return new ClickUpTaskBackend(contextRoot, config, deps);
}
