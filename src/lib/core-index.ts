import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CoreFileEntry {
  filename: string;
  name: string;
  type: string;
  summary: string;
  path: string;
}

// ─── Index Builder ─────────────────────────────────────────────────────────

/**
 * Scan core/ for extra files (3+) not already loaded in full by the snapshot.
 * Excludes 0.soul, 1.user, 2.memory, CHANGELOG.json, RELEASES.json, features/.
 * Returns [] if none exist.
 */
export function buildCoreIndex(contextRoot: string): CoreFileEntry[] {
  const coreDir = join(contextRoot, 'core');
  if (!existsSync(coreDir)) return [];

  const files = fg.sync('[3-9]*', { cwd: coreDir, absolute: true });
  const entries: CoreFileEntry[] = [];

  for (const file of files) {
    const filename = basename(file);
    const relativePath = `_dream_context/core/${filename}`;

    // JSON files don't have frontmatter — derive name from filename
    if (filename.endsWith('.json')) {
      entries.push({
        filename,
        name: filename.replace(/^\d+\./, '').replace(/\.\w+$/, '').replace(/_/g, ' '),
        type: 'data',
        summary: '',
        path: relativePath,
      });
      continue;
    }

    try {
      const { data } = readFrontmatter(file);
      entries.push({
        filename,
        name: String(data.name ?? filename),
        type: String(data.type ?? 'unknown'),
        summary: String(data.summary ?? ''),
        path: relativePath,
      });
    } catch {
      entries.push({
        filename,
        name: filename,
        type: 'unknown',
        summary: '',
        path: relativePath,
      });
    }
  }

  entries.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  return entries;
}
