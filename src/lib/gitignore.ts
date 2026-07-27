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

/**
 * Remove exact-match entries (after trimming) from the project-root
 * `.gitignore`. Comment lines and anything not byte-for-byte equal to one of
 * `entries` are left completely untouched — this never guesses at intent, it
 * only undoes what `ensureGitignoreEntries` (or an equivalent exact append)
 * put there.
 *
 * Missing file ⇒ `[]`, nothing to remove — mirrors `ensureGitignoreEntries`'s
 * "already covered" no-op in the opposite direction. Throws under the same
 * condition `ensureGitignoreEntries` does (the path exists but isn't a
 * regular file) — a directory in place of `.gitignore` is a state neither
 * function can recover from silently.
 *
 * Returns the requested entries that were actually found and removed (empty
 * ⇒ none were present). A no-op call never rewrites the file, so a caller
 * that unconditionally calls this on every read cannot churn an untouched
 * `.gitignore`'s mtime.
 */
export function removeGitignoreEntries(projectRoot: string, entries: string[]): string[] {
  const path = join(projectRoot, '.gitignore');
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isFile()) {
    throw new Error(`.gitignore at ${path} is not a regular file`);
  }

  const current = readFileSync(path, 'utf-8');
  const targets = new Set(entries.map((e) => e.trim()));

  const removedTrimmed = new Set<string>();
  const kept = current.split('\n').filter((line) => {
    const trimmed = line.trim();
    // Never touch comments — even one whose text happens to match an entry
    // (it can't in practice: entries never carry a leading '#', so this is
    // belt-and-braces against a future caller passing one by mistake).
    if (trimmed.startsWith('#')) return true;
    if (targets.has(trimmed)) {
      removedTrimmed.add(trimmed);
      return false;
    }
    return true;
  });

  if (removedTrimmed.size === 0) return [];

  writeFileSync(path, kept.join('\n'), 'utf-8');
  // Report in the caller's requested order/casing, once per entry actually
  // removed — not once per duplicate physical line.
  return entries.filter((e) => removedTrimmed.has(e.trim()));
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
