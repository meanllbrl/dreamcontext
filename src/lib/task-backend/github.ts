import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import matter from 'gray-matter';
import { generateId, slugify } from '../id.js';
import type { SetupConfig } from '../setup-config.js';
import { ApiAdapter } from './api-adapter.js';
import { foldAscii } from '../fold-ascii.js';
import {
  bodyToIssueBody,
  composeIssueBody,
  parseDatesBlock,
  stripDatesBlock,
  renderFieldsBlock,
  parseFieldsBlock,
  stripFieldsBlock,
  deleteToGitHub,
  githubTimeMs,
  githubTimeIso,
  labelNamesOf,
  labelsFromGitHub,
  labelsToGitHub,
  normalizeEntry,
  splitChangelogEntries,
  statusFromGitHub,
  statusToGitHub,
  DELETED_SENTINEL,
  type GitHubComment,
  type GitHubIssue,
} from './github-map.js';
import { RECOMMENDED_LABELS } from './github-fields.js';
import {
  ASSETS_BRANCH,
  assetRemotePath,
  assetRemoteUrl,
  extractImageRefs,
  isLocalImageRef,
  resolveLocalImagePath,
  rewriteImageRefs,
} from './github-assets.js';
import { sniffImageType } from '../image-sniff.js';
import { createHash } from 'node:crypto';
import { customFieldsFor, loadTaskOverride, type CustomFieldDef } from '../overrides.js';
import { recordDashboardChange, type FieldChange } from '../change-tracker.js';
import { resolveActor } from './identity.js';
import { resolveGitHubToken, writeGitHubToken, maskToken } from './secrets.js';
import { BACKLOG_TAG, LocalTaskBackend } from './local.js';
import { merge3Bodies, mergeScalar, planAssigneeHeal, unionChangelog } from './merge.js';
import { SyncLedger, hashContent, reconcileRenamedTasks } from './sync-state.js';
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
// Same shape as the ClickUp backend: a task carries any number of
// `person:<slug>` tags, and each maps to a GitHub assignee. On GitHub the
// member "id" is the login itself — so the slug→login resolution is just the
// member cache (collaborators), and an unknown login is skipped gracefully.

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
 * The assignee SET for a task: every `person:<slug>` tag plus the legacy single
 * `assignee` frontmatter field (back-compat). Sorted + de-duped for order-stable
 * JSON-equality merges.
 */
function assigneeSlugsOf(raw: Record<string, unknown> | null, tags: string[]): string[] {
  const set = new Set(personTagSlugs(tags));
  const legacy = (raw?.assignee as string | null | undefined) ?? null;
  if (legacy) set.add(legacy);
  return [...set].sort();
}

/**
 * Slug for a GitHub login. Ascii-folds before slugify so non-ascii logins fold
 * the same way ClickUp display names do — parity with `clickup.ts` memberSlug.
 */
export function memberSlug(name: string): string {
  return slugify(foldAscii(name));
}

/**
 * GitHub Issues task backend.
 *
 * Plain Issues over REST v3 via the generic ApiAdapter — NO GraphQL/Projects-v2
 * (that is a Tier-2 follow-up). Mirrors the ClickUp backend's architecture: the
 * gitignored `state/*.md` mirror is the read path, every local mutation lands in
 * the mirror first + enqueues a write-ahead op, and network I/O happens ONLY
 * inside `sync()`.
 *
 * The single behavioral divergence from ClickUp is delete: GitHub REST cannot
 * hard-delete an issue, so `delete()` SOFT-deletes by closing the issue as
 * `not_planned` (replayed from the WAL like every other op). Inbound, a
 * `not_planned` close removes the local mirror (soft-delete symmetry).
 */

export interface GitHubBackendDeps {
  /** Injectable adapter (tests use a mocked transport). */
  adapter?: ApiAdapter;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const GITHUB_BASE_URL = 'https://api.github.com';

// GitHub's primary REST limit is 5000 requests/hour (~83/min). Pace BELOW it so
// a large burst self-throttles under the ceiling rather than tipping into
// secondary-rate-limit 403s at the window edge.
const GITHUB_RATE_PER_MINUTE = 80;
// Survive transient 429/5xx/secondary limits past the throttle. 5 attempts of
// exponential backoff (honouring Retry-After, handled in ApiAdapter).
const GITHUB_MAX_RETRIES = 5;
// GitHub's secondary rate limit punishes WRITE bursts independently of the
// per-minute ceiling above (observed: 4 content-creation ops queued during
// `sleep done` tripped it, needing 90s + 10min retries). Spacing writes by 1s
// self-throttles under that limit instead of hitting it and backing off.
const GITHUB_MIN_WRITE_INTERVAL_MS = 1000;

/** GitHub REST auth headers — Bearer token + the pinned API version. */
function githubAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export class GitHubTaskBackend extends LocalTaskBackend {
  readonly name: string = 'github';

  protected readonly ledger: SyncLedger;
  private adapterInstance: ApiAdapter | null = null;
  /** Suppresses queue/attribution while sync() writes remote state into the mirror. */
  protected applyingRemote = false;

  constructor(
    protected readonly contextRoot: string,
    protected readonly config: SetupConfig | null,
    protected readonly deps: GitHubBackendDeps = {},
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

  private _userFieldDefs?: CustomFieldDef[];
  /** Override-declared custom fields targeting GitHub (cached per instance). */
  protected userFieldDefs(): CustomFieldDef[] {
    if (this._userFieldDefs === undefined) {
      const ov = loadTaskOverride(this.contextRoot);
      this._userFieldDefs = ov ? customFieldsFor(ov.customFields, 'github') : [];
    }
    return this._userFieldDefs;
  }

  /** `select` fields ride as `<key>:<value>` labels. */
  protected selectFieldDefs(): CustomFieldDef[] {
    return this.userFieldDefs().filter((d) => d.type === 'select');
  }

  /** text / number / date fields ride in the `<!-- dc:fields -->` body block. */
  protected bodyFieldDefs(): CustomFieldDef[] {
    return this.userFieldDefs().filter((d) => d.type !== 'select');
  }

  /** Read a custom-field value off raw task frontmatter (null when unset). */
  protected customFieldValue(raw: Record<string, unknown>, key: string): string | null {
    const cf = (raw.custom_fields ?? null) as Record<string, unknown> | null;
    const v = cf?.[key];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' || s === 'null' ? null : s;
  }

  protected getToken(): string | null {
    return resolveGitHubToken(this.projectRoot)?.token ?? null;
  }

  protected getAdapter(): ApiAdapter {
    if (this.deps.adapter) return this.deps.adapter;
    if (!this.adapterInstance) {
      const token = this.getToken();
      if (!token) {
        throw new Error('No GitHub token configured. Run `dreamcontext config github-token`.');
      }
      this.adapterInstance = new ApiAdapter({
        baseUrl: GITHUB_BASE_URL,
        authHeaders: () => githubAuthHeaders(token),
        ratePerMinute: GITHUB_RATE_PER_MINUTE,
        maxRetries: GITHUB_MAX_RETRIES,
        minWriteIntervalMs: GITHUB_MIN_WRITE_INTERVAL_MS,
        fetchImpl: this.deps.fetchImpl,
        now: this.deps.now,
        sleep: this.deps.sleep,
      });
    }
    return this.adapterInstance;
  }

  /** The configured `owner/repo` coordinates, or throw (analogous to requireListId). */
  protected requireRepo(): { owner: string; repo: string } {
    const owner = this.config?.github?.owner;
    const repo = this.config?.github?.repo;
    if (!owner || !repo) {
      throw new Error('No GitHub repo configured. Run `dreamcontext config github-repo <owner> <repo>`.');
    }
    return { owner, repo };
  }

  private issuesPath(owner: string, repo: string): string {
    return `/repos/${owner}/${repo}/issues`;
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

  /**
   * SOFT delete (the one divergence from ClickUp): drop every local trace now,
   * and enqueue a delete op carrying the remoteId. On replay the op closes the
   * issue as `not_planned` — GitHub REST cannot hard-delete, and a soft close
   * preserves issue history + reopenability.
   */
  async delete(slug: string): Promise<void> {
    const remoteId = this.ledger.remoteIdFor(slug);
    await super.delete(slug);
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
    // Re-key the ledger (map + sync-state + queued ops) so the SAME issue is
    // matched by its stable dcId and UPDATED on next sync — never duplicated.
    if (newSlug !== slug && !this.applyingRemote) this.ledger.migrateSlug(slug, newSlug);
    return newSlug;
  }

  // ── Members (assignee candidates = repo collaborators) ────────────────────

  private membersRefreshed = false;

  private static readonly META_REFRESH_MS = 60 * 60 * 1000;
  private static readonly RECONCILE_MS = 2 * 60 * 1000;
  private static readonly LOCK_STALE_MS = 3 * 60 * 1000;

  /** GitHub's hard cap on an issue body (chars) — a longer POST/PATCH 422s. */
  private static readonly MAX_ISSUE_BODY_CHARS = 65_536;

  /**
   * Best-effort collaborator cache refresh (1 GET). Throttled to once per hour
   * across processes; `force` (listMembers, provision) bypasses. Failure never
   * breaks sync. On GitHub the member "id" IS the login.
   */
  protected async refreshMembers(
    adapter: ApiAdapter,
    owner: string,
    repo: string,
    force = false,
  ): Promise<void> {
    if (this.membersRefreshed) return;
    if (!force) {
      const last = this.ledger.readThrottle('lastMetaRefreshAt');
      if (last !== null && this.nowMs() - last < GitHubTaskBackend.META_REFRESH_MS) {
        this.membersRefreshed = true;
        return;
      }
    }
    this.membersRefreshed = true;
    this.ledger.writeThrottle('lastMetaRefreshAt', this.nowMs());
    try {
      const collaborators = await this.fetchCollaborators(adapter, owner, repo);
      const map: Record<string, { id: string; name: string }> = {};
      for (const c of collaborators) {
        if (!c.login) continue;
        map[memberSlug(c.login)] = { id: c.login, name: c.login };
      }
      if (Object.keys(map).length > 0) this.ledger.writeMembers(map);
    } catch { /* collaborators are a convenience — never fail the sync */ }
  }

  private async fetchCollaborators(
    adapter: ApiAdapter,
    owner: string,
    repo: string,
  ): Promise<Array<{ login: string; id?: number }>> {
    const out: Array<{ login: string; id?: number }> = [];
    for (let page = 1; ; page++) {
      const batch = await adapter.request<Array<{ login: string; id?: number }>>(
        'GET',
        `/repos/${owner}/${repo}/collaborators`,
        { query: { per_page: 100, page } },
      );
      const items = Array.isArray(batch) ? batch : [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  /**
   * Repo collaborators for the assignee picker. Tries a live refresh; offline /
   * unconfigured it falls back to the cache rather than returning empty.
   */
  async listMembers(): Promise<RemoteMember[]> {
    try {
      const adapter = this.getAdapter();
      const { owner, repo } = this.requireRepo();
      this.membersRefreshed = false;
      await this.refreshMembers(adapter, owner, repo, true);
    } catch { /* fall back to the cache below */ }
    return Object.entries(this.ledger.readMembers())
      .map(([slug, m]) => ({ slug, id: m.id, name: m.name }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** Person slug → GitHub login (the cached collaborator login). */
  protected loginForSlug(slug: string): string | null {
    return this.ledger.readMembers()[slug]?.id ?? null;
  }

  /** GitHub login → person slug: the cached collaborator slug, else the folded login. */
  protected slugForLogin(login: string): string {
    for (const [slug, m] of Object.entries(this.ledger.readMembers())) {
      if (m.id === login) return slug;
    }
    return memberSlug(login);
  }

  /**
   * Create the recommended `dc:*` / convention labels that don't already exist
   * (GET labels → POST missing). Idempotent: an existing name is skipped.
   *
   * `{ dryRun: true }` reports what WOULD be created (`created`) vs what already
   * exists, creating NOTHING — the Settings preview.
   */
  async provisionRemote(opts?: { dryRun?: boolean }): Promise<{ created: string[]; existing: string[]; backfilled: number; errors: string[] }> {
    const adapter = this.getAdapter();
    const { owner, repo } = this.requireRepo();
    const { created, existing, errors } = await this.createMissingLabels(adapter, owner, repo, opts?.dryRun === true);
    return { created, existing, backfilled: 0, errors };
  }

  /**
   * Label-creation core, shared by `provisionRemote` (the manual button) and
   * `sync()` (auto-provision). Lists the repo labels (GET) then POSTs the
   * missing recommended ones. `dryRun` reports the delta without POSTing. Safe to
   * call from inside `sync()` (no nested sync, no throw).
   */
  private async createMissingLabels(
    adapter: ApiAdapter,
    owner: string,
    repo: string,
    dryRun: boolean,
  ): Promise<{ created: string[]; existing: string[]; errors: string[] }> {
    const created: string[] = [];
    const existing: string[] = [];
    const errors: string[] = [];

    const present = new Set<string>();
    try {
      for (let page = 1; ; page++) {
        const batch = await adapter.request<Array<{ name?: string }>>(
          'GET',
          `/repos/${owner}/${repo}/labels`,
          { query: { per_page: 100, page } },
        );
        const items = Array.isArray(batch) ? batch : [];
        for (const l of items) if (l.name) present.add(l.name.toLowerCase());
        if (items.length < 100) break;
      }
    } catch (err) {
      errors.push(`list labels: ${(err as Error).message ?? err}`);
    }

    // Recommended labels + one label per option of every override-declared
    // `select` custom field (`<key>:<option>`). An existing name is REUSED, not
    // recreated (present-set check + 422 swallow) — the reuse-if-exists rule.
    const fieldLabels = this.selectFieldDefs().flatMap((d) =>
      (d.options ?? []).map((opt) => ({
        name: `${d.key}:${opt}`,
        color: 'ededed',
        description: `dreamcontext custom field: ${d.name}`,
      })),
    );

    for (const def of [...RECOMMENDED_LABELS, ...fieldLabels]) {
      if (present.has(def.name.toLowerCase())) {
        existing.push(def.name);
        continue;
      }
      if (dryRun) {
        created.push(def.name); // would create — preview only
        continue;
      }
      try {
        await adapter.request('POST', `/repos/${owner}/${repo}/labels`, {
          body: { name: def.name, color: def.color, description: def.description },
        });
        created.push(def.name);
      } catch (err) {
        // A 422 means the label already exists (concurrent provision / casing) —
        // treat it as existing rather than an error.
        if ((err as { status?: number }).status === 422) existing.push(def.name);
        else errors.push(`${def.name}: ${(err as Error).message ?? err}`);
      }
    }

    return { created, existing, errors };
  }

  /** Pickable repos for the Settings onboarding (token resolved internally). */
  async discoverContainers(): Promise<Array<{ ids: Record<string, string>; path: string; name: string }>> {
    const token = this.getToken();
    if (!token) return [];
    const repos = await discoverGitHubReposInternal(token, this.deps);
    return repos.map((r) => ({
      ids: { owner: r.owner, repo: r.name },
      path: r.full_name,
      name: r.name,
    }));
  }

  /** Settings "Test connection": authenticate and fetch the token's user. */
  async testConnection(): Promise<{ ok: true; user: string } | { ok: false; error: string }> {
    try {
      const adapter = this.getAdapter();
      const res = await adapter.request<{ login?: string; id?: number }>('GET', '/user');
      return { ok: true, user: String(res.login ?? res.id ?? 'unknown') };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
  }

  /** Settings inline API-key entry: persist the token into the secrets store. */
  setToken(token: string): void {
    writeGitHubToken(this.projectRoot, token);
  }

  /** Settings "key set ✓" indicator: resolved token status, masked. */
  tokenStatus(): TokenStatus {
    const resolved = resolveGitHubToken(this.projectRoot);
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

    if (!this.ledger.acquireSyncLock(this.nowMs(), GitHubTaskBackend.LOCK_STALE_MS)) {
      report.skipped = 'locked';
      report.pendingQueue = this.ledger.readQueue().length;
      report.watermark = this.ledger.readSyncState().watermark;
      return report;
    }

    try {
      // Heal renamed tasks FIRST (#77): re-key the ledger from any stale slug to
      // the renamed file's current slug (matched by stable dcId) before either
      // direction runs — so push UPDATEs the same issue (no duplicate) and pull
      // resolves it by the live slug (no resurrected mirror).
      const renamed = reconcileRenamedTasks(this.ledger, this.liveTaskIdentities());
      for (const r of renamed) {
        report.warnings.push(`renamed: ${r.from} → ${r.to} (remapped to existing remote task; no duplicate created)`);
      }
      try {
        const { owner, repo } = this.requireRepo();
        // Same provenance guard as ClickUp (#184): repointing `github.owner/repo`
        // must not carry the old repo's cached collaborators/labels or its pull
        // watermark into a different issue tracker.
        const moved = this.ledger.adoptContainer(`github:${owner}/${repo}`);
        if (moved.switched) {
          report.warnings.push(
            `sync target moved (${moved.from} → github:${owner}/${repo}): dropped the cached members/fields of the old repo and reset the pull watermark — this sync re-reads the new repo in full.`,
          );
        }
        await this.refreshMembers(this.getAdapter(), owner, repo);
        // Auto-provision the recommended labels so a push always has them with
        // proper colors (GitHub would otherwise auto-create them gray). Throttled
        // to once per hour (a labels GET per sync would be wasteful), best-effort:
        // a failure here must never break the sync.
        const lastProvision = this.ledger.readThrottle('lastLabelProvisionAt');
        if (lastProvision === null || this.nowMs() - lastProvision >= GitHubTaskBackend.META_REFRESH_MS) {
          this.ledger.writeThrottle('lastLabelProvisionAt', this.nowMs());
          await this.createMissingLabels(this.getAdapter(), owner, repo, false);
        }
      } catch (err) {
        // Best-effort, but never silent: surface the failure in the report so a
        // missing remote label isn't a mystery (#dashboard-custom-fields review).
        report.errors.push('auto-provision: ' + ((err as Error).message ?? err));
      }
      if (direction === 'pull' || direction === 'both') {
        await this.pullRemote(report);
      }
      if (direction === 'push' || direction === 'both') {
        await this.pushLocal(report);
      }
      // Heal pre-existing assignee drift LAST (#78): adopt the remote assignee
      // set for tasks whose drift sits below the watermark (a normal delta pull
      // never re-examines them). Opt-in (`--reconcile`) — costs a full fetch.
      if (opts.reconcile) {
        await this.reconcileAssignees(report);
      }
    } catch (err) {
      report.errors.push((err as Error).message ?? String(err));
    } finally {
      this.ledger.releaseSyncLock();
    }

    report.pendingQueue = this.ledger.readQueue().length;
    report.watermark = this.ledger.readSyncState().watermark;
    return report;
  }

  // ── PUSH (local → GitHub) ────────────────────────────────────────────────

  protected async pushLocal(report: SyncReport): Promise<void> {
    const adapter = this.getAdapter();
    const { owner, repo } = this.requireRepo();

    // Replay queued soft-deletes first: close the issue as `not_planned`.
    // A 404 means the issue is already gone — done.
    for (const op of this.ledger.readQueue().filter((q) => q.kind === 'delete')) {
      try {
        const patch = deleteToGitHub();
        await adapter.request('PATCH', `${this.issuesPath(owner, repo)}/${op.remoteId}`, {
          body: { state: patch.state, state_reason: patch.state_reason },
        });
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
        await this.pushTask(slug, adapter, owner, repo, report);
      } catch (err) {
        report.failedPushes.push(slug);
        report.errors.push(`push ${slug}: ${(err as Error).message ?? err}`);
      }
    }
  }

  protected async pushTask(
    slug: string,
    adapter: ApiAdapter,
    owner: string,
    repo: string,
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

    // assignees: every person:<slug> tag (plus the legacy field), resolved to
    // GitHub logins via the collaborator cache. A slug that resolves to NO
    // collaborator is surfaced as a warning rather than silently dropped (GitHub
    // ignores unknown assignees on write — never a 4xx abort, but the user must
    // still be told the assignment did not land).
    const assignees: string[] = [];
    const unmappedAssignees: string[] = [];
    for (const s of assigneeSlugsOf(task.raw, task.tags)) {
      const login = this.loginForSlug(s);
      if (login !== null) assignees.push(login);
      else unmappedAssignees.push(s);
    }
    if (unmappedAssignees.length > 0) {
      report.warnings.push(
        `push ${slug}: assignee ${unmappedAssignees.map((s) => `person:${s}`).join(', ')} ` +
        `is not a collaborator on this repo — left unassigned (invite them, or use a ` +
        `\`person:<slug>\` matching their GitHub login).`,
      );
    }

    // The FULL computed label set (PATCH labels REPLACES the whole set on
    // GitHub, so we always send everything the map derives for this task — a
    // `backlog` tag rides verbatim as a label, no special-casing needed).
    // Override-declared `select` custom fields ride here as `<key>:<value>`.
    const labels = labelsToGitHub({
      tags: stripPersonTags(task.tags),
      priority: task.priority,
      urgency: task.urgency,
      version: task.version,
      status: task.status,
      selectFields: this.selectFieldDefs().map((d) => ({
        key: d.key,
        value: this.customFieldValue(task.raw, d.key),
      })),
    });

    // GitHub has no native date fields, so start/due ride INSIDE the issue body
    // as a marked block (the only way they reliably sync over plain REST).
    // Backlog tasks are undated by rule → no block. Non-select custom fields
    // ride in their own `<!-- dc:fields -->` body block alongside the dates.
    const fieldsBlock = renderFieldsBlock(
      this.bodyFieldDefs().map((d) => ({ name: d.name, value: this.customFieldValue(task.raw, d.key) })),
    );
    const isBacklog = task.tags.some((t) => t.toLowerCase() === BACKLOG_TAG);
    const startLocal = isBacklog ? null : ((task.raw.start_date as string | null | undefined) ?? null);
    const dueLocal = isBacklog ? null : ((task.raw.due_date as string | null | undefined) ?? null);
    // Local images embedded in the body (agent-drops, screenshots) can't render
    // on GitHub — upload them to the assets branch and rewrite each reference to
    // its hosted URL, WIRE-ONLY (the mirror keeps the canonical local path).
    const prose = await this.uploadAndRewriteImages(bodyToIssueBody(task.body), adapter, owner, repo, report);
    const body = composeIssueBody(prose, startLocal, dueLocal, fieldsBlock);

    // GitHub rejects issue bodies over 65,536 chars with a 422 — and pushing a
    // TRUNCATED body instead would read back as a remote edit on the next pull,
    // clobbering the canonical local body. Skip with a warning: the task must be
    // shortened or split locally before it can mirror.
    if (body.length > GitHubTaskBackend.MAX_ISSUE_BODY_CHARS) {
      report.warnings.push(
        `push ${slug}: body is ${body.length} chars — over GitHub's ${GitHubTaskBackend.MAX_ISSUE_BODY_CHARS}-char issue limit; ` +
        `skipped (shorten or split the task locally, then re-sync).`,
      );
      return;
    }

    let remoteId = this.ledger.remoteIdFor(slug);
    if (!remoteId) {
      // Rename-safe join (#77): the slug may have changed, but the STABLE dcId
      // still maps to an existing issue. Re-key the ledger and UPDATE it rather
      // than CREATE a duplicate. (The sync() pre-pass normally heals this first;
      // this is the per-task safety net so the create branch is only ever taken
      // for a genuinely new, never-synced task.)
      const byDcId = this.ledger.entryForDcId(task.id);
      if (byDcId && byDcId.slug !== slug) {
        this.ledger.migrateSlug(byDcId.slug, slug);
        remoteId = byDcId.remoteId;
      }
    }
    let serverTime: number | null = null;

    if (!remoteId) {
      // CREATE: one POST carries title + body + labels + assignees. A brand-new
      // issue is always OPEN; the status patch below settles closed/reopened.
      const created = await adapter.request<GitHubIssue>('POST', this.issuesPath(owner, repo), {
        body: { title: task.name, body, labels, assignees },
      });
      remoteId = String(created.number);
      this.ledger.recordMapping({ slug, dcId: task.id, backend: this.name, remoteId });
      serverTime = githubTimeMs(created.updated_at);
      report.created++;

      // If the local status closes the issue, PATCH it now (a fresh issue is
      // open). statusToGitHub maps completed→closed/completed; open states are a
      // no-op (already open + labels applied).
      const patch = statusToGitHub(task.status);
      if (patch.state === 'closed') {
        const closed = await adapter.request<GitHubIssue>(
          'PATCH',
          `${this.issuesPath(owner, repo)}/${remoteId}`,
          { body: { state: patch.state, state_reason: patch.state_reason } },
        );
        serverTime = githubTimeMs(closed.updated_at) ?? serverTime;
      }
    } else {
      // UPDATE: ONE PATCH carries title + body + the full label set + assignees
      // + the state/state_reason for the status. We detect a reopen (the base
      // snapshot was completed, the local task is now active) so GitHub records
      // `state_reason: reopened` rather than a bare open.
      const baseFm = entry?.base_snapshot
        ? (matter(entry.base_snapshot.body).data as Record<string, unknown>)
        : null;
      const wasClosed = (baseFm?.status as string | undefined) === 'completed';
      const reopening = wasClosed && task.status !== 'completed';
      const patch = statusToGitHub(task.status, { reopen: reopening });

      const updated = await adapter.request<GitHubIssue>(
        'PATCH',
        `${this.issuesPath(owner, repo)}/${remoteId}`,
        {
          body: {
            title: task.name,
            body,
            labels,
            assignees,
            state: patch.state,
            ...(patch.state_reason ? { state_reason: patch.state_reason } : {}),
          },
        },
      );
      serverTime = githubTimeMs(updated.updated_at) ?? serverTime;
      report.pushed++;
    }

    // Changelog → issue comments (union-merged remotely; only entries the remote
    // hasn't seen yet, so re-runs post nothing).
    for (const entryText of newEntries) {
      const comment = await adapter.request<GitHubComment>(
        'POST',
        `${this.issuesPath(owner, repo)}/${remoteId}/comments`,
        { body: { body: entryText } },
      );
      serverTime = githubTimeMs(comment.created_at) ?? serverTime;
      report.commentsAdded++;
    }

    const raw = readFileSync(path, 'utf-8');
    this.ledger.updateTaskSync(slug, {
      last_synced_at: serverTime ?? entry?.last_synced_at ?? 0,
      base_snapshot: { hash: hashContent(raw), body: raw },
      localHash: hashContent(raw),
      pendingPush: false,
    });
    // Same rule as the ClickUp backend (#185): a push must not advance the global
    // pull watermark. "I wrote at T" is not "I have pulled everything up to T",
    // and conflating them silently drops a collaborator's older, unpulled change
    // out of every future delta pull. Echo is absorbed by base_snapshot/localHash.
    this.ledger.dequeueFor(slug, enqueueCutoff);
  }

  // ── Image assets (local task images → hosted GitHub URLs) ─────────────────

  /** Max bytes for an uploaded task image (matches the agent-drop cap). */
  private static readonly MAX_ASSET_BYTES = 25 * 1024 * 1024;

  /**
   * Resolve every LOCAL image reference in `prose` to a hosted GitHub URL,
   * uploading new bytes to the assets branch and rewriting the WIRE body. The
   * mirror is never touched; a failed/unresolvable image keeps its reference
   * as-is and surfaces a warning — a broken image must never abort a task push.
   * Byte-stable (zero network) when the body embeds no local image.
   */
  protected async uploadAndRewriteImages(
    prose: string,
    adapter: ApiAdapter,
    owner: string,
    repo: string,
    report: SyncReport,
  ): Promise<string> {
    const dests = [...new Set(extractImageRefs(prose).map((r) => r.dest))].filter(isLocalImageRef);
    if (dests.length === 0) return prose;

    const map = new Map<string, string>();
    for (const dest of dests) {
      try {
        const url = await this.uploadLocalImage(dest, adapter, owner, repo);
        if (url) map.set(dest, url);
        else report.warnings.push(`image "${dest}" did not resolve to a local image file — left as-is (it will not render on GitHub).`);
      } catch (err) {
        report.warnings.push(`image "${dest}" upload failed: ${(err as Error).message ?? err} — left as-is.`);
      }
    }
    if (map.size === 0) return prose;
    return rewriteImageRefs(prose, (d) => map.get(d) ?? null);
  }

  /**
   * Resolve a local image destination to its bytes — CONTAINED to the project
   * root, SIZE-GATED before the read, and confirmed to be a real image by magic
   * bytes. Returns null (never throws, never reads out-of-root or oversized
   * files) for anything that isn't a contained, in-range, genuine image, so a
   * remotely-pulled body can't drive an arbitrary-file read or an OOM.
   */
  private resolveImageBytes(
    localUrl: string,
  ): { bytes: Buffer; type: ReturnType<typeof sniffImageType>; contentSha: string } | null {
    // Hard boundary: only files inside the project root are eligible (blocks an
    // absolute path or `../` traversal injected via a pulled issue body).
    const abs = resolveLocalImagePath(localUrl, [this.projectRoot, this.contextRoot], this.projectRoot);
    if (!abs) return null;
    let size: number;
    try { size = statSync(abs).size; } catch { return null; }
    // Reject by size BEFORE buffering the file (a naive read-then-check would let
    // a huge file OOM the process — the same discipline agent-drop.ts enforces).
    if (size === 0 || size > GitHubTaskBackend.MAX_ASSET_BYTES) return null;
    let bytes: Buffer;
    try { bytes = readFileSync(abs); } catch { return null; }
    const type = sniffImageType(bytes);
    if (!type) return null; // referenced as an image but isn't one — never upload arbitrary bytes
    const contentSha = createHash('sha1').update(bytes).digest('hex');
    return { bytes, type, contentSha };
  }

  /**
   * Upload one local image to the assets branch and return its hosted URL (or
   * null when the path doesn't resolve to a contained, real image). Idempotent:
   * the same authored path reuses its bridge entry without touching the network
   * or disk; identical bytes under a different path reuse the prior upload.
   */
  private async uploadLocalImage(
    localUrl: string,
    adapter: ApiAdapter,
    owner: string,
    repo: string,
  ): Promise<string | null> {
    const cached = this.ledger.assetForLocalUrl(localUrl);
    if (cached) return cached.remoteUrl;

    const resolved = this.resolveImageBytes(localUrl);
    if (!resolved || !resolved.type) return null;
    const { bytes, type, contentSha } = resolved;

    const byContent = this.ledger.assetForContentSha(contentSha);
    if (byContent) {
      this.ledger.recordAsset({ ...byContent, localUrl });
      return byContent.remoteUrl;
    }

    const remotePath = assetRemotePath(contentSha, type);
    await this.ensureAssetsBranch(adapter, owner, repo);
    await this.putAssetContent(adapter, owner, repo, remotePath, bytes, contentSha);
    const remoteUrl = assetRemoteUrl(owner, repo, remotePath);
    this.ledger.recordAsset({ localUrl, contentSha, remotePath, remoteUrl });
    return remoteUrl;
  }

  /**
   * Pull-side bridge recovery (mirror of push's content-addressed 422 dedup):
   * when the gitignored `assets` cache was lost (a fresh checkout / reset) the
   * reverse-map can't turn a hosted asset URL back into its local path, which
   * would spuriously churn the image line and flag a `missing_base` conflict.
   *
   * Re-derive the bridge from the EXISTING local mirror: for each contained
   * local image whose content-addressed hosted URL actually appears in the
   * remote body, re-record the mapping. Content-addressing makes this safe — an
   * entry is only re-created when the local bytes genuinely correspond to the
   * URL the remote already serves, so a not-yet-pushed local image is never
   * falsely marked uploaded.
   */
  private rebuildAssetBridgeFromLocal(owner: string, repo: string, localBody: string, remoteStripped: string): void {
    if (!remoteStripped.includes(`/raw/${ASSETS_BRANCH}/`)) return;
    const dests = [...new Set(extractImageRefs(localBody).map((r) => r.dest))].filter(isLocalImageRef);
    for (const dest of dests) {
      if (this.ledger.assetForLocalUrl(dest)) continue;
      const resolved = this.resolveImageBytes(dest);
      if (!resolved || !resolved.type) continue;
      const remotePath = assetRemotePath(resolved.contentSha, resolved.type);
      const remoteUrl = assetRemoteUrl(owner, repo, remotePath);
      if (!remoteStripped.includes(remoteUrl)) continue; // only bridge images actually present remotely
      this.ledger.recordAsset({ localUrl: dest, contentSha: resolved.contentSha, remotePath, remoteUrl });
    }
  }

  /** Commit the bytes to the assets branch (Contents API). A 422 == already present. */
  private async putAssetContent(
    adapter: ApiAdapter,
    owner: string,
    repo: string,
    remotePath: string,
    bytes: Buffer,
    contentSha: string,
  ): Promise<void> {
    try {
      await adapter.request('PUT', `/repos/${owner}/${repo}/contents/${remotePath}`, {
        body: {
          message: `chore(dreamcontext): task image ${contentSha.slice(0, 12)}`,
          content: bytes.toString('base64'),
          branch: ASSETS_BRANCH,
        },
      });
    } catch (err) {
      // 422 == the content-addressed path already exists (a prior run committed
      // it; the local ledger may have been wiped). The bytes are identical by
      // construction, so reuse the existing blob rather than fail the push.
      if ((err as { status?: number }).status !== 422) throw err;
    }
  }

  /**
   * Ensure the dedicated assets branch exists — created off the default branch's
   * HEAD so the default branch's tree and history stay untouched. Confirmed once
   * then cached in the ledger; a concurrent-create 422 is benign.
   */
  private async ensureAssetsBranch(adapter: ApiAdapter, owner: string, repo: string): Promise<void> {
    if (this.ledger.assetsBranchReady()) return;
    try {
      await adapter.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${ASSETS_BRANCH}`);
      this.ledger.markAssetsBranchReady();
      return;
    } catch (err) {
      if ((err as { kind?: string }).kind !== 'not_found') throw err;
    }
    const repoInfo = await adapter.request<{ default_branch?: string }>('GET', `/repos/${owner}/${repo}`);
    const defaultBranch = repoInfo.default_branch || 'main';
    const baseRef = await adapter.request<{ object?: { sha?: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`,
    );
    const sha = baseRef.object?.sha;
    if (!sha) throw new Error(`could not resolve ${defaultBranch} HEAD to create the asset branch`);
    try {
      await adapter.request('POST', `/repos/${owner}/${repo}/git/refs`, {
        body: { ref: `refs/heads/${ASSETS_BRANCH}`, sha },
      });
    } catch (err) {
      if ((err as { status?: number }).status !== 422) throw err; // 422 == created concurrently
    }
    this.ledger.markAssetsBranchReady();
  }

  /** Reverse the wire transform on pull: map any hosted asset URL back to its local path. */
  protected mapRemoteImagesToLocal(body: string): string {
    if (!body.includes(`/raw/${ASSETS_BRANCH}/`)) return body;
    return rewriteImageRefs(body, (dest) => this.ledger.localUrlForRemoteUrl(dest));
  }

  // ── PULL (GitHub → local) ────────────────────────────────────────────────

  protected async pullRemote(report: SyncReport): Promise<void> {
    const adapter = this.getAdapter();
    const { owner, repo } = this.requireRepo();
    const watermark = this.ledger.readSyncState().watermark;
    const sinceIso = githubTimeIso(watermark);

    const remoteIssues: GitHubIssue[] = [];
    // When the watermark is null the delta fetch returns EVERYTHING — reuse
    // those numbers for deletion reconciliation instead of fetching again.
    const fullSetIds: Set<string> | null = watermark === null ? new Set<string>() : null;
    // PAGE-NUMBER pagination: start at page 1, increment until a page returns
    // fewer than per_page items (the adapter exposes no headers, so Link-header
    // pagination is intentionally not used). The issues endpoint also returns
    // PRs — every item with a `pull_request` field is a PR; filter them OUT.
    const perPage = 100;
    for (let page = 1; ; page++) {
      const batch = await adapter.request<Array<GitHubIssue & { pull_request?: unknown }>>(
        'GET',
        this.issuesPath(owner, repo),
        {
          query: {
            state: 'all',
            per_page: perPage,
            page,
            ...(sinceIso !== null ? { since: sinceIso } : {}),
          },
        },
      );
      const items = Array.isArray(batch) ? batch : [];
      const issuesOnly = items.filter((i) => i.pull_request === undefined);
      if (fullSetIds) for (const i of issuesOnly) fullSetIds.add(String(i.number));
      // Client-side watermark guard: GitHub's `since` is inclusive (>=), which
      // would echo the newest issue on every pull. Keep ONLY strictly-greater.
      remoteIssues.push(
        ...issuesOnly.filter((i) => {
          const ts = githubTimeMs(i.updated_at);
          return watermark === null || ts === null || ts > watermark;
        }),
      );
      if (items.length < perPage) break;
    }

    const pendingDeletes = this.ledger.pendingDeleteRemoteIds();
    for (const issue of remoteIssues) {
      if (pendingDeletes.has(String(issue.number))) continue; // deleted locally
      try {
        await this.applyRemoteIssue(issue, adapter, owner, repo, report);
      } catch (err) {
        report.errors.push(`pull #${issue.number}: ${(err as Error).message ?? err}`);
      }
    }

    await this.reconcileRemoteDeletions(adapter, owner, repo, pendingDeletes, report, fullSetIds);
  }

  protected async reconcileRemoteDeletions(
    adapter: ApiAdapter,
    owner: string,
    repo: string,
    pendingDeletes: Set<string>,
    report: SyncReport,
    knownFullSet: Set<string> | null,
  ): Promise<void> {
    const map = this.ledger.readMap();
    if (map.length === 0) return;

    let remoteIds: Set<string>;
    if (knownFullSet) {
      remoteIds = knownFullSet;
    } else {
      const last = this.ledger.readThrottle('lastReconcileAt');
      if (last !== null && this.nowMs() - last < GitHubTaskBackend.RECONCILE_MS) return;
      remoteIds = new Set<string>();
      try {
        const perPage = 100;
        for (let page = 1; ; page++) {
          const batch = await adapter.request<Array<GitHubIssue & { pull_request?: unknown }>>(
            'GET',
            this.issuesPath(owner, repo),
            { query: { state: 'all', per_page: perPage, page } },
          );
          const items = Array.isArray(batch) ? batch : [];
          for (const i of items) if (i.pull_request === undefined) remoteIds.add(String(i.number));
          if (items.length < perPage) break;
        }
      } catch {
        return; // offline / flaky — try again next sync
      }
    }
    this.ledger.writeThrottle('lastReconcileAt', this.nowMs());

    for (const entry of map) {
      if (remoteIds.has(entry.remoteId)) continue;
      if (pendingDeletes.has(entry.remoteId)) continue;
      const path = this.taskPath(entry.slug);

      try {
        if (existsSync(path)) {
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
  }

  protected async applyRemoteIssue(
    issue: GitHubIssue,
    adapter: ApiAdapter,
    owner: string,
    repo: string,
    report: SyncReport,
  ): Promise<void> {
    const remoteId = String(issue.number);
    const remoteTime = githubTimeMs(issue.updated_at);

    // closed + not_planned → soft-delete: remove the local mirror (symmetry
    // with our own delete()). Detect via the map's DELETED_SENTINEL.
    const remoteStatusRaw = statusFromGitHub(issue);
    if (remoteStatusRaw === DELETED_SENTINEL) {
      await this.applyRemoteSoftDelete(remoteId, remoteTime, report);
      return;
    }
    let remoteStatus = remoteStatusRaw;

    // ECHO GATE (#185) — skip a remote state we ourselves just wrote. Per-task,
    // because the push no longer advances the global pull watermark: doing so
    // silently dropped a collaborator's older, unpulled change out of every
    // future delta pull. `last_synced_at` is the server time of the remote state
    // we last ingested or wrote for THIS issue, so anything at or below it is our
    // own echo; a real edit by someone else always advances `updated_at` past it.
    // Placed after the soft-delete branch so deletion semantics are untouched.
    const knownSlug = this.ledger.slugForRemoteId(remoteId);
    if (knownSlug !== null && remoteTime !== null) {
      const seenAt = this.ledger.taskSync(knownSlug)?.last_synced_at ?? 0;
      if (seenAt > 0 && remoteTime <= seenAt) {
        this.ledger.advanceWatermark(remoteTime);
        return;
      }
    }

    const remoteComments = await this.fetchIssueComments(adapter, owner, repo, remoteId);
    const remoteEntries = remoteComments
      .map((c) => (c.body ?? '').trim())
      .filter(Boolean);

    const selectDefs = this.selectFieldDefs();
    const bodyDefs = this.bodyFieldDefs();
    const { tags: remoteTags, priority: remotePriority, urgency: remoteUrgency, version: remoteVersion, customFields: remoteSelectFields } =
      labelsFromGitHub(issue.labels, selectDefs.map((d) => d.key));
    // Dates + custom fields live in marked blocks inside the issue body — parse
    // them out, then strip the blocks so the prose that goes into the 3-way
    // merge is block-free.
    const normalizedIssueBody = (issue.body ?? '').replace(/\r\n/g, '\n');
    const { start: remoteStartRaw, due: remoteDueRaw } = parseDatesBlock(normalizedIssueBody);
    const remoteBodyFields = parseFieldsBlock(normalizedIssueBody, bodyDefs);
    // Combined remote custom-field state (select labels + body block), keyed by
    // local field key. Values are coerced back to the declared type so a NUMBER
    // field that round-trips through the string body block (8 → "8") does not
    // read as a remote "change" against the numeric local value on every pull.
    const remoteCustomFields: Record<string, string | number> = {};
    for (const [k, v] of Object.entries({ ...remoteSelectFields, ...remoteBodyFields })) {
      const def = this.userFieldDefs().find((d) => d.key === k);
      remoteCustomFields[k] = def?.type === 'number' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    const remoteBacklog = remoteTags.some((t) => t.toLowerCase() === BACKLOG_TAG);
    const remoteStart = remoteBacklog ? null : remoteStartRaw;
    const remoteDue = remoteBacklog ? null : remoteDueRaw;
    // Map any hosted asset URL we uploaded back to its canonical local path, so
    // an image reference reads identically on both sides and never churns merge.
    // (For an EXISTING mirror the bridge is first re-derived from local — see the
    // re-map below — so a wiped `assets` cache can't manufacture a false conflict.)
    const remoteStripped = stripFieldsBlock(stripDatesBlock(normalizedIssueBody)).trim();
    let remoteBody = this.mapRemoteImagesToLocal(remoteStripped);
    // Every assignee login maps back to a person:<slug> tag. Guard the resolve
    // path so a non-collaborator / unknown login is skipped, not a crash.
    const remoteAssignees: string[] = [
      ...new Set(
        (issue.assignees ?? [])
          .map((a) => {
            try {
              return a?.login ? this.slugForLogin(a.login) : null;
            } catch {
              return null;
            }
          })
          .filter((s): s is string => Boolean(s)),
      ),
    ].sort();

    let slug = this.ledger.slugForRemoteId(remoteId);

    if (!slug || !existsSync(this.taskPath(slug))) {
      // NEW remote issue (or vanished mirror) → create the mirror file.
      slug = slug ?? this.uniqueSlugFor(issue.title);
      const fm: Record<string, unknown> = {
        id: generateId('task'),
        name: issue.title,
        description: issue.title,
        priority: remotePriority,
        urgency: remoteUrgency ?? 'medium',
        status: remoteStatus,
        created_at: dateOf(githubTimeMs(issue.created_at) ?? remoteTime),
        updated_at: dateOf(remoteTime),
        tags: withPersonTags(remoteTags, remoteAssignees),
        parent_task: null,
        related_feature: null,
        version: remoteVersion,
        rice: null,
        start_date: remoteStart,
        due_date: remoteDue,
        created_by: 'github',
        updated_by: 'github',
        ...(Object.keys(remoteCustomFields).length > 0 ? { custom_fields: remoteCustomFields } : {}),
      };
      const written = this.writeMirror(slug, fm, remoteBody, remoteEntries);
      this.ledger.recordMapping({ slug, dcId: fm.id as string, backend: this.name, remoteId });
      this.ledger.updateTaskSync(slug, {
        last_synced_at: remoteTime ?? 0,
        base_snapshot: { hash: hashContent(written), body: written },
        localHash: hashContent(written),
        pendingPush: false,
      });
      this.ledger.advanceWatermark(remoteTime);
      report.pulled++;
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
    // Re-derive the image bridge from the local mirror before the merge sees the
    // remote body, so a lost `assets` cache doesn't leave hosted URLs unmapped
    // (which would churn the image line and raise a spurious missing_base).
    this.rebuildAssetBridgeFromLocal(owner, repo, local.body, remoteStripped);
    remoteBody = this.mapRemoteImagesToLocal(remoteStripped);
    const localChanged = entry?.localHash ? hashContent(localRaw) !== entry.localHash : true;
    const localChangedAt = entry?.lastLocalChangeAt ?? null;

    const base = entry?.base_snapshot?.body ?? null;
    const baseParsed = base !== null ? matter(base) : null;
    const baseFm = (baseParsed?.data ?? null) as Record<string, unknown> | null;
    const baseBody = baseParsed ? bodyToIssueBody(baseParsed.content.trim()).trim() : null;
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

    // ── prose: 3-way with base; missing base → GitHub wins + conflict copy ──
    const localBody = bodyToIssueBody(local.body).trim();
    let mergedBody = remoteBody;
    let proseLocalKept = false;
    const conflicts: Array<'missing_base' | 'both_changed'> = [];

    if (!localChanged) {
      mergedBody = remoteBody;
    } else if (baseBody === null) {
      if (localBody !== remoteBody) conflicts.push('missing_base');
      mergedBody = remoteBody;
    } else {
      const res = merge3Bodies(baseBody, localBody, remoteBody);
      mergedBody = res.merged.trim();
      proseLocalKept = res.localChangesKept;
      if (res.conflictSections.length > 0) conflicts.push('both_changed');
    }

    // Status equivalence: when the local status would push to exactly this
    // remote open sub-status, the remote did not really move — keep the richer
    // local status (e.g. local `todo` vs a remote open with no dc: label).
    if (issue.state === 'open') {
      const localPushLabels = labelsToGitHub({ status: local.status });
      const remoteLabelSet = labelNamesOf(issue.labels);
      const localSub = localPushLabels.find((l) => l.toLowerCase().startsWith('dc:'));
      const remoteSub = remoteLabelSet.find((l) => l.toLowerCase().startsWith('dc:'));
      if ((localSub ?? null) === (remoteSub ?? null)) {
        remoteStatus = local.status === 'completed' ? remoteStatus : local.status;
      }
    }

    const scalar = <T,>(baseV: T | undefined, localV: T, remoteV: T) =>
      mergeScalar(baseV, localV, remoteV, localChanged ? localChangedAt : null, remoteTime);

    const statusM = scalar(baseFm?.status as string | undefined, local.status, remoteStatus);
    const priorityM = scalar(baseFm?.priority as string | undefined, local.priority, remotePriority);
    const urgencyM = scalar(
      (baseFm?.urgency as string | undefined),
      local.urgency,
      remoteUrgency ?? local.urgency,
    );
    const nameM = scalar(baseFm?.name as string | undefined, local.name, issue.title);
    const tagsM = scalar(baseTagInfo?.tags, stripPersonTags(local.tags), remoteTags);
    const versionM = scalar(baseTagInfo?.version, local.version, remoteVersion);
    const assigneeM = scalar(
      baseTagInfo?.assignees,
      assigneeSlugsOf(local.raw, local.tags),
      remoteAssignees,
    );
    // Dates round-trip through the issue-body block (parsed above), merged LWW
    // just like the other scalars so a clear or an edit propagates either way.
    const dueM = scalar(
      (baseFm?.due_date as string | null | undefined) ?? null,
      (local.raw.due_date as string | null | undefined) ?? null,
      remoteDue,
    );
    const startM = scalar(
      (baseFm?.start_date as string | null | undefined) ?? null,
      (local.raw.start_date as string | null | undefined) ?? null,
      remoteStart,
    );

    // Custom fields (select labels + body block) — per-field LWW like the dates.
    const declaredFieldKeys = [...selectDefs, ...bodyDefs].map((d) => d.key);
    const localCustom = (local.raw.custom_fields ?? {}) as Record<string, unknown>;
    const baseCustom = (baseFm?.custom_fields ?? null) as Record<string, unknown> | null;
    const customFieldsM: Record<string, string | number | null> = { ...localCustom } as Record<string, string | number | null>;
    const remoteCustomBase: Record<string, string | number | null> = { ...localCustom } as Record<string, string | number | null>;
    let anyCustomLocalWin = false;
    let anyCustomRemoteWin = false;
    for (const key of declaredFieldKeys) {
      const baseV = (baseCustom?.[key] as string | number | null | undefined) ?? null;
      const localV = (localCustom[key] as string | number | null | undefined) ?? null;
      const remoteV = (remoteCustomFields[key] as string | number | undefined) ?? null;
      const m = scalar<string | number | null>(baseV, localV, remoteV);
      customFieldsM[key] = m.value;
      remoteCustomBase[key] = remoteV;
      if (m.winner === 'local') anyCustomLocalWin = true;
      if (m.winner === 'remote') anyCustomRemoteWin = true;
    }

    const scalarResults = [statusM, priorityM, urgencyM, nameM, tagsM, versionM, assigneeM, dueM, startM];
    const anyLocalWin = scalarResults.some((r) => r.winner === 'local') || anyCustomLocalWin;
    const anyRemoteWin = scalarResults.some((r) => r.winner === 'remote') || anyCustomRemoteWin;
    const remoteAddedEntries = mergedEntries.length > localEntries.length;
    const remoteContributed = anyRemoteWin || remoteAddedEntries || mergedBody !== localBody;

    for (const reason of conflicts) {
      const savedTo = this.saveConflictCopy(slug, localRaw, remoteTime);
      report.conflicts.push({ slug, savedTo, reason });
    }

    const fm: Record<string, unknown> = {
      ...local.raw,
      name: nameM.value,
      status: statusM.value,
      priority: priorityM.value,
      urgency: urgencyM.value,
      tags: withPersonTags(tagsM.value, assigneeM.value),
      version: versionM.value,
      start_date: tagsM.value.some((t) => t.toLowerCase() === BACKLOG_TAG)
        ? null
        : startM.value,
      due_date: tagsM.value.some((t) => t.toLowerCase() === BACKLOG_TAG)
        ? null
        : dueM.value,
      updated_at: remoteContributed && remoteTime !== null ? dateOf(remoteTime) : local.updated_at,
      updated_by: anyRemoteWin || conflicts.length > 0 ? 'github' : (local.raw.updated_by ?? null),
      ...(declaredFieldKeys.length > 0 ? { custom_fields: customFieldsM } : {}),
    };
    delete fm.assignee;

    const written = this.writeMirror(slug, fm, mergedBody, mergedEntries);

    const keptLocal = anyLocalWin || proseLocalKept || localOnlyEntries.length > 0;
    if (keptLocal) {
      const remoteRender = this.renderMirror(
        {
          ...fm,
          name: issue.title,
          status: remoteStatus,
          priority: remotePriority,
          urgency: remoteUrgency ?? fm.urgency,
          tags: withPersonTags(remoteTags, remoteAssignees),
          version: remoteVersion,
          start_date: remoteTags.some((t) => t.toLowerCase() === BACKLOG_TAG)
            ? null
            : remoteStart,
          due_date: remoteTags.some((t) => t.toLowerCase() === BACKLOG_TAG)
            ? null
            : remoteDue,
          ...(declaredFieldKeys.length > 0 ? { custom_fields: remoteCustomBase } : {}),
        },
        remoteBody,
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

    try {
      const remoteFieldChanges: FieldChange[] = [];
      const namedScalars: Array<[string, { winner: string; value: unknown }, unknown]> = [
        ['status', statusM, local.status],
        ['priority', priorityM, local.priority],
        ['urgency', urgencyM, local.urgency],
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
      if (remoteAddedEntries) remoteFieldChanges.push({ field: 'changelog', from: null, to: null });
      if (mergedBody !== localBody) remoteFieldChanges.push({ field: 'body', from: null, to: null });

      if (remoteFieldChanges.length > 0) {
        const fieldNames = remoteFieldChanges.map((f) => f.field).join(', ');
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
        recordDashboardChange(this.contextRoot, {
          entity: 'task',
          action: 'update',
          target: `state/${slug}.md`,
          field: 'conflict',
          summary: `Remote sync conflict on '${slug}' (${conflicts.join(', ')}) — GitHub version kept, local copy preserved under state/.conflicts/`,
        });
      }
    } catch { /* the journal must never break a sync */ }
  }

  /**
   * Inbound soft-delete: a closed+not_planned issue is the delete signal —
   * remove the local mirror (symmetry with our own `delete()`), preserving any
   * unsaved local edits to .conflicts/ first.
   */
  protected async applyRemoteSoftDelete(
    remoteId: string,
    remoteTime: number | null,
    report: SyncReport,
  ): Promise<void> {
    const slug = this.ledger.slugForRemoteId(remoteId);
    if (!slug) {
      // Never mapped locally → nothing to delete; just advance the watermark so
      // the close event isn't re-fetched forever.
      this.ledger.advanceWatermark(remoteTime);
      return;
    }
    const path = this.taskPath(slug);
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf-8');
        const syncEntry = this.ledger.taskSync(slug);
        const localChanged = !syncEntry?.localHash || hashContent(raw) !== syncEntry.localHash;
        if (localChanged) {
          const savedTo = this.saveConflictCopy(slug, raw, remoteTime);
          report.conflicts.push({ slug, savedTo, reason: 'remote_deleted' });
        }
        this.applyingRemote = true;
        try {
          await super.delete(slug);
        } finally {
          this.applyingRemote = false;
        }
      }
      this.ledger.removeMapping(slug);
      this.ledger.removeTaskSync(slug);
      this.ledger.dequeueFor(slug, Number.MAX_SAFE_INTEGER);
      this.ledger.advanceWatermark(remoteTime);
      report.mirrorDeleted++;
      try {
        recordDashboardChange(this.contextRoot, {
          entity: 'task',
          action: 'delete',
          target: `state/${slug}.md`,
          summary: `Remote sync deleted task '${slug}' (closed as not_planned on ${this.name})`,
        });
      } catch { /* the journal must never break a sync */ }
    } catch (err) {
      report.errors.push(`soft-delete ${slug}: ${(err as Error).message ?? err}`);
    }
  }

  private async fetchIssueComments(
    adapter: ApiAdapter,
    owner: string,
    repo: string,
    remoteId: string,
  ): Promise<GitHubComment[]> {
    const out: GitHubComment[] = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
      const batch = await adapter.request<GitHubComment[]>(
        'GET',
        `${this.issuesPath(owner, repo)}/${remoteId}/comments`,
        { query: { per_page: perPage, page } },
      );
      const items = Array.isArray(batch) ? batch : [];
      out.push(...items);
      if (items.length < perPage) break;
    }
    return out;
  }

  // ── Assignee reconcile (#78) ──────────────────────────────────────────────

  /** remoteId (issue number) → sorted person-slug assignee set, for every issue. */
  private async fetchRemoteAssigneeMap(adapter: ApiAdapter, owner: string, repo: string): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const perPage = 100;
    for (let page = 1; ; page++) {
      const batch = await adapter.request<Array<GitHubIssue & { pull_request?: unknown }>>(
        'GET',
        this.issuesPath(owner, repo),
        { query: { state: 'all', per_page: perPage, page } },
      );
      const items = Array.isArray(batch) ? batch : [];
      for (const i of items) {
        if (i.pull_request !== undefined) continue; // PRs are not tasks
        out.set(
          String(i.number),
          [...new Set(
            (i.assignees ?? [])
              .map((a) => {
                try {
                  return a?.login ? this.slugForLogin(a.login) : null;
                } catch {
                  return null;
                }
              })
              .filter((s): s is string => Boolean(s)),
          )].sort(),
        );
      }
      if (items.length < perPage) break;
    }
    return out;
  }

  /**
   * Read-only assignee-drift scan (#78): mapped tasks whose remote assignee set
   * differs from local `person:` tags and that a `--reconcile` would safely heal
   * (remote moved, local did not). Hits the network (full issue list + member refresh).
   */
  async detectAssigneeDrift(): Promise<AssigneeDrift[]> {
    const adapter = this.getAdapter();
    const { owner, repo } = this.requireRepo();
    await this.refreshMembers(adapter, owner, repo, true); // fresh login→slug
    const remoteMap = await this.fetchRemoteAssigneeMap(adapter, owner, repo);

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
   * Apply the assignee-drift heal: replace each healable task's `person:` tags
   * with the remote set and re-baseline the ledger so the next sync sees it as
   * settled (no echo push, no re-pull). Idempotent.
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
    body: string,
    changelogEntries: string[],
  ): string {
    const changelog = changelogEntries.length > 0
      ? `## Changelog\n<!-- LIFO: newest at top -->\n\n${changelogEntries.join('\n\n')}\n`
      : '';
    const composed = `${body.trim()}\n${changelog ? `\n${changelog}` : ''}`;
    return matter.stringify(composed, fm);
  }

  protected writeMirror(
    slug: string,
    fm: Record<string, unknown>,
    body: string,
    changelogEntries: string[],
  ): string {
    const content = this.renderMirror(fm, body, changelogEntries);
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

/** One pickable repo, with its full path (onboarding picker). */
export interface DiscoveredRepo {
  owner: string;
  name: string;
  full_name: string;
}

/**
 * Enumerate every repo the token can see (`GET /user/repos`, page-number
 * paginated). Used by the guided onboarding so nobody has to type ids.
 */
export async function discoverGitHubRepos(
  token: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoveredRepo[]> {
  return discoverGitHubReposInternal(token, deps);
}

async function discoverGitHubReposInternal(
  token: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoveredRepo[]> {
  const adapter = new ApiAdapter({
    baseUrl: GITHUB_BASE_URL,
    authHeaders: () => githubAuthHeaders(token),
    fetchImpl: deps.fetchImpl,
  });
  const out: DiscoveredRepo[] = [];
  const perPage = 100;
  for (let page = 1; ; page++) {
    const batch = await adapter.request<Array<{ name?: string; full_name?: string; owner?: { login?: string } }>>(
      'GET',
      '/user/repos',
      { query: { per_page: perPage, page } },
    );
    const items = Array.isArray(batch) ? batch : [];
    for (const r of items) {
      if (r.name && r.owner?.login) {
        out.push({ owner: r.owner.login, name: r.name, full_name: r.full_name ?? `${r.owner.login}/${r.name}` });
      }
    }
    if (items.length < perPage) break;
  }
  return out;
}

/**
 * Factory used by getTaskBackend(). Always returns the backend when
 * taskBackend=github — mirror reads/writes work offline; only sync() needs the
 * token/repo and reports (never throws) when they are missing.
 */
export function createGitHubBackend(
  contextRoot: string,
  config: SetupConfig | null,
  deps: GitHubBackendDeps = {},
): GitHubTaskBackend {
  return new GitHubTaskBackend(contextRoot, config, deps);
}
