import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResolvedToken } from '../task-backend/secrets.js';

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

  const secrets = readGlobalSecretsFile(home);
  secrets.github = { ...(secrets.github ?? {}), token: token.trim() };

  // 0600 mode-on-create; belt-and-suspenders chmod for the rewrite path.
  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on exotic filesystems */ }
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
  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
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
  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

/** Clear the global GitHub token + login (logout). Idempotent — a missing file is a no-op. */
export function clearGlobalGitHubToken(home?: string): void {
  const path = globalSecretsPath(home);
  if (!existsSync(path)) return;
  const secrets = readGlobalSecretsFile(home);
  if (secrets.github) { delete secrets.github.token; delete secrets.github.login; delete secrets.github.needsReconnect; }
  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}
