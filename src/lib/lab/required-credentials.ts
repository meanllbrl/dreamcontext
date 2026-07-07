import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listInsights } from './store.js';
import type { InsightManifest } from './types.js';

/**
 * Required-credential-keys helper + the tracked example file.
 *
 * `lab/credentials.example.json` is the COMMITTABLE twin of the secret
 * `lab/credentials.json`: same keys, every value an empty string, so a
 * teammate cloning the brain sees exactly which credentials the insights need
 * without ever seeing a value. It is kept current by `writeCredential`,
 * `lab credentials set`, and `createInsight` — and kept tracked by the
 * `!lab/credentials.example.json` gitignore negations (LAB_GITIGNORE_ENTRIES /
 * buildBrainGitignore).
 */

/** Relative path of the tracked example file under `_dream_context/`. */
export const CREDENTIALS_EXAMPLE_REL = 'lab/credentials.example.json';

/** `{{cred:key}}` only — `{{tweak:*}}` placeholders are not credentials. */
const CRED_PLACEHOLDER = /\{\{cred:([^}]+)\}\}/g;

/**
 * Every credential key ONE manifest requires: its declared `credentials_used`
 * plus any `{{cred:key}}` placeholder in the http source's endpoint/headers/body.
 * Script files can't be scanned — scripts contribute only their declared
 * `credentials_used`. Sorted, unique.
 */
export function requiredCredentialKeys(manifest: InsightManifest): string[] {
  const keys = new Set<string>();
  for (const key of manifest.credentials_used) {
    if (key.trim()) keys.add(key.trim());
  }
  if (manifest.source?.adapter === 'http') {
    const templates = [
      manifest.source.endpoint,
      manifest.source.body ?? '',
      ...Object.values(manifest.source.headers),
    ];
    for (const template of templates) {
      for (const match of template.matchAll(CRED_PLACEHOLDER)) {
        const key = match[1].trim();
        if (key) keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/** The union of every insight's required credential keys. Sorted, unique. */
export function collectRequiredCredentialKeys(contextRoot: string): string[] {
  const keys = new Set<string>();
  for (const manifest of listInsights(contextRoot)) {
    for (const key of requiredCredentialKeys(manifest)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Write (or refresh) the tracked `lab/credentials.example.json`: one entry per
 * required key, every value `""`. Contains NO secrets by construction. When no
 * key is required and the file doesn't exist, nothing is created; when it does
 * exist it is refreshed (possibly to `{}`) so it never advertises stale keys.
 */
export function writeCredentialsExample(contextRoot: string): void {
  const keys = collectRequiredCredentialKeys(contextRoot);
  const path = join(contextRoot, 'lab', 'credentials.example.json');
  if (keys.length === 0 && !existsSync(path)) return;

  const example: Record<string, string> = {};
  for (const key of keys) example[key] = '';

  mkdirSync(join(contextRoot, 'lab'), { recursive: true });
  writeFileSync(path, JSON.stringify(example, null, 2) + '\n', 'utf-8');
}
