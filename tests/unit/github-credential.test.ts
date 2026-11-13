/**
 * The ONE GitHub credential (github-baglanti, plan r4): C1 resolver order per purpose, the
 * C2 heal for task sync (a dead per-project PAT heals onto the sign-in), per-purpose vs 401
 * demotion, a rate-limit 403 that neither retries nor demotes, the C3 flag (raised only by
 * the sign-in's own 401, fingerprint-guarded), C4 kinds, C6 never writing the ClickUp key,
 * the D7 one-line stop, and the gate: no file outside auth-store.ts reads a GitHub token.
 *
 * HOME is a temp dir for every test, so nothing here can read or write the real
 * `~/.dreamcontext/.secrets.json`. Every token is fictional.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  resolveGitHubCredential,
  writeGlobalGitHubToken,
  readGlobalGitHubNeedsReconnect,
  setGlobalGitHubAuthValid,
  reportGitHubAuthOutcome,
  tokenFingerprint,
  demoteProjectGitHubToken,
  isProjectTokenDemoted,
  projectGitHubTokenState,
  readGlobalGitHubCredential,
} from '../../src/lib/git-sync/auth-store.js';
import { GitHubAuthSession, classifyGitHubReject, githubApiAdapter } from '../../src/lib/git-sync/token-fallback.js';
import { classifySyncError, githubErrorPayload } from '../../src/lib/git-sync/failure.js';
import { writeClickUpToken, writeGitHubToken } from '../../src/lib/task-backend/secrets.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter, ApiError } from '../../src/lib/task-backend/api-adapter.js';
import { isTokenRefused, renderStaleRemoteLine } from '../../src/lib/sleep-cycle-tools.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

const DEAD_PAT = 'github_pat_fictional_dead_0001';
const SIGN_IN = 'gho_fictional_signin_0002';
const OTHER_SIGN_IN = 'gho_fictional_signin_0003';

let home: string;
let project: string;
const saved = { HOME: process.env.HOME, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-ghc-home-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-ghc-proj-')));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  process.env.HOME = home;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('C1 resolveGitHubCredential: one order for every purpose', () => {
  it('nothing anywhere = null', () => {
    expect(resolveGitHubCredential({ projectRoot: project, purpose: 'tasks', home })).toBeNull();
  });

  it('project → sign-in → env, the same for brain, tasks and browse', () => {
    process.env.GH_TOKEN = 'env_fictional_0004';
    expect(resolveGitHubCredential({ projectRoot: project, purpose: 'tasks', home })).toMatchObject({ source: 'env', via: 'GH_TOKEN' });
    writeGlobalGitHubToken(SIGN_IN, home);
    for (const purpose of ['brain', 'tasks', 'browse'] as const) {
      // A stray shell token no longer overrides the sign-in (task sync used env first).
      expect(resolveGitHubCredential({ projectRoot: project, purpose, home })).toMatchObject({ token: SIGN_IN, source: 'global' });
    }
    writeGitHubToken(project, DEAD_PAT);
    for (const purpose of ['brain', 'tasks', 'browse'] as const) {
      expect(resolveGitHubCredential({ projectRoot: project, purpose, home })).toMatchObject({ token: DEAD_PAT, source: 'project' });
    }
    // No project (the launcher): never the project slot.
    expect(resolveGitHubCredential({ purpose: 'browse', home })).toMatchObject({ source: 'global' });
  });

  it('the fingerprint is a sha256 prefix, never the token', () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    const c = resolveGitHubCredential({ purpose: 'browse', home })!;
    expect(c.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(c.fingerprint).not.toContain(SIGN_IN);
  });

  it('a 403 demotion is per purpose; a 401 demotion is for all; a new key restores priority', () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    writeGitHubToken(project, DEAD_PAT);
    demoteProjectGitHubToken(project, DEAD_PAT, 'brain');
    expect(resolveGitHubCredential({ projectRoot: project, purpose: 'brain', home })).toMatchObject({ source: 'global' });
    expect(resolveGitHubCredential({ projectRoot: project, purpose: 'tasks', home })).toMatchObject({ source: 'project' });
    demoteProjectGitHubToken(project, DEAD_PAT, 'all');
    expect(resolveGitHubCredential({ projectRoot: project, purpose: 'tasks', home })).toMatchObject({ source: 'global' });
    expect(projectGitHubTokenState(project)).toBe('demoted');
    // The file is untouched: the token is still there.
    expect(readFileSync(join(project, '_dream_context', 'state', '.secrets.json'), 'utf-8')).toContain(DEAD_PAT);
    writeGitHubToken(project, 'github_pat_fictional_new_0005');
    expect(resolveGitHubCredential({ projectRoot: project, purpose: 'tasks', home })).toMatchObject({ source: 'project' });
    expect(projectGitHubTokenState(project)).toBe('active');
  });

  it("brain sync's pre-plan demotion marker still demotes for brain only", () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    writeGitHubToken(project, DEAD_PAT);
    const sha = createHash('sha256').update(DEAD_PAT).digest('hex');
    writeFileSync(join(project, '_dream_context', 'state', '.brain-local.json'), JSON.stringify({ demotedTokenSha256: sha }));
    expect(isProjectTokenDemoted(project, DEAD_PAT, 'brain')).toBe(true);
    expect(isProjectTokenDemoted(project, DEAD_PAT, 'tasks')).toBe(false);
  });
});

describe('C3 the reconnect flag', () => {
  it('only the sign-in\'s own 401 raises it, only its success clears it', () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    const fp = tokenFingerprint(SIGN_IN);
    reportGitHubAuthOutcome({ source: 'project', fingerprint: tokenFingerprint(DEAD_PAT), kind: 'auth' }, home);
    reportGitHubAuthOutcome({ source: 'global', fingerprint: fp, kind: 'forbidden' }, home);
    reportGitHubAuthOutcome({ source: 'global', fingerprint: fp, kind: 'rate_limited' }, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(false);
    reportGitHubAuthOutcome({ source: 'global', fingerprint: fp, kind: 'auth' }, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(true);
    reportGitHubAuthOutcome({ source: 'project', fingerprint: tokenFingerprint(DEAD_PAT), kind: 'ok' }, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(true);
    reportGitHubAuthOutcome({ source: 'global', fingerprint: fp, kind: 'ok' }, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(false);
  });

  it('a late 401 about the OLD sign-in never flags a fresh one', () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    const oldFp = tokenFingerprint(SIGN_IN);
    reportGitHubAuthOutcome({ source: 'global', fingerprint: oldFp, kind: 'auth' }, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(true);
    // Reconnect: a new token is a new session, the old flag does not carry over.
    writeGlobalGitHubToken(OTHER_SIGN_IN, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(false);
    reportGitHubAuthOutcome({ source: 'global', fingerprint: oldFp, kind: 'auth' }, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(false);
  });

  it('leaves no lock file behind and keeps the secrets file 0600', () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    reportGitHubAuthOutcome({ source: 'global', fingerprint: tokenFingerprint(SIGN_IN), kind: 'auth' }, home);
    setGlobalGitHubAuthValid(true, home);
    const dir = join(home, '.dreamcontext');
    expect(readdirSync(dir).filter((f) => f.endsWith('.lock'))).toEqual([]);
    expect(statSync(join(dir, '.secrets.json')).mode & 0o777).toBe(0o600);
  });
});

describe('C2 GitHubAuthSession', () => {
  function session(initial: 'project' | 'global', opts: { global?: string | null } = {}) {
    const reports: Array<{ source: string; kind: string }> = [];
    const demotions: Array<{ scope: string }> = [];
    const g = opts.global === undefined ? SIGN_IN : opts.global;
    const cred = initial === 'project'
      ? { token: DEAD_PAT, source: 'project' as const, via: 'token', fingerprint: tokenFingerprint(DEAD_PAT) }
      : { token: SIGN_IN, source: 'global' as const, via: 'sign-in', fingerprint: tokenFingerprint(SIGN_IN) };
    const s = new GitHubAuthSession(cred, 'tasks', project, {
      readGlobalGitHubCredential: () => (g ? { token: g, source: 'global', via: 'sign-in', fingerprint: tokenFingerprint(g) } : null),
      demoteProjectGitHubToken: (_root, _token, scope) => { demotions.push({ scope }); },
      reportGitHubAuthOutcome: (o) => { reports.push({ source: o.source, kind: o.kind }); },
    });
    return { s, reports, demotions };
  }

  it('a 401 on the project token swaps to the sign-in and demotes it for all purposes', () => {
    const { s, demotions, reports } = session('project');
    expect(s.handleReject('auth')).toBe(true);
    expect(s.token).toBe(SIGN_IN);
    // Demoted only once the sign-in actually worked.
    expect(demotions).toEqual([]);
    s.noteSuccess();
    expect(demotions).toEqual([{ scope: 'all' }]);
    expect(s.healedStaleProjectToken).toBe(true);
    expect(reports).toEqual([{ source: 'global', kind: 'ok' }]);
  });

  it('a 403 demotes for this purpose only', () => {
    const { s, demotions } = session('project');
    expect(s.handleReject('forbidden')).toBe(true);
    s.noteSuccess();
    expect(demotions).toEqual([{ scope: 'tasks' }]);
  });

  it('a rate limit neither retries on another token nor demotes', () => {
    const { s, demotions } = session('project');
    expect(s.handleReject('rate_limited')).toBe(false);
    expect(s.token).toBe(DEAD_PAT);
    expect(demotions).toEqual([]);
    expect(s.authDead).toBe(false);
  });

  it('both dead: the retry\'s own 401 reaches the flag writer as the sign-in, and the run is dead', () => {
    const { s, reports, demotions } = session('project');
    expect(s.handleReject('auth')).toBe(true);
    s.handleRetryReject('auth');
    expect(reports).toEqual([{ source: 'global', kind: 'auth' }]);
    expect(s.authDead).toBe(true);
    // Nothing demoted, the run keeps its own token.
    expect(demotions).toEqual([]);
    expect(s.token).toBe(DEAD_PAT);
    // One attempt per run: never a loop.
    expect(s.handleReject('auth')).toBe(false);
  });

  it('the sign-in failing on its own is reported and stops the run; no sign-in = no fallback', () => {
    const a = session('global');
    expect(a.s.handleReject('auth')).toBe(false);
    expect(a.reports).toEqual([{ source: 'global', kind: 'auth' }]);
    expect(a.s.authDead).toBe(true);
    const b = session('project', { global: null });
    expect(b.s.handleReject('auth')).toBe(false);
    expect(b.demotions).toEqual([]);
  });
});

describe('C4 classification (GitHub only)', () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it('401 = auth; 403 with the limit spent, retry-after or a limit body = rate_limited; other 403 = forbidden', () => {
    expect(classifyGitHubReject(401, h(), '{"message":"Bad credentials"}')?.kind).toBe('auth');
    expect(classifyGitHubReject(403, h({ 'x-ratelimit-remaining': '0' }), '')?.kind).toBe('rate_limited');
    expect(classifyGitHubReject(403, h({ 'retry-after': '30' }), '')).toEqual({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(classifyGitHubReject(403, h(), '{"message":"You have exceeded a secondary rate limit"}')?.kind).toBe('rate_limited');
    expect(classifyGitHubReject(403, h(), '{"message":"Resource protected by organization SAML enforcement."}')?.kind).toBe('forbidden');
  });

  it('git: askpass not running is `helper`, never "sign-in expired"', () => {
    const f = classifySyncError("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    expect(f.kind).toBe('helper');
    expect(f.message).not.toMatch(/expired/i);
    expect(classifySyncError('remote: Invalid username or password.\nfatal: Authentication failed').kind).toBe('auth');
    expect(classifySyncError('remote: API rate limit exceeded').kind).toBe('rate_limited');
  });

  // End review r1 (class github-403-read-as-dead-sign-in): the launcher's repo search built its
  // own adapter, so an SSO 403 came back as `auth` and raised the reconnect flag.
  it('every GitHub client reads a 403 through the classifier: SSO = forbidden, a spent limit backs off, only 401 = auth', async () => {
    const saml = (async () => new Response('{"message":"Resource protected by organization SAML enforcement."}', { status: 403 })) as typeof fetch;
    await expect(githubApiAdapter({ authHeaders: () => ({}), fetchImpl: saml, maxRetries: 0 }).request('GET', '/repos/acme/x'))
      .rejects.toMatchObject({ kind: 'forbidden' });
    let calls = 0;
    const limited = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '0.01' } })
        : new Response('[]', { status: 200 });
    }) as typeof fetch;
    await expect(githubApiAdapter({ authHeaders: () => ({}), fetchImpl: limited }).request('GET', '/user/repos')).resolves.toEqual([]);
    expect(calls).toBe(2);
    const dead = (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof fetch;
    await expect(githubApiAdapter({ authHeaders: () => ({}), fetchImpl: dead, maxRetries: 0 }).request('GET', '/user'))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('the launcher reports to the reconnect flag only on `auth`; a 403 answers its own kind', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'server', 'routes', 'launcher.ts'), 'utf-8');
    const at = src.indexOf('export async function handleLauncherGithubRepos');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body.match(/reportGitHubAuthOutcome\(/g)?.length).toBe(2); // ok + auth
    expect(body).toMatch(/err\.kind === 'auth'\) \{\s*\/\/ C3/);
    expect(body).toContain("err.kind === 'forbidden' || err.kind === 'rate_limited'");
  });

  it('a non-GitHub adapter keeps every 401/403 as auth (ClickUp unchanged)', async () => {
    const fetchImpl = (async () => new Response('{"err":"no"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) as typeof fetch;
    const api = new ApiAdapter({ baseUrl: 'https://api.clickup.example', authHeaders: () => ({}), fetchImpl, maxRetries: 0 });
    await expect(api.request('GET', '/x')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('C5: reconnect only for the sign-in\'s 401 or no sign-in at all', () => {
    expect(githubErrorPayload('auth', 'global').reconnect).toBe(true);
    expect(githubErrorPayload('no_token').reconnect).toBe(true);
    expect(githubErrorPayload('auth', 'project').reconnect).toBe(false);
    expect(githubErrorPayload('forbidden', 'global').reconnect).toBe(false);
    expect(githubErrorPayload('rate_limited').reconnect).toBe(false);
    expect(githubErrorPayload('auth', 'global').message).toContain('Settings → GitHub → Reconnect');
  });
});

describe('criterion 1: task sync heals a dead project PAT onto the sign-in', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true,
    taskBackend: 'github', cloudTaskManagement: true,
    github: { owner: 'acme-fictional', repo: 'board', changelogTarget: 'comments' },
  } as SetupConfig;

  /** The fake GitHub, behind a credential check: only `good` tokens get through. */
  function guarded(fake: FakeGitHub, good: Set<string>, opts: { rateLimitOnce?: boolean } = {}) {
    const seen: string[] = [];
    let limited = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      const token = auth.replace(/^Bearer /, '');
      seen.push(token);
      if (!good.has(token)) return new Response('{"message":"Bad credentials"}', { status: 401 });
      if (opts.rateLimitOnce && !limited && init?.method === 'POST') {
        limited = true;
        return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '1' } });
      }
      return fake.fetchImpl(url as string, init);
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  function backend(fetchImpl: typeof fetch, reports: Array<{ source: string; kind: string }>) {
    let clock = 1000;
    return new GitHubTaskBackend(join(project, '_dream_context'), CONFIG, {
      fetchImpl,
      now: () => (clock += 7),
      sleep: async () => { clock += 1; },
      authSessionDeps: { reportGitHubAuthOutcome: (o) => { reports.push({ source: o.source, kind: o.kind }); } },
    });
  }

  it('dead PAT + valid sign-in: the queue drains, the PAT is marked dead (file untouched), no duplicate on re-run', async () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    writeGitHubToken(project, DEAD_PAT);
    const fake = makeFakeGitHub();
    const { fetchImpl } = guarded(fake, new Set([SIGN_IN]));
    const reports: Array<{ source: string; kind: string }> = [];
    const b = backend(fetchImpl, reports);
    await b.create({ name: 'Heal One', variant: 'cli' });
    await b.create({ name: 'Heal Two', variant: 'cli' });

    const report = await b.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(2);
    expect(fake.issues.size).toBe(2);
    expect(isProjectTokenDemoted(project, DEAD_PAT, 'tasks')).toBe(true);
    expect(isProjectTokenDemoted(project, DEAD_PAT, 'brain')).toBe(true);
    expect(readFileSync(join(project, '_dream_context', 'state', '.secrets.json'), 'utf-8')).toContain(DEAD_PAT);
    expect(reports.some((r) => r.source === 'global' && r.kind === 'ok')).toBe(true);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(false);

    // A fresh run resolves straight to the sign-in and replays nothing twice.
    const again = backend(fetchImpl, []);
    const second = await again.sync('push');
    expect(second.errors).toEqual([]);
    expect(fake.issues.size).toBe(2);
  });

  it('a rate-limit 403 mid-drain backs off and keeps the token: no switch, no demotion', async () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    writeGitHubToken(project, DEAD_PAT);
    const fake = makeFakeGitHub();
    // Here the PROJECT token is the good one: a rate limit must not move off it.
    const { fetchImpl, seen } = guarded(fake, new Set([DEAD_PAT]), { rateLimitOnce: true });
    const b = backend(fetchImpl, []);
    await b.create({ name: 'Limited', variant: 'cli' });
    const report = await b.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(1);
    expect(seen.every((t) => t === DEAD_PAT)).toBe(true);
    expect(isProjectTokenDemoted(project, DEAD_PAT, 'tasks')).toBe(false);
  });

  it('criteria 3+7: both dead: the flag rises, the run stops after the first refusal, one line names the fix', async () => {
    writeGlobalGitHubToken(SIGN_IN, home);
    writeGitHubToken(project, DEAD_PAT);
    const fake = makeFakeGitHub();
    const { fetchImpl, seen } = guarded(fake, new Set());
    let clock = 1000;
    const b = new GitHubTaskBackend(join(project, '_dream_context'), CONFIG, {
      fetchImpl, now: () => (clock += 7), sleep: async () => { clock += 1; },
    });
    for (let i = 0; i < 12; i++) await b.create({ name: `Stuck ${i}`, variant: 'cli' });
    const report = await b.sync('push');
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(true);
    // One refusal per token, then nothing more is sent.
    expect(seen.length).toBeLessThanOrEqual(4);
    expect(isTokenRefused(report)).toBe(true);
    expect(report.errors.length).toBeLessThanOrEqual(2);
    const line = renderStaleRemoteLine({ ops: 12, tasks: 12, oldest: '2026-11-01' }, 'github');
    expect(line).toContain('Settings → GitHub → Reconnect');
    expect(line).not.toMatch(/dreamcontext (config|tasks)|token, then/);
    // It names the credential GitHub refused (task criterion 1, end review r1 Minor).
    expect(line).toContain('your GitHub sign-in');
    expect(renderStaleRemoteLine({ ops: 1, tasks: 1, oldest: null }, 'github', 'project')).toContain("this project's own GitHub token");
    expect(renderStaleRemoteLine({ ops: 1, tasks: 1, oldest: null }, 'github', 'env')).toContain('the GitHub token set outside the app');
  });
});

describe('C6: the per-project token never touches the ClickUp key', () => {
  it('writeGitHubToken keeps the clickup block intact', () => {
    writeClickUpToken(project, 'pk_fictional_clickup_0006');
    writeGitHubToken(project, DEAD_PAT);
    const parsed = JSON.parse(readFileSync(join(project, '_dream_context', 'state', '.secrets.json'), 'utf-8'));
    expect(parsed.clickup.token).toBe('pk_fictional_clickup_0006');
    expect(parsed.github.token).toBe(DEAD_PAT);
  });

  it('the global credential reader returns the sign-in only', () => {
    expect(readGlobalGitHubCredential(home)).toBeNull();
    writeGlobalGitHubToken(SIGN_IN, home);
    expect(readGlobalGitHubCredential(home)).toMatchObject({ source: 'global', token: SIGN_IN });
  });
});

describe('gate: no file outside auth-store.ts reads a GitHub token', () => {
  it('nobody else reads GITHUB_TOKEN/GH_TOKEN or the github.token slot', () => {
    const root = join(__dirname, '..', '..', 'src');
    const allow = new Set([
      'lib/git-sync/auth-store.ts',
      // Strips the env for `gh` so it uses its own store: removes, never reads.
      'lib/onboarding/fixes.ts',
      // The per-project secrets WRITER (gitignore-first); it has no GitHub reader.
      'lib/task-backend/secrets.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'vendor' || name === 'node_modules') continue;
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        const rel = relative(root, p).split('\\').join('/');
        if (allow.has(rel)) continue;
        const src = readFileSync(p, 'utf-8');
        if (/env\[['"]?(GITHUB_TOKEN|GH_TOKEN)|process\.env\.(GITHUB_TOKEN|GH_TOKEN)|\[\s*'GITHUB_TOKEN'\s*,\s*'GH_TOKEN'\s*\]/.test(src)) offenders.push(rel);
        if (/\.github\?*\.token\b/.test(src)) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('nobody builds a GitHub REST client by hand: githubApiAdapter is the one way (403s classified)', () => {
    const root = join(__dirname, '..', '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'vendor' || name === 'node_modules') continue;
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        const rel = relative(root, p).split('\\').join('/');
        if (rel === 'lib/git-sync/token-fallback.ts') continue;
        const src = readFileSync(p, 'utf-8');
        if (/new ApiAdapter\(\{[\s\S]{0,200}?api\.github\.com/.test(src)) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('ApiError keeps its kinds (forbidden added)', () => {
    expect(new ApiError('forbidden', 'x', 403).kind).toBe('forbidden');
  });
});
