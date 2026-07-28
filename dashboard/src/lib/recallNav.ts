import type { RecallHit } from '../hooks/useRecall';
import type { Page } from '../components/layout/Sidebar';

/**
 * Map a recall hit to the dashboard page (and slug) that renders it, so opening a
 * search result from the ⌘K command palette lands on the right surface.
 *
 * The slug a detail page expects is NOT always `hit.slug`. For knowledge the recall
 * corpus stores the basename only (`decision-foo`), while the Knowledge page keys on
 * the folder-qualified slug (`decisions/decision-foo`); we derive that from
 * `hit.path` exactly like {@link DocContent} (`DocContent.tsx:21-23`). Feature PRDs
 * are typed knowledge under `knowledge/features/`, so a feature hit opens the
 * Knowledge page at the same path-derived slug (`features/<slug>`). Tasks key on
 * `hit.slug` directly.
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

/**
 * The automation an `automation` hit belongs to. A manifest hit's slug already IS
 * the automation (`automations/<slug>.md`); a run-output hit carries the synthetic
 * `run#<automation>-<date>` slug, so recover the automation from its parent
 * directory (`automations/output/<automation>/<date>.md`) — the run itself has no
 * page of its own.
 */
function automationSlug(hit: RecallHit): string {
  const m = hit.path.match(/(?:^|\/)automations\/output\/([^/]+)\//);
  if (m) return m[1];
  return hit.slug;
}

export function recallNavTarget(hit: RecallHit): RecallNavTarget {
  switch (hit.type) {
    case 'knowledge':
      return { page: 'knowledge', slug: knowledgeSlug(hit.path) };
    case 'feature':
      // PRDs live at knowledge/features/<slug>.md — path-derived like knowledge.
      return { page: 'knowledge', slug: knowledgeSlug(hit.path) };
    case 'task':
      return { page: 'tasks', slug: hit.slug };
    // Each of these channels HAS its own dashboard page, so a hit opens the
    // surface that actually renders it. Before this they fell through to the
    // `default` and opened the Core page on an empty slug — a dead end that
    // looked like the search had found nothing real.
    case 'objective':
      return { page: 'roadmap', slug: hit.slug };
    case 'insight':
      return { page: 'lab', slug: hit.slug };
    case 'thesis':
      return { page: 'hypotheses', slug: hit.slug };
    case 'automation':
      // A run-output hit (`run#<automation>-<date>`) opens the automation it
      // belongs to — the run detail lives inside that automation's panel.
      return { page: 'automations', slug: automationSlug(hit) };
    case 'changelog':
    case 'memory':
    default:
      return { page: 'core', slug: coreFileName(hit.path) };
  }
}
