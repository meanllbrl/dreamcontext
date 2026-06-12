import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Idempotently ensure the project-root `.gitignore` contains the given
 * entries. Creates the file when missing; appends only the entries that are
 * not already present (exact-line match after trimming).
 *
 * Throws when `.gitignore` cannot be read or written (e.g. the path exists
 * but is a directory, or the fs write fails). Callers that are about to write
 * secrets MUST call this FIRST and abort on throw — a secret may never exist
 * on disk without its ignore entry, even transiently (issue #11).
 *
 * Returns the entries that were actually added (empty ⇒ already covered).
 */
export function ensureGitignoreEntries(
  projectRoot: string,
  entries: string[],
  opts?: { comment?: string },
): string[] {
  const path = join(projectRoot, '.gitignore');

  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error(`.gitignore at ${path} is not a regular file`);
  }

  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const have = new Set(
    current
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#')),
  );

  const missing = entries.filter((e) => !have.has(e.trim()));
  if (missing.length === 0) return [];

  const lines: string[] = [];
  if (current.length > 0 && !current.endsWith('\n')) lines.push('');
  if (opts?.comment) lines.push('', `# ${opts.comment}`);
  lines.push(...missing);

  writeFileSync(path, current + lines.join('\n') + '\n', 'utf-8');
  return missing;
}

/** True when the `.gitignore` already covers every given entry (exact line). */
export function gitignoreCovers(projectRoot: string, entries: string[]): boolean {
  const path = join(projectRoot, '.gitignore');
  if (!existsSync(path) || !lstatSync(path).isFile()) return false;
  const have = new Set(
    readFileSync(path, 'utf-8')
      .split('\n')
      .map((l) => l.trim()),
  );
  return entries.every((e) => have.has(e.trim()));
}
