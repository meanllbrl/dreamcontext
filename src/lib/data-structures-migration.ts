import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter } from './frontmatter.js';

export const OLD_DATA_STRUCTURES_DIR = join('core', 'data-structures');
export const NEW_DATA_STRUCTURES_DIR = join('knowledge', 'data-structures');

/** Tags every data-structures knowledge file should carry for recall/filtering. */
export const DATA_STRUCTURES_TAGS = ['data-structures', 'database', 'schema'];

export interface MigrationResult {
  migrated: string[]; // product names moved (e.g. "default", "lina")
  skipped: string[];  // already present at the destination → left untouched
}

/**
 * Enrich a data-structures file's frontmatter for its new home under knowledge/:
 * guarantees `type: data-structures`, a `product`, and the standard tag set
 * (union — existing tags preserved). Pure; returns the merged frontmatter.
 */
export function enrichDataStructuresFrontmatter(
  data: Record<string, unknown>,
  product: string,
): Record<string, unknown> {
  const existingTags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  const tags = [...existingTags];
  for (const t of DATA_STRUCTURES_TAGS) {
    if (!tags.includes(t)) tags.push(t);
  }
  return {
    ...data,
    name: data.name ?? product,
    type: 'data-structures',
    product: data.product ?? product,
    tags,
  };
}

/**
 * Wrap a data-structures body in a ```sql fence so it renders as highlighted SQL
 * in the dashboard. Idempotent: a body already starting with a code fence is
 * returned unchanged so the migration never double-wraps. Empty / whitespace-only
 * bodies are also returned unchanged.
 */
export function ensureSqlFence(body: string): string {
  if (body.trimStart().startsWith('```')) return body;
  const trimmed = body.trim();
  return trimmed ? '```sql\n' + trimmed + '\n```\n' : body;
}

/**
 * Idempotently migrate `core/data-structures/*.md` → `knowledge/data-structures/*.md`,
 * enriching frontmatter for the knowledge corpus. Files already present at the
 * destination are skipped (never overwritten). The OLD directory is left in
 * place — the user deletes it once they've confirmed the move (mirrors the
 * legacy `5.data_structures.sql` migration discipline).
 */
export function migrateDataStructures(contextRoot: string): MigrationResult {
  const result: MigrationResult = { migrated: [], skipped: [] };

  const oldDir = join(contextRoot, OLD_DATA_STRUCTURES_DIR);
  if (!existsSync(oldDir)) return result;

  const files = fg.sync('*.md', { cwd: oldDir, absolute: true });
  if (files.length === 0) return result;

  const newDir = join(contextRoot, NEW_DATA_STRUCTURES_DIR);
  mkdirSync(newDir, { recursive: true });

  for (const oldFile of files) {
    const product = basename(oldFile, '.md');
    const newFile = join(newDir, `${product}.md`);

    if (existsSync(newFile)) {
      result.skipped.push(product);
      continue;
    }

    const { data, content } = readFrontmatter<Record<string, unknown>>(oldFile);
    writeFrontmatter(newFile, enrichDataStructuresFrontmatter(data, product), ensureSqlFence(content));
    result.migrated.push(product);
  }

  return result;
}

/**
 * Read-only: product names under knowledge/data-structures/ whose body is NOT
 * yet wrapped in a ```sql fence. Writes nothing. Shares `ensureSqlFence` as the
 * single authority on "is it fenced?".
 */
export function listUnfencedDataStructures(contextRoot: string): string[] {
  const dir = join(contextRoot, NEW_DATA_STRUCTURES_DIR);
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  for (const file of fg.sync('*.md', { cwd: dir, absolute: true })) {
    try {
      const { content } = readFrontmatter<Record<string, unknown>>(file);
      if (ensureSqlFence(content) !== content) out.push(basename(file, '.md'));
    } catch { /* skip unreadable */ }
  }
  return out.sort();
}

/**
 * Backfill: fence (in place) any unfenced knowledge/data-structures/*.md so it
 * renders as SQL in the dashboard. Idempotent — rewrites ONLY files whose body
 * actually changes, and preserves frontmatter verbatim (does NOT bump `updated`,
 * so a format-only normalization never resets the staleness clock). Returns the
 * product names that were fenced this run.
 */
export function fenceExistingDataStructures(contextRoot: string): string[] {
  const dir = join(contextRoot, NEW_DATA_STRUCTURES_DIR);
  if (!existsSync(dir)) return [];

  const fenced: string[] = [];
  for (const file of fg.sync('*.md', { cwd: dir, absolute: true })) {
    try {
      const { data, content } = readFrontmatter<Record<string, unknown>>(file);
      const next = ensureSqlFence(content);
      if (next !== content) {
        writeFrontmatter(file, data, next);
        fenced.push(basename(file, '.md'));
      }
    } catch { /* skip unreadable */ }
  }
  return fenced.sort();
}
