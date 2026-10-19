/**
 * Pure dreamcontext ↔ GitHub Issues mapping — the GitHub-backend wire map.
 * No I/O, no network: unit-testable in isolation. This is the ONLY module
 * (besides github.ts) allowed to know GitHub Issue wire shapes; nothing here
 * may leak past the backend boundary.
 *
 * Mirrors `clickup-map.ts`. Two intentional divergences forced by plain
 * Issues over REST (see knowledge/decision-github-task-backend.md):
 *  - GitHub issues have no free-form status: a dreamcontext status (the shipped
 *    four plus any the project declares in overrides/task.md) degrades to
 *    `state` (open|closed) + `state_reason` + a `dc:<key>` sub-status label.
 *    `not_planned` is EXCLUSIVELY the soft-delete signal; a cancelled-kind
 *    status closes as `completed` + its `dc:<key>` label.
 *  - GitHub issues have no native priority/urgency: those (plus tags + version)
 *    ride as LABELS, with reserved prefixes carving the structured ones out.
 */

import { foldAscii } from '../fold-ascii.js';
import { splitChangelogEntries, normalizeEntry } from './clickup-map.js';
import {
  DEFAULT_STATUSES,
  DONE_STATUS_KEY,
  dcLabelFor,
  doneStatus,
  findStatus,
  isCancelled,
  isDone,
  isKnown,
  parentOf,
  keyFromDcLabel,
  normalizeStatusKey,
  type StatusDef,
} from '../task-status.js';

// Re-export the shared changelog helpers so callers can import the whole
// changelog-comment surface from one module (parity with clickup-map).
export { splitChangelogEntries, normalizeEntry };

/** GitHub Issue (REST v3) shape — the subset we read/write. */
export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  /** Null on legacy/never-closed issues; the close-reason discriminator. */
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null;
  /**
   * GitHub returns label objects (`{ name }`); some payloads / fakes use bare
   * strings. Both are accepted on read (see `labelNamesOf`).
   */
  labels?: Array<{ name: string } | string> | null;
  assignees?: Array<{ login: string }> | null;
  milestone?: { title?: string; due_on?: string | null } | null;
  /** ISO-8601 strings — GitHub SERVER time. `updated_at` is the watermark. */
  created_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string } | null;
}

/** GitHub issue comment — one changelog entry rides as one comment. */
export interface GitHubComment {
  id: number;
  body?: string | null;
  /** ISO-8601, server time. */
  created_at?: string | null;
  user?: { login?: string } | null;
}

// ─── Reserved label prefixes ─────────────────────────────────────────────────
// Labels carry structured fields GitHub issues lack natively. Anything WITHOUT
// one of these prefixes is a verbatim user tag.

export const PRIORITY_PREFIX = 'priority:';
export const URGENCY_PREFIX = 'urgency:';
export const VERSION_PREFIX = 'version:';
/** dreamcontext-reserved namespace (sub-status labels live here). */
export const DC_PREFIX = 'dc:';

const RESERVED_PREFIXES = [PRIORITY_PREFIX, URGENCY_PREFIX, VERSION_PREFIX, DC_PREFIX];

// ─── Status ────────────────────────────────────────────────────────────────

/** The GitHub close-reason used for a normal task completion. */
export const STATE_REASON_COMPLETED = 'completed' as const;
/** The GitHub close-reason used for a SOFT delete (no hard delete on REST). */
export const STATE_REASON_NOT_PLANNED = 'not_planned' as const;
/** The GitHub close-reason set when reopening a previously-closed issue. */
export const STATE_REASON_REOPENED = 'reopened' as const;

/**
 * Sentinel returned by `statusFromGitHub` for a closed+`not_planned` issue:
 * the backend reads this as "remove the local mirror" (soft-delete symmetry).
 * It is intentionally NOT a real dreamcontext status, so callers must branch on
 * it explicitly rather than persisting it.
 */
export const DELETED_SENTINEL = '__deleted__' as const;

/**
 * The wire patch a dreamcontext status maps to. `state` is OPTIONAL: for a
 * status key the loaded set does not declare the patch carries NO state and no
 * state_reason — the issue's open/closed state is left exactly as it is, so a
 * schema-drifted machine can never reopen an issue the user deliberately closed.
 */
export interface GitHubStatePatch {
  state?: 'open' | 'closed';
  state_reason?: 'completed' | 'not_planned' | 'reopened';
}

/**
 * Map a dreamcontext status to the GitHub `state`/`state_reason` patch — via the
 * status's PARENT, one of the four shipped statuses, so a declared status needs
 * nothing created on the remote:
 * - parent `completed` (the done status, and every cancelled-kind status)
 *                             → closed + completed. A cancelled-kind status is
 *                               told apart by its `dc:<key>` label, see
 *                               `subStatusLabel`. NEVER `not_planned`: that is
 *                               EXCLUSIVELY the soft-delete signal
 *                               (decision-github-task-backend.md).
 * - any other KNOWN parent    → open (sub-status rides a label); when `reopen`
 *                               is true the open patch carries `state_reason: reopened`.
 * - an UNKNOWN status key     → {} — state and state_reason OMITTED entirely.
 *                               Never infer "open" from a key we do not understand.
 */
export function statusToGitHub(
  status: string,
  opts?: { reopen?: boolean; statuses?: readonly StatusDef[] },
): GitHubStatePatch {
  const defs = opts?.statuses ?? DEFAULT_STATUSES;
  if (!isKnown(defs, status)) return {};
  if (parentOf(defs, status) === DONE_STATUS_KEY) {
    return { state: 'closed', state_reason: STATE_REASON_COMPLETED };
  }
  if (opts?.reopen) {
    return { state: 'open', state_reason: STATE_REASON_REOPENED };
  }
  return { state: 'open' };
}

/** The GitHub patch a `tasks delete` maps to: a SOFT delete (close not_planned). */
export function deleteToGitHub(): GitHubStatePatch {
  return { state: 'closed', state_reason: STATE_REASON_NOT_PLANNED };
}

/**
 * The `dc:*` sub-status label for a status, or null for `todo` and the done
 * status (`completed`) — absence of a label is todo; a bare close is done.
 *
 * STRING-DERIVED, never gated on finding a def in the loaded set: a key this
 * machine does not recognise still yields `dc:<key>`. The label PATCH replaces
 * the whole set, so a def-gated lookup would let a schema-drifted machine strip
 * another machine's `dc:*` label on any unrelated push (the anti-strip rule).
 */
export function subStatusLabel(status: string, _statuses: readonly StatusDef[] = DEFAULT_STATUSES): string | null {
  const key = normalizeStatusKey(status);
  if (!key || key === 'todo' || key === DONE_STATUS_KEY) return null;
  return dcLabelFor(key);
}

/**
 * Derive the open-issue sub-status from its label set. Default `todo`. A
 * `dc:*` label naming a status the loaded set does not declare is skipped
 * (the caller warns; see `unknownDcLabels`), so the mirror records `todo`
 * rather than a key this machine cannot reason about.
 */
export function statusFromLabels(labelNames: string[], statuses: readonly StatusDef[] = DEFAULT_STATUSES): string {
  for (const name of labelNames) {
    const key = keyFromDcLabel(name);
    if (!key) continue;
    if (key === 'todo') return 'todo';
    // An OPEN issue is by definition live: a stale terminal label (dc:cancelled
    // left on an issue someone reopened on github.com) does not make it cancelled.
    const def = findStatus(statuses, key);
    if (def && def.kind !== 'done' && def.kind !== 'cancelled') return def.key;
  }
  return 'todo';
}

/**
 * The `dc:*` labels on an issue that name NO status in the loaded set — the
 * schema-drift signal a pull surfaces in its SyncReport (non-destructive: the
 * status downgrades, nothing is deleted, and it self-corrects once this machine
 * pulls `overrides/task.md`).
 */
export function unknownDcLabels(
  labels: Array<{ name: string } | string> | string[] | null | undefined,
  statuses: readonly StatusDef[] = DEFAULT_STATUSES,
): string[] {
  const out: string[] = [];
  for (const name of labelNamesOf(labels)) {
    const key = keyFromDcLabel(name);
    if (!key || key === 'todo') continue;
    if (!isKnown(statuses, key)) out.push(name);
  }
  return out;
}

/**
 * Map a GitHub issue back to a dreamcontext status:
 *  - closed + `not_planned`        → `DELETED_SENTINEL` (remove local mirror). UNCHANGED —
 *                                    this is the soft-delete signal and nothing else.
 *  - closed + `completed` / null   → a `dc:*` label resolving to a CANCELLED-kind status
 *                                    wins, else the done status (`completed`). A machine
 *                                    that does not know the label records `completed`.
 *  - open                          → status from the `dc:*` label (default todo)
 */
export function statusFromGitHub(
  issue: Pick<GitHubIssue, 'state' | 'state_reason' | 'labels'>,
  statuses: readonly StatusDef[] = DEFAULT_STATUSES,
): string {
  if (issue.state === 'closed') {
    if (issue.state_reason === STATE_REASON_NOT_PLANNED) return DELETED_SENTINEL;
    for (const name of labelNamesOf(issue.labels)) {
      const key = keyFromDcLabel(name);
      if (key && isCancelled(statuses, key)) return findStatus(statuses, key)!.key;
    }
    return doneStatus(statuses).key;
  }
  return statusFromLabels(labelNamesOf(issue.labels), statuses);
}

// ─── Labels (priority / urgency / tags / version + dc:* sub-status) ───────────

const PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);

/**
 * Compose the full GitHub label set for an issue:
 *  - every user `tag` verbatim
 *  - `priority:<p>` when provided (labels are the only carrier on plain issues)
 *  - `urgency:<u>` when provided
 *  - `version:<v>` when provided (rides as a label, exactly like ClickUp)
 *  - the `dc:*` sub-status label for an open non-todo state
 */
export function labelsToGitHub(input: {
  tags?: string[];
  priority?: string | null;
  urgency?: string | null;
  version?: string | null;
  status?: string | null;
  /** Override-declared `select` custom fields — ride as `<key>:<value>` labels. */
  selectFields?: Array<{ key: string; value: string | null }>;
}): string[] {
  const out: string[] = [];
  for (const tag of input.tags ?? []) {
    if (tag && tag.trim()) out.push(tag.trim());
  }
  if (input.priority && input.priority.trim()) out.push(`${PRIORITY_PREFIX}${input.priority.trim()}`);
  if (input.urgency && input.urgency.trim()) out.push(`${URGENCY_PREFIX}${input.urgency.trim()}`);
  if (input.version && input.version.trim()) out.push(`${VERSION_PREFIX}${input.version.trim()}`);
  for (const f of input.selectFields ?? []) {
    if (f.key && f.value !== null && String(f.value).trim()) {
      out.push(`${f.key}:${String(f.value).trim()}`);
    }
  }
  if (input.status) {
    const sub = subStatusLabel(input.status);
    if (sub) out.push(sub);
  }
  // De-dup while preserving first-seen order (a user tag named `priority:high`
  // and a real priority of `high` should not double up).
  return [...new Set(out)];
}

/**
 * Decompose a GitHub label set into the structured fields + user tags.
 * Reserved prefixes are split out; `dc:*` labels are dropped (status is read
 * separately via `statusFromGitHub`). Everything else is a verbatim user tag.
 * Mirrors ClickUp defaults: priority defaults to `medium` when no label is set.
 */
export function labelsFromGitHub(
  labelNames: Array<{ name: string } | string> | string[] | null | undefined,
  selectFieldKeys: string[] = [],
): {
  tags: string[];
  priority: string;
  urgency: string | null;
  version: string | null;
  /** Values of override-declared `select` custom fields carried as labels. */
  customFields: Record<string, string>;
} {
  const names = labelNamesOf(labelNames);
  const tags: string[] = [];
  let priority = 'medium';
  let urgency: string | null = null;
  let version: string | null = null;
  const customFields: Record<string, string> = {};
  // Match the LONGEST key first so a `team_lead:` field isn't shadowed by `team:`.
  const fieldKeys = [...selectFieldKeys].sort((a, b) => b.length - a.length);

  outer: for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(PRIORITY_PREFIX)) {
      const p = name.slice(PRIORITY_PREFIX.length).trim().toLowerCase();
      if (PRIORITIES.has(p)) priority = p;
      continue;
    }
    if (lower.startsWith(URGENCY_PREFIX)) {
      urgency = name.slice(URGENCY_PREFIX.length).trim() || null;
      continue;
    }
    if (lower.startsWith(VERSION_PREFIX)) {
      version = name.slice(VERSION_PREFIX.length).trim() || null;
      continue;
    }
    if (lower.startsWith(DC_PREFIX)) {
      continue; // sub-status; read via statusFromGitHub
    }
    for (const key of fieldKeys) {
      if (lower.startsWith(`${key.toLowerCase()}:`)) {
        const v = name.slice(key.length + 1).trim();
        if (v) customFields[key] = v;
        continue outer;
      }
    }
    tags.push(name);
  }

  return { tags, priority, urgency, version, customFields };
}

/** Normalize a GitHub `labels` array (objects OR strings) to a string[]. */
export function labelNamesOf(
  labels: Array<{ name: string } | string> | string[] | null | undefined,
): string[] {
  if (!labels) return [];
  const out: string[] = [];
  for (const l of labels) {
    const name = typeof l === 'string' ? l : l?.name;
    if (name && name.trim()) out.push(name);
  }
  return out;
}

/** Whether a label name is reserved (structured field, not a user tag). */
export function isReservedLabel(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_PREFIXES.some((p) => lower.startsWith(p));
}

// ─── Body ↔ issue body ───────────────────────────────────────────────────────

/**
 * The issue body is the task body WITHOUT the `## Changelog` section (changelog
 * entries live as issue comments — union-merged, conflict-free). Same logic as
 * ClickUp's `bodyToDescription`.
 */
export function bodyToIssueBody(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inChangelog = false;
  for (const line of lines) {
    const h = line.match(/^(#{2})\s+(.+)$/);
    if (h) inChangelog = h[2].trim().toLowerCase() === 'changelog';
    if (!inChangelog) out.push(line);
  }
  return out.join('\n').trimEnd() + '\n';
}

// ─── Dates (start_date / due_date) — encoded IN the issue body ─────────────────
// GitHub Issues have no native date fields, so to make dates RELIABLY sync we
// persist them inside the issue body as a marked, human-visible block. The block
// is the single source of truth on the remote: it round-trips deterministically,
// is stripped from the prose before any 3-way merge (so dates never collide with
// prose edits), and is re-composed on push from the merged frontmatter values.
// A task with no dates carries NO block (the body bytes stay exactly as before).

const DATES_OPEN = '<!-- dc:dates -->';
const DATES_CLOSE = '<!-- /dc:dates -->';
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Render the dates block for an issue body, or '' when neither date is set.
 * Visible form (so it reads well in the GitHub UI):
 *   <!-- dc:dates -->
 *   > 🗓️ **Start:** 2026-06-22 · **Due:** 2026-06-27
 *   <!-- /dc:dates -->
 */
export function renderDatesBlock(start: string | null | undefined, due: string | null | undefined): string {
  const parts: string[] = [];
  if (start) parts.push(`**Start:** ${start}`);
  if (due) parts.push(`**Due:** ${due}`);
  if (parts.length === 0) return '';
  return `${DATES_OPEN}\n> 🗓️ ${parts.join(' · ')}\n${DATES_CLOSE}`;
}

/** Parse the dates block out of an issue body. Missing block / dates → nulls. */
export function parseDatesBlock(body: string | null | undefined): { start: string | null; due: string | null } {
  if (!body) return { start: null, due: null };
  const open = body.indexOf(DATES_OPEN);
  const close = body.indexOf(DATES_CLOSE);
  if (open === -1 || close === -1 || close < open) return { start: null, due: null };
  const inner = body.slice(open + DATES_OPEN.length, close);
  const startMatch = inner.match(/\*\*Start:\*\*\s*/);
  const dueMatch = inner.match(/\*\*Due:\*\*\s*/);
  const after = (m: RegExpMatchArray | null): string | null => {
    if (!m || m.index === undefined) return null;
    const d = inner.slice(m.index + m[0].length).match(DATE_RE);
    return d ? d[1] : null;
  };
  return { start: after(startMatch), due: after(dueMatch) };
}

/** Remove the dates block (and the blank lines hugging it) from an issue body. */
export function stripDatesBlock(body: string | null | undefined): string {
  if (!body) return '';
  const open = body.indexOf(DATES_OPEN);
  const close = body.indexOf(DATES_CLOSE);
  if (open === -1 || close === -1 || close < open) return body;
  const before = body.slice(0, open).replace(/\n+$/, '');
  const after = body.slice(close + DATES_CLOSE.length).replace(/^\n+/, '');
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

// ─── Custom fields (text / number / date) — encoded IN the issue body ──────────
// GitHub plain Issues have no custom fields; `select` fields ride as labels (see
// labelsToGitHub). Every OTHER override-declared field rides here, in a marked,
// human-visible body block — the same reliable round-trip the dates block uses.
// One line per field (so values may contain any punctuation). The block is the
// single source of truth on the remote, stripped before the 3-way prose merge,
// and re-composed on push from the merged frontmatter values. No fields → no
// block (the body bytes stay exactly as before).

const FIELDS_OPEN = '<!-- dc:fields -->';
const FIELDS_CLOSE = '<!-- /dc:fields -->';

/**
 * Render the custom-fields block, or '' when no field has a value. Visible form:
 *   <!-- dc:fields -->
 *   > 🏷️ **Story Points:** 8
 *   > **Sprint:** 24.3
 *   <!-- /dc:fields -->
 */
export function renderFieldsBlock(fields: Array<{ name: string; value: string | number | null | undefined }>): string {
  const lines: string[] = [];
  for (const f of fields) {
    if (f.value === null || f.value === undefined) continue;
    const v = String(f.value).trim();
    if (v === '') continue;
    lines.push(`> ${lines.length === 0 ? '🏷️ ' : ''}**${f.name}:** ${v}`);
  }
  if (lines.length === 0) return '';
  return `${FIELDS_OPEN}\n${lines.join('\n')}\n${FIELDS_CLOSE}`;
}

/**
 * Parse the custom-fields block out of an issue body. `defs` maps each field's
 * display name to its local key; the returned map is keyed by local key.
 * Missing block / unmatched fields → omitted (no key).
 */
export function parseFieldsBlock(
  body: string | null | undefined,
  defs: Array<{ name: string; key: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) return out;
  const open = body.indexOf(FIELDS_OPEN);
  const close = body.indexOf(FIELDS_CLOSE);
  if (open === -1 || close === -1 || close < open) return out;
  const inner = body.slice(open + FIELDS_OPEN.length, close);
  for (const def of defs) {
    const escaped = def.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `i` flag: tolerate capitalisation variants of the field name in the body
    // (e.g. `**Story Points:**` vs a `story points` def) — github review nit.
    const m = inner.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, 'i'));
    if (m) {
      const v = m[1].trim();
      if (v) out[def.key] = v;
    }
  }
  return out;
}

/** Remove the custom-fields block (and the blank lines hugging it) from a body. */
export function stripFieldsBlock(body: string | null | undefined): string {
  if (!body) return '';
  const open = body.indexOf(FIELDS_OPEN);
  const close = body.indexOf(FIELDS_CLOSE);
  if (open === -1 || close === -1 || close < open) return body;
  const before = body.slice(0, open).replace(/\n+$/, '');
  const after = body.slice(close + FIELDS_CLOSE.length).replace(/^\n+/, '');
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

/**
 * Compose the full issue body for a push: the dates block (when any date is set)
 * above the changelog-free prose. `prose` is expected to already be the output
 * of {@link bodyToIssueBody}. Idempotent — strips any stray block from `prose`
 * first so re-pushes never stack duplicate blocks.
 */
export function composeIssueBody(
  prose: string,
  start: string | null | undefined,
  due: string | null | undefined,
  fieldsBlock = '',
): string {
  const cleanProse = stripFieldsBlock(stripDatesBlock(prose)).trimEnd();
  const datesBlock = renderDatesBlock(start, due);
  const blocks = [datesBlock, fieldsBlock].filter(Boolean).join('\n\n');
  if (!blocks) return cleanProse ? `${cleanProse}\n` : '';
  return cleanProse ? `${blocks}\n\n${cleanProse}\n` : `${blocks}\n`;
}

// ─── Server time / watermark ──────────────────────────────────────────────────

/**
 * Parse a GitHub ISO-8601 timestamp (e.g. issue `updated_at`) to epoch ms.
 * Null/garbage → null. Analogous to ClickUp's `serverTimeMs`, but the wire
 * value is an ISO string rather than an epoch-ms string.
 */
export function githubTimeMs(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** GitHub `updated_at` ISO ← epoch ms (for `since=` delta queries). */
export function githubTimeIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// Re-exported so a single import surface mirrors clickup-map's foldAscii usage.
export { foldAscii };
