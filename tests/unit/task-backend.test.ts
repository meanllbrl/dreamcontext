import { describe, it } from 'vitest';

/**
 * SPEC — Pluggable task backend (local | github)
 * GitHub: https://github.com/meanllbrl/dreamcontext/issues/11
 *
 * Goal: a `TaskBackend` interface both the CLI command actions and the server
 * route handlers call, so tasks can live either on disk (`local`, default,
 * current behavior) or in a GitHub Project (`github`). The dashboard, CLI,
 * recall, SessionStart snapshot, and sleep must all keep working unchanged.
 *
 * These are executable placeholders (`it.todo`). Convert each to a real `it`
 * as the matching milestone (M1–M5) ships. CI stays green until then.
 *
 * Target interface (the contract this file pins):
 *
 *   interface TaskBackend {
 *     list(filter?): Promise<TaskSummary[]>
 *     get(slug): Promise<TaskData | null>
 *     create(input): Promise<TaskData>
 *     updateFields(slug, fields): Promise<TaskData>     // status, priority, rice, tags...
 *     insertSection(slug, section, content): Promise<void>   // LIFO-aware
 *     addChangelog(slug, content): Promise<void>
 *     complete(slug, summary?): Promise<TaskData>
 *   }
 *   getTaskBackend(config): TaskBackend                  // resolves by config.taskBackend
 *
 * Config (.config.json), mirroring the native-memory toggle:
 *   taskBackend: "local" | "github"
 *   github?: { owner, repo, projectNumber, changelogTarget: "body" | "comments" }
 *
 * GitHub Projects v2 field mapping (pure mapping fns, unit-testable without network):
 *   status      -> Project Status single-select (Todo/In Progress/In Review/Done)
 *   priority    -> single-select custom field
 *   tags        -> issue labels
 *   assignee/   -> issue assignees (person tags from #8 map here)
 *   version     -> iteration/milestone
 *   rice.*      -> Number custom fields (score computed)
 *   product     -> single-select custom field
 *   body        -> issue body markdown (AC checkboxes -> native task list)
 *   changelog   -> issue body `## Changelog` section (or comments)
 *   id-map      -> state/.github-tasks.json { slug, dcId, issueNumber, itemNodeId }
 */
describe('task backend', () => {
  describe('M1 — interface + local backend conformance', () => {
    it.todo('getTaskBackend(config) returns the local backend when taskBackend is "local" or unset');
    it.todo('local backend implements every TaskBackend method');
    it.todo('GOLDEN: list/create/updateFields/insert/changelog/complete produce byte-identical state/*.md vs the pre-refactor CLI');
    it.todo('CLI verbs (list/create/rice/insert/status/complete/log) route through the backend, not direct fs');
    it.todo('server route handlers (GET/POST /api/tasks, GET/PATCH /api/tasks/:slug, /:slug/changelog, /:slug/insert) route through the backend');
  });

  describe('M2 — github read', () => {
    it.todo('github backend list() maps Project items -> TaskSummary (status/priority/tags/version/rice)');
    it.todo('github backend get(slug) resolves via the id-map and parses the issue body into task sections');
    it.todo('id-map state/.github-tasks.json round-trips slug <-> issueNumber <-> itemNodeId stably across renames');
    it.todo('auth resolves env (GITHUB_TOKEN/GH_TOKEN) -> `gh auth token` -> config PAT; headless-safe');
  });

  describe('field mapping (pure, no network)', () => {
    it.todo('status todo|in_progress|in_review|completed <-> Project Status options');
    it.todo('rice {reach,impact,confidence,effort} -> Number fields; score recomputed not trusted from remote');
    it.todo('tags <-> labels; person tags (#8) <-> assignees');
    it.todo('Acceptance Criteria checkboxes <-> native GitHub task-list items');
    it.todo('Changelog LIFO <-> issue body `## Changelog` section (changelogTarget=body)');
  });

  describe('M3 — github write + dashboard parity', () => {
    it.todo('create() opens an issue, adds it to the Project, sets fields, records the id-map');
    it.todo('updateFields() patches Project fields + issue (status bump, rice edit) idempotently');
    it.todo('insertSection()/addChangelog() edit the issue body LIFO-correctly');
    it.todo('complete() flips Status to Done without deleting the item');
    it.todo('every existing dashboard action works against github (no UI change beyond a backend badge)');
  });

  describe('M4 — sync: mirror + pull/push + conflicts + sleep', () => {
    // Source of truth = GitHub; local state/*.md = derived gitignored cache.
    // Model = pull-refresh + write-through + offline queue (NOT a 2-way merge engine).
    it.todo('github backend keeps a gitignored local mirror state/*.md so buildCorpus + snapshot are UNCHANGED');
    it.todo('PULL is a delta sync: only items with updatedAt > per-item lastSyncedAt are re-mirrored (no full refetch)');
    it.todo('PULL is throttled on hot read paths; runs on snapshot + dashboard refresh + sleep start');
    it.todo('writes are GitHub-first (field/section-level mutation, no blind body overwrite) then mirror-updated');
    it.todo('writes use optimistic concurrency: re-read item updatedAt, apply delta, retry on mismatch');
    it.todo('offline writes enqueue to state/.github-queue.json (idempotent, op-id keyed) and replay on reconnect');
    it.todo('conflict (both sides changed) resolves GitHub-wins; local version preserved under state/.conflicts/ and surfaced');
    it.todo('ledger split: committed state/.github-tasks.json (stable map) + gitignored state/.github-sync.json (cursors)');
    it.todo('sleep-tasks (tasks log/status/insert) updates GitHub idempotently — no duplicate items/comments on re-run');
  });

  describe('M5 — config toggle', () => {
    it.todo('.config.json taskBackend + github block validated (strict-pick) on PATCH /api/config');
    it.todo('config task-backend <local|github> CLI writes config; config show reports the backend');
    it.todo('default is local; existing projects with no taskBackend field behave exactly as today');
  });
});
