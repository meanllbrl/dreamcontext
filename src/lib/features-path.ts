import { join } from 'node:path';

/**
 * Single source of truth for where feature PRDs live.
 *
 * Features are typed knowledge: they physically live under
 * `knowledge/features/<slug>.md` with frontmatter `type: feature`. Every
 * read-side consumer (recall, snapshot, graph, releases, server) imports from
 * here so the location is defined in exactly one place.
 */

/** Subdirectory (under `knowledge/`) that holds feature PRDs. */
export const FEATURES_SUBDIR = 'features';

/** The frontmatter `type` discriminator for a feature knowledge file. */
export const FEATURES_TYPE = 'feature';

/** Absolute path to the features directory for a given `_dream_context` root. */
export function featuresDir(contextRoot: string): string {
  return join(contextRoot, 'knowledge', FEATURES_SUBDIR);
}
