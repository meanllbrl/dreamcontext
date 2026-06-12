import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFrontmatter } from './frontmatter.js';
import { generateId } from './id.js';
import { readSleepState, writeSleepState } from '../cli/commands/sleep.js';
import { slugFromTitle } from './federation-digest.js';
import type { DigestEntry } from './federation-inbox.js';

export interface IngestResult {
  /** Absolute path of the doc written (the canonical or the namespaced fallback). */
  path: string;
  /** The slug actually used (may be `<slug>--from-<vault>` on collision). */
  slug: string;
  /** True iff a slug collision forced the `--from-<vault>` namespaced fallback. */
  collided: boolean;
  /** True iff a conflict-note was ALSO surfaced as a bookmark (never auto-resolved). */
  bookmarked: boolean;
}

/**
 * Ingest one drained {@link DigestEntry} as FIRST-CLASS local knowledge (P3.1).
 *
 * - The doc lands in `knowledge/<slug>.md` (slug derived from the title).
 * - Its frontmatter carries `federated: true` + `origin{vault,entryId,
 *   sourceTimestamp}` so it is recognised as ingested (and EXCLUDED from onward
 *   cross-vault serving + digest — the transitive-leak guard reads this flag).
 * - Slug COLLISION with an existing local doc → `knowledge/<slug>--from-<vault>.md`
 *   instead, so a peer's doc NEVER clobbers a local one (P3.2). The namespaced
 *   file is itself written if-absent (re-ingest is idempotent).
 * - A `conflict-note` entry is ingested AND ALSO surfaced as a bookmark / known
 *   issue for the user — it is NEVER auto-resolved (P3.7).
 */
export function ingestEntry(contextRoot: string, entry: DigestEntry): IngestResult {
  const knowledgeDir = join(contextRoot, 'knowledge');
  mkdirSync(knowledgeDir, { recursive: true });

  const baseSlug = slugFromTitle(entry.title);
  const canonicalPath = join(knowledgeDir, `${baseSlug}.md`);

  // Collision → namespace by origin vault, never clobber the local doc.
  const collided = existsSync(canonicalPath);
  const slug = collided
    ? `${baseSlug}--from-${sanitizeVault(entry.origin.vault)}`
    : baseSlug;
  const targetPath = join(knowledgeDir, `${slug}.md`);

  // Re-ingest of an already-written federated doc is idempotent: skip if present.
  if (!existsSync(targetPath)) {
    writeFrontmatter(
      targetPath,
      {
        name: entry.title,
        description: entry.summary,
        type: 'knowledge',
        tags: federationTags(entry),
        federated: true,
        origin: {
          vault: entry.origin.vault,
          entryId: entry.origin.entryId,
          sourceTimestamp: entry.origin.sourceTimestamp,
        },
        date: new Date().toISOString().slice(0, 10),
      },
      buildBody(entry),
    );
  }

  let bookmarked = false;
  if (entry.kind === 'conflict-note') {
    bookmarked = surfaceConflictBookmark(contextRoot, entry, slug);
  }

  return { path: targetPath, slug, collided, bookmarked };
}

/** Tags applied to every ingested doc: a `federated` marker + the origin vault. */
function federationTags(entry: DigestEntry): string[] {
  return ['federated', `from:${entry.origin.vault}`];
}

/** Build the markdown body: the summary plus a provenance footer + source links. */
function buildBody(entry: DigestEntry): string {
  const lines: string[] = [];
  lines.push(entry.summary.trim());
  lines.push('');
  lines.push('---');
  lines.push(
    `_Federated from **${entry.origin.vault}** (entry \`${entry.origin.entryId}\`). ` +
      `Provenance only — edit in the source vault, not here._`,
  );
  if (entry.links.length > 0) {
    lines.push('');
    lines.push('Source paths:');
    for (const link of entry.links) lines.push(`- \`${link}\``);
  }
  return lines.join('\n') + '\n';
}

/**
 * Surface a conflict-note as a bookmark so the user is alerted — the conflict is
 * NEVER auto-resolved. Reuses the same sleep-state bookmark store the
 * `bookmark` CLI writes to (salience 3 = critical). Idempotent: a bookmark for
 * this exact federated entry is added only once.
 */
function surfaceConflictBookmark(contextRoot: string, entry: DigestEntry, slug: string): boolean {
  const message =
    `Federation conflict: peer "${entry.origin.vault}" sent "${entry.title}" which collides ` +
    `with local knowledge. Ingested as knowledge/${slug}.md (federated) — review and reconcile ` +
    `manually; NOT auto-resolved.`;

  const state = readSleepState(contextRoot);
  // De-dup: never add a second bookmark for the same federated entry id.
  const marker = `[federation:${entry.id}]`;
  if (state.bookmarks.some((b) => typeof b.message === 'string' && b.message.includes(marker))) {
    return false;
  }
  state.bookmarks.unshift({
    id: generateId('bm'),
    message: `${message} ${marker}`,
    salience: 3,
    created_at: new Date().toISOString(),
    session_id: null,
    task_slug: null,
  });
  writeSleepState(contextRoot, state);
  return true;
}

/** Sanitise a vault name for use inside a filename slug (`[a-z0-9-]`). */
function sanitizeVault(vault: string): string {
  const cleaned = String(vault)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'peer';
}
