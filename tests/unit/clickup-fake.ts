/**
 * In-memory fake of the ClickUp REST v2 surface the backend uses.
 * Implements: POST /list/:id/task, PUT /task/:id, GET /task/:id,
 * GET /list/:id/task (delta by date_updated_gt), POST/GET /task/:id/comment,
 * GET /user. Keeps its own SERVER clock (distinct from any local clock the
 * backend uses) so watermark tests can prove server-time-only behavior.
 */

export interface FakeTask {
  id: string;
  name: string;
  description: string;
  status: { status: string };
  priority: { id: string };
  tags: Array<{ name: string }>;
  assignees: Array<{ id: number }>;
  date_created: string;
  date_updated: string;
}

export interface FakeComment {
  id: string;
  comment_text: string;
  date: string;
  user: { id: number; username: string };
}

export interface FakeRequestLogEntry {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeClickUp {
  fetchImpl: typeof fetch;
  tasks: Map<string, FakeTask>;
  comments: Map<string, FakeComment[]>;
  requests: FakeRequestLogEntry[];
  /** Server clock (epoch ms). Starts far from any test-local clock. */
  serverNow: () => number;
  advanceServer: (ms: number) => void;
  /** Simulate a REMOTE edit (bumps server time + date_updated). */
  editTask: (id: string, patch: Partial<Omit<FakeTask, 'id'>>) => void;
  addRemoteComment: (taskId: string, text: string, username?: string) => void;
  /** While set, every request fails this way ('network' throws, or an HTTP status). */
  failMode: { kind: 'network' } | { kind: 'http'; status: number } | null;
  setFailMode: (mode: FakeClickUp['failMode']) => void;
  /** People with access to the list (GET /list/:id/member). */
  members: Array<{ id: number; username: string; email?: string }>;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

export function makeFakeClickUp(opts: { serverStart?: number } = {}): FakeClickUp {
  let serverTime = opts.serverStart ?? 1_900_000_000_000;
  let idCounter = 0;
  const tasks = new Map<string, FakeTask>();
  const comments = new Map<string, FakeComment[]>();
  const requests: FakeRequestLogEntry[] = [];

  const fake: FakeClickUp = {
    tasks,
    comments,
    requests,
    serverNow: () => serverTime,
    advanceServer: (ms) => { serverTime += ms; },
    failMode: null,
    members: [
      { id: 501, username: 'Alice Smith', email: 'alice@example.test' },
      { id: 502, username: 'Mehmet Nuraydın', email: 'mehmet@example.test' },
    ],
    setFailMode: (mode) => { fake.failMode = mode; },
    editTask: (id, patch) => {
      const t = tasks.get(id);
      if (!t) throw new Error(`fake: no task ${id}`);
      serverTime += 1000;
      Object.assign(t, patch, { date_updated: String(serverTime) });
    },
    addRemoteComment: (taskId, text, username = 'remote-user') => {
      serverTime += 1000;
      const list = comments.get(taskId) ?? [];
      list.push({
        id: `c${++idCounter}`,
        comment_text: text,
        date: String(serverTime),
        user: { id: 99, username },
      });
      comments.set(taskId, list);
    },
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = u.pathname.replace(/^\/api\/v2/, '');
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path, body });

      if (fake.failMode?.kind === 'network') throw new Error('ECONNREFUSED (fake)');
      if (fake.failMode?.kind === 'http') return jsonResponse(fake.failMode.status, { err: 'forced' });

      // POST /list/:listId/task
      let m = path.match(/^\/list\/([^/]+)\/task$/);
      if (m && method === 'POST') {
        serverTime += 1000;
        const id = `cu_${++idCounter}`;
        const task: FakeTask = {
          id,
          name: body.name ?? '',
          description: body.description ?? '',
          status: { status: body.status ?? 'to do' },
          priority: { id: String(body.priority ?? 3) },
          tags: (body.tags ?? []).map((name: string) => ({ name })),
          assignees: (body.assignees ?? []).map((id2: number) => ({ id: id2 })),
          date_created: String(serverTime),
          date_updated: String(serverTime),
        };
        tasks.set(id, task);
        return jsonResponse(200, task);
      }

      // GET /list/:listId/task?date_updated_gt=...
      if (m && method === 'GET') {
        const gt = u.searchParams.get('date_updated_gt');
        const page = Number(u.searchParams.get('page') ?? '0');
        // Real ClickUp treats date_updated_gt as >= (observed live) — the
        // fake mirrors that so the backend's client-side strictly-greater
        // watermark guard stays under test.
        const all = [...tasks.values()].filter(
          (t) => gt === null || Number(t.date_updated) >= Number(gt),
        );
        // single-page fake (last_page signals no more)
        return jsonResponse(200, { tasks: page === 0 ? all : [], last_page: true });
      }

      // /task/:id
      m = path.match(/^\/task\/([^/]+)$/);
      if (m) {
        const task = tasks.get(m[1]);
        if (!task) return jsonResponse(404, { err: 'Task not found' });
        if (method === 'GET') return jsonResponse(200, task);
        if (method === 'PUT') {
          serverTime += 1000;
          if (body.name !== undefined) task.name = body.name;
          if (body.description !== undefined) task.description = body.description;
          if (body.status !== undefined) task.status = { status: body.status };
          if (body.priority !== undefined) task.priority = { id: String(body.priority) };
          if (body.assignees?.add) {
            for (const a of body.assignees.add) {
              if (!task.assignees.some((x) => x.id === a)) task.assignees.push({ id: a });
            }
          }
          if (body.assignees?.rem) {
            task.assignees = task.assignees.filter((x) => !body.assignees.rem.includes(x.id));
          }
          task.date_updated = String(serverTime);
          return jsonResponse(200, task);
        }
      }

      // /task/:id/comment
      m = path.match(/^\/task\/([^/]+)\/comment$/);
      if (m) {
        const taskId = m[1];
        if (!tasks.has(taskId)) return jsonResponse(404, { err: 'Task not found' });
        if (method === 'POST') {
          serverTime += 1000;
          const list = comments.get(taskId) ?? [];
          const comment: FakeComment = {
            id: `c${++idCounter}`,
            comment_text: body.comment_text ?? '',
            date: String(serverTime),
            user: { id: 1, username: 'api-user' },
          };
          list.push(comment);
          comments.set(taskId, list);
          // Comments bump the task's date_updated on real ClickUp too.
          const t = tasks.get(taskId)!;
          t.date_updated = String(serverTime);
          return jsonResponse(200, comment);
        }
        if (method === 'GET') {
          return jsonResponse(200, { comments: comments.get(taskId) ?? [] });
        }
      }

      // GET /user (connection test)
      if (path === '/user' && method === 'GET') {
        return jsonResponse(200, { user: { id: 1, username: 'api-user' } });
      }

      // GET /list/:id/member (assignee candidates)
      m = path.match(/^\/list\/([^/]+)\/member$/);
      if (m && method === 'GET') {
        return jsonResponse(200, { members: fake.members });
      }

      return jsonResponse(404, { err: `fake: unhandled ${method} ${path}` });
    }) as typeof fetch,
  };

  return fake;
}
