import { join, relative } from 'node:path';

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

/**
 * A feature's slug relative to the features directory, without `.md` and
 * forward-slashed. Flat features round-trip to their basename (`checkout`);
 * a feature nested in a topical/product subfolder keeps its folder prefix
 * (`lina/checkout`), which is what every consumer needs to render an accurate
 * path pointer and an unambiguous label. Mirrors the knowledge-index slug rule
 * (path relative to `knowledge/`) one directory deeper.
 */
export function featureSlug(featuresPath: string, absFile: string): string {
  return relative(featuresPath, absFile).replace(/\\/g, '/').replace(/\.md$/i, '');
}

/** As `featureSlug`, but relative to the `_dream_context` root directly. */
export function featureSlugFromRoot(contextRoot: string, absFile: string): string {
  return featureSlug(featuresDir(contextRoot), absFile);
}

/**
 * A feature's product — the SINGLE SOURCE OF TRUTH for which product a PRD
 * belongs to. It is the top-level subfolder under `features/` and nothing else:
 * `features/lina/checkout.md` → `lina`, `features/lina/growth/x.md` → `lina`
 * (deeper nesting is intra-product grouping), a flat `features/x.md` → undefined
 * (unscoped / global).
 *
 * Product is DERIVED from the path, never stored in frontmatter, so it cannot
 * diverge — moving the file (via `features move`) is the one operation that
 * re-scopes it. `multiProduct` in `.config.json` remains the product registry
 * (what products exist); the folder is the assignment.
 */
export function featureProduct(featuresPath: string, absFile: string): string | undefined {
  const slug = featureSlug(featuresPath, absFile);
  const slash = slug.indexOf('/');
  return slash > 0 ? slug.slice(0, slash) : undefined;
}

/**
 * As `featureProduct`, but from a context-root-relative path (e.g.
 * `knowledge/features/lina/checkout.md`). Returns the product only for a NESTED
 * feature — a flat `knowledge/features/x.md` yields undefined. Used by the recall
 * corpus loader, which works in relative paths.
 */
export function featureProductFromRelPath(relPath: string): string | undefined {
  const m = relPath.replace(/\\/g, '/').match(/(?:^|\/)knowledge\/features\/([^/]+)\//);
  return m ? m[1] : undefined;
}
