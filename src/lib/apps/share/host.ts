/**
 * Where shared apps live (paylasilan-app-ler plan r3). Two hosts behind one interface:
 *
 * - `github`: the real one. The signed-in account's token (the launcher's global sign-in, then
 *   GITHUB_TOKEN/GH_TOKEN), or anonymous for a public install. Git runs with the askpass helper,
 *   the token never in argv, env or a URL.
 * - `local`: a folder of bare repos (`<dir>/<owner>/<repo>.git` + `<repo>.json` for the metadata
 *   GitHub would hold). Only when `DREAMCONTEXT_APPS_LOCAL_HOST` names that folder: tests and the
 *   end-to-end trial on this Mac, so nothing reaches GitHub. `DREAMCONTEXT_APPS_LOCAL_LOGIN` is
 *   the "signed-in" account there.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ApiAdapter, ApiError } from '../../task-backend/api-adapter.js';
import { resolveLauncherGitHubToken } from '../../git-sync/github-browse.js';
import { withGitCredentials } from '../../git-sync/credentials.js';
import { initHardRepo, installedGit } from './installed-git.js';

export const APP_TOPIC = 'dreamcontext-app';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface RepoInfo {
  fullName: string;
  owner: string;
  repoId: string;
  ownerId: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string | null;
  pushedAt: string | null;
  description: string | null;
  topics: string[];
}

export interface HostUser {
  login: string;
  id: string;
  createdAt: string | null;
}

export interface Invitation {
  id: string;
  fullName: string;
  inviter: string;
}

export class HostError extends Error {
  constructor(public code: 'not_signed_in' | 'not_found' | 'no_access' | 'rate_limited' | 'exists' | 'bad_name' | 'host_error', message: string) { super(message); }
}

export interface AppHost {
  kind: 'github' | 'local';
  signedIn: boolean;
  me(): Promise<HostUser>;
  user(login: string): Promise<HostUser | null>;
  getRepo(fullName: string): Promise<RepoInfo | null>;
  createRepo(name: string, opts: { private: boolean; description: string }): Promise<RepoInfo>;
  setTopics(fullName: string, topics: string[]): Promise<void>;
  setVisibility(fullName: string, isPublic: boolean): Promise<void>;
  addCollaborator(fullName: string, login: string): Promise<void>;
  listAppRepos(): Promise<RepoInfo[]>;
  listInvitations(): Promise<Invitation[]>;
  acceptInvitation(id: string): Promise<void>;
  getFile(fullName: string, path: string): Promise<string | null>;
  /** The URL git uses: always derived from a validated fullName, never from user text. */
  cloneUrl(fullName: string): string;
  allowFile: boolean;
  /** Run git with this host's credentials (none for an anonymous host). */
  withGit<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T> | T): Promise<T>;
  /** The noreply commit identity of the signed-in account. */
  identity(user: HostUser): { name: string; email: string };
}

export function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo, extra] = fullName.split('/');
  if (extra !== undefined || !owner || !repo || !NAME_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') throw new HostError('bad_name', `"${fullName}" is not owner/repo`);
  return { owner, repo };
}

// ─── GitHub ──────────────────────────────────────────────────────────────────────────

interface GhRepo {
  id: number; full_name: string; private: boolean; default_branch?: string; created_at?: string; pushed_at?: string;
  description?: string | null; topics?: string[]; owner: { id: number; login: string };
}

function ghInfo(r: GhRepo): RepoInfo {
  return {
    fullName: r.full_name, owner: r.owner.login, repoId: String(r.id), ownerId: String(r.owner.id), private: r.private,
    defaultBranch: r.default_branch ?? 'main', createdAt: r.created_at ?? null, pushedAt: r.pushed_at ?? null,
    description: r.description ?? null, topics: r.topics ?? [],
  };
}

export class GitHubHost implements AppHost {
  kind = 'github' as const;
  allowFile = false;
  private api: ApiAdapter;
  constructor(private token: string | null, adapter?: ApiAdapter) {
    this.api = adapter ?? new ApiAdapter({
      baseUrl: 'https://api.github.com',
      authHeaders: (): Record<string, string> => (token ? { Authorization: `token ${token}` } : {}),
    });
  }
  get signedIn(): boolean { return !!this.token; }

  private async req<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts?: { query?: Record<string, string | number>; body?: unknown }): Promise<T> {
    try {
      return await this.api.request<T>(method, path, opts as never);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.kind === 'not_found') throw new HostError('not_found', 'not found (or no access)');
        if (e.kind === 'auth') throw new HostError(this.token ? 'no_access' : 'not_signed_in', this.token ? 'GitHub refused the request. Sign in again in Settings → GitHub.' : 'sign in with GitHub first (Settings → GitHub)');
        if (e.kind === 'rate_limited') throw new HostError('rate_limited', 'GitHub rate limit reached; try again later');
        if (e.kind === 'invalid' && /already exists/i.test(e.message)) throw new HostError('exists', 'that repo already exists');
      }
      throw new HostError('host_error', (e as Error).message);
    }
  }
  private need(): void { if (!this.token) throw new HostError('not_signed_in', 'Sign in with GitHub first (Settings → GitHub).'); }

  async me(): Promise<HostUser> {
    this.need();
    const u = await this.req<{ login: string; id: number; created_at?: string }>('GET', '/user');
    return { login: u.login, id: String(u.id), createdAt: u.created_at ?? null };
  }
  async user(login: string): Promise<HostUser | null> {
    if (!NAME_RE.test(login)) return null;
    try { const u = await this.req<{ login: string; id: number; created_at?: string }>('GET', `/users/${login}`); return { login: u.login, id: String(u.id), createdAt: u.created_at ?? null }; } catch { return null; }
  }
  async getRepo(fullName: string): Promise<RepoInfo | null> {
    const { owner, repo } = splitFullName(fullName);
    try { return ghInfo(await this.req<GhRepo>('GET', `/repos/${owner}/${repo}`)); } catch (e) { if (e instanceof HostError && e.code === 'not_found') return null; throw e; }
  }
  async createRepo(name: string, opts: { private: boolean; description: string }): Promise<RepoInfo> {
    this.need();
    if (!REPO_RE.test(name)) throw new HostError('bad_name', `"${name}" is not a repo name`);
    return ghInfo(await this.req<GhRepo>('POST', '/user/repos', { body: { name, private: opts.private, description: opts.description.slice(0, 300), auto_init: false, has_issues: false, has_wiki: false, has_projects: false } }));
  }
  async setTopics(fullName: string, topics: string[]): Promise<void> {
    const { owner, repo } = splitFullName(fullName);
    await this.req('PUT', `/repos/${owner}/${repo}/topics`, { body: { names: topics } });
  }
  async setVisibility(fullName: string, isPublic: boolean): Promise<void> {
    const { owner, repo } = splitFullName(fullName);
    await this.req('PATCH', `/repos/${owner}/${repo}`, { body: { private: !isPublic } });
  }
  async addCollaborator(fullName: string, login: string): Promise<void> {
    const { owner, repo } = splitFullName(fullName);
    if (!NAME_RE.test(login)) throw new HostError('bad_name', `"${login}" is not a GitHub login`);
    await this.req('PUT', `/repos/${owner}/${repo}/collaborators/${login}`, { body: { permission: 'pull' } });
  }
  async listAppRepos(): Promise<RepoInfo[]> {
    this.need();
    const all: GhRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.req<GhRepo[]>('GET', '/user/repos', { query: { per_page: 100, page, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' } });
      all.push(...(batch ?? []));
      if (!batch || batch.length < 100) break;
    }
    return all.filter((r) => (r.topics ?? []).includes(APP_TOPIC)).map(ghInfo);
  }
  async listInvitations(): Promise<Invitation[]> {
    this.need();
    const rows = await this.req<Array<{ id: number; repository: { full_name: string }; inviter?: { login: string } }>>('GET', '/user/repository_invitations');
    return (rows ?? []).map((r) => ({ id: String(r.id), fullName: r.repository.full_name, inviter: r.inviter?.login ?? '' }));
  }
  async acceptInvitation(id: string): Promise<void> {
    this.need();
    if (!/^\d{1,20}$/.test(id)) throw new HostError('bad_name', 'bad invitation id');
    await this.req('PATCH', `/user/repository_invitations/${id}`);
  }
  async getFile(fullName: string, path: string): Promise<string | null> {
    const { owner, repo } = splitFullName(fullName);
    try {
      const r = await this.req<{ content?: string; encoding?: string; size?: number }>('GET', `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
      if (!r.content || r.encoding !== 'base64' || (r.size ?? 0) > 64 * 1024) return null;
      return Buffer.from(r.content, 'base64').toString('utf-8');
    } catch (e) { if (e instanceof HostError && e.code === 'not_found') return null; throw e; }
  }
  cloneUrl(fullName: string): string {
    const { owner, repo } = splitFullName(fullName);
    return `https://github.com/${owner}/${repo}.git`;
  }
  async withGit<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T> | T): Promise<T> {
    if (!this.token) return fn({});
    return withGitCredentials(this.token, (env) => fn({ GIT_ASKPASS: env.GIT_ASKPASS, DREAMCONTEXT_ASKPASS_TOKEN_FILE: env.DREAMCONTEXT_ASKPASS_TOKEN_FILE, PATH: env.PATH }));
  }
  identity(user: HostUser): { name: string; email: string } {
    return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
  }
}

// ─── Local (tests and the on-Mac trial) ─────────────────────────────────────────────

interface LocalMeta {
  id: string;
  ownerId: string;
  private: boolean;
  topics: string[];
  collaborators: string[];
  invitations: Array<{ id: string; login: string; inviter: string }>;
  createdAt: string;
  description: string;
}

export class LocalHost implements AppHost {
  kind = 'local' as const;
  allowFile = true;
  signedIn: boolean;
  constructor(private dir: string, private login: string | null) {
    if (!isAbsolute(dir)) throw new HostError('host_error', 'the local app host must be an absolute folder');
    this.signedIn = !!login;
  }
  private metaPath(owner: string, repo: string): string { return join(this.dir, owner, `${repo}.json`); }
  gitDirOf(fullName: string): string { const { owner, repo } = splitFullName(fullName); return join(this.dir, owner, `${repo}.git`); }
  private readMeta(owner: string, repo: string): LocalMeta | null {
    try { return JSON.parse(readFileSync(this.metaPath(owner, repo), 'utf-8')) as LocalMeta; } catch { return null; }
  }
  private writeMeta(owner: string, repo: string, m: LocalMeta): void { writeFileSync(this.metaPath(owner, repo), JSON.stringify(m, null, 2)); }
  private canRead(owner: string, m: LocalMeta): boolean {
    return !m.private || (!!this.login && (owner === this.login || m.collaborators.includes(this.login)));
  }
  private info(owner: string, repo: string, m: LocalMeta): RepoInfo {
    let pushedAt: string | null = null;
    try { pushedAt = lstatSync(join(this.gitDirOf(`${owner}/${repo}`), 'refs', 'heads', 'main')).mtime.toISOString(); } catch { /* empty repo */ }
    return { fullName: `${owner}/${repo}`, owner, repoId: m.id, ownerId: m.ownerId, private: m.private, defaultBranch: 'main', createdAt: m.createdAt, pushedAt, description: m.description, topics: m.topics };
  }
  private need(): string { if (!this.login) throw new HostError('not_signed_in', 'no local login'); return this.login; }

  async me(): Promise<HostUser> { const l = this.need(); return { login: l, id: `local-${l}`, createdAt: null }; }
  async user(login: string): Promise<HostUser | null> { return NAME_RE.test(login) ? { login, id: `local-${login}`, createdAt: null } : null; }
  async getRepo(fullName: string): Promise<RepoInfo | null> {
    const { owner, repo } = splitFullName(fullName);
    const m = this.readMeta(owner, repo);
    return m && this.canRead(owner, m) ? this.info(owner, repo, m) : null;
  }
  async createRepo(name: string, opts: { private: boolean; description: string }): Promise<RepoInfo> {
    const owner = this.need();
    if (!REPO_RE.test(name)) throw new HostError('bad_name', `"${name}" is not a repo name`);
    if (this.readMeta(owner, name)) throw new HostError('exists', `${owner}/${name} already exists`);
    mkdirSync(join(this.dir, owner), { recursive: true });
    initHardRepo(this.gitDirOf(`${owner}/${name}`), true);
    const m: LocalMeta = { id: randomBytes(6).toString('hex'), ownerId: `local-${owner}`, private: opts.private, topics: [], collaborators: [], invitations: [], createdAt: new Date().toISOString(), description: opts.description };
    this.writeMeta(owner, name, m);
    return this.info(owner, name, m);
  }
  private own(fullName: string): { owner: string; repo: string; m: LocalMeta } {
    const { owner, repo } = splitFullName(fullName);
    const m = this.readMeta(owner, repo);
    if (!m) throw new HostError('not_found', 'not found');
    if (owner !== this.need()) throw new HostError('no_access', 'not yours');
    return { owner, repo, m };
  }
  async setTopics(fullName: string, topics: string[]): Promise<void> { const o = this.own(fullName); o.m.topics = topics; this.writeMeta(o.owner, o.repo, o.m); }
  async setVisibility(fullName: string, isPublic: boolean): Promise<void> { const o = this.own(fullName); o.m.private = !isPublic; this.writeMeta(o.owner, o.repo, o.m); }
  async addCollaborator(fullName: string, login: string): Promise<void> {
    const o = this.own(fullName);
    if (!NAME_RE.test(login)) throw new HostError('bad_name', 'bad login');
    if (!o.m.collaborators.includes(login) && !o.m.invitations.some((i) => i.login === login)) o.m.invitations.push({ id: String(Date.now() % 1e9 + o.m.invitations.length), login, inviter: o.owner });
    this.writeMeta(o.owner, o.repo, o.m);
  }
  private *all(): Generator<{ owner: string; repo: string; m: LocalMeta }> {
    if (!existsSync(this.dir)) return;
    for (const owner of readdirSync(this.dir)) {
      if (!NAME_RE.test(owner)) continue;
      let names: string[] = [];
      try { names = readdirSync(join(this.dir, owner)); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.json')) continue;
        const repo = f.slice(0, -5);
        const m = this.readMeta(owner, repo);
        if (m) yield { owner, repo, m };
      }
    }
  }
  async listAppRepos(): Promise<RepoInfo[]> {
    const me = this.need();
    const out: RepoInfo[] = [];
    for (const { owner, repo, m } of this.all()) if ((owner === me || m.collaborators.includes(me)) && m.topics.includes(APP_TOPIC)) out.push(this.info(owner, repo, m));
    return out;
  }
  async listInvitations(): Promise<Invitation[]> {
    const me = this.need();
    const out: Invitation[] = [];
    for (const { owner, repo, m } of this.all()) for (const i of m.invitations) if (i.login === me) out.push({ id: i.id, fullName: `${owner}/${repo}`, inviter: i.inviter });
    return out;
  }
  async acceptInvitation(id: string): Promise<void> {
    const me = this.need();
    for (const { owner, repo, m } of this.all()) {
      const i = m.invitations.find((x) => x.id === id && x.login === me);
      if (!i) continue;
      m.invitations = m.invitations.filter((x) => x !== i);
      if (!m.collaborators.includes(me)) m.collaborators.push(me);
      this.writeMeta(owner, repo, m);
      return;
    }
    throw new HostError('not_found', 'no such invitation');
  }
  async getFile(fullName: string, path: string): Promise<string | null> {
    if (!(await this.getRepo(fullName))) return null;
    try { return installedGit(this.gitDirOf(fullName), ['show', `main:${path}`]); } catch { return null; }
  }
  cloneUrl(fullName: string): string { return `file://${this.gitDirOf(fullName)}`; }
  async withGit<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T> | T): Promise<T> { return fn({}); }
  identity(user: HostUser): { name: string; email: string } { return { name: user.login, email: `0+${user.login}@users.noreply.github.com` }; }
}

/** The host for this process: the local test host when the env names one, else GitHub. */
export function resolveAppHost(home: string = homedir(), opts: { anonymous?: boolean } = {}): AppHost {
  const local = process.env.DREAMCONTEXT_APPS_LOCAL_HOST;
  if (local && local.trim()) return new LocalHost(resolve(local.trim()), opts.anonymous ? null : (process.env.DREAMCONTEXT_APPS_LOCAL_LOGIN?.trim() || null));
  if (opts.anonymous) return new GitHubHost(null);
  return new GitHubHost(resolveLauncherGitHubToken(home)?.token ?? null);
}

/** Read a repo reference the owner typed: `https://github.com/o/r`, `github.com/o/r`, `o/r`. */
export function parseAppRepoRef(text: string): string | null {
  const t = text.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)$/i.exec(t) ?? /^([^/\s:]+)\/([^/\s:]+)$/.exec(t);
  if (!m) return null;
  try { splitFullName(`${m[1]}/${m[2]}`); return `${m[1]}/${m[2]}`; } catch { return null; }
}
