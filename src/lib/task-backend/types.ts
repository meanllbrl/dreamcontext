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
  /** Optional due date (YYYY-MM-DD). Absent on tasks that never set one. */
  due_date?: string | null;
  /** Remote identity — present only for synced tasks on a remote backend. */
  assignee?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
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
  due_date: string | null;
  assignee: string | null;
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
  due_date?: string | null;
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

export interface SyncConflict {
  slug: string;
  /** Where the losing local copy was preserved (state/.conflicts/...). */
  savedTo: string;
  reason: 'missing_base' | 'both_changed';
}

export interface SyncReport {
  backend: string;
  direction: SyncDirection;
  pushed: number;
  pulled: number;
  created: number;
  /** Remote tasks deleted (propagated local deletions). */
  deleted: number;
  commentsAdded: number;
  conflicts: SyncConflict[];
  pendingQueue: number;
  errors: string[];
  /** Remote server-time watermark after this sync (epoch ms), if any. */
  watermark: number | null;
  /** True when nothing had to be done (also the local backend's constant result). */
  noop: boolean;
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
  /** Resolve a human-entered name to a slug (exact → prefix → substring). */
  resolveSlug(name: string): Promise<SlugResolution>;
  /** Two-way sync with the remote. No-op for the local backend. */
  sync(direction?: SyncDirection): Promise<SyncReport>;
  /** Remote connectivity probe (Settings "Test connection"). Absent on local. */
  testConnection?(): Promise<ConnectionTestResult>;
  /** People with access to the remote container (assignee candidates). Absent on local. */
  listMembers?(): Promise<RemoteMember[]>;
  /** Create the recommended remote structure (custom fields). Absent on local. */
  provisionRemote?(): Promise<RemoteProvisionResult>;
}

export interface RemoteProvisionResult {
  /** Field names created on the remote container. */
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
