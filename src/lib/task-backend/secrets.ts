import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureGitignoreEntries } from '../gitignore.js';

/**
 * CLI-managed secrets store for remote task backends — issue #11.
 *
 * The ClickUp API key lives in `_dream_context/state/.secrets.json`
 * (mode 0600), NEVER in `.config.json` (which may be committed).
 *
 * Ordering guarantee: the `.gitignore` entry covering the secrets file is
 * written BEFORE the secrets file is created. If `.gitignore` cannot be
 * updated, the write aborts — the key must never be committable, even
 * transiently. This ordering is itself under test.
 */

export const SECRETS_REL_PATH = '_dream_context/state/.secrets.json';
/** The exact .gitignore line that covers the secrets file. */
export const SECRETS_GITIGNORE_ENTRY = '_dream_context/state/.secrets.json';

interface SecretsFile {
  clickup?: {
    /** Default token (single-user projects). */
    token?: string;
    /** Per-person tokens keyed by person slug (identity layer). */
    users?: Record<string, string>;
  };
  github?: {
    /** Default token (single-user projects). */
    token?: string;
    /** Per-person tokens keyed by person slug (identity layer). */
    users?: Record<string, string>;
  };
}

function secretsPath(projectRoot: string): string {
  return join(projectRoot, SECRETS_REL_PATH);
}

function readSecretsFile(projectRoot: string): SecretsFile {
  const path = secretsPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SecretsFile;
  } catch {
    return {};
  }
}

/**
 * Store a ClickUp token. `user` scopes the token to a person slug (per-user
 * keys for the identity layer); omitted ⇒ the project default token.
 *
 * Throws (writing NOTHING) when the .gitignore entry cannot be ensured.
 */
export function writeClickUpToken(projectRoot: string, token: string, user?: string): void {
  if (!token || !token.trim()) {
    throw new Error('Token must be a non-empty string.');
  }

  // ORDERING GUARANTEE: gitignore first; abort on failure.
  try {
    ensureGitignoreEntries(projectRoot, [SECRETS_GITIGNORE_ENTRY], {
      comment: 'dreamcontext secrets (never commit)',
    });
  } catch (err) {
    throw new Error(
      `Refusing to write the secrets file: .gitignore could not be updated (${(err as Error).message}). ` +
      'The API key must never be committable, even transiently.',
    );
  }

  const path = secretsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });

  const secrets = readSecretsFile(projectRoot);
  secrets.clickup = secrets.clickup ?? {};
  if (user && user.trim()) {
    secrets.clickup.users = { ...(secrets.clickup.users ?? {}), [user.trim()]: token.trim() };
  } else {
    secrets.clickup.token = token.trim();
  }

  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // mode in writeFileSync only applies on create — enforce on rewrite too.
  try { chmodSync(path, 0o600); } catch { /* best-effort on exotic filesystems */ }
}

/**
 * Store a GitHub token. `user` scopes the token to a person slug (per-user keys
 * for the identity layer); omitted ⇒ the project default token. Shares the same
 * `.secrets.json` as ClickUp under a `github` block — same gitignore-first
 * abort guard, same never-logged invariant.
 *
 * Throws (writing NOTHING) when the .gitignore entry cannot be ensured.
 */
export function writeGitHubToken(projectRoot: string, token: string, user?: string): void {
  if (!token || !token.trim()) {
    throw new Error('Token must be a non-empty string.');
  }

  // ORDERING GUARANTEE: gitignore first; abort on failure.
  try {
    ensureGitignoreEntries(projectRoot, [SECRETS_GITIGNORE_ENTRY], {
      comment: 'dreamcontext secrets (never commit)',
    });
  } catch (err) {
    throw new Error(
      `Refusing to write the secrets file: .gitignore could not be updated (${(err as Error).message}). ` +
      'The API key must never be committable, even transiently.',
    );
  }

  const path = secretsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });

  const secrets = readSecretsFile(projectRoot);
  secrets.github = secrets.github ?? {};
  if (user && user.trim()) {
    secrets.github.users = { ...(secrets.github.users ?? {}), [user.trim()]: token.trim() };
  } else {
    secrets.github.token = token.trim();
  }

  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // mode in writeFileSync only applies on create — enforce on rewrite too.
  try { chmodSync(path, 0o600); } catch { /* best-effort on exotic filesystems */ }
}

/**
 * Remove ONLY the per-project default GitHub token (`github.token`) from
 * `_dream_context/state/.secrets.json`, preserving every other key — the
 * per-user token map (`github.users`), the whole `clickup` block, anything
 * else. This is the self-heal for a STALE per-project token that shadows the
 * signed-in global account (the token never wins resolution again, so
 * `resolveBrainSyncToken` falls through to the global tier). If deleting the
 * token empties the `github` block AND the whole file, the file is removed
 * entirely. Idempotent — a missing file / missing token is a no-op. NEVER logs
 * the token value.
 */
export function removeProjectGitHubToken(projectRoot: string): void {
  const path = secretsPath(projectRoot);
  if (!existsSync(path)) return;
  const secrets = readSecretsFile(projectRoot);
  if (!secrets.github || secrets.github.token === undefined) return;

  delete secrets.github.token;
  // Drop an emptied github block, then the whole file if nothing else remains —
  // never leave a `{}`/`{"github":{}}` husk behind.
  if (Object.keys(secrets.github).length === 0) delete secrets.github;
  if (Object.keys(secrets).length === 0) {
    try { unlinkSync(path); } catch { /* best-effort — already gone */ }
    return;
  }

  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // mode in writeFileSync only applies on create — enforce on rewrite too.
  try { chmodSync(path, 0o600); } catch { /* best-effort on exotic filesystems */ }
}

export interface ResolvedToken {
  token: string;
  source: 'env' | 'secrets';
  /** Which env var or secrets slot produced the token (for `config show`). */
  via: string;
}

/**
 * Resolve a ClickUp token. Order (issue #11): env → secrets file.
 *  1. `opts.envVar` (per-person `tokenEnv` from the identity layer)
 *  2. `CLICKUP_TOKEN` / `CLICKUP_API_KEY`
 *  3. secrets file per-user slot (`opts.user`)
 *  4. secrets file default slot
 */
export function resolveClickUpToken(
  projectRoot: string,
  opts?: { envVar?: string; user?: string },
): ResolvedToken | null {
  if (opts?.envVar) {
    const v = process.env[opts.envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: opts.envVar };
  }
  for (const envVar of ['CLICKUP_TOKEN', 'CLICKUP_API_KEY']) {
    const v = process.env[envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: envVar };
  }

  const secrets = readSecretsFile(projectRoot);
  if (opts?.user) {
    const v = secrets.clickup?.users?.[opts.user];
    if (v && v.trim()) return { token: v.trim(), source: 'secrets', via: `users.${opts.user}` };
  }
  const v = secrets.clickup?.token;
  if (v && v.trim()) return { token: v.trim(), source: 'secrets', via: 'token' };
  return null;
}

/**
 * Resolve a GitHub token. Order (mirrors ClickUp): env → secrets file.
 *  1. `opts.envVar` (per-person `tokenEnv` from the identity layer)
 *  2. `GITHUB_TOKEN` / `GH_TOKEN`
 *  3. secrets file per-user slot (`opts.user`)
 *  4. secrets file default slot
 */
export function resolveGitHubToken(
  projectRoot: string,
  opts?: { envVar?: string; user?: string },
): ResolvedToken | null {
  if (opts?.envVar) {
    const v = process.env[opts.envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: opts.envVar };
  }
  for (const envVar of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = process.env[envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: envVar };
  }

  const secrets = readSecretsFile(projectRoot);
  if (opts?.user) {
    const v = secrets.github?.users?.[opts.user];
    if (v && v.trim()) return { token: v.trim(), source: 'secrets', via: `users.${opts.user}` };
  }
  const v = secrets.github?.token;
  if (v && v.trim()) return { token: v.trim(), source: 'secrets', via: 'token' };
  return null;
}

/**
 * Read a GitHub token from the per-project secrets file ONLY — no env fallback.
 * Used by `resolveBrainSyncToken` (git-sync/brain-repo.ts), which is
 * intentionally secrets-first/env-last (the reverse of `resolveGitHubToken`'s
 * env-first order) — a non-technical collaborator's logged-in/stored credential
 * must win over a stray `GITHUB_TOKEN` in some inherited shell. Do NOT widen
 * this into an env-aware resolver; that is exactly what `resolveGitHubToken`
 * already is, and the two must stay distinct.
 */
export function readGitHubTokenSecretsOnly(
  projectRoot: string,
  opts?: { user?: string },
): ResolvedToken | null {
  const secrets = readSecretsFile(projectRoot);
  if (opts?.user) {
    const v = secrets.github?.users?.[opts.user];
    if (v && v.trim()) return { token: v.trim(), source: 'secrets', via: `users.${opts.user}` };
  }
  const v = secrets.github?.token;
  if (v && v.trim()) return { token: v.trim(), source: 'secrets', via: 'token' };
  return null;
}

/** True when a secrets file exists for this project. */
export function hasSecretsFile(projectRoot: string): boolean {
  return existsSync(secretsPath(projectRoot));
}

/**
 * Mask a token for display: never echo the secret. Shows only the last 4
 * characters (or full mask for short tokens).
 */
export function maskToken(token: string): string {
  const t = token.trim();
  if (t.length <= 8) return '••••••••';
  return `••••••••${t.slice(-4)}`;
}
