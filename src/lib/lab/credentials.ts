import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignoreEntries } from '../gitignore.js';
import { ensureLocalOnlyArtifacts, currentTaskBackend } from '../git-sync/brain-repo.js';
import { writeCredentialsExample } from './required-credentials.js';
import { LabError } from './types.js';

/**
 * Lab credential store + secret redaction — the security spine of the subsystem.
 *
 * `lab/credentials.json` (key → secret) is written ONLY through `writeCredential`,
 * which enforces a strict gitignore-first ordering so a secret can NEVER exist on
 * disk without a governing ignore entry, even transiently (mirrors
 * secrets.ts:writeClickUpToken). Placeholders in manifests (`{{cred:key}}`) are
 * resolved just-in-time by the adapters; every error/log/cache string is built
 * from the REDACTED resolution and passed through `redactSecrets` as a final net.
 */

/** Relative path of the credential file under `_dream_context/`. */
export const CREDENTIALS_REL = 'lab/credentials.json';
/** Gitignore entries covering the credential file, brain-repo-relative. The
 *  negation (AFTER the wildcard — order matters to git) keeps the secret-free
 *  `lab/credentials.example.json` tracked. */
export const LAB_GITIGNORE_ENTRIES = [
  'lab/credentials.json',
  'lab/credentials.*',
  '!lab/credentials.example.json',
];
/** Gitignore entries covering the credential file, project-root-relative (in-tree mode). */
export const LAB_GITIGNORE_ENTRIES_ROOT = [
  '_dream_context/lab/credentials.json',
  '_dream_context/lab/credentials.*',
  '!_dream_context/lab/credentials.example.json',
];

function credentialsPath(contextRoot: string): string {
  return join(contextRoot, 'lab', 'credentials.json');
}

/** Read the credential map. A missing/malformed file returns `{}` (never throws). */
export function readCredentials(contextRoot: string): Record<string, string> {
  const path = credentialsPath(contextRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Store one credential. STRICT ordering (any failure aborts BEFORE the secret
 * touches disk):
 *   1. `ensureLocalOnlyArtifacts` — writes the FULL canonical brain gitignore iff
 *      `_dream_context/.gitignore` is missing (never a 2-line stub that would
 *      permanently defeat `bootstrapBrainRepo`'s `!existsSync` guard).
 *   2. append the lab entries to `_dream_context/.gitignore` (brain-repo mode).
 *   3. append the project-root entries to `.gitignore` (in-tree mode).
 * On success: mkdir, merge, write mode 0600 + chmod 0600.
 */
export function writeCredential(
  projectRoot: string,
  contextRoot: string,
  key: string,
  value: string,
): void {
  if (!key || !key.trim()) throw new LabError('Credential key must be a non-empty string.');
  if (typeof value !== 'string' || value === '') throw new LabError('Credential value must be a non-empty string.');

  // ── gitignore-first, unconditionally both governing files (A4). ──
  try {
    ensureLocalOnlyArtifacts(contextRoot, currentTaskBackend(projectRoot));
    ensureGitignoreEntries(contextRoot, LAB_GITIGNORE_ENTRIES, {
      comment: 'dreamcontext lab credentials (never commit)',
    });
    ensureGitignoreEntries(projectRoot, LAB_GITIGNORE_ENTRIES_ROOT, {
      comment: 'dreamcontext lab credentials (never commit)',
    });
  } catch (err) {
    throw new LabError(
      `Refusing to write lab credentials: a governing .gitignore could not be ensured (${(err as Error).message}). ` +
      'The credential must never be committable, even transiently.',
    );
  }

  const path = credentialsPath(contextRoot);
  mkdirSync(join(contextRoot, 'lab'), { recursive: true });

  const creds = readCredentials(contextRoot);
  creds[key.trim()] = value;

  writeFileSync(path, JSON.stringify(creds, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync's mode only applies on create — enforce on rewrite too.
  try { chmodSync(path, 0o600); } catch { /* best-effort on exotic filesystems */ }
  // Keep the tracked, secret-free example file current (best-effort — the
  // credential itself is already safely stored and gitignored).
  try { writeCredentialsExample(contextRoot); } catch { /* never fail the credential write */ }
}

/** The credential KEY names (never values) — for `lab credentials list`. */
export function listCredentialNames(contextRoot: string): string[] {
  return Object.keys(readCredentials(contextRoot)).sort();
}

const PLACEHOLDER = /\{\{(cred|tweak):([^}]+)\}\}/g;

/**
 * Resolve `{{cred:key}}` / `{{tweak:key}}` placeholders in a template. With
 * `redact`, every `{{cred:*}}` renders as `***` (used to build error/log strings
 * that must never carry a real secret). Unknown keys pass through unchanged.
 */
export function resolvePlaceholders(
  template: string,
  ctx: { cred: Record<string, string>; tweak: Record<string, string> },
  opts?: { redact?: boolean },
): string {
  return template.replace(PLACEHOLDER, (whole, kind: string, rawKey: string) => {
    const k = rawKey.trim();
    if (kind === 'cred') {
      if (opts?.redact) return '***';
      return k in ctx.cred ? ctx.cred[k] : whole;
    }
    return k in ctx.tweak ? ctx.tweak[k] : whole;
  });
}

/**
 * Final redaction net: replace every literal occurrence of any secret value with
 * `***`. Applied to every error/log string so a secret can't leak even if it
 * arrived from somewhere other than a `{{cred:*}}` placeholder.
 */
export function redactSecrets(str: string, secretValues: string[]): string {
  let out = str;
  for (const secret of secretValues) {
    if (secret && secret.length >= 1) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}
