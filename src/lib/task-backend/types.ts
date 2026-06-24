import type { RiceFields } from '../rice.js';
import type { TaskFilter, TaskRecord } from '../task-query.js';

/**
 * Pluggable task backend — issue #11.
 *
 * Callers (CLI verbs in src/cli/commands/tasks.ts, server routes in
 * src/server/routes/tasks.ts, post-sleep flows) never touch the filesystem or
 * HTTP for task data directly; they resolve a backend via `getTaskBackend()`
 * and speak this interface. `local` is the current file implementation;
 * Remote backends speak REST via the generic ApiAdapter. Nothing
 * provider-specific may appear in this file — that is the boundary test for
 * adding more backends later.
 */

/** Task frontmatter fields (raw YAML values as stored in state/*.md). */
export interface TaskFrontmatter {
  id: string;
  name: string;
  description: string;
  priority: string;
  urgency: string;
  status: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  parent_task: string | null;
  related_feature: string | null;
  version: string | null;
  rice: RiceFields | null;
  /** Optional planned START of the task's date range (YYYY-MM-DD). */
  start_date?: string | null;
  /** Optional due/END date (YYYY-MM-DD). Absent on tasks that never set one. */
  due_date?: string | null;
  /** Remote identity — present only for synced tasks on a remote backend. */
  assignee?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  /**
   * User-defined custom fields (override-declared, see src/lib/overrides.ts).
   * A flat key→value map keyed by the field's snake_case key. Absent on tasks
   * in projects without a `_dream_context/overrides/task.md`.
   */
  custom_fields?: Record<string, string | number | null> | null;
}

/** Lightweight listing row. Identical to the normalized TaskRecord the CLI uses. */
export type TaskSummary = TaskRecord;

/** Full task view (frontmatter + parsed sections + body). */
export interface TaskData {
  slug: string;
  id: string;
  name: string;
  description: string;
  priority: string;
  urgency: string;
  status: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  parent_task: string | null;
  related_feature: string | null;
  version: string | null;
  rice: RiceFields | null;
  start_date: string | null;
  due_date: string | null;
  assignee: string | null;
  /** User-defined custom-field values (override-declared). Empty when none. */
  custom_fields: Record<string, string | number | null>;
  why: string;
  user_stories: string;
  acceptance_criteria: string;
  constraints: string;
  technical_details: string;
  notes: string;
  changelog: string;
  sections: string[];
  /** Body with surrounding whitespace trimmed (dashboard display form). */
  body: string;
  /**
   * Body EXACTLY as stored (untrimmed). Needed by callers that diff the body
   * for no-op detection (dashboard PATCH body) — trimming would change which
   * writes are detected as changes.
   */
  rawBody: string;
  /** Raw frontmatter as parsed — change-tracking diffs raw values, not normalized ones. */
  raw: Record<string, unknown>;
}

/** Section keys accepted by insertSection (matches SECTION_MAP in section-insert.ts). */
export type TaskSection =
  | 'why'
  | 'user_stories'
  | 'acceptance_criteria'
  | 'constraints'
  | 'technical_details'
  | 'notes'
  | 'changelog';

export interface CreateTaskInput {
  name: string;
  description?: string;
  priority?: string;
  urgency?: string;
  status?: string;
  tags?: string[];
  why?: string;
  version?: string | null;
  rice?: RiceFields | null;
  start_date?: string | null;
  due_date?: string | null;
  /** Seed user-defined custom-field values at creation (override-declared). */
  custom_fields?: Record<string, string | number | null>;
  /**
   * Which historical template produced the file. The CLI and the dashboard
   * have always written different task skeletons (full template with Workflow
   * mermaid vs. the compact inline one); preserving both byte-exactly is an
   * M1 golden-test requirement, so the variant rides the input.
   */
  variant: 'cli' | 'dashboard';
}

export interface InsertSectionOptions {
  /** 'top' = LIFO (right after header), 'bottom' = before next section. */
  position: 'top' | 'bottom';
  /** Replace template placeholder lines on first real insert (CLI behavior). */
  replacePlaceholders?: boolean;
}

export interface AddChangelogOptions {
  /**
   * When the task has no `## Changelog` section: append the raw entry at EOF
   * (CLI behavior) instead of throwing (server-route behavior).
   */
  fallbackAppend?: boolean;
}

export interface UpdateFieldsOptions {
  /** Replace the entire markdown body in the same write (dashboard body edit). */
  body?: string;
}

/** How a fuzzy task name resolved against the backend's slugs. */
export type SlugResolution =
  | { kind: 'match'; slug: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

export type SyncDirection = 'push' | 'pull' | 'both';

export interface SyncOptions {
  /**
   * Heal pre-existing assignee drift in one pass (#78). The normal delta pull is
   * watermark-gated, so a remote-side assignee change made BELOW the watermark is
   * never re-examined and never reaches local `person:<slug>` tags. With this set,
   * the sync re-fetches every mapped remote task regardless of the delta window and
   * adopts the remote assignee set wherever local hasn't itself diverged. No-op for
   * the local backend; idempotent (a second run heals nothing).
   */
  reconcile?: boolean;
}

/** A task whose remote assignees differ from its local `person:<slug>` tags (#78). */
export interface AssigneeDrift {
  slug: string;
  /** Local assignee person-slugs (current `person:` tags + legacy field), sorted. */
  local: string[];
  /** Remote assignee person-slugs, sorted — what a `--reconcile` pass would adopt. */
  remote: string[];
}

export interface SyncConflict {
  slug: string;
  /** Where the losing local copy was preserved (state/.conflicts/...). */
  savedTo: string;
  reason: 'missing_base' | 'both_changed' | 'remote_deleted';
}

export interface SyncReport {
  backend: string;
  direction: SyncDirection;
  pushed: number;
  pulled: number;
  created: number;
  /** Remote tasks deleted (propagated local deletions). */
  deleted: number;
  /** Local mirrors removed because the task was deleted on the remote. */
  mirrorDeleted: number;
  commentsAdded: number;
  conflicts: SyncConflict[];
  pendingQueue: number;
  errors: string[];
  /**
   * Slugs whose push FAILED this run (after the adapter exhausted its retries).
   * Distinct from `errors` (free-form, also covers pull/delete/field failures):
   * a non-empty list means the local→remote sync is INCOMPLETE, so callers must
   * surface it loudly rather than report success.
   */
  failedPushes: string[];
  /**
   * Non-fatal data-quality warnings surfaced by a sync (e.g. a `person:<slug>`
   * assignee tag that resolves to no remote member, so it was left unassigned
   * rather than silently falling back to the API-token owner). The task itself
   * still synced — distinct from `errors`/`failedPushes` — but the user must be
   * told, never silently dropped. Callers surface these loudly.
   */
  warnings: string[];
  /** Remote server-time watermark after this sync (epoch ms), if any. */
  watermark: number | null;
  /**
   * Tasks whose local assignees were HEALED to the remote set by a `--reconcile`
   * pass (#78). Always 0 unless `SyncOptions.reconcile` was set; a non-zero count
   * means below-watermark assignee drift was found and fixed.
   */
  reconciled: number;
  /** True when nothing had to be done (also the local backend's constant result). */
  noop: boolean;
  /** Set when the sync did not run at all (another sync holds the lock). */
  skipped?: 'locked';
}

export interface TaskBackend {
  /** Backend id ('local' | a remote backend id). */
  readonly name: string;

  list(filter?: TaskFilter): Promise<TaskSummary[]>;
  get(slug: string): Promise<TaskData | null>;
  create(input: CreateTaskInput): Promise<TaskData>;
  updateFields(
    slug: string,
    fields: Partial<TaskFrontmatter> & Record<string, unknown>,
    opts?: UpdateFieldsOptions,
  ): Promise<TaskData>;
  insertSection(
    slug: string,
    sectionName: string,
    content: string,
    opts: InsertSectionOptions,
  ): Promise<void>;
  /** `entry` is the fully formatted changelog block (callers own the label format). */
  addChangelog(slug: string, entry: string, opts?: AddChangelogOptions): Promise<void>;
  complete(slug: string, summary?: string): Promise<TaskData>;
  /** Delete a task (remote backends propagate the deletion on sync). */
  delete(slug: string): Promise<void>;
  /**
   * Rename a task: rewrite its name, move its file to the new name-derived slug,
   * and (on remote backends) re-key the sync mapping by the stable dcId so the
   * SAME remote task is updated on the next sync — never duplicated (#77).
   * Returns the resulting slug (unchanged when only the display name changed).
   */
  rename(slug: string, newName: string): Promise<string>;
  /** Resolve a human-entered name to a slug (exact → prefix → substring). */
  resolveSlug(name: string): Promise<SlugResolution>;
  /** Two-way sync with the remote. No-op for the local backend. */
  sync(direction?: SyncDirection, opts?: SyncOptions): Promise<SyncReport>;
  /**
   * Read-only scan for assignee drift (#78): mapped tasks whose remote assignees
   * differ from their local `person:` tags and that a `--reconcile` would heal.
   * Hits the network (full remote fetch). Absent on local (no remote to compare).
   */
  detectAssigneeDrift?(): Promise<AssigneeDrift[]>;
  /** Remote connectivity probe (Settings "Test connection"). Absent on local. */
  testConnection?(): Promise<ConnectionTestResult>;
  /**
   * Persist the remote API token into this backend's gitignored secrets store
   * (never `.config.json`). Throws if the secret could not be written safely.
   * Absent on local (no remote to authenticate against).
   */
  setToken?(token: string): void;
  /**
   * Report whether an API token is configured (and where it comes from), masked
   * — never the raw secret. Drives the Settings "key set ✓" indicator. Absent on
   * local.
   */
  tokenStatus?(): TokenStatus;
  /** People with access to the remote container (assignee candidates). Absent on local. */
  listMembers?(): Promise<RemoteMember[]>;
  /**
   * Create the recommended remote structure (custom fields / labels). Absent on
   * local. With `{ dryRun: true }` NOTHING is created or backfilled — the result
   * reports what WOULD be created (`created`) vs what already exists, so the UI
   * can preview the change before committing to it.
   */
  provisionRemote?(opts?: { dryRun?: boolean }): Promise<RemoteProvisionResult>;
  /** Enumerate pickable remote containers (lists/boards). Absent on local. */
  discoverContainers?(): Promise<RemoteContainer[]>;
}

/** A pickable remote container with its human-readable path. */
export interface RemoteContainer {
  /** Opaque ids the config needs (provider-specific meanings). */
  ids: Record<string, string>;
  /** e.g. "Ouromedia / OURO ALL / INBOX-OURO". */
  path: string;
  name: string;
}

export interface RemoteProvisionResult {
  /** Field names created on the remote container (under `dryRun`: would be created). */
  created: string[];
  /** Recommended fields that already existed (matched by name). */
  existing: string[];
  /** Field values backfilled onto already-synced tasks. */
  backfilled: number;
  errors: string[];
}

/** A person with access to the remote task container. */
export interface RemoteMember {
  /** Stable kebab-case slug derived from the remote display name (ascii-folded). */
  slug: string;
  /** Remote member id (assignee mapping). */
  id: string;
  name: string;
  email?: string;
}

export type ConnectionTestResult =
  | { ok: true; user: string }
  | { ok: false; error: string };

/** Masked API-token status for the Settings page (never carries the raw token). */
export interface TokenStatus {
  set: boolean;
  /** Where the resolved token came from, or null when none is configured. */
  source: 'env' | 'secrets' | null;
  /** Last-4 masked token (e.g. "••••••••1234"), or null when none is set. */
  masked: string | null;
}

/** Lightweight sync status for dashboard badges / doctor output. */
export interface TaskSyncStatus {
  backend: string;
  /** Tasks flagged pending-push (local changes not yet on the remote). */
  pendingPush: number;
  /** Queued write-ahead ops awaiting replay. */
  queuedOps: number;
  /** Preserved conflict copies under state/.conflicts/. */
  conflicts: number;
  /** Remote server-time watermark (epoch ms) of the last sync. */
  watermark: number | null;
}

/** Error a backend throws for structured failures callers map to exit codes / HTTP. */
export class TaskBackendError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'already_exists'
      | 'invalid_input'
      | 'write_error'
      | 'remote_error',
    message: string,
  ) {
    super(message);
    this.name = 'TaskBackendError';
  }
}
