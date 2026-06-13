import { dirname } from 'node:path';
import fg from 'fast-glob';

/**
 * Discover every dreamcontext project under `root` by globbing for
 * `_dream_context/` directories (P1.1). Returns the PARENT project directories
 * (the dir that holds `_dream_context/`), absolute and de-duplicated, in stable
 * sorted order.
 *
 * - `node_modules` and `.git` are ignored so vendored copies never register.
 * - Depth is bounded (`deep: 6`) so a huge tree can't run away — federation is a
 *   handful of sibling projects, not a filesystem crawl.
 */
export function discoverVaults(root: string): string[] {
  const matches = fg.sync('**/_dream_context', {
    cwd: root,
    absolute: true,
    onlyDirectories: true,
    deep: 6,
    ignore: ['**/node_modules/**', '**/.git/**'],
    suppressErrors: true,
  });

  const projects = new Set<string>();
  for (const ctx of matches) projects.add(dirname(ctx));
  return Array.from(projects).sort();
}
