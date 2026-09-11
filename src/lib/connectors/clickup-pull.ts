import { dirname } from 'node:path';
import { ApiAdapter } from '../task-backend/api-adapter.js';
import { resolveClickUpToken } from '../task-backend/secrets.js';
import type { ClickUpComment, ClickUpTask } from '../task-backend/clickup-map.js';
import { readConnectorCache, writeConnectorCache } from './store.js';
import {
  ConnectorError,
  DEFAULT_BACKFILL_MS,
  MAX_HISTORY,
  type ConnectorCaps,
  type ConnectorEvent,
  type ConnectorManifest,
} from './types.js';

/**
 * ClickUp read-side pull — the `clickup` connector kind.
 *
 * Scope contract (task sleep-connectors, overlap guard vs task-sync): this
 * pull observes DISCUSSION — comments, plus a one-line context event for a
 * newly created task. It never reads task state into the brain (status,
 * assignees, fields) and issues GET requests only. Every list carries its own
 * `date_updated_gt` cursor, so one connector can watch many lists and a
 * failing list never stalls the others.
 *
 * Bounded by contract: pages, tasks-per-list, per-event text, and the
 * manifest's `max_events`/`max_chars` caps. Sleep never blocks on a pull —
 * failures land in the cache `error` and the outcome, not as a throw
 * (a missing token is the exception: that is a setup problem the user must fix).
 */

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';
const CLICKUP_RATE_PER_MINUTE = 90;
const MAX_PAGES_PER_LIST = 5;
const MAX_TASKS_PER_LIST = 50;
const EVENT_TEXT_CAP = 1_000;

export interface ListPullReport {
  id: string;
  name: string | null;
  tasksScanned: number;
  added: number;
  /** True when the task window was cut at MAX_TASKS_PER_LIST/MAX_PAGES. */
  truncated: boolean;
  error: string | null;
}

export interface PullOutcome {
  slug: string;
  added: number;
  pending: number;
  dropped: number;
  perList: ListPullReport[];
  /** Aggregated per-list failures; null when every list pulled clean. */
  error: string | null;
}

export interface PullDeps {
  /** Injectable adapter (tests). When provided, no token is resolved. */
  adapter?: ApiAdapter;
  nowMs?: () => number;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > EVENT_TEXT_CAP ? `${t.slice(0, EVENT_TEXT_CAP)}…` : t;
}

function taskLink(taskId: string): string {
  return `https://app.clickup.com/t/${taskId}`;
}

/** Newest-first drop order is wrong for a learning feed — drop OLDEST first. */
export function applyCaps(events: ConnectorEvent[], caps: ConnectorCaps): { kept: ConnectorEvent[]; dropped: number } {
  const sorted = [...events].sort((a, b) => a.t.localeCompare(b.t));
  let dropped = 0;
  while (sorted.length > caps.max_events) {
    sorted.shift();
    dropped++;
  }
  let chars = sorted.reduce((n, e) => n + e.text.length, 0);
  while (chars > caps.max_chars && sorted.length > 1) {
    const gone = sorted.shift()!;
    chars -= gone.text.length;
    dropped++;
  }
  return { kept: sorted, dropped };
}

function buildAdapter(contextRoot: string, deps?: PullDeps): ApiAdapter {
  if (deps?.adapter) return deps.adapter;
  const token = resolveClickUpToken(dirname(contextRoot));
  if (!token) {
    throw new ConnectorError(
      'No ClickUp token found. Set CLICKUP_TOKEN or run `dreamcontext connectors token <token>`.',
    );
  }
  return new ApiAdapter({
    baseUrl: CLICKUP_BASE_URL,
    authHeaders: () => ({ Authorization: token.token }),
    ratePerMinute: CLICKUP_RATE_PER_MINUTE,
  });
}

async function pullList(
  adapter: ApiAdapter,
  list: { id: string; name: string | null },
  since: number,
): Promise<{ events: ConnectorEvent[]; maxUpdated: number; tasksScanned: number; truncated: boolean }> {
  const label = list.name ?? list.id;
  const tasks: ClickUpTask[] = [];
  let truncated = false;
  // `reverse: true` with `order_by: updated` = OLDEST-updated first. That
  // ordering is load-bearing for cursor safety: any task the caps cut off is
  // NEWER than everything we processed, so advancing the cursor to the newest
  // processed task re-offers the cut remainder on the next pull instead of
  // skipping past it forever.
  for (let page = 0; page < MAX_PAGES_PER_LIST; page++) {
    const res = await adapter.request<{ tasks?: ClickUpTask[]; last_page?: boolean }>(
      'GET',
      `/list/${list.id}/task`,
      { query: { page, include_closed: true, order_by: 'updated', reverse: true, date_updated_gt: since } },
    );
    const batch = res.tasks ?? [];
    tasks.push(...batch);
    if (res.last_page !== false || batch.length === 0) break;
    if (page === MAX_PAGES_PER_LIST - 1) truncated = true;
  }
  // Defensive re-sort (never trust remote ordering), then keep the OLDEST
  // slice — the cursor below derives from processed tasks only, so it never
  // advances past an unprocessed one.
  tasks.sort((a, b) => Number(a.date_updated ?? 0) - Number(b.date_updated ?? 0));
  if (tasks.length > MAX_TASKS_PER_LIST) {
    tasks.length = MAX_TASKS_PER_LIST;
    truncated = true;
  }

  const events: ConnectorEvent[] = [];
  let maxUpdated = since;
  for (const task of tasks) {
    const updated = Number(task.date_updated ?? 0);
    if (updated > maxUpdated) maxUpdated = updated;

    // Context event for a task BORN inside the window — name only, no state.
    const created = Number(task.date_created ?? 0);
    if (created > since) {
      events.push({
        id: `${task.id}:created`,
        t: new Date(created).toISOString(),
        kind: 'task',
        list: label,
        task: task.name,
        author: null,
        text: clip(`New task: ${task.name}`),
        link: taskLink(task.id),
      });
    }

    const res = await adapter.request<{ comments?: ClickUpComment[] }>('GET', `/task/${task.id}/comment`);
    for (const c of res.comments ?? []) {
      const at = Number(c.date ?? 0);
      const text = (c.comment_text ?? '').trim();
      if (at <= since || !text) continue;
      events.push({
        id: `${task.id}:c:${c.id}`,
        t: new Date(at).toISOString(),
        kind: 'comment',
        list: label,
        task: task.name,
        author: c.user?.username ?? null,
        text: clip(text),
        link: taskLink(task.id),
      });
    }
  }
  return { events, maxUpdated, tasksScanned: tasks.length, truncated };
}

/**
 * Pull one connector: every configured list, per-list cursor, per-list
 * fault isolation. Persists the cache (merged pending events, advanced
 * cursors, pull history) and returns the outcome for the caller to render.
 */
export async function pullConnector(
  contextRoot: string,
  manifest: ConnectorManifest,
  opts?: { cycle?: number | null; deps?: PullDeps },
): Promise<PullOutcome> {
  const nowMs = opts?.deps?.nowMs ?? Date.now;
  const adapter = buildAdapter(contextRoot, opts?.deps);
  const cache = readConnectorCache(contextRoot, manifest.slug);

  const fresh: ConnectorEvent[] = [];
  const perList: ListPullReport[] = [];
  const newCursors: Record<string, number> = { ...cache.cursors };

  for (const list of manifest.source.lists) {
    const since = cache.cursors[list.id] ?? nowMs() - DEFAULT_BACKFILL_MS;
    try {
      const r = await pullList(adapter, list, since);
      fresh.push(...r.events);
      newCursors[list.id] = Math.max(since, r.maxUpdated);
      perList.push({ id: list.id, name: list.name, tasksScanned: r.tasksScanned, added: r.events.length, truncated: r.truncated, error: null });
    } catch (err) {
      // Cursor NOT advanced — the failed window re-offers next pull.
      perList.push({ id: list.id, name: list.name, tasksScanned: 0, added: 0, truncated: false, error: (err as Error).message });
    }
  }

  // Merge with unconsumed pending events; dedup by event id.
  const seen = new Set(cache.events.map((e) => e.id));
  const added = fresh.filter((e) => !seen.has(e.id));
  const { kept, dropped } = applyCaps([...cache.events, ...added], manifest.caps);

  const errors = perList.filter((l) => l.error).map((l) => `${l.name ?? l.id}: ${l.error}`);
  const error = errors.length > 0 ? errors.join('; ') : null;
  const pulledAt = new Date(nowMs()).toISOString();

  cache.pulledAt = pulledAt;
  cache.pulledCycle = opts?.cycle ?? cache.pulledCycle;
  cache.cursors = newCursors;
  cache.events = kept;
  cache.error = error;
  cache.errorAt = error ? pulledAt : null;
  cache.history = [
    { pulledAt, added: added.length, pending: kept.length, dropped, error },
    ...cache.history,
  ].slice(0, MAX_HISTORY);
  writeConnectorCache(contextRoot, cache);

  return { slug: manifest.slug, added: added.length, pending: kept.length, dropped, perList, error };
}
