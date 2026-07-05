import { existsSync } from 'node:fs';
import fg from 'fast-glob';
import { readFrontmatter, updateFrontmatterFields } from './frontmatter.js';
import { today } from './id.js';
import { featuresDir } from './features-path.js';

/**
 * Set released_version on selected features.
 */
export function backPopulateFeatures(root: string, featureIds: string[], version: string): void {
  const dir = featuresDir(root);
  if (!existsSync(dir)) return;

  const files = fg.sync('*.md', { cwd: dir, absolute: true });
  const idSet = new Set(featureIds);

  for (const file of files) {
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      const id = String(data.id ?? '');
      if (idSet.has(id)) {
        updateFrontmatterFields(file, {
          released_version: version,
          updated: today(),
        });
      }
    } catch { /* skip */ }
  }
}
