import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResolvedToken } from '../task-backend/secrets.js';
import { readBrainLocal, writeBrainLocal } from '../setup-config.js';
import { withFileLockSync } from '../file-lock.js';

/**
 * GLOBAL GitHub auth store — `~/.dreamcontext/.secrets.json` (mode 0600).
 *
 * This is the account a collaborator "signs into dreamcontext" as, from the
 * launcher/dashboard (device flow or a pasted PAT). It sits in the MIDDLE of
 * `resolveBrainSyncToken`'s tier order: per-project → **global** → env. A
 * per-project stored token still wins (an explicit project override), and a
 * stray `GITHUB_TOKEN` in some inherited shell must NOT override the account
 * the user is actually logged in as.
 *
 * The token is a secret: it is NEVER logged and NEVER returned in any HTTP
 * response body. The file is created 0600 mode-on-create (`writeFileSync
 * { mode: 0o600 }`) with a belt-and-suspenders `chmodSync` on rewrite —
 * mirroring `secrets.ts` and `credentials.ts` (mode-on-create doesn't apply on
 * every filesystem, and only applies on create).
 */

interface GlobalSecretsFile {
  github?: {
    /** The signed-in account's token. */
    token?: string;
    /** The signed-in account's login — cached so `status` needs no network call. NOT a secret. */
    login?: string;
    /**
     * Set when the LAST real git op authenticated with this token was rejected
     * for auth (expired/revoked/invalid) — the SINGLE source of truth both the
     * sidebar sync surface and the Settings session chip read, so they can never
     * disagree ("Sync failed / sign-in expired" over a green "Signed in as …").
     * Cleared the moment a git op authenticates successfully or a fresh token is
     * stored. NOT a secret.
     */
    needsReconnect?: boolean;
  };
}

/** Thrown when the secrets file (or its folder) is a symlink: a token is never written through one. */
export class SecretsPathError extends Error {
  constructor(path: string) {
    super(`Refusing to write GitHub credentials through a symlink: ${path}`);
    this.name = 'SecretsPathError';
  }
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * Write the secrets file 0600. A symlinked `.secrets.json` (or `~/.dreamcontext`) is
 * refused: following it would hand the token to whatever file the link names.
 */
function writeSecretsFile(path: string, secrets: GlobalSecretsFile): void {
  if (isSymlink(dirname(path)) || isSymlink(path)) throw new SecretsPathError(path);
  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on exotic filesystems */ }
}

/** `~/.dreamcontext/.secrets.json` — the per-machine, cross-project auth store. */
export function globalSecretsPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', '.secrets.json');
}

function readGlobalSecretsFile(home?: string): GlobalSecretsFile {
  const path = globalSecretsPath(home);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as GlobalSecretsFile;
  } catch {
    return {};
  }
}

/**
 * Persist the signed-in GitHub token to the global store. Creates
 * `~/.dreamcontext/` if needed. NEVER logs the token.
 */
export function writeGlobalGitHubToken(token: string, home?: string): void {
  if (!token || !token.trim()) {
    throw new Error('Token must be a non-empty string.');
  }
  const path = globalSecretsPath(home);
  mkdirSync(dirname(path), { recursive: true });

  // Under the same lock as reportGitHubAuthOutcome (C3): a late 401 from the OLD token can
  // never land between this write and its flag clear.
  withGlobalSecretsLock(home, () => {
    const secrets = readGlobalSecretsFile(home);
    // A new token is a new session: an old flag never carries over to it.
    const { needsReconnect: _old, ...rest } = secrets.github ?? {};
    secrets.github = { ...rest, token: token.trim() };
    // 0600 mode-on-create; belt-and-suspenders chmod for the rewrite path.
    writeSecretsFile(path, secrets);
  });
}

/**
 * Read the global GitHub token, or null if none is stored. `source` is
 * `'secrets'` (reusing the ClickUp/GitHub secrets convention); `via` is
 * `'global'` so `config show` can distinguish it from the per-project slot.
 */
export function readGlobalGitHubToken(home?: string): ResolvedToken | null {
  const v = readGlobalSecretsFile(home).github?.token;
  if (v && v.trim()) return { token: v.trim(), source: 'secrets', via: 'global' };
  return null;
}

/**
 * Cache the signed-in login alongside the token so `status` can report it with
 * zero network calls. Merges into the existing github block (preserving the
 * token). No-op friendly — safe to call right after `writeGlobalGitHubToken`.
 */
export function setGlobalGitHubLogin(login: string, home?: string): void {
  const path = globalSecretsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const secrets = readGlobalSecretsFile(home);
  secrets.github = { ...(secrets.github ?? {}), login: login.trim() || undefined };
  writeSecretsFile(path, secrets);
}

/** Read the cached signed-in login, or null. */
export function readGlobalGitHubLogin(home?: string): string | null {
  const v = readGlobalSecretsFile(home).github?.login;
  return v && v.trim() ? v.trim() : null;
}

/**
 * Whether the signed-in GitHub session is currently known to be INVALID — the
 * last authenticated git op was rejected for auth. Only meaningful when a token
 * is actually stored (a never-connected account cannot "need reconnect"), so it
 * returns false when there is no token.
 */
export function readGlobalGitHubNeedsReconnect(home?: string): boolean {
  const gh = readGlobalSecretsFile(home).github;
  return !!(gh?.token && gh.token.trim() && gh.needsReconnect === true);
}

/**
 * Record whether the stored token just authenticated successfully. `valid:false`
 * flags the session as needing a reconnect (an auth-rejected git op); `valid:true`
 * clears that flag (a git op authenticated, or a fresh token was stored). This is
 * the ONE writer both surfaces trust — the sync path calls it off the ACTUAL git
 * result, never a standalone token guess. No-ops (no write) when the flag is
 * already in the target state, and never marks-invalid when no token is stored.
 */
export function setGlobalGitHubAuthValid(valid: boolean, home?: string): void {
  withGlobalSecretsLock(home, () => setAuthValidUnlocked(valid, home));
}

function setAuthValidUnlocked(valid: boolean, home?: string): void {
  const secrets = readGlobalSecretsFile(home);
  const gh = secrets.github;
  // No token ⇒ nothing to invalidate/validate; the disconnected UI already covers it.
  if (!gh?.token || !gh.token.trim()) return;
  const current = gh.needsReconnect === true;
  const next = !valid;
  if (current === next) return; // idempotent — avoid rewriting the 0600 file every sync
  if (next) gh.needsReconnect = true;
  else delete gh.needsReconnect;

  const path = globalSecretsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeSecretsFile(path, secrets);
}

/** Clear the global GitHub token + login (logout). Idempotent — a missing file is a no-op. */
export function clearGlobalGitHubToken(home?: string): void {
  const path = globalSecretsPath(home);
  if (!existsSync(path)) return;
  withGlobalSecretsLock(home, () => {
    const secrets = readGlobalSecretsFile(home);
    if (secrets.github) { delete secrets.github.token; delete secrets.github.login; delete secrets.github.needsReconnect; }
    writeSecretsFile(path, secrets);
  });
}

function withGlobalSecretsLock<T>(home: string | undefined, fn: () => T): T {
  const lock = `${globalSecretsPath(home)}.lock`;
  if (isSymlink(dirname(lock))) throw new SecretsPathError(lock);
  // failOpen: a flag write must never fail a sync; the fingerprint check in C3 still guards.
  return withFileLockSync(lock, fn, { waitMs: 2_000, staleMs: 10_000, failOpen: true });
}

// ─── The ONE GitHub credential (github-baglanti C1-C3) ──────────────────────

/**
 * What a credential is used for. `brain` = brain/cloud sync against the project's origin,
 * `tasks` = the GitHub Issues task backend, `browse` = the launcher, app sharing, repo
 * visibility, linked repos. A per-project token demoted for one purpose still serves the others.
 */
export type GitHubPurpose = 'brain' | 'tasks' | 'browse';

export interface GitHubCredential {
  token: string;
  /** `project` = this project's `github.token`, `global` = the app's sign-in, `env` = GITHUB_TOKEN/GH_TOKEN. */
  source: 'project' | 'global' | 'env';
  /** The slot or variable it came from (for `config show`). Never the value. */
  via: string;
  /** sha256 prefix of the value: what the flag writer compares. Never the token. */
  fingerprint: string;
  /** The signed-in login, for the global sign-in. */
  login?: string;
}

/** A sha256 prefix: enough to tell two tokens apart, never enough to recover one. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf-8').digest('hex').slice(0, 16);
}

function tokenSha256(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf-8').digest('hex');
}

/** `_dream_context/state/.secrets.json`: the per-project secrets (written by task-backend/secrets.ts). */
export function projectSecretsPath(projectRoot: string): string {
  return join(projectRoot, '_dream_context', 'state', '.secrets.json');
}

/** The per-project `github.token`, or null. A symlinked secrets file is not read. */
export function readProjectGitHubToken(projectRoot: string): string | null {
  const path = projectSecretsPath(projectRoot);
  if (!existsSync(path) || isSymlink(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { github?: { token?: unknown } } | null;
    const v = parsed && typeof parsed === 'object' ? parsed.github?.token : undefined;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** The app's sign-in as a credential, or null. */
export function readGlobalGitHubCredential(home?: string): GitHubCredential | null {
  const g = readGlobalSecretsFile(home).github;
  const v = g?.token;
  if (!v || !v.trim()) return null;
  const login = g?.login && g.login.trim() ? g.login.trim() : undefined;
  return { token: v.trim(), source: 'global', via: 'sign-in', fingerprint: tokenFingerprint(v), ...(login ? { login } : {}) };
}

function envCredential(env: NodeJS.ProcessEnv): GitHubCredential | null {
  for (const envVar of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = env[envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: envVar, fingerprint: tokenFingerprint(v) };
  }
  return null;
}

/** Is THIS per-project token demoted for `purpose` (a 401 demotes it for all, a 403 for one)? */
export function isProjectTokenDemoted(projectRoot: string, token: string, purpose: GitHubPurpose): boolean {
  const local = readBrainLocal(projectRoot);
  const sha = tokenSha256(token);
  const marks = local.githubDemoted ?? {};
  if (marks.all === sha || marks[purpose] === sha) return true;
  // The marker brain sync wrote before github-baglanti: a brain-only demotion.
  return purpose === 'brain' && local.demotedTokenSha256 === sha;
}

/**
 * Demote (never delete) the per-project token: `scope: 'all'` after GitHub said 401 (dead
 * everywhere), a purpose after a 403 for that purpose only. Hash only, machine-local.
 */
export function demoteProjectGitHubToken(projectRoot: string, token: string, scope: GitHubPurpose | 'all'): void {
  const marks = { ...(readBrainLocal(projectRoot).githubDemoted ?? {}) };
  marks[scope] = tokenSha256(token);
  writeBrainLocal(projectRoot, { githubDemoted: marks });
}

/** Lift every demotion marker (a new per-project token was entered or removed). */
export function clearProjectGitHubDemotion(projectRoot: string): void {
  const local = readBrainLocal(projectRoot);
  if (!local.githubDemoted && !local.demotedTokenSha256) return;
  writeBrainLocal(projectRoot, { githubDemoted: {}, demotedTokenSha256: undefined });
}

/** The open project's own token, as Settings → GitHub shows it: none, in use, or demoted (dead somewhere). */
export function projectGitHubTokenState(projectRoot: string): 'none' | 'active' | 'demoted' {
  const t = readProjectGitHubToken(projectRoot);
  if (!t) return 'none';
  const marks = readBrainLocal(projectRoot).githubDemoted ?? {};
  const sha = tokenSha256(t);
  return marks.all === sha || marks.tasks === sha || marks.brain === sha || marks.browse === sha ? 'demoted' : 'active';
}

export interface ResolveGitHubCredentialOpts {
  /** The project whose own token may override; omitted = no project (the launcher). */
  projectRoot?: string;
  purpose: GitHubPurpose;
  /** TEST seam: the home of the global store. */
  home?: string;
  /** TEST seam: the environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * C1, the ONE resolver every GitHub path uses. Order: this project's own token (unless
 * demoted for this purpose) → the app's sign-in → GITHUB_TOKEN/GH_TOKEN. Env is last so a
 * stray shell variable never overrides the account the user signed in as, yet env-only CI
 * keeps working. A token demoted for ONE purpose (a 403) is still the last resort there;
 * a dead one (401, `all`) is not.
 */
export function resolveGitHubCredential(opts: ResolveGitHubCredentialOpts): GitHubCredential | null {
  let demotedForPurpose: GitHubCredential | null = null;
  if (opts.projectRoot) {
    const t = readProjectGitHubToken(opts.projectRoot);
    if (t) {
      const cred: GitHubCredential = { token: t, source: 'project', via: 'token', fingerprint: tokenFingerprint(t) };
      if (!isProjectTokenDemoted(opts.projectRoot, t, opts.purpose)) return cred;
      const dead = (readBrainLocal(opts.projectRoot).githubDemoted ?? {}).all === tokenSha256(t);
      if (!dead) demotedForPurpose = cred;
    }
  }
  return readGlobalGitHubCredential(opts.home) ?? envCredential(opts.env ?? process.env) ?? demotedForPurpose;
}

/** How GitHub answered a credentialed request, as the flag writer needs it. */
export type GitHubAuthOutcomeKind = 'ok' | 'auth' | 'forbidden' | 'rate_limited' | 'other';

/**
 * C3, the ONLY writer of `needsReconnect` besides sign-in and sign-out. Raised when the
 * GLOBAL sign-in got a 401, cleared only when the global sign-in succeeded; any other token's
 * outcome says nothing about the sign-in. Under the secrets lock, and only when `fingerprint`
 * is the token stored NOW, so a late answer about an old token never flips a fresh sign-in.
 */
export function reportGitHubAuthOutcome(
  o: { source: GitHubCredential['source']; fingerprint: string; kind: GitHubAuthOutcomeKind },
  home?: string,
): void {
  if (o.source !== 'global') return;
  if (o.kind !== 'ok' && o.kind !== 'auth') return;
  try {
    withGlobalSecretsLock(home, () => {
      const current = readGlobalGitHubCredential(home);
      if (!current || current.fingerprint !== o.fingerprint) return;
      setAuthValidUnlocked(o.kind === 'ok', home);
    });
  } catch {
    // A flag write never fails the operation that reported it.
  }
}
