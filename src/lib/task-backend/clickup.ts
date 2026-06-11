import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import matter from 'gray-matter';
import { generateId, slugify } from '../id.js';
import type { SetupConfig } from '../setup-config.js';
import { ApiAdapter } from './api-adapter.js';
import {
  bodyToDescription,
  normalizeEntry,
  priorityFromClickUp,
  priorityToClickUp,
  splitChangelogEntries,
  statusFromClickUp,
  statusToClickUp,
  tagsFromClickUp,
  tagsToClickUp,
  serverTimeMs,
  type ClickUpComment,
  type ClickUpTask,
} from './clickup-map.js';
import { clickupMemberMap, resolveActor, resolveActorToken } from './identity.js';
import { LocalTaskBackend } from './local.js';
import { merge3Bodies, mergeScalar, unionChangelog } from './merge.js';
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

  // ── PULL (ClickUp → local) ────────────────────────────────────────────────

  /**
   * Delta pull: only tasks with `date_updated > watermark` (SERVER time) are
   * fetched. Each is merged into the mirror per the field-class rules:
   * changelog = comment union (conflict-free); scalars = LWW; prose = 3-way
   * with base_snapshot; missing base → ClickUp wins + local copy preserved
   * under state/.conflicts/ and surfaced. Nothing is ever silently lost.
   */
  protected async pullRemote(report: SyncReport): Promise<void> {
    const adapter = this.getAdapter();
    const listId = this.requireListId();
    const watermark = this.ledger.readSyncState().watermark;

    const remoteTasks: ClickUpTask[] = [];
    for (let page = 0; ; page++) {
      const res = await adapter.request<{ tasks?: ClickUpTask[]; last_page?: boolean }>(
        'GET',
        `/list/${listId}/task`,
        {
          query: {
            page,
            include_closed: true,
            ...(watermark !== null ? { date_updated_gt: watermark } : {}),
          },
        },
      );
      const batch = res.tasks ?? [];
      remoteTasks.push(...batch);
      if (res.last_page !== false || batch.length === 0) break;
    }

    for (const remote of remoteTasks) {
      try {
        await this.applyRemoteTask(remote, adapter, report);
      } catch (err) {
        report.errors.push(`pull ${remote.id}: ${(err as Error).message ?? err}`);
      }
    }
  }

  /** Inverse member map: ClickUp member id → person slug. */
  protected memberSlugById(): Record<string, string> {
    const inverse: Record<string, string> = {};
    for (const [slug, id] of Object.entries(clickupMemberMap(this.contextRoot, this.config))) {
      inverse[String(id)] = slug;
    }
    return inverse;
  }

  protected async applyRemoteTask(
    remote: ClickUpTask,
    adapter: ApiAdapter,
    report: SyncReport,
  ): Promise<void> {
    const remoteTime = serverTimeMs(remote.date_updated);
    const commentsRes = await adapter.request<{ comments?: ClickUpComment[] }>(
      'GET',
      `/task/${remote.id}/comment`,
    );
    const remoteEntries = (commentsRes.comments ?? [])
      .map((c) => (c.comment_text ?? '').trim())
      .filter(Boolean);

    const { tags: remoteTags, version: remoteVersion } = tagsFromClickUp(remote.tags);
    const remoteStatus = statusFromClickUp(remote.status?.status);
    const remotePriority = priorityFromClickUp(remote.priority);
    const remoteDesc = (remote.description ?? '').replace(/\r\n/g, '\n').trim();
    const inverseMembers = this.memberSlugById();
    const firstAssignee = remote.assignees?.[0];
    const remoteAssignee: string | null = firstAssignee
      ? inverseMembers[String(firstAssignee.id)] ?? String(firstAssignee.username ?? firstAssignee.id)
      : null;

    let slug = this.ledger.slugForRemoteId(remote.id);

    if (!slug || !existsSync(this.taskPath(slug))) {
      // NEW remote task (or vanished mirror) → create the mirror file.
      slug = slug ?? this.uniqueSlugFor(remote.name);
      const fm: Record<string, unknown> = {
        id: generateId('task'),
        name: remote.name,
        description: remote.name,
        priority: remotePriority,
        urgency: 'medium',
        status: remoteStatus,
        created_at: dateOf(serverTimeMs(remote.date_created) ?? remoteTime),
        updated_at: dateOf(remoteTime),
        tags: remoteTags,
        parent_task: null,
        related_feature: null,
        version: remoteVersion,
        rice: null,
        assignee: remoteAssignee,
        created_by: 'clickup',
        updated_by: 'clickup',
      };
      const written = this.writeMirror(slug, fm, remoteDesc, remoteEntries);
      this.ledger.recordMapping({ slug, dcId: fm.id as string, backend: this.name, remoteId: remote.id });
      this.ledger.updateTaskSync(slug, {
        last_synced_at: remoteTime ?? 0,
        base_snapshot: { hash: hashContent(written), body: written },
        localHash: hashContent(written),
        pendingPush: false,
      });
      this.ledger.advanceWatermark(remoteTime);
      report.pulled++;
      return;
    }

    // EXISTING mirror → merge.
    const path = this.taskPath(slug);
    const entry = this.ledger.taskSync(slug);
    const localRaw = readFileSync(path, 'utf-8');
    const local = (await this.getLocal(slug))!;
    const localChanged = entry?.localHash ? hashContent(localRaw) !== entry.localHash : true;
    const localChangedAt = entry?.lastLocalChangeAt ?? null;

    const base = entry?.base_snapshot?.body ?? null;
    const baseParsed = base !== null ? matter(base) : null;
    const baseFm = (baseParsed?.data ?? null) as Record<string, unknown> | null;
    const baseDesc = baseParsed ? bodyToDescription(baseParsed.content.trim()).trim() : null;
    const baseTagInfo = baseFm
      ? { tags: (baseFm.tags as string[]) ?? [], version: (baseFm.version as string | null) ?? null }
      : null;

    // ── changelog: union (conflict-free by construction) ──
    const localEntries = splitChangelogEntries(local.changelog);
    const mergedEntries = unionChangelog(localEntries, remoteEntries);
    const remoteNorm = new Set(remoteEntries.map(normalizeEntry));
    const localOnlyEntries = localEntries.filter((e) => !remoteNorm.has(normalizeEntry(e)));

    // ── prose: 3-way with base; missing base → ClickUp wins + conflict copy ──
    const localDesc = bodyToDescription(local.body).trim();
    let mergedDesc = remoteDesc;
    let proseLocalKept = false;
    const conflicts: Array<'missing_base' | 'both_changed'> = [];

    if (!localChanged) {
      mergedDesc = remoteDesc;
    } else if (baseDesc === null) {
      if (localDesc !== remoteDesc) {
        conflicts.push('missing_base');
      }
      mergedDesc = remoteDesc;
    } else {
      const res = merge3Bodies(baseDesc, localDesc, remoteDesc);
      mergedDesc = res.merged.trim();
      proseLocalKept = res.localChangesKept;
      if (res.conflictSections.length > 0) conflicts.push('both_changed');
    }

    // ── scalars: last-write-wins (server time vs recorded local mutation) ──
    const scalar = <T,>(baseV: T | undefined, localV: T, remoteV: T) =>
      mergeScalar(baseV, localV, remoteV, localChanged ? localChangedAt : null, remoteTime);

    const statusM = scalar(baseFm?.status as string | undefined, local.status, remoteStatus);
    const priorityM = scalar(baseFm?.priority as string | undefined, local.priority, remotePriority);
    const nameM = scalar(baseFm?.name as string | undefined, local.name, remote.name);
    const tagsM = scalar(baseTagInfo?.tags, local.tags, remoteTags);
    const versionM = scalar(baseTagInfo?.version, local.version, remoteVersion);
    // assignee is ClickUp-authoritative; the local mirror still wins when the
    // remote side did not move (a pending local assignment awaiting push).
    const assigneeM = scalar(
      (baseFm?.assignee as string | null | undefined) ?? null,
      ((local.raw.assignee as string | null | undefined) ?? null),
      remoteAssignee,
    );

    const scalarResults = [statusM, priorityM, nameM, tagsM, versionM, assigneeM];
    const anyLocalWin = scalarResults.some((r) => r.winner === 'local');
    const anyRemoteWin = scalarResults.some((r) => r.winner === 'remote');
    const remoteAddedEntries = mergedEntries.length > localEntries.length;
    const remoteContributed = anyRemoteWin || remoteAddedEntries || mergedDesc !== localDesc;

    // ── conflicts: preserve the losing local copy, surface it ──
    for (const reason of conflicts) {
      const savedTo = this.saveConflictCopy(slug, localRaw, remoteTime);
      report.conflicts.push({ slug, savedTo, reason });
    }

    // ── write the merged mirror ──
    const fm: Record<string, unknown> = {
      ...local.raw,
      name: nameM.value,
      status: statusM.value,
      priority: priorityM.value,
      tags: tagsM.value,
      version: versionM.value,
      assignee: assigneeM.value,
      updated_at: remoteContributed && remoteTime !== null ? dateOf(remoteTime) : local.updated_at,
      // updated_by records the WINNER of the merge.
      updated_by: anyRemoteWin || conflicts.length > 0
        ? 'clickup'
        : (local.raw.updated_by ?? null),
    };
    const written = this.writeMirror(slug, fm, mergedDesc, mergedEntries);

    // ── bookkeeping: base reflects the REMOTE state so surviving local
    //    changes still diff (and push) against it. ──
    const keptLocal = anyLocalWin || proseLocalKept || localOnlyEntries.length > 0;
    if (keptLocal) {
      const remoteRender = this.renderMirror(
        { ...fm, name: remote.name, status: remoteStatus, priority: remotePriority, tags: remoteTags, version: remoteVersion, assignee: remoteAssignee },
        remoteDesc,
        remoteEntries,
      );
      this.ledger.updateTaskSync(slug, {
        last_synced_at: remoteTime ?? entry?.last_synced_at ?? 0,
        base_snapshot: { hash: hashContent(remoteRender), body: remoteRender },
        localHash: hashContent(remoteRender),
        pendingPush: true,
      });
    } else {
      this.ledger.updateTaskSync(slug, {
        last_synced_at: remoteTime ?? entry?.last_synced_at ?? 0,
        base_snapshot: { hash: hashContent(written), body: written },
        localHash: hashContent(written),
        pendingPush: false,
      });
      this.ledger.dequeueFor(slug, this.nowMs());
    }

    this.ledger.advanceWatermark(remoteTime);
    report.pulled++;
  }

  /** Read the mirror without any remote bookkeeping (super.get under a clear name). */
  protected getLocal(slug: string): Promise<TaskData | null> {
    return super.get(slug);
  }

  protected uniqueSlugFor(name: string): string {
    const baseSlug = slugify(name) || 'task';
    let candidate = baseSlug;
    let n = 1;
    while (existsSync(this.taskPath(candidate))) {
      n++;
      candidate = `${baseSlug}-${n}`;
    }
    return candidate;
  }

  /** Compose a mirror file (frontmatter + prose body + Changelog section). */
  protected renderMirror(
    fm: Record<string, unknown>,
    desc: string,
    changelogEntries: string[],
  ): string {
    const changelog = changelogEntries.length > 0
      ? `## Changelog\n<!-- LIFO: newest at top -->\n\n${changelogEntries.join('\n\n')}\n`
      : '';
    const body = `${desc.trim()}\n${changelog ? `\n${changelog}` : ''}`;
    return matter.stringify(body, fm);
  }

  protected writeMirror(
    slug: string,
    fm: Record<string, unknown>,
    desc: string,
    changelogEntries: string[],
  ): string {
    const content = this.renderMirror(fm, desc, changelogEntries);
    this.applyingRemote = true;
    try {
      writeFileSync(this.taskPath(slug), content, 'utf-8');
    } finally {
      this.applyingRemote = false;
    }
    return content;
  }

  /** Preserve a losing local copy under state/.conflicts/ — never silent loss. */
  protected saveConflictCopy(slug: string, localRaw: string, remoteTime: number | null): string {
    const dir = this.ledger.conflictsDir();
    mkdirSync(dir, { recursive: true });
    const stamp = remoteTime ?? this.nowMs();
    let path = join(dir, `${slug}-${stamp}.md`);
    let n = 1;
    while (existsSync(path)) {
      n++;
      path = join(dir, `${slug}-${stamp}-${n}.md`);
    }
    writeFileSync(path, localRaw, 'utf-8');
    return path;
  }
}

/** Epoch-ms (server time) → YYYY-MM-DD frontmatter date. */
function dateOf(ms: number | null): string {
  return new Date(ms ?? 0).toISOString().split('T')[0];
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
