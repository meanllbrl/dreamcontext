import type { RecallHit } from '../hooks/useRecall';
import type { Page } from '../components/layout/Sidebar';

/**
 * Map a recall hit to the dashboard page (and slug) that renders it, so opening a
 * search result from the ⌘K command palette lands on the right surface.
 *
 * The slug a detail page expects is NOT always `hit.slug`. For knowledge the recall
 * corpus stores the basename only (`decision-foo`), while the Knowledge page keys on
 * the folder-qualified slug (`decisions/decision-foo`); we derive that from
 * `hit.path` exactly like {@link DocContent} (`DocContent.tsx:21-23`). Features and
 * tasks key on `hit.slug` directly.
 *
 * Changelog/memory hits are synthetic entries inside `core/CHANGELOG.json` /
 * `core/2.memory.md` — there is no per-entry page. They open the Core page on the
 * file that contains them (`CHANGELOG.json` / `2.memory.md`), both of which the
 * Core list renders. Bookmark-backed memory hits live in `state/.sleep.json` (not a
 * core file), so they yield an empty slug and Core stays on its default file.
 *
 * Pure + dependency-free (type-only imports) so it is unit-testable in isolation.
 */

export interface RecallNavTarget {
  page: Page;
  slug: string;
}

/** Folder-qualified knowledge slug, mirroring DocContent's derivation. */
function knowledgeSlug(path: string): string {
  return path.replace(/^.*?knowledge\//, '').replace(/\.md$/, '');
}

/** The core filename a memory/changelog entry lives in (e.g. `2.memory.md`), or '' if not under core/. */
function coreFileName(path: string): string {
  const m = path.match(/(?:^|\/)core\/([^/]+)$/);
  return m ? m[1] : '';
}

export function recallNavTarget(hit: RecallHit): RecallNavTarget {
  switch (hit.type) {
    case 'knowledge':
      return { page: 'knowledge', slug: knowledgeSlug(hit.path) };
    case 'feature':
      return { page: 'features', slug: hit.slug };
    case 'task':
      return { page: 'tasks', slug: hit.slug };
    case 'changelog':
    case 'memory':
    default:
      return { page: 'core', slug: coreFileName(hit.path) };
  }
}
