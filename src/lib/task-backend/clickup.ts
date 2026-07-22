import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import matter from 'gray-matter';
import { generateId, slugify } from '../id.js';
import { mergeRice, normalizeRice, type RiceInput } from '../rice.js';
import type { SetupConfig } from '../setup-config.js';
import { ApiAdapter } from './api-adapter.js';
import {
  bodyToDescription,
  dueDateFromClickUp,
  dueDateToClickUp,
  startDateFromClickUp,
  startDateToClickUp,
  foldAscii,
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
import {
  decodeFieldValue,
  encodeFieldValue,
  isPullable,
  localFieldValue,
  matchCustomFields,
  buildSpecs,
  userProvisionDefs,
  BUILTIN_FIELD_KEYS,
  RECOMMENDED_FIELD_DEFS,
  RICE_KEYS,
  type ClickUpFieldDef,
  type ClickUpFieldValue,
  type FieldBinding,
} from './clickup-fields.js';
import { customFieldsFor, loadTaskOverride, type CustomFieldDef } from '../overrides.js';
import { getActivePlanningVersion } from '../active-version.js';
import { getExistingReleases } from '../release-discovery.js';
import { recordDashboardChange, type FieldChange } from '../change-tracker.js';
import { clickupMemberMap, resolveActor, resolveActorToken } from './identity.js';
import { foreignProjectOf, projectScopeId, projectTag } from './provenance.js';
import { writeClickUpToken, resolveClickUpToken, maskToken } from './secrets.js';
import { BACKLOG_TAG, LocalTaskBackend } from './local.js';
import { merge3Bodies, mergeScalar, planAssigneeHeal, unionChangelog } from './merge.js';
import { SyncLedger, hashContent, reconcileRenamedTasks, matchLocalTaskForRemote } from './sync-state.js';
import type {
  AddChangelogOptions,
  AssigneeDrift,
  CreateTaskInput,
  InsertSectionOptions,
  RemoteMember,
  SyncDirection,
  SyncOptions,
  SyncReport,
  TaskData,
  TokenStatus,
  UpdateFieldsOptions,
} from './types.js';

// ─── person:<slug> tags ↔ assignees bridge ──────────────────────────────────
// dreamcontext leans on person tags for assignment: a task may carry any number
// of `person:<slug>` tags, and each maps to a real ClickUp assignee. On push the
// full set becomes the remote `assignees`; on pull the remote assignees come
// back as person tags. person: tags never leave the mirror as plain tags —
// ClickUp has real assignees instead. The legacy single `assignee` frontmatter
// field is still read (folded into the set) so pre-existing tasks keep working.

const PERSON_TAG_PREFIX = 'person:';

function stripPersonTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith(PERSON_TAG_PREFIX));
}

function personTagSlugs(tags: string[]): string[] {
  return tags
    .filter((t) => t.startsWith(PERSON_TAG_PREFIX))
    .map((t) => t.slice(PERSON_TAG_PREFIX.length))
    .filter(Boolean);
}

function withPersonTags(tags: string[], assignees: string[]): string[] {
  const out = stripPersonTags(tags);
  for (const slug of assignees) if (slug) out.push(`${PERSON_TAG_PREFIX}${slug}`);
  return out;
}

/**
 * The assignee SET for a task: every `person:<slug>` tag, plus the legacy
 * single `assignee` frontmatter field if present (back-compat). Returned
 * sorted + de-duped so the value is order-stable for JSON-equality merges.
 */
function assigneeSlugsOf(raw: Record<string, unknown> | null, tags: string[]): string[] {
  const set = new Set(personTagSlugs(tags));
  const legacy = ((raw?.assignee as string | null | undefined) ?? null);
  if (legacy) set.add(legacy);
  return [...set].sort();
}

/**
 * Slug for a remote display name. Ascii-folds before slugify so
 * "Mehmet Nuraydın" → "mehmet-nuraydin" (plain slugify would mangle the
 * dotless ı into a dash).
 */
export function memberSlug(name: string): string {
  return slugify(foldAscii(name));
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

// ClickUp's hard limit is 100 requests/minute per token. Pace BELOW it so a
// large burst (the post-sleep push of every reconciled task) self-throttles
// under the ceiling instead of tipping into 429s at the window edge — the sync
// just takes a little longer. The headroom also absorbs client/server window
// skew and any concurrent requests sharing the token.
const CLICKUP_RATE_PER_MINUTE = 90;
// Survive transient 429/5xx past the throttle: exponential backoff honouring
// Retry-After (handled in ApiAdapter). 5 attempts covers a full rate window.
const CLICKUP_MAX_RETRIES = 5;

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

  /**
   * The canonical version spellings a lowercased ClickUp tag folds back onto
   * (#184) — RELEASES.json plus the active sprint. Deliberately NOT "any version
   * string seen on a local task": that would let one typo'd task capture every
   * pull. An unregistered version simply stays as ClickUp returned it.
   *
   * Memoised for the life of the backend: the pull calls this once per task.
   */
  private knownVersionsMemo: string[] | null = null;
  protected knownVersions(): string[] {
    if (this.knownVersionsMemo) return this.knownVersionsMemo;
    const out = new Set<string>();
    try {
      for (const r of getExistingReleases(this.contextRoot)) {
        if (r.version) out.add(r.version);
      }
    } catch { /* no/!readable RELEASES.json — nothing to canonicalize against */ }
    try {
      const active = getActivePlanningVersion(this.contextRoot);
      if (active) out.add(active);
    } catch { /* same */ }
    this.knownVersionsMemo = [...out];
    return this.knownVersionsMemo;
  }

  /**
   * This project's stable provenance id (#177) — stamped on every pushed row and
   * compared against a pulled row's `dcproject:` tag to tell native from foreign.
   * Memoised; null only when no id can be derived at all (never in practice —
   * the basename fallback always yields one).
   */
  private projectIdMemo: string | null | undefined;
  protected myProjectId(): string | null {
    if (this.projectIdMemo === undefined) {
      this.projectIdMemo = projectScopeId(this.config, this.projectRoot);
    }
    return this.projectIdMemo;
  }

  /** Append this project's `dcproject:` stamp to a remote tag set (no-op when no id). */
  protected withProjectStamp(tags: string[]): string[] {
    const id = this.myProjectId();
    return id ? [...tags, projectTag(id)] : tags;
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
        ratePerMinute: CLICKUP_RATE_PER_MINUTE,
        maxRetries: CLICKUP_MAX_RETRIES,
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

  async delete(slug: string): Promise<void> {
    const remoteId = this.ledger.remoteIdFor(slug);
    await super.delete(slug);
    // Drop every local trace NOW; the remote deletion replays on next sync.
    this.ledger.removeMapping(slug);
    this.ledger.removeTaskSync(slug);
    this.ledger.dequeueFor(slug, Number.MAX_SAFE_INTEGER);
    if (remoteId && !this.applyingRemote) {
      this.ledger.enqueue({ id: generateId('op'), kind: 'delete', slug, ts: this.nowMs(), remoteId });
    }
  }

  async rename(slug: string, newName: string): Promise<string> {
    // Move the file + rewrite the name (the local backend also enqueues a push
    // op under the OLD slug via our updateFields override).
    const newSlug = await super.rename(slug, newName);
    // Re-key the ledger (map + sync-state + queued ops) so the SAME ClickUp task
    // is matched by its stable dcId and UPDATED on next sync — never duplicated.
    if (newSlug !== slug && !this.applyingRemote) this.ledger.migrateSlug(slug, newSlug);
    return newSlug;
  }

  // ── Members (assignee candidates) ────────────────────────────────────────

  private membersRefreshed = false;

  /** Container meta rarely changes — refresh at most once per hour. */
  private static readonly META_REFRESH_MS = 60 * 60 * 1000;
  /** Deletions are rare — full id sweeps at most once per 2 minutes. */
  private static readonly RECONCILE_MS = 2 * 60 * 1000;
  /** A sync lock older than this belongs to a dead process — break it. */
  private static readonly LOCK_STALE_MS = 3 * 60 * 1000;

  /**
   * Best-effort meta refresh (members + statuses + field defs = 3 GETs).
   * Throttled to once per hour across processes; `force` (listMembers,
   * provision) bypasses. Failure never breaks sync.
   */
  protected async refreshMembers(adapter: ApiAdapter, listId: string, force = false): Promise<void> {
    if (this.membersRefreshed) return;
    if (!force) {
      const last = this.ledger.readThrottle('lastMetaRefreshAt');
      if (last !== null && this.nowMs() - last < ClickUpTaskBackend.META_REFRESH_MS) {
        this.membersRefreshed = true;
        return; // cached meta is fresh enough — saves 3 requests per sync
      }
    }
    this.membersRefreshed = true;
    this.ledger.writeThrottle('lastMetaRefreshAt', this.nowMs());
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
    try {
      // Custom field defs — the bridge for urgency/summary/RICE/feature/….
      // Creating a matching field on the list is all it takes to opt in.
      const res = await adapter.request<{ fields?: ClickUpFieldDef[] }>(
        'GET',
        `/list/${listId}/field`,
      );
      this.ledger.writeCustomFields((res.fields ?? []) as unknown as Array<Record<string, unknown>>);
    } catch { /* field bridge is opt-in — absence is fine */ }
  }

  private _userFieldDefs?: CustomFieldDef[];
  /** Override-declared custom fields targeting ClickUp (cached per instance). */
  protected userFieldDefs(): CustomFieldDef[] {
    if (this._userFieldDefs === undefined) {
      const ov = loadTaskOverride(this.contextRoot);
      this._userFieldDefs = ov ? customFieldsFor(ov.customFields, 'clickup') : [];
    }
    return this._userFieldDefs;
  }

  protected fieldBindings(): FieldBinding[] {
    return matchCustomFields(
      this.ledger.readCustomFields<ClickUpFieldDef>(),
      buildSpecs(this.userFieldDefs()),
    );
  }

  /**
   * Member list for the configured container. Tries a live refresh; when
   * offline/unconfigured it falls back to the cached set rather than
   * returning empty (the assignee picker must keep working offline).
   */
  async listMembers(): Promise<RemoteMember[]> {
    try {
      const adapter = this.getAdapter();
      const listId = this.requireListId();
      this.membersRefreshed = false;
      await this.refreshMembers(adapter, listId, true);
    } catch { /* fall back to the cache below */ }
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

  /**
   * Create the recommended custom fields on the list (verified live:
   * POST /list/:id/field works on ClickUp v2). Skips fields the bridge
   * already binds; refreshes the cache so the next sync uses them at once.
   *
   * `{ dryRun: true }` reports what WOULD be created (`created`) vs what already
   * exists, creating NOTHING and skipping backfill — the Settings preview.
   */
  async provisionRemote(opts?: { dryRun?: boolean }): Promise<{ created: string[]; existing: string[]; backfilled: number; errors: string[] }> {
    const dryRun = opts?.dryRun === true;
    const adapter = this.getAdapter();
    const listId = this.requireListId();

    // Fresh defs → which recommended keys are already bound?
    this.membersRefreshed = false;
    await this.refreshMembers(adapter, listId, true);

    const { created, existing, errors } = await this.createMissingFields(adapter, listId, dryRun);

    // Preview mode: report the delta only; never mutate (no creation, no backfill).
    if (dryRun) {
      return { created, existing, backfilled: 0, errors };
    }

    // BACKFILL: already-synced tasks have no hash drift, so the delta push
    // would never fill fresh fields. Write the local value wherever the
    // remote field is still EMPTY — idempotent by construction.
    let backfilled = 0;
    const bindings = this.fieldBindings();
    if (bindings.length > 0) {
      for (const mapEntry of this.ledger.readMap()) {
        const task = await this.getLocal(mapEntry.slug);
        if (!task) continue;
        let remoteTask: ClickUpTask;
        try {
          remoteTask = await adapter.request<ClickUpTask>('GET', `/task/${mapEntry.remoteId}`);
        } catch {
          continue; // unreachable remote task — sync will surface it later
        }
        const remoteFields = (remoteTask.custom_fields ?? []) as unknown as ClickUpFieldValue[];
        for (const binding of bindings) {
          const value = localFieldValue(task.raw, binding.key);
          if (value === null) continue;
          const rf = remoteFields.find((f) => f.id === binding.field.id);
          if (rf && rf.value !== undefined && rf.value !== null && rf.value !== '') continue;
          const encoded = encodeFieldValue(binding, value);
          if (encoded === null) continue;
          try {
            await adapter.request('POST', `/task/${mapEntry.remoteId}/field/${binding.field.id}`, {
              body: { value: encoded },
            });
            backfilled++;
          } catch (err) {
            errors.push(`${mapEntry.slug}.${binding.key}: ${(err as Error).message ?? err}`);
          }
        }
      }
      if (backfilled > 0) {
        // Our writes bumped remote date_updated — settle the watermark with a
        // pull (no-op merges: the values came from the local files).
        await this.sync('pull');
      }
    }
    return { created, existing, backfilled, errors };
  }

  /**
   * Field-creation core, shared by `provisionRemote` (the manual button) and
   * `sync()` (auto-provision). Reads the CURRENTLY cached field bindings — the
   * caller is responsible for refreshing them first — so it adds no network when
   * nothing is missing. `dryRun` reports the delta without POSTing anything.
   * Never backfills and never triggers a nested sync (so it is safe to call from
   * inside `sync()`).
   */
  private async createMissingFields(
    adapter: ApiAdapter,
    listId: string,
    dryRun: boolean,
  ): Promise<{ created: string[]; existing: string[]; errors: string[] }> {
    const bound = new Set(this.fieldBindings().map((b) => b.key));
    const created: string[] = [];
    const existing: string[] = [];
    const errors: string[] = [];

    // Recommended fields + every override-declared custom field. A field whose
    // folded name already binds on the list is REUSED (reported `existing`),
    // never recreated — the user's "use it if it's already there" requirement.
    const provisionDefs: Array<{ key: string; name: string; type: string; options?: string[] }> = [
      ...RECOMMENDED_FIELD_DEFS,
      ...userProvisionDefs(this.userFieldDefs()),
    ];

    for (const def of provisionDefs) {
      if (bound.has(def.key)) {
        existing.push(def.name);
        continue;
      }
      if (dryRun) {
        created.push(def.name); // would create — preview only
        continue;
      }
      try {
        await adapter.request('POST', `/list/${listId}/field`, {
          body: {
            name: def.name,
            type: def.type,
            ...(def.options
              ? { type_config: { options: def.options.map((name) => ({ name })) } }
              : {}),
          },
        });
        created.push(def.name);
      } catch (err) {
        errors.push(`${def.name}: ${(err as Error).message ?? err}`);
      }
    }

    if (!dryRun && created.length > 0) {
      this.membersRefreshed = false;
      await this.refreshMembers(adapter, listId, true); // re-cache with the new defs
    }

    return { created, existing, errors };
  }

  /** Pickable lists for the Settings onboarding (token resolved internally). */
  async discoverContainers(): Promise<Array<{ ids: Record<string, string>; path: string; name: string }>> {
    const token = resolveActorToken(this.projectRoot, this.contextRoot, this.config);
    if (!token) return [];
    const lists = await discoverClickUpListsInternal(token.token, this.deps);
    return lists.map((l) => ({
      ids: { teamId: l.teamId, spaceId: l.spaceId, listId: l.listId },
      path: `${l.teamName} / ${l.spaceName}${l.folderName ? ` / ${l.folderName}` : ''} / ${l.listName}`,
      name: l.listName,
    }));
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

  /** Settings inline API-key entry: persist the token into the secrets store. */
  setToken(token: string): void {
    writeClickUpToken(this.projectRoot, token);
  }

  /** Settings "key set ✓" indicator: resolved token status, masked. */
  tokenStatus(): TokenStatus {
    const resolved = resolveClickUpToken(this.projectRoot);
    return resolved
      ? { set: true, source: resolved.source, masked: maskToken(resolved.token) }
      : { set: false, source: null, masked: null };
  }

  // ── Sync engine ───────────────────────────────────────────────────────────

  async sync(direction: SyncDirection = 'both', opts: SyncOptions = {}): Promise<SyncReport> {
    const report: SyncReport = {
      backend: this.name,
      direction,
      pushed: 0,
      pulled: 0,
      created: 0,
      deleted: 0,
      mirrorDeleted: 0,
      mirrorRemapped: 0,
      commentsAdded: 0,
      conflicts: [],
      pendingQueue: 0,
      errors: [],
      failedPushes: [],
      warnings: [],
      reconciled: 0,
      watermark: null,
      noop: false,
    };

    // ONE sync engine per project: manual CLI, git hooks, post-sleep, and
    // the dashboard button can all fire concurrently — the loser yields.
    if (!this.ledger.acquireSyncLock(this.nowMs(), ClickUpTaskBackend.LOCK_STALE_MS)) {
      report.skipped = 'locked';
      report.pendingQueue = this.ledger.readQueue().length;
      report.watermark = this.ledger.readSyncState().watermark;
      return report;
    }

    try {
      // Heal renamed tasks FIRST (#77): re-key the ledger from any stale slug to
      // the renamed file's current slug (matched by stable dcId) before either
      // direction runs — so push UPDATEs the same remote task (no duplicate) and
      // pull resolves it by the live slug (no resurrected mirror).
      const renamed = reconcileRenamedTasks(this.ledger, this.liveTaskIdentities());
      for (const r of renamed) {
        report.warnings.push(`renamed: ${r.from} → ${r.to} (remapped to existing remote task; no duplicate created)`);
      }
      // The remote-list memo is scoped to ONE sync — it exists so the two
      // reconcile passes share a fetch, not so a reused backend instance can
      // serve last sync's tasks.
      this.remoteListMemo = null;
      // Bind the derived caches to the list they describe BEFORE anything reads
      // them (#184): whichever path repointed `clickup.listId` — `--keep`, the
      // dashboard config PATCH, a hand-edited config — the cached statuses of the
      // OLD list must not survive into this sync.
      try {
        const moved = this.ledger.adoptContainer(`list:${this.requireListId()}`);
        if (moved.switched) {
          report.warnings.push(
            `sync target moved (${moved.from} → list:${this.requireListId()}): dropped the cached statuses/members/fields of the old list and reset the pull watermark — this sync re-reads the new list in full. Local task mirrors are KEPT (never deleted) and re-created in the new list; nothing is silently lost.`,
          );
        }
      } catch { /* config errors surface below via pull/push */ }
      // Member cache refresh (assignee candidates) — best-effort, 1 request.
      // `--refresh-meta` bypasses the hourly throttle so a status just added in
      // the ClickUp UI is picked up now rather than up to an hour from now.
      try {
        await this.refreshMembers(this.getAdapter(), this.requireListId(), opts.refreshMeta === true);
      } catch { /* config errors surface below via pull/push */ }
      // Auto-provision the recommended custom fields so a push always has
      // somewhere to write — the user shouldn't have to remember the button.
      // Reads the just-refreshed field cache, so it costs ZERO network in the
      // steady state (everything already bound); only the first sync after the
      // list is configured actually creates fields. Best-effort: a failure here
      // must never break the sync.
      try {
        await this.createMissingFields(this.getAdapter(), this.requireListId(), false);
      } catch (err) {
        // Best-effort, but never silent: surface the failure in the report so a
        // missing remote field isn't a mystery (#dashboard-custom-fields review).
        report.errors.push('auto-provision: ' + ((err as Error).message ?? err));
      }
      if (direction === 'pull' || direction === 'both') {
        await this.pullRemote(report);
      }
      if (direction === 'push' || direction === 'both') {
        await this.pushLocal(report);
      }
      // Heal pre-existing assignee drift LAST (#78): after push has settled any
      // local-first changes, adopt the remote assignee set for tasks whose drift
      // sits below the watermark (so a normal delta pull would never re-examine
      // them). Opt-in (`--reconcile`) because it costs a full remote fetch.
      if (opts.reconcile) {
        await this.reconcileAssignees(report);
        // Same below-the-watermark blind spot, different facet (#184): a version
        // tag added remotely after import. Shares the assignee pass's full fetch.
        await this.reconcileVersions(report);
      }
    } catch (err) {
      // Total failures (missing token/list, auth) — never throw out of sync():
      // hooks and post-sleep depend on sync being unable to break the caller.
      report.errors.push((err as Error).message ?? String(err));
    } finally {
      this.ledger.releaseSyncLock();
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

    // Replay queued deletions first (a 404 means it is already gone — done).
    for (const op of this.ledger.readQueue().filter((q) => q.kind === 'delete')) {
      try {
        await adapter.request('DELETE', `/task/${op.remoteId}`);
        report.deleted++;
        this.ledger.dequeueFor(op.slug, op.ts);
      } catch (err) {
        if ((err as { kind?: string }).kind === 'not_found') {
          this.ledger.dequeueFor(op.slug, op.ts);
        } else {
          report.errors.push(`delete ${op.slug}: ${(err as Error).message ?? err}`);
        }
      }
    }

    const state = this.ledger.readSyncState();
    const candidates = new Set(
      this.ledger.readQueue().filter((q) => q.kind !== 'delete').map((q) => q.slug),
    );
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
        // The task stays drifted (no last_synced bump) and will be re-selected
        // next run — but record it so callers never read a partial push as done.
        report.failedPushes.push(slug);
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

    // assignees: every person:<slug> tag (plus the legacy assignee field),
    // mapped to ClickUp member ids. A slug that maps to NO member is NOT
    // silently dropped — it is surfaced as a warning (otherwise an all-unmapped
    // create sends an empty assignee set and ClickUp defaults the assignee to
    // the API-token owner, with no signal to the user).
    const assigneeIds: number[] = [];
    const unmappedAssignees: string[] = [];
    for (const s of assigneeSlugsOf(task.raw, task.tags)) {
      const id = this.memberIdFor(s);
      if (id !== null) assigneeIds.push(Number(id));
      else unmappedAssignees.push(s);
    }
    if (unmappedAssignees.length > 0) {
      report.warnings.push(
        `push ${slug}: assignee ${unmappedAssignees.map((s) => `person:${s}`).join(', ')} ` +
        `maps to no ClickUp member — left unassigned (add them to the list, or map with ` +
        `\`dreamcontext config clickup-member <slug> <id>\`).`,
      );
    }

    // Map the status against the list's actual status set; an unmappable
    // status is OMITTED (the remote keeps its value) instead of 400-ing.
    const listStatuses = this.ledger.readListStatuses();
    const mappedStatus = statusToClickUp(task.status, listStatuses);
    // Omitting the status is safe on an UPDATE but NOT honest on a CREATE: with
    // no status in the payload ClickUp stamps the list's first open status, so
    // an in_progress task silently materialises as e.g. 'backlog' and looks like
    // data loss (#184/#178). The push can't do better — the list genuinely has no
    // matching status — but it must not stay quiet about it.
    if (mappedStatus === null && listStatuses.length > 0) {
      report.warnings.push(
        `push ${slug}: status '${task.status}' matches none of the list's statuses ` +
        `(${listStatuses.join(', ')}) — ClickUp will stamp its first open status instead. ` +
        `Add a matching status to the list in the ClickUp UI, then re-run ` +
        `\`dreamcontext tasks sync --refresh-meta\`.`,
      );
    }
    // start_date + due_date ride the same single PUT/POST (both NATIVE ClickUp
    // fields). Each is sent when set, or as null to CLEAR one the remote already
    // had (so clears propagate). Backlog tasks are undated by rule → both null.
    const isBacklog = task.tags.some((t) => t.toLowerCase() === BACKLOG_TAG);
    const dueLocal = isBacklog ? null : ((task.raw.due_date as string | null | undefined) ?? null);
    const startLocal = isBacklog ? null : ((task.raw.start_date as string | null | undefined) ?? null);
    const baseSnapshotFm = entry?.base_snapshot
      ? (matter(entry.base_snapshot.body).data as Record<string, unknown>)
      : null;
    const baseFmDue = (baseSnapshotFm?.due_date as string | null | undefined) ?? null;
    const baseFmStart = (baseSnapshotFm?.start_date as string | null | undefined) ?? null;
    const fields = {
      name: task.name,
      description: bodyToDescription(task.body),
      ...(mappedStatus !== null ? { status: mappedStatus } : {}),
      priority: priorityToClickUp(task.priority),
      ...(startLocal !== null || baseFmStart !== null
        ? { start_date: startDateToClickUp(startLocal), start_date_time: false }
        : {}),
      ...(dueLocal !== null || baseFmDue !== null
        ? { due_date: dueDateToClickUp(dueLocal), due_date_time: false }
        : {}),
    };

    let remoteId = this.ledger.remoteIdFor(slug);
    if (!remoteId) {
      // Rename-safe join (#77): the slug may have changed, but the STABLE dcId
      // still maps to an existing remote task. Re-key the ledger and UPDATE it
      // rather than CREATE a duplicate. (The sync() pre-pass normally heals this
      // first; this is the per-task safety net so the create branch is only ever
      // taken for a genuinely new, never-synced task.)
      const byDcId = this.ledger.entryForDcId(task.id);
      if (byDcId && byDcId.slug !== slug) {
        this.ledger.migrateSlug(byDcId.slug, slug);
        remoteId = byDcId.remoteId;
      }
    }
    let serverTime: number | null = null;
    // Tag/field endpoints bump date_updated without returning it — refetch
    // once at the end so the watermark covers our own writes (no echo pull).
    let needsTimestampRefetch = false;

    if (!remoteId) {
      // CREATE: one POST carries everything (fields + tags + assignees).
      const created = await adapter.request<ClickUpTask>('POST', `/list/${listId}/task`, {
        body: {
          ...fields,
          // person: tags stay local — the remote has real assignees.
          // dcproject: stamps the row so a shared-list pull can tell it apart (#177).
          tags: this.withProjectStamp(tagsToClickUp(stripPersonTags(task.tags), task.version)),
          assignees: assigneeIds,
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
      const baseAssigneeIds = (baseFm
        ? assigneeSlugsOf(baseFm, ((baseFm.tags as string[]) ?? []))
        : []
      )
        .map((s) => this.memberIdFor(s))
        .filter((id): id is string => id !== null)
        .map(Number);
      const add = assigneeIds.filter((id) => !baseAssigneeIds.includes(id));
      const rem = baseAssigneeIds.filter((id) => !assigneeIds.includes(id));
      const assigneePatch = add.length > 0 || rem.length > 0
        ? { assignees: { add, rem } }
        : {};

      // UPDATE: ONE field-level PUT per task (rate-limit friendly by design).
      const updated = await adapter.request<ClickUpTask>('PUT', `/task/${remoteId}`, {
        body: { ...fields, ...assigneePatch },
      });
      serverTime = serverTimeMs(updated.date_updated);
      report.pushed++;

      // Tag deltas: ClickUp's PUT carries no tags — changed tags go through
      // the per-tag endpoints. person: tags stay local (assignees above).
      const toAdd: string[] = [];
      const toRemove: string[] = [];

      // Non-version tags diff against the base snapshot, so remote-only tags
      // (added in ClickUp) survive until a merge reconciles them.
      if (baseFm) {
        const baseTags = stripPersonTags(((baseFm.tags as string[]) ?? []));
        const desiredTags = stripPersonTags(task.tags);
        toAdd.push(...desiredTags.filter((t) => !baseTags.includes(t)));
        toRemove.push(...baseTags.filter((t) => !desiredTags.includes(t)));
      }

      // version: is single-valued — at most ONE version:<v> may exist remotely.
      // The base-snapshot diff alone misses a stale version tag whenever the
      // snapshot's version drifted from the actual remote tag (e.g. the version
      // was changed via a bound custom FIELD rather than the tag). Reconcile
      // against the LIVE remote tags carried in the PUT response so a version
      // change never leaves an orphaned version:<v> behind.
      const desiredVersionTag = task.version ? `version:${task.version}` : null;
      const liveTagNames = (updated.tags ?? []).map((t) => t.name).filter(Boolean);
      for (const live of liveTagNames) {
        if (live.startsWith('version:') && live !== desiredVersionTag && !toRemove.includes(live)) {
          toRemove.push(live);
        }
      }
      if (desiredVersionTag && !liveTagNames.includes(desiredVersionTag) && !toAdd.includes(desiredVersionTag)) {
        toAdd.push(desiredVersionTag);
      }

      // dcproject: is a static stamp — self-heal it onto rows this project owns
      // but pushed before provenance shipped (#177). Never removed here: a row we
      // push is ours, so we only ever ensure OUR stamp is present.
      const myStamp = this.myProjectId() ? projectTag(this.myProjectId()!) : null;
      if (myStamp && !liveTagNames.includes(myStamp) && !toAdd.includes(myStamp)) {
        toAdd.push(myStamp);
      }

      for (const tag of toAdd) {
        await adapter.request('POST', `/task/${remoteId}/tag/${encodeURIComponent(tag)}`);
      }
      for (const tag of toRemove) {
        await adapter.request('DELETE', `/task/${remoteId}/tag/${encodeURIComponent(tag)}`);
      }
      if (toAdd.length > 0 || toRemove.length > 0) needsTimestampRefetch = true;
    }

    // Custom-field deltas (urgency, summary, RICE, feature, …): write only
    // the keys whose value moved vs the base snapshot — and only for fields
    // that actually EXIST on the list.
    const bindings = this.fieldBindings();
    if (bindings.length > 0) {
      const baseFmFields = entry?.base_snapshot
        ? (matter(entry.base_snapshot.body).data as Record<string, unknown>)
        : null;
      for (const binding of bindings) {
        const localVal = localFieldValue(task.raw, binding.key);
        const baseVal = baseFmFields ? localFieldValue(baseFmFields, binding.key) : null;
        if (localVal === baseVal) continue;
        const encoded = encodeFieldValue(binding, localVal);
        if (encoded === null && localVal !== null) continue; // unmappable dropdown option
        try {
          await adapter.request('POST', `/task/${remoteId}/field/${binding.field.id}`, {
            body: { value: encoded },
          });
          needsTimestampRefetch = true;
        } catch (err) {
          report.errors.push(`field ${binding.key} on ${slug}: ${(err as Error).message ?? err}`);
        }
      }
    }

    if (needsTimestampRefetch) {
      const fresh = await adapter.request<ClickUpTask>('GET', `/task/${remoteId}`);
      serverTime = serverTimeMs(fresh.date_updated) ?? serverTime;
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
    // local clock; when the server omitted it we keep the previous value.
    const raw = readFileSync(path, 'utf-8');
    this.ledger.updateTaskSync(slug, {
      last_synced_at: serverTime ?? entry?.last_synced_at ?? 0,
      base_snapshot: { hash: hashContent(raw), body: raw },
      localHash: hashContent(raw),
      pendingPush: false,
    });
    // NOTE: the push must NOT advance the global pull watermark (#185). The
    // watermark's contract is "I have PULLED everything up to T" — it gates
    // `date_updated_gt`. A push proves only "I WROTE at T", which is a different
    // fact. Advancing it here silently skipped every remote change older than our
    // own write that we had not pulled yet: teammate pushes at T1, we push at
    // T2 > T1 without pulling, and their task is excluded from every future delta
    // pull. Forever, with no error — the pull just reports `pulled 0`.
    //
    // Echo suppression (the reason this was here) does not need the watermark:
    // base_snapshot + localHash are written right above, so re-pulling our own
    // write merges to a no-op. Per-task `last_synced_at` stays — that IS per-task
    // bookkeeping, not the global pull gate.
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
    // When the watermark is null the delta fetch returns EVERYTHING — reuse
    // those ids for deletion reconciliation instead of fetching again.
    const fullSetIds: Set<string> | null = watermark === null ? new Set<string>() : null;
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
      if (fullSetIds) for (const t of batch) fullSetIds.add(t.id);
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

    const pendingDeletes = this.ledger.pendingDeleteRemoteIds();
    for (const remote of remoteTasks) {
      if (pendingDeletes.has(remote.id)) continue; // deleted locally — do not resurrect
      try {
        await this.applyRemoteTask(remote, adapter, report);
      } catch (err) {
        report.errors.push(`pull ${remote.id}: ${(err as Error).message ?? err}`);
      }
    }

    // ── Remote-deletion reconciliation ──────────────────────────────────────
    // A deleted remote task produces NO delta event — it just vanishes from
    // the list. Diff the id-map against the FULL remote id set; any mapped
    // task missing remotely was deleted on the remote side.
    await this.reconcileRemoteDeletions(adapter, listId, pendingDeletes, report, fullSetIds);
  }

  protected async reconcileRemoteDeletions(
    adapter: ApiAdapter,
    listId: string,
    pendingDeletes: Set<string>,
    report: SyncReport,
    knownFullSet: Set<string> | null,
  ): Promise<void> {
    const map = this.ledger.readMap();
    if (map.length === 0) return;

    // Request budget: the sweep is FREE when the delta already fetched the
    // full set (null watermark); otherwise it runs at most once per 2 minutes
    // (deletions are rare; commit-hook bursts collapse to one sweep).
    let remoteIds: Set<string>;
    if (knownFullSet) {
      remoteIds = knownFullSet;
    } else {
      const last = this.ledger.readThrottle('lastReconcileAt');
      if (last !== null && this.nowMs() - last < ClickUpTaskBackend.RECONCILE_MS) return;
      // Full id sweep — if ANY page fails, skip reconciliation entirely: a
      // partial set must never be read as "everything else was deleted".
      remoteIds = new Set<string>();
      try {
        for (let page = 0; ; page++) {
          const res = await adapter.request<{ tasks?: ClickUpTask[]; last_page?: boolean }>(
            'GET',
            `/list/${listId}/task`,
            { query: { page, include_closed: true } },
          );
          const batch = res.tasks ?? [];
          for (const t of batch) remoteIds.add(t.id);
          if (res.last_page !== false || batch.length === 0) break;
        }
      } catch {
        return; // offline / flaky — try again next sync
      }
    }
    this.ledger.writeThrottle('lastReconcileAt', this.nowMs());

    // TARGET SWITCH, not a remote deletion. While a remap is pending, a map entry
    // that points at the OLD container's remote id is absent from the NEW one
    // because the target moved — not because the user deleted a task. This sweep
    // now runs against an AUTHORITATIVE full remote set (a switch nulls the
    // watermark, so `knownFullSet` is populated), so once we finish the loop the
    // stale mappings are resolved and the intent can be cleared.
    const remapMode = this.ledger.pendingContainerRemap();

    for (const entry of map) {
      if (remoteIds.has(entry.remoteId)) continue;
      if (pendingDeletes.has(entry.remoteId)) continue; // our own deletion in flight

      // Deleting the mirror here would nuke every task the moment the target is
      // repointed (via `--keep`, the dashboard config PATCH, or a hand-edited
      // config). Instead we KEEP the file and drop only the stale mapping/sync
      // state; this same sync's push re-creates the task in the new container
      // (migrate semantics), so the `--keep`-but-wrong / dashboard / hand-edit
      // paths all become non-destructive. Genuinely-moved tasks (`--keep`
      // truthful) keep the same remote id, so they ARE present in the new
      // container and never reach this branch.
      if (remapMode) {
        this.ledger.removeMapping(entry.slug);
        this.ledger.removeTaskSync(entry.slug);
        this.ledger.dequeueFor(entry.slug, Number.MAX_SAFE_INTEGER);
        report.mirrorRemapped++;
        report.warnings.push(
          `task '${entry.slug}' was mapped to the previous sync target and is not in the new one — its local mirror is KEPT and will be re-created in the new container on this sync's push (not deleted).`,
        );
        continue;
      }

      const path = this.taskPath(entry.slug);

      try {
        if (existsSync(path)) {
          // Never silently lose local edits: if the mirror moved since the
          // last sync, preserve a copy before honoring the remote deletion.
          const raw = readFileSync(path, 'utf-8');
          const syncEntry = this.ledger.taskSync(entry.slug);
          const localChanged = !syncEntry?.localHash || hashContent(raw) !== syncEntry.localHash;
          if (localChanged) {
            const savedTo = this.saveConflictCopy(entry.slug, raw, null);
            report.conflicts.push({ slug: entry.slug, savedTo, reason: 'remote_deleted' });
          }
          this.applyingRemote = true;
          try {
            await super.delete(entry.slug);
          } finally {
            this.applyingRemote = false;
          }
        }
        this.ledger.removeMapping(entry.slug);
        this.ledger.removeTaskSync(entry.slug);
        this.ledger.dequeueFor(entry.slug, Number.MAX_SAFE_INTEGER);
        report.mirrorDeleted++;

        // Consolidation must see outside deletions too.
        try {
          recordDashboardChange(this.contextRoot, {
            entity: 'task',
            action: 'delete',
            target: `state/${entry.slug}.md`,
            summary: `Remote sync deleted task '${entry.slug}' (removed on ${this.name})`,
          });
        } catch { /* the journal must never break a sync */ }
      } catch (err) {
        report.errors.push(`reconcile ${entry.slug}: ${(err as Error).message ?? err}`);
      }
    }

    // The stale mappings from the switch are now resolved against an authoritative
    // remote set — clear the intent so ordinary remote deletions reconcile normally
    // again on the next sync.
    if (remapMode) this.ledger.clearPendingContainerRemap();
  }

  protected async applyRemoteTask(
    remote: ClickUpTask,
    adapter: ApiAdapter,
    report: SyncReport,
  ): Promise<void> {
    const remoteTime = serverTimeMs(remote.date_updated);

    // ECHO GATE (#185) — skip a remote state we ourselves just wrote.
    //
    // Echo suppression used to ride on the GLOBAL pull watermark: the push
    // advanced it past its own writes so the next delta pull wouldn't see them.
    // That silently dropped a COLLABORATOR's older, unpulled change out of every
    // future pull — their task's date_updated sat below a watermark our own push
    // had jumped. Suppression has to be per-task, because "I wrote this task at
    // T" is a fact about ONE task, not about the whole list.
    //
    // `last_synced_at` is the server time of the remote state we last ingested or
    // wrote for THIS task, so `remoteTime <= last_synced_at` means we are looking
    // at our own write (or a state already merged). A real edit by someone else
    // always advances date_updated beyond it. Cheap, precise, and it lets the
    // watermark go back to meaning only "I have pulled everything up to T".
    const known = this.ledger.slugForRemoteId(remote.id);
    if (known !== null && remoteTime !== null) {
      const seenAt = this.ledger.taskSync(known)?.last_synced_at ?? 0;
      if (seenAt > 0 && remoteTime <= seenAt) {
        this.ledger.advanceWatermark(remoteTime);
        return; // not a change — never count or journal our own echo
      }
    }

    // PROVENANCE (#177) — a shared list pulls every project's rows. `foreign` is
    // set when the row's `dcproject:` stamp names ANOTHER project; null for a
    // native or unstamped row. Under `scope: 'project'` a foreign row is skipped
    // outright (never imported); otherwise it is imported but marked so it is
    // visibly foreign in the snapshot and `tasks list`.
    const remoteTagNames = (remote.tags ?? []).map((t) => t.name).filter(Boolean);
    const foreign = foreignProjectOf(remoteTagNames, this.myProjectId());
    if (foreign && this.config?.clickup?.scope === 'project') {
      // Skip WITHOUT advancing the watermark: the global watermark must never
      // jump on a row we didn't ingest, or an older unpulled native task could
      // slip below it. Re-seen next delta pull, skipped again — cheap (no fetch).
      return;
    }

    const commentsRes = await adapter.request<{ comments?: ClickUpComment[] }>(
      'GET',
      `/task/${remote.id}/comment`,
    );
    const remoteEntries = (commentsRes.comments ?? [])
      .map((c) => (c.comment_text ?? '').trim())
      .filter(Boolean);

    const { tags: remoteTags, version: remoteVersion } = tagsFromClickUp(remote.tags, this.knownVersions());
    let remoteStatus = statusFromClickUp(remote.status?.status);
    const remotePriority = priorityFromClickUp(remote.priority);
    const remoteDesc = (remote.description ?? '').replace(/\r\n/g, '\n').trim();
    const remoteDue = dueDateFromClickUp(remote.due_date);
    const remoteStart = startDateFromClickUp(remote.start_date);
    // Every remote assignee maps back to a person:<slug> tag (sorted + deduped
    // for order-stable merges). dreamcontext leans on person tags, not a single
    // assignee field, so the full set round-trips.
    const remoteAssignees: string[] = [
      ...new Set(
        (remote.assignees ?? []).map(
          (a) =>
            this.slugForMemberId(String(a.id)) ??
            memberSlug(String(a.username ?? a.id)),
        ),
      ),
    ].sort();

    let slug = this.ledger.slugForRemoteId(remote.id);

    // FALLBACK MATCH (#204) — the map entry for this remote task is missing
    // (e.g. a team-merge conflict on `.tasks-map.json`), but the local mirror
    // may still exist. Re-link by exact name before falling through to the
    // create-new path, so a lost mapping re-links instead of duplicating.
    //
    // GUARD: `pull` runs BEFORE `push` (see `sync()`), so a freshly-created,
    // never-synced local task has no map entry either — the matcher's only
    // exclusion (claimed by a DIFFERENT remoteId) can't see it. Without this
    // guard, an unrelated remote task that merely shares its name would get
    // re-linked to it, 3-way-merging two unrelated tasks' content (base null)
    // and binding future pushes to the wrong remote. A genuine #204 orphan
    // corrupts the COMMITTED `.tasks-map.json` but leaves the machine-local
    // `.tasks-sync.json` intact, so only accept the match when the candidate
    // has PRIOR sync history on this machine (`taskSync().base_snapshot` set)
    // — a never-synced creation has none and safely falls through to `-N`.
    if (!slug) {
      const match = matchLocalTaskForRemote(this.ledger, this.liveTaskDescriptors(), {
        remoteId: remote.id,
        name: remote.name,
      });
      if (match && this.ledger.taskSync(match.slug)?.base_snapshot) {
        slug = match.slug;
        this.ledger.recordMapping({ slug: match.slug, dcId: match.dcId, backend: this.name, remoteId: remote.id });
        try {
          recordDashboardChange(this.contextRoot, {
            entity: 'task',
            action: 'update',
            target: `state/${slug}.md`,
            summary: `Re-linked orphaned mirror '${slug}' to remote task (${this.name}) — .tasks-map.json entry was missing`,
          });
        } catch { /* the journal must never break a sync */ }
      }
    }

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
        tags: withPersonTags(remoteTags, remoteAssignees),
        parent_task: null,
        related_feature: null,
        version: remoteVersion,
        rice: null,
        start_date: remoteStart,
        due_date: remoteDue,
        created_by: 'clickup',
        updated_by: 'clickup',
        // Foreign provenance (#177): only present when the row belongs to another
        // project sharing this list — never on native rows, so `tasks list` and
        // the snapshot stay clean for the common single-project case.
        ...(foreign ? { source_project: foreign } : {}),
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
      // Remote-originated changes must reach consolidation too: tasks are
      // editable from outside, so the sleep ledger journals every pull.
      try {
        recordDashboardChange(this.contextRoot, {
          entity: 'task',
          action: 'create',
          target: `state/${slug}.md`,
          summary: `Remote sync created task '${slug}' (from ${this.name})`,
        });
      } catch { /* the journal must never break a sync */ }
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
          assignees: assigneeSlugsOf(baseFm, ((baseFm.tags as string[]) ?? [])),
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
    const remoteRawStatus = remote.status?.status ? foldAscii(remote.status.status) : null;
    const wouldPush = statusToClickUp(local.status, this.ledger.readListStatuses());
    if (remoteRawStatus !== null && wouldPush !== null && foldAscii(wouldPush) === remoteRawStatus) {
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
    // assignees are ClickUp-authoritative; the local mirror still wins when the
    // remote side did not move (a pending local assignment awaiting push). The
    // whole SET is merged LWW (slugs sorted → order-stable JSON equality).
    const assigneeM = scalar(
      baseTagInfo?.assignees,
      assigneeSlugsOf(local.raw, local.tags),
      remoteAssignees,
    );

    // ── custom fields: decode remote values, per-field LWW like other scalars ──
    const bindings = this.fieldBindings();
    const remoteFields = (remote.custom_fields ?? []) as unknown as ClickUpFieldValue[];
    const fieldWinners: Array<{ key: string; value: string | number | null; winner: 'local' | 'remote' | 'none' }> = [];
    const remoteFieldState: Record<string, string | number | null> = {};
    for (const binding of bindings) {
      if (!isPullable(binding)) continue;
      const rf = remoteFields.find((f) => f.id === binding.field.id);
      if (!rf) continue; // task payload didn't carry the field
      const remoteVal = decodeFieldValue(rf, binding);
      remoteFieldState[binding.key] = remoteVal;
      const localVal = localFieldValue(local.raw, binding.key);
      const baseVal = baseFm ? localFieldValue(baseFm, binding.key) : undefined;
      const merged = scalar(baseVal, localVal, remoteVal);
      fieldWinners.push({ key: binding.key, value: merged.value, winner: merged.winner });
    }

    const dueM = scalar(
      ((baseFm?.due_date as string | null | undefined) ?? null) as string | null,
      ((local.raw.due_date as string | null | undefined) ?? null),
      remoteDue,
    );
    const startM = scalar(
      ((baseFm?.start_date as string | null | undefined) ?? null) as string | null,
      ((local.raw.start_date as string | null | undefined) ?? null),
      remoteStart,
    );

    const scalarResults = [statusM, priorityM, nameM, tagsM, versionM, assigneeM, dueM, startM];
    const anyLocalWin = scalarResults.some((r) => r.winner === 'local')
      || fieldWinners.some((r) => r.winner === 'local');
    const anyRemoteWin = scalarResults.some((r) => r.winner === 'remote')
      || fieldWinners.some((r) => r.winner === 'remote');
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
      tags: withPersonTags(tagsM.value, assigneeM.value),
      version: versionM.value,
      // Product rule: backlog ⇒ undated (applies to remote-originated state too).
      start_date: tagsM.value.some((t) => t.toLowerCase() === BACKLOG_TAG) ? null : startM.value,
      due_date: tagsM.value.some((t) => t.toLowerCase() === BACKLOG_TAG) ? null : dueM.value,
      updated_at: remoteContributed && remoteTime !== null ? dateOf(remoteTime) : local.updated_at,
      // updated_by records the WINNER of the merge.
      updated_by: anyRemoteWin || conflicts.length > 0
        ? 'clickup'
        : (local.raw.updated_by ?? null),
    };
    // Lean on person tags: a legacy single `assignee` field (spread from
    // local.raw) is folded into the tag set above, so drop it from the mirror.
    delete fm.assignee;
    // Apply custom-field winners (rice subfields rebuild the block — score
    // is always recomputed locally, never trusted from the remote).
    const ricePatch: RiceInput = {};
    let riceTouched = false;
    const customPatch: Record<string, string | number | null> = {};
    for (const fw of fieldWinners) {
      if ((RICE_KEYS as string[]).includes(fw.key)) {
        if (fw.value !== localFieldValue(local.raw, fw.key as never)) riceTouched = true;
        (ricePatch as Record<string, unknown>)[fw.key] = fw.value ?? undefined;
        continue;
      }
      if (fw.key === 'version') {
        fm.version = fw.value; // a bound version FIELD outranks the version tag
        continue;
      }
      if (!BUILTIN_FIELD_KEYS.has(fw.key)) {
        customPatch[fw.key] = fw.value; // override-declared custom field
        continue;
      }
      fm[fw.key] = fw.value;
    }
    if (riceTouched) {
      fm.rice = mergeRice(normalizeRice(local.raw.rice), ricePatch);
    }
    if (Object.keys(customPatch).length > 0) {
      fm.custom_fields = {
        ...((local.raw.custom_fields as Record<string, unknown>) ?? {}),
        ...customPatch,
      };
    }

    const written = this.writeMirror(slug, fm, mergedDesc, mergedEntries);

    // ── bookkeeping: base reflects the REMOTE state so surviving local
    //    changes still diff (and push) against it. ──
    const keptLocal = anyLocalWin || proseLocalKept || localOnlyEntries.length > 0;
    if (keptLocal) {
      const remoteFmOverrides: Record<string, unknown> = {};
      const remoteCustom: Record<string, unknown> = {};
      let remoteRice = normalizeRice(fm.rice);
      for (const [key, value] of Object.entries(remoteFieldState)) {
        if ((RICE_KEYS as string[]).includes(key)) {
          remoteRice = mergeRice(remoteRice, { [key]: value ?? undefined } as RiceInput);
        } else if (key === 'version') {
          remoteFmOverrides.version = value;
        } else if (!BUILTIN_FIELD_KEYS.has(key)) {
          remoteCustom[key] = value;
        } else {
          remoteFmOverrides[key] = value;
        }
      }
      const remoteCustomOverride = Object.keys(remoteCustom).length > 0
        ? { custom_fields: { ...((fm.custom_fields as Record<string, unknown>) ?? {}), ...remoteCustom } }
        : {};
      const remoteRender = this.renderMirror(
        { ...fm, name: remote.name, status: remoteStatus, priority: remotePriority, tags: withPersonTags(remoteTags, remoteAssignees), version: remoteVersion, start_date: remoteTags.some((t) => t.toLowerCase() === BACKLOG_TAG) ? null : remoteStart, due_date: remoteTags.some((t) => t.toLowerCase() === BACKLOG_TAG) ? null : remoteDue, ...remoteFmOverrides, ...remoteCustomOverride, rice: remoteRice },
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

    // Journal what the REMOTE changed (winners only) into the sleep ledger —
    // consolidation has to see outside edits exactly like dashboard edits.
    try {
      const remoteFieldChanges: FieldChange[] = [];
      const namedScalars: Array<[string, { winner: string; value: unknown }, unknown]> = [
        ['status', statusM, local.status],
        ['priority', priorityM, local.priority],
        ['name', nameM, local.name],
        ['tags', tagsM, stripPersonTags(local.tags)],
        ['version', versionM, local.version],
        ['assignees', assigneeM, assigneeSlugsOf(local.raw, local.tags)],
        ['due_date', dueM, (local.raw.due_date as string | null | undefined) ?? null],
        ['start_date', startM, (local.raw.start_date as string | null | undefined) ?? null],
      ];
      for (const [field, merged, from] of namedScalars) {
        if (merged.winner === 'remote') {
          remoteFieldChanges.push({
            field,
            from: from as FieldChange['from'],
            to: merged.value as FieldChange['to'],
          });
        }
      }
      for (const fw of fieldWinners) {
        if (fw.winner === 'remote') {
          remoteFieldChanges.push({
            field: fw.key,
            from: localFieldValue(local.raw, fw.key as never) as FieldChange['from'],
            to: fw.value as FieldChange['to'],
          });
        }
      }
      if (remoteAddedEntries) {
        remoteFieldChanges.push({ field: 'changelog', from: null, to: null });
      }
      if (mergedDesc !== localDesc) {
        remoteFieldChanges.push({ field: 'body', from: null, to: null });
      }

      if (remoteFieldChanges.length > 0) {
        const fieldNames = remoteFieldChanges.map((f) => f.field).join(', ');
        // With `fields` set, the ledger coalesces + rebuilds the summary from
        // the net field diffs — exactly what consolidation needs to read.
        recordDashboardChange(this.contextRoot, {
          entity: 'task',
          action: 'update',
          target: `state/${slug}.md`,
          field: fieldNames,
          fields: remoteFieldChanges,
          summary: `Remote sync updated task '${slug}' (${fieldNames})`,
        });
      }
      if (conflicts.length > 0) {
        // Conflicts get their own entry (no `fields`) so the pointer to the
        // preserved copy survives verbatim into the sleep ledger.
        recordDashboardChange(this.contextRoot, {
          entity: 'task',
          action: 'update',
          target: `state/${slug}.md`,
          field: 'conflict',
          summary: `Remote sync conflict on '${slug}' (${conflicts.join(', ')}) — ClickUp version kept, local copy preserved under state/.conflicts/`,
        });
      }
    } catch { /* the journal must never break a sync */ }
  }

  // ── Reconcile passes (#78 assignees, #184 version) ────────────────────────

  /**
   * EVERY task on the list, paged. Memoised for the life of the backend so the
   * assignee (#78) and version (#184) reconcile passes of one sync share a single
   * full fetch — this is the expensive call that makes `--reconcile` opt-in, and
   * paying it twice for two facets of the same payload would be waste.
   */
  private remoteListMemo: ClickUpTask[] | null = null;
  private async fetchAllRemote(adapter: ApiAdapter, listId: string): Promise<ClickUpTask[]> {
    if (this.remoteListMemo) return this.remoteListMemo;
    const all: ClickUpTask[] = [];
    for (let page = 0; ; page++) {
      const res = await adapter.request<{ tasks?: ClickUpTask[]; last_page?: boolean }>(
        'GET',
        `/list/${listId}/task`,
        { query: { page, include_closed: true } }, // closed tasks drift too
      );
      const batch = res.tasks ?? [];
      all.push(...batch);
      if (res.last_page !== false || batch.length === 0) break;
    }
    this.remoteListMemo = all;
    return all;
  }

  /** remoteId → sorted person-slug assignee set, for EVERY task on the list. */
  private async fetchRemoteAssigneeMap(adapter: ApiAdapter, listId: string): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const t of await this.fetchAllRemote(adapter, listId)) {
      out.set(
        t.id,
        [...new Set(
          (t.assignees ?? []).map(
            (a) => this.slugForMemberId(String(a.id)) ?? memberSlug(String(a.username ?? a.id)),
          ),
        )].sort(),
      );
    }
    return out;
  }

  /**
   * Read-only assignee-drift scan (#78): mapped tasks whose remote assignee set
   * differs from local `person:` tags and that a `--reconcile` would safely heal
   * (remote moved, local did not — pending/diverged tasks are left for a normal
   * sync). Hits the network (full list fetch + a fresh member refresh).
   */
  async detectAssigneeDrift(): Promise<AssigneeDrift[]> {
    const adapter = this.getAdapter();
    const listId = this.requireListId();
    // Fresh id→slug mapping so a member assigned only in the ClickUp UI resolves.
    this.membersRefreshed = false;
    await this.refreshMembers(adapter, listId, true);
    const remoteMap = await this.fetchRemoteAssigneeMap(adapter, listId);

    const out: AssigneeDrift[] = [];
    for (const entry of this.ledger.readMap()) {
      const remote = remoteMap.get(entry.remoteId);
      if (remote === undefined) continue; // remote gone — deletion path owns it
      const local = await this.getLocal(entry.slug);
      if (!local) continue;
      const localAssignees = assigneeSlugsOf(local.raw, local.tags);
      const syncEntry = this.ledger.taskSync(entry.slug);
      const baseFm = syncEntry?.base_snapshot
        ? (matter(syncEntry.base_snapshot.body).data as Record<string, unknown>)
        : null;
      const baseAssignees = baseFm ? assigneeSlugsOf(baseFm, ((baseFm.tags as string[]) ?? [])) : null;
      if (planAssigneeHeal(localAssignees, baseAssignees, remote, !!syncEntry?.pendingPush) === 'heal') {
        out.push({ slug: entry.slug, local: localAssignees, remote });
      }
    }
    return out;
  }

  /**
   * Apply the assignee-drift heal: for each safely-healable task, replace its
   * `person:` tags with the remote set and re-baseline the ledger so the next
   * sync sees it as settled (no echo push, no re-pull). Idempotent.
   */
  protected async reconcileAssignees(report: SyncReport): Promise<void> {
    let drift: AssigneeDrift[];
    try {
      drift = await this.detectAssigneeDrift();
    } catch (err) {
      report.errors.push(`reconcile assignees: ${(err as Error).message ?? err}`);
      return;
    }
    for (const d of drift) {
      try {
        const local = await this.getLocal(d.slug);
        if (!local) continue;
        const newTags = withPersonTags(local.tags, d.remote);
        // Remote-origin write: applyingRemote suppresses the WAL/attribution so
        // the heal does not enqueue a push back at the remote we just read.
        this.applyingRemote = true;
        try {
          await super.updateFields(d.slug, {
            tags: newTags,
            updated_by: this.name,
            ...(local.raw.assignee != null ? { assignee: null } : {}),
          });
        } finally {
          this.applyingRemote = false;
        }
        const newRaw = readFileSync(this.taskPath(d.slug), 'utf-8');
        const entry = this.ledger.taskSync(d.slug);
        this.ledger.updateTaskSync(d.slug, {
          last_synced_at: entry?.last_synced_at ?? 0,
          base_snapshot: { hash: hashContent(newRaw), body: newRaw },
          localHash: hashContent(newRaw),
          pendingPush: false,
        });
        report.reconciled++;
        try {
          recordDashboardChange(this.contextRoot, {
            entity: 'task',
            action: 'update',
            target: `state/${d.slug}.md`,
            field: 'assignees',
            fields: [{ field: 'assignees', from: d.local, to: d.remote }],
            summary: `Reconciled assignees on '${d.slug}' from ${this.name} (${d.remote.map((s) => `person:${s}`).join(', ') || 'unassigned'})`,
          });
        } catch { /* the journal must never break a sync */ }
      } catch (err) {
        report.errors.push(`reconcile ${d.slug}: ${(err as Error).message ?? err}`);
      }
    }
  }

  // ── Version reconcile (#184) ──────────────────────────────────────────────

  /**
   * Adopt the remote `version:` tag for mapped tasks the delta pull cannot reach.
   *
   * A version label added in ClickUp AFTER a task was imported does not advance
   * that task's `date_updated` past the sync watermark in any way the delta pull
   * will revisit, so the version never lands locally — the task keeps `version:
   * null` and silently drops out of the Current Sprint board while ClickUp shows
   * it in the sprint. The only signal was noticing it missing (#184/#179).
   *
   * Deliberately conservative, mirroring the assignee heal: adopt ONLY where the
   * remote has a version and local does not. A local version that differs is real
   * divergence and belongs to the normal merge; a pending push must not be
   * clobbered by the value we just read. Idempotent.
   */
  protected async reconcileVersions(report: SyncReport): Promise<void> {
    let remote: ClickUpTask[];
    try {
      remote = await this.fetchAllRemote(this.getAdapter(), this.requireListId());
    } catch (err) {
      report.errors.push(`reconcile versions: ${(err as Error).message ?? err}`);
      return;
    }
    const known = this.knownVersions();
    const byId = new Map(remote.map((t) => [t.id, t]));

    for (const entry of this.ledger.readMap()) {
      const remoteTask = byId.get(entry.remoteId);
      if (!remoteTask) continue; // remote gone — the deletion path owns it
      try {
        const { version: remoteVersion } = tagsFromClickUp(remoteTask.tags, known);
        if (!remoteVersion) continue;
        const local = await this.getLocal(entry.slug);
        if (!local) continue;
        const localVersion = (local.raw.version as string | null | undefined) ?? null;
        if (localVersion !== null) continue; // local has a value — not ours to overwrite
        if (this.ledger.taskSync(entry.slug)?.pendingPush) continue; // local write in flight

        this.applyingRemote = true;
        try {
          await super.updateFields(entry.slug, { version: remoteVersion, updated_by: this.name });
        } finally {
          this.applyingRemote = false;
        }
        const newRaw = readFileSync(this.taskPath(entry.slug), 'utf-8');
        const syncEntry = this.ledger.taskSync(entry.slug);
        this.ledger.updateTaskSync(entry.slug, {
          last_synced_at: syncEntry?.last_synced_at ?? 0,
          base_snapshot: { hash: hashContent(newRaw), body: newRaw },
          localHash: hashContent(newRaw),
          pendingPush: false,
        });
        report.reconciled++;
        try {
          recordDashboardChange(this.contextRoot, {
            entity: 'task',
            action: 'update',
            target: `state/${entry.slug}.md`,
            field: 'version',
            fields: [{ field: 'version', from: null, to: remoteVersion }],
            summary: `Reconciled version on '${entry.slug}' from ${this.name} (${remoteVersion})`,
          });
        } catch { /* the journal must never break a sync */ }
      } catch (err) {
        report.errors.push(`reconcile version ${entry.slug}: ${(err as Error).message ?? err}`);
      }
    }
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

/** One pickable list, with its full workspace path (onboarding picker). */
export interface DiscoveredList {
  teamId: string;
  teamName: string;
  spaceId: string;
  spaceName: string;
  listId: string;
  listName: string;
  folderName?: string;
}

/**
 * Enumerate every list the token can see (workspaces → spaces → lists,
 * folderless + foldered). Used by the guided onboarding so nobody has to
 * hunt ids out of URLs. Explicit-command path — the request count
 * (1 + 2×spaces) is fine there.
 */
export async function discoverClickUpLists(
  token: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoveredList[]> {
  return discoverClickUpListsInternal(token, deps);
}

async function discoverClickUpListsInternal(
  token: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoveredList[]> {
  const adapter = new ApiAdapter({
    baseUrl: CLICKUP_BASE_URL,
    authHeaders: () => ({ Authorization: token }),
    fetchImpl: deps.fetchImpl,
  });
  const out: DiscoveredList[] = [];
  const teams = await adapter.request<{ teams?: Array<{ id: string; name?: string }> }>('GET', '/team');
  for (const team of teams.teams ?? []) {
    const spaces = await adapter.request<{ spaces?: Array<{ id: string; name?: string }> }>(
      'GET', `/team/${team.id}/space`,
    );
    for (const space of spaces.spaces ?? []) {
      const base = {
        teamId: String(team.id),
        teamName: team.name ?? String(team.id),
        spaceId: String(space.id),
        spaceName: space.name ?? String(space.id),
      };
      const folderless = await adapter.request<{ lists?: Array<{ id: string; name?: string }> }>(
        'GET', `/space/${space.id}/list`,
      );
      for (const l of folderless.lists ?? []) {
        out.push({ ...base, listId: String(l.id), listName: l.name ?? String(l.id) });
      }
      const folders = await adapter.request<{ folders?: Array<{ id: string; name?: string; lists?: Array<{ id: string; name?: string }> }> }>(
        'GET', `/space/${space.id}/folder`,
      );
      for (const f of folders.folders ?? []) {
        for (const l of f.lists ?? []) {
          out.push({ ...base, listId: String(l.id), listName: l.name ?? String(l.id), folderName: f.name });
        }
      }
    }
  }
  return out;
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
