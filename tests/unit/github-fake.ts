/**
 * In-memory fake of the GitHub Issues REST v3 surface the backend uses.
 * Implements: POST/PATCH/GET /repos/:o/:r/issues[/:n],
 * GET /repos/:o/:r/issues (delta by `since`, PAGE-NUMBER pagination),
 * GET/POST /repos/:o/:r/issues/:n/comments,
 * GET/POST /repos/:o/:r/labels, GET /repos/:o/:r/collaborators,
 * GET /user/repos, GET /user.
 *
 * Keeps its own SERVER clock (epoch ms, far from any test-local clock) so
 * watermark tests can prove server-time-only behavior. ISO-8601 timestamps are
 * derived from that clock so `since=<ISO>` filtering matches the backend's
 * `updated_at` watermark exactly.
 *
 * Pagination: real per_page slicing (page 1 = first slice, etc.) so a multi-page
 * drain is exercised. `headers.get` returns null (no Link header) — the backend
 * must NOT read headers (the ApiAdapter exposes only the parsed body).
 */

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: 'completed' | 'not_planned' | 'reopened' | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  /** Present ONLY on pull-request items — the backend must filter these out. */
  pull_request?: { url: string };
}

export interface FakeIssueComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
}

export interface FakeLabel {
  name: string;
  color: string;
  description: string;
}

export interface FakeRequestLogEntry {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface FakeGitHub {
  fetchImpl: typeof fetch;
  issues: Map<number, FakeIssue>;
  comments: Map<number, FakeIssueComment[]>;
  labels: Map<string, FakeLabel>;
  requests: FakeRequestLogEntry[];
  /** Server clock (epoch ms). Starts far from any test-local clock. */
  serverNow: () => number;
  advanceServer: (ms: number) => void;
  /** Seed an issue directly (server-side). Returns the created issue. */
  seedIssue: (issue: Partial<Omit<FakeIssue, 'number'>> & { title: string }) => FakeIssue;
  /** Simulate a REMOTE edit (bumps server time + updated_at). */
  editIssue: (number: number, patch: Partial<Omit<FakeIssue, 'number'>>) => void;
  addRemoteComment: (issueNumber: number, body: string, login?: string) => void;
  /** While set, every request fails this way ('network' throws, or an HTTP status). */
  failMode: { kind: 'network' } | { kind: 'http'; status: number } | null;
  setFailMode: (mode: FakeGitHub['failMode']) => void;
  /** Repo collaborators (GET /repos/:o/:r/collaborators). */
  collaborators: Array<{ login: string; id: number }>;
  /** Repos visible to the token (GET /user/repos). */
  repos: Array<{ name: string; full_name: string; owner: { login: string } }>;
  /** The authenticated user (GET /user). */
  user: { login: string; id: number };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null }, // no Link header — the backend must not read headers
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

export function makeFakeGitHub(opts: { serverStart?: number } = {}): FakeGitHub {
  let serverTime = opts.serverStart ?? 1_900_000_000_000;
  let issueCounter = 0;
  let commentCounter = 0;
  const issues = new Map<number, FakeIssue>();
  const comments = new Map<number, FakeIssueComment[]>();
  const labels = new Map<string, FakeLabel>();
  const requests: FakeRequestLogEntry[] = [];

  const iso = (ms: number) => new Date(ms).toISOString();

  const fake: FakeGitHub = {
    issues,
    comments,
    labels,
    requests,
    serverNow: () => serverTime,
    advanceServer: (ms) => { serverTime += ms; },
    failMode: null,
    collaborators: [
      { login: 'alice', id: 501 },
      { login: 'mehmet', id: 502 },
    ],
    repos: [
      { name: 'dreamcontext', full_name: 'meanllbrl/dreamcontext', owner: { login: 'meanllbrl' } },
      { name: 'sandbox', full_name: 'alice/sandbox', owner: { login: 'alice' } },
    ],
    user: { login: 'api-user', id: 1 },
    seedIssue: (issue) => {
      serverTime += 1000;
      const number = ++issueCounter;
      const created: FakeIssue = {
        number,
        title: issue.title,
        body: issue.body ?? '',
        state: issue.state ?? 'open',
        state_reason: issue.state_reason ?? null,
        labels: issue.labels ?? [],
        assignees: issue.assignees ?? [],
        created_at: issue.created_at ?? iso(serverTime),
        updated_at: issue.updated_at ?? iso(serverTime),
        ...(issue.pull_request ? { pull_request: issue.pull_request } : {}),
      };
      issues.set(number, created);
      return created;
    },
    editIssue: (number, patch) => {
      const i = issues.get(number);
      if (!i) throw new Error(`fake: no issue #${number}`);
      serverTime += 1000;
      Object.assign(i, patch, { updated_at: iso(serverTime) });
    },
    addRemoteComment: (issueNumber, body, login = 'remote-user') => {
      serverTime += 1000;
      const list = comments.get(issueNumber) ?? [];
      list.push({ id: ++commentCounter, body, created_at: iso(serverTime), user: { login } });
      comments.set(issueNumber, list);
      const i = issues.get(issueNumber);
      if (i) i.updated_at = iso(serverTime);
    },
    setFailMode: (mode) => { fake.failMode = mode; },
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = u.pathname;
      const query: Record<string, string> = {};
      for (const [k, v] of u.searchParams.entries()) query[k] = v;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path, query, body });

      if (fake.failMode?.kind === 'network') throw new Error('ECONNREFUSED (fake)');
      if (fake.failMode?.kind === 'http') return jsonResponse(fake.failMode.status, { message: 'forced' });

      const perPage = (key: string, dflt: number) => Number(query[key] ?? String(dflt));
      const page = perPage('page', 1);
      const per = perPage('per_page', 30);

      // GET /repos/:o/:r/issues  (delta list — `since` is >= on updated_at; PRs included)
      let m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
      if (m && method === 'GET') {
        const since = query.since ?? null;
        const all = [...issues.values()]
          .filter((i) => since === null || Date.parse(i.updated_at) >= Date.parse(since))
          .sort((a, b) => a.number - b.number);
        const start = (page - 1) * per;
        const slice = all.slice(start, start + per);
        return jsonResponse(200, slice);
      }

      // POST /repos/:o/:r/issues
      if (m && method === 'POST') {
        serverTime += 1000;
        const number = ++issueCounter;
        const issue: FakeIssue = {
          number,
          title: body.title ?? '',
          body: body.body ?? '',
          state: 'open',
          state_reason: null,
          labels: (body.labels ?? []).map((name: string) => ({ name })),
          assignees: resolveAssignees(body.assignees ?? []),
          created_at: iso(serverTime),
          updated_at: iso(serverTime),
        };
        issues.set(number, issue);
        return jsonResponse(201, issue);
      }

      // /repos/:o/:r/issues/:number
      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
      if (m) {
        const number = Number(m[3]);
        const issue = issues.get(number);
        if (!issue) return jsonResponse(404, { message: 'Not Found' });
        if (method === 'GET') return jsonResponse(200, issue);
        if (method === 'PATCH') {
          serverTime += 1000;
          if (body.title !== undefined) issue.title = body.title;
          if (body.body !== undefined) issue.body = body.body;
          if (body.labels !== undefined) {
            // PATCH labels REPLACES the whole set (GitHub semantics).
            issue.labels = (body.labels ?? []).map((name: string) => ({ name }));
          }
          if (body.assignees !== undefined) {
            // GitHub silently ignores unknown assignees — only collaborators land.
            issue.assignees = resolveAssignees(body.assignees ?? []);
          }
          if (body.state !== undefined) issue.state = body.state;
          if (body.state_reason !== undefined) issue.state_reason = body.state_reason;
          issue.updated_at = iso(serverTime);
          return jsonResponse(200, issue);
        }
      }

      // /repos/:o/:r/issues/:number/comments
      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/);
      if (m) {
        const number = Number(m[3]);
        if (!issues.has(number)) return jsonResponse(404, { message: 'Not Found' });
        if (method === 'GET') {
          const all = comments.get(number) ?? [];
          const start = (page - 1) * per;
          return jsonResponse(200, all.slice(start, start + per));
        }
        if (method === 'POST') {
          serverTime += 1000;
          const list = comments.get(number) ?? [];
          const comment: FakeIssueComment = {
            id: ++commentCounter,
            body: body.body ?? '',
            created_at: iso(serverTime),
            user: { login: 'api-user' },
          };
          list.push(comment);
          comments.set(number, list);
          const issue = issues.get(number)!;
          issue.updated_at = iso(serverTime);
          return jsonResponse(201, comment);
        }
      }

      // /repos/:o/:r/labels
      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/labels$/);
      if (m && method === 'GET') {
        const all = [...labels.values()];
        const start = (page - 1) * per;
        return jsonResponse(200, all.slice(start, start + per));
      }
      if (m && method === 'POST') {
        const name = String(body.name ?? '');
        if (labels.has(name.toLowerCase())) {
          return jsonResponse(422, { message: 'already_exists' });
        }
        const label: FakeLabel = {
          name,
          color: body.color ?? '000000',
          description: body.description ?? '',
        };
        labels.set(name.toLowerCase(), label);
        return jsonResponse(201, label);
      }

      // GET /repos/:o/:r/collaborators
      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/collaborators$/);
      if (m && method === 'GET') {
        const all = fake.collaborators;
        const start = (page - 1) * per;
        return jsonResponse(200, all.slice(start, start + per));
      }

      // GET /user/repos
      if (path === '/user/repos' && method === 'GET') {
        const all = fake.repos;
        const start = (page - 1) * per;
        return jsonResponse(200, all.slice(start, start + per));
      }

      // GET /user (connection test)
      if (path === '/user' && method === 'GET') {
        return jsonResponse(200, fake.user);
      }

      return jsonResponse(404, { message: `fake: unhandled ${method} ${path}` });
    }) as typeof fetch,
  };

  // Only collaborators can be assigned (GitHub ignores unknown logins on write).
  function resolveAssignees(logins: string[]): Array<{ login: string }> {
    const known = new Set(fake.collaborators.map((c) => c.login));
    return logins.filter((l) => known.has(l)).map((login) => ({ login }));
  }

  return fake;
}
