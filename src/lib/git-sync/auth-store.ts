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

/** Clear the global GitHub token + login (logout). Idempotent — a missing file is a no-op. */
export function clearGlobalGitHubToken(home?: string): void {
  const path = globalSecretsPath(home);
  if (!existsSync(path)) return;
  const secrets = readGlobalSecretsFile(home);
  if (secrets.github) { delete secrets.github.token; delete secrets.github.login; }
  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}
