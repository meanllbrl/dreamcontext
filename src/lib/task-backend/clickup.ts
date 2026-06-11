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
  RemoteMember,
  SyncDirection,
  SyncReport,
  TaskData,
  UpdateFieldsOptions,
} from './types.js';

// ─── person:<slug> tag ↔ assignee bridge ────────────────────────────────────
// dreamcontext's existing person-tag convention drives the remote assignee:
// tag a task `person:<slug>` and the push assigns it to that member; a remote
// assignee pulls back as both the `assignee` field and the person tag.
// person: tags never leave the mirror — ClickUp has real assignees instead.

const PERSON_TAG_PREFIX = 'person:';

function stripPersonTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith(PERSON_TAG_PREFIX));
}

function personTagSlug(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith(PERSON_TAG_PREFIX));
  return tag ? tag.slice(PERSON_TAG_PREFIX.length) : null;
}

function withPersonTag(tags: string[], assignee: string | null): string[] {
  const out = stripPersonTags(tags);
  if (assignee) out.push(`${PERSON_TAG_PREFIX}${assignee}`);
  return out;
}

/**
 * Slug for a remote display name. Ascii-folds before slugify so
 * "Mehmet Nuraydın" → "mehmet-nuraydin" (plain slugify would mangle the
 * dotless ı into a dash).
 */
export function memberSlug(name: string): string {
  const folded = name
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return slugify(folded);
}

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

  // ── Members (assignee candidates) ────────────────────────────────────────

  private membersRefreshed = false;

  /** Best-effort member refresh — once per sync(), failure never breaks sync. */
  protected async refreshMembers(adapter: ApiAdapter, listId: string): Promise<void> {
    if (this.membersRefreshed) return;
    this.membersRefreshed = true;
    try {
      const res = await adapter.request<{ members?: Array<{ id: number | string; username?: string; email?: string }> }>(
        'GET',
        `/list/${listId}/member`,
      );
      const map: Record<string, { id: string; name: string; email?: string }> = {};
      for (const m of res.members ?? []) {
        const name = m.username ?? String(m.id);
        map[memberSlug(name)] = { id: String(m.id), name, ...(m.email ? { email: m.email } : {}) };
      }
      if (Object.keys(map).length > 0) this.ledger.writeMembers(map);
    } catch { /* members are a convenience — never fail the sync */ }
    try {
      // The list's status SET (custom per list) — status pushes map against
      // it so we never PUT a status the list rejects with a 400.
      const list = await adapter.request<{ statuses?: Array<{ status?: string }> }>(
        'GET',
        `/list/${listId}`,
      );
      const statuses = (list.statuses ?? []).map((x) => x.status ?? '').filter(Boolean);
      if (statuses.length > 0) this.ledger.writeListStatuses(statuses);
    } catch { /* status cache is a convenience too */ }
  }

  /** Live member list for the configured container (also refreshes the cache). */
  async listMembers(): Promise<RemoteMember[]> {
    const adapter = this.getAdapter();
    const listId = this.requireListId();
    this.membersRefreshed = false;
    await this.refreshMembers(adapter, listId);
    return Object.entries(this.ledger.readMembers())
      .map(([slug, m]) => ({ slug, id: m.id, name: m.name, email: m.email }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** Person slug → remote member id: explicit config mapping first, then the cache. */
  protected memberIdFor(slug: string): string | null {
    const configured = clickupMemberMap(this.contextRoot, this.config)[slug];
    if (configured) return configured;
    return this.ledger.readMembers()[slug]?.id ?? null;
  }

  /** Remote member id → person slug: config mapping first, then the cache. */
  protected slugForMemberId(id: string): string | null {
    for (const [slug, memberId] of Object.entries(clickupMemberMap(this.contextRoot, this.config))) {
      if (memberId === id) return slug;
    }
    for (const [slug, m] of Object.entries(this.ledger.readMembers())) {
      if (m.id === id) return slug;
    }
    return null;
  }

  /** Settings "Test connection": authenticate and fetch the token's user. */
  async testConnection(): Promise<{ ok: true; user: string } | { ok: false; error: string }> {
    try {
      const adapter = this.getAdapter();
      const res = await adapter.request<{ user?: { username?: string; id?: number | string } }>('GET', '/user');
      return { ok: true, user: String(res.user?.username ?? res.user?.id ?? 'unknown') };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
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
      // Member cache refresh (assignee candidates) — best-effort, 1 request.
      try {
        await this.refreshMembers(this.getAdapter(), this.requireListId());
      } catch { /* config errors surface below via pull/push */ }
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

    // assignee: explicit frontmatter field, else the person:<slug> tag.
    const assigneeSlug = ((task.raw.assignee as string | null | undefined) ?? null) || personTagSlug(task.tags);
    const assigneeId = assigneeSlug ? this.memberIdFor(assigneeSlug) : null;

    // Map the status against the list's actual status set; an unmappable
    // status is OMITTED (the remote keeps its value) instead of 400-ing.
    const mappedStatus = statusToClickUp(task.status, this.ledger.readListStatuses());
    const fields = {
      name: task.name,
      description: bodyToDescription(task.body),
      ...(mappedStatus !== null ? { status: mappedStatus } : {}),
      priority: priorityToClickUp(task.priority),
    };

    let remoteId = this.ledger.remoteIdFor(slug);
    let serverTime: number | null = null;

    if (!remoteId) {
      // CREATE: one POST carries everything (fields + tags + assignees).
      const created = await adapter.request<ClickUpTask>('POST', `/list/${listId}/task`, {
        body: {
          ...fields,
          // person: tags stay local — the remote has real assignees.
          tags: tagsToClickUp(stripPersonTags(task.tags), task.version),
          assignees: assigneeId ? [Number(assigneeId)] : [],
        },
      });
      remoteId = created.id;
      this.ledger.recordMapping({ slug, dcId: task.id, backend: this.name, remoteId });
      serverTime = serverTimeMs(created.date_updated);
      report.created++;
    } else {
      // Diff against the base snapshot: assignees and tags are the only
      // fields ClickUp's PUT cannot fully express, so they need deltas.
      const baseFm = entry?.base_snapshot
        ? (matter(entry.base_snapshot.body).data as Record<string, unknown>)
        : null;
      const baseAssigneeSlug = baseFm
        ? (((baseFm.assignee as string | null | undefined) ?? null)
            || personTagSlug(((baseFm.tags as string[]) ?? [])))
        : null;
      const baseAssigneeId = baseAssigneeSlug ? this.memberIdFor(baseAssigneeSlug) : null;
      const assigneePatch = assigneeId !== baseAssigneeId
        ? {
            assignees: {
              add: assigneeId ? [Number(assigneeId)] : [],
              rem: baseAssigneeId ? [Number(baseAssigneeId)] : [],
            },
          }
        : {};

      // UPDATE: ONE field-level PUT per task (rate-limit friendly by design).
      const updated = await adapter.request<ClickUpTask>('PUT', `/task/${remoteId}`, {
        body: { ...fields, ...assigneePatch },
      });
      serverTime = serverTimeMs(updated.date_updated);
      report.pushed++;

      // Tag deltas: ClickUp's PUT carries no tags — changed tags go through
      // the per-tag endpoints. person: tags stay local (assignees above).
      if (baseFm) {
        const baseTags = tagsToClickUp(
          stripPersonTags(((baseFm.tags as string[]) ?? [])),
          ((baseFm.version as string | null | undefined) ?? null),
        );
        const desiredTags = tagsToClickUp(stripPersonTags(task.tags), task.version);
        const toAdd = desiredTags.filter((t) => !baseTags.includes(t));
        const toRemove = baseTags.filter((t) => !desiredTags.includes(t));
        for (const tag of toAdd) {
          await adapter.request('POST', `/task/${remoteId}/tag/${encodeURIComponent(tag)}`);
        }
        for (const tag of toRemove) {
          await adapter.request('DELETE', `/task/${remoteId}/tag/${encodeURIComponent(tag)}`);
        }
        if (toAdd.length > 0 || toRemove.length > 0) {
          // Tag endpoints bump date_updated server-side without returning it —
          // refetch once so the watermark covers our own write (no echo pull).
          const fresh = await adapter.request<ClickUpTask>('GET', `/task/${remoteId}`);
          serverTime = serverTimeMs(fresh.date_updated) ?? serverTime;
        }
      }
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
      // Client-side watermark guard: the real API treats `date_updated_gt`
      // as >= (observed live), which would echo the newest task on every
      // pull forever. Filter strictly-greater here so convergence never
      // depends on the server's comparison semantics.
      remoteTasks.push(
        ...batch.filter((t) => {
          const ts = serverTimeMs(t.date_updated);
          return watermark === null || ts === null || ts > watermark;
        }),
      );
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
    let remoteStatus = statusFromClickUp(remote.status?.status);
    const remotePriority = priorityFromClickUp(remote.priority);
    const remoteDesc = (remote.description ?? '').replace(/\r\n/g, '\n').trim();
    const firstAssignee = remote.assignees?.[0];
    const remoteAssignee: string | null = firstAssignee
      ? this.slugForMemberId(String(firstAssignee.id))
        ?? memberSlug(String(firstAssignee.username ?? firstAssignee.id))
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
        tags: withPersonTag(remoteTags, remoteAssignee),
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
      ? {
          tags: stripPersonTags(((baseFm.tags as string[]) ?? [])),
          version: (baseFm.version as string | null) ?? null,
          assignee: ((baseFm.assignee as string | null | undefined) ?? null)
            || personTagSlug(((baseFm.tags as string[]) ?? [])),
        }
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

    // Status equivalence: when the remote raw status is exactly what WE would
    // push for the local status (e.g. local `in_review` mapped onto a list
    // without a review status as "in progress"), the remote did not really
    // move — don't let the folded value overwrite the richer local one.
    const remoteRawStatus = remote.status?.status?.toLowerCase() ?? null;
    if (
      remoteRawStatus !== null &&
      statusToClickUp(local.status, this.ledger.readListStatuses())?.toLowerCase() === remoteRawStatus
    ) {
      remoteStatus = local.status;
    }

    // ── scalars: last-write-wins (server time vs recorded local mutation) ──
    const scalar = <T,>(baseV: T | undefined, localV: T, remoteV: T) =>
      mergeScalar(baseV, localV, remoteV, localChanged ? localChangedAt : null, remoteTime);

    const statusM = scalar(baseFm?.status as string | undefined, local.status, remoteStatus);
    const priorityM = scalar(baseFm?.priority as string | undefined, local.priority, remotePriority);
    const nameM = scalar(baseFm?.name as string | undefined, local.name, remote.name);
    const tagsM = scalar(baseTagInfo?.tags, stripPersonTags(local.tags), remoteTags);
    const versionM = scalar(baseTagInfo?.version, local.version, remoteVersion);
    // assignee is ClickUp-authoritative; the local mirror still wins when the
    // remote side did not move (a pending local assignment awaiting push).
    const assigneeM = scalar(
      baseTagInfo?.assignee,
      (((local.raw.assignee as string | null | undefined) ?? null) || personTagSlug(local.tags)),
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
      tags: withPersonTag(tagsM.value, assigneeM.value),
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
        { ...fm, name: remote.name, status: remoteStatus, priority: remotePriority, tags: withPersonTag(remoteTags, remoteAssignee), version: remoteVersion, assignee: remoteAssignee },
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
