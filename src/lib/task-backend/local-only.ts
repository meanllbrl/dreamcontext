import matter from 'gray-matter';

/**
 * LOCAL-ONLY TASK FIELDS — the pull path's data-loss guard.
 *
 * A remote sync backend owns a NAMED, CLOSED set of task frontmatter fields:
 * exactly the ones it can map onto the remote (title, labels, dates, assignees,
 * custom fields, …). Everything else on a task is LOCAL — it exists only in the
 * `state/<slug>.md` mirror, has no remote representation, and therefore CANNOT
 * be reconstructed from a remote payload. `objectives:` is the canonical case
 * (the 2026-07-02 roadmap decision made it local-only precisely because a
 * `string[]` would be mangled into a single remote label), but it is not the
 * only one: `rice`, `parent_task`, `related_feature`, `description`, and every
 * key a user or a future feature adds to the frontmatter are in the same class.
 *
 * That matters because `state/` is GITIGNORED: a mirror overwritten with a
 * remote render is not recoverable from git history. A pull that silently drops
 * a local-only field destroys it permanently and still reports success — which
 * is exactly what happened on 2026-07-27 (72 task→objective links lost in one
 * `tasks sync pull`; recovered only because the auto-generated, git-tracked
 * `knowledge/roadmap/board.md` from the previous day happened to list them).
 *
 * So the rule here is structural rather than per-field: the pull may write ONLY
 * the keys in {@link REMOTE_MAPPED_TASK_FIELDS}; any other key present on the
 * local mirror must survive the merge byte-for-byte. `preserveLocalOnlyFields`
 * enforces that on the merged frontmatter and NAMES whatever it had to rescue,
 * so a future mapping change that starts dropping a field is loud, not silent.
 */

/**
 * Frontmatter keys a remote backend is allowed to author on a pull. Anything
 * NOT in this set is local-only by construction — including keys this codebase
 * has never heard of.
 *
 * `assignee` is here because the pull deliberately RETIRES it (the legacy single
 * assignee field is folded into `person:<slug>` tags); listing it keeps that
 * intentional removal from being reported as an accidental drop.
 */
export const REMOTE_MAPPED_TASK_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'status',
  'priority',
  'urgency',
  'tags',
  'version',
  'start_date',
  'due_date',
  'updated_at',
  'updated_by',
  'created_by',
  'custom_fields',
  'assignee',
  'source_project',
]);

/**
 * The local-only fields this codebase knows by name — used for documentation,
 * doctor messages and tests. NOT the enforcement mechanism: enforcement is the
 * complement of {@link REMOTE_MAPPED_TASK_FIELDS}, so an unknown key is treated
 * as local-only too (fail safe, not fail open).
 */
export const KNOWN_LOCAL_ONLY_TASK_FIELDS: readonly string[] = [
  'objectives',
  'rice',
  'parent_task',
  'related_feature',
  'description',
  'id',
  'created_at',
];

/** Identity fields the mirror-rebuild path mints fresh rather than restoring. */
const REBUILD_MINTED_FIELDS: ReadonlySet<string> = new Set(['id', 'created_at']);

/** A value that carries no information — losing it loses nothing. */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** True when `key` has no remote representation on any backend. */
export function isLocalOnlyTaskField(key: string): boolean {
  return !REMOTE_MAPPED_TASK_FIELDS.has(key);
}

export interface PreserveResult {
  /** The merged frontmatter with every rescued local-only value put back. */
  fm: Record<string, unknown>;
  /**
   * Local-only keys the merge WOULD have dropped (or emptied) and that were
   * restored. Non-empty means the mapping regressed — callers surface it.
   */
  rescued: string[];
}

/**
 * Put back every local-only field the merged frontmatter would have lost.
 *
 * A field is "lost" when the local mirror carried a non-empty value for it and
 * the merged result has none (absent, null, or emptied). Fields the remote owns
 * are never touched — clearing a `due_date` from the remote is a legitimate
 * merge outcome, clearing `objectives:` is not, because no remote can express it.
 */
export function preserveLocalOnlyFields(
  localFm: Record<string, unknown> | null | undefined,
  mergedFm: Record<string, unknown>,
  /**
   * Keys this particular sync ALSO owns, on top of the static set. A backend
   * whose remote container can be configured to carry an otherwise-local field
   * (ClickUp binds `description`, `related_feature`, `rice`, … to list custom
   * fields when they exist) passes the keys it actually merged a remote value
   * through, so clearing one of those from the remote stays a legitimate merge
   * outcome instead of being "rescued" back.
   */
  alsoRemoteOwned: Iterable<string> = [],
): PreserveResult {
  const remoteOwned = new Set([...REMOTE_MAPPED_TASK_FIELDS, ...alsoRemoteOwned]);
  const fm = { ...mergedFm };
  const rescued: string[] = [];
  for (const [key, value] of Object.entries(localFm ?? {})) {
    if (remoteOwned.has(key)) continue;
    if (isEmptyValue(value)) continue;
    if (!isEmptyValue(fm[key])) continue;
    fm[key] = value;
    rescued.push(key);
  }
  return { fm, rescued };
}

/**
 * The local-only fields recorded in a ledger base snapshot — what a REBUILD of
 * a vanished mirror can restore.
 *
 * The pull's create branch also fires when a mapped task's mirror FILE is gone
 * (a lost `state/` file, a `.tasks-map.json` team-merge re-slug, a crashed
 * write). Rebuilding it from the remote alone would silently drop every
 * local-only field the task had — but the ledger still holds the last synced
 * bytes of that exact mirror, so the links are recoverable rather than lost.
 * Identity (`id`, `created_at`) is deliberately NOT restored: the rebuild mints
 * a fresh identity and the map entry is re-recorded against it.
 */
export function localOnlyFieldsFromSnapshot(body: string | null | undefined): Record<string, unknown> {
  if (!body) return {};
  let data: Record<string, unknown>;
  try {
    data = matter(body).data as Record<string, unknown>;
  } catch {
    return {}; // an unparseable snapshot must never break a pull
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (REMOTE_MAPPED_TASK_FIELDS.has(key)) continue;
    if (REBUILD_MINTED_FIELDS.has(key)) continue;
    if (isEmptyValue(value)) continue;
    out[key] = value;
  }
  return out;
}
