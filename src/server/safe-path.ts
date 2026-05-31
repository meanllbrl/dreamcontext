import { resolve, sep } from 'node:path';

/**
 * Resolve `child` under `baseDir` and guarantee the result stays inside it.
 * Returns null if the child escapes the base directory via `..`, an absolute
 * path, or a null byte. Use for any filesystem path built from request input.
 */
export function safeChildPath(baseDir: string, child: string): string | null {
  if (!child || child.includes('\0')) return null;
  const base = resolve(baseDir);
  const target = resolve(base, child);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}
