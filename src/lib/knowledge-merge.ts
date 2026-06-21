import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import { rewriteWikilinks, WikilinkRemap } from './wikilink-rewrite.js';

export type KnowledgeMergeFailure =
  | 'unsafe-slug'
  | 'src-not-found'
  | 'dst-not-found'
  | 'same-file';

export interface KnowledgeMergeSuccess {
  ok: true;
  /** Source slug (path relative to knowledge/, without .md). */
  srcSlug: string;
  /** Destination slug (path relative to knowledge/, without .md). */
  dstSlug: string;
  /** Source path relative to contextRoot (e.g. `knowledge/foo.md`). */
  srcPath: string;
  /** Destination path relative to contextRoot (e.g. `knowledge/bar.md`). */
  dstPath: string;
  /** Absolute paths of files whose inbound [[wikilinks]] were rewritten. */
  wikilinksRewritten: string[];
  /** Tags that were present in src but not in dst (now added to dst). */
  tagsAdded: string[];
  /** Whether src body was actually appended (false = marker already present). */
  contentMerged: boolean;
}

export interface KnowledgeMergeError {
  ok: false;
  code: KnowledgeMergeFailure;
  message: string;
}

export type KnowledgeMergeResult = KnowledgeMergeSuccess | KnowledgeMergeError;

/** Strip `.md`, normalise separators, trim leading/trailing slashes + whitespace. */
function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

/** A path is safe when every segment is a real name (no '', '.', or '..'). */
function hasUnsafeSegment(p: string): boolean {
  return p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * Merge one knowledge file into another:
 *   - Repoints all inbound [[srcSlug]] wikilinks to [[dstSlug]]
 *   - Unions src tags into dst tags (dedupe)
 *   - Appends src body to dst body under a `<!-- merged-from: <srcSlug> -->` marker
 *   - Deletes src
 *
 * Ordering is crash-safe (mirrors moveKnowledgeFile):
 * 1. Rewrite wikilinks FIRST while src still exists.
 * 2. Write merged dst atomically (tmp + rename).
 * 3. Delete src.
 *
 * Idempotency: if the marker is already in dst body, the content append is skipped.
 * A re-run after a partial crash will find wikilinks already repointed (no-op),
 * marker present (no double-append), and will complete by deleting src.
 */
export function mergeKnowledgeFiles(
  contextRoot: string,
  rawSrcSlug: string,
  rawDstSlug: string,
): KnowledgeMergeResult {
  const knowledgeDir = join(contextRoot, 'knowledge');

  const srcSlug = normalizeSlug(rawSrcSlug);
  const dstSlug = normalizeSlug(rawDstSlug);

  // --- validate src slug ---
  if (!srcSlug || hasUnsafeSegment(srcSlug)) {
    return {
      ok: false,
      code: 'unsafe-slug',
      message: `Invalid source knowledge slug: "${rawSrcSlug}"`,
    };
  }

  // --- validate dst slug ---
  if (!dstSlug || hasUnsafeSegment(dstSlug)) {
    return {
      ok: false,
      code: 'unsafe-slug',
      message: `Invalid destination knowledge slug: "${rawDstSlug}"`,
    };
  }

  // --- src and dst must differ ---
  if (srcSlug === dstSlug) {
    return {
      ok: false,
      code: 'same-file',
      message: `Source and destination are the same file: "${srcSlug}"`,
    };
  }

  const srcAbsPath = join(knowledgeDir, `${srcSlug}.md`);
  const dstAbsPath = join(knowledgeDir, `${dstSlug}.md`);

  // --- containment: both paths must resolve strictly under knowledge/ ---
  // hasUnsafeSegment already rejects every '..'/'' segment and normalizeSlug
  // strips leading slashes, so no traversal can be constructed — this is a
  // belt-and-suspenders assertion mirroring moveKnowledgeFile, foreclosing any
  // future edge case (and symlink surprises) before a single fs touch.
  const knowledgeDirResolved = resolve(knowledgeDir);
  const srcResolved = resolve(srcAbsPath);
  const dstResolved = resolve(dstAbsPath);
  if (
    !srcResolved.startsWith(knowledgeDirResolved + sep) ||
    !dstResolved.startsWith(knowledgeDirResolved + sep)
  ) {
    return {
      ok: false,
      code: 'unsafe-slug',
      message: `Knowledge slug escapes knowledge/: "${rawSrcSlug}" → "${rawDstSlug}"`,
    };
  }

  // --- src must exist ---
  if (!existsSync(srcAbsPath)) {
    return {
      ok: false,
      code: 'src-not-found',
      message: `Source knowledge file not found: ${srcSlug}.md`,
    };
  }

  // --- dst must exist ---
  if (!existsSync(dstAbsPath)) {
    return {
      ok: false,
      code: 'dst-not-found',
      message: `Destination knowledge file not found: ${dstSlug}.md`,
    };
  }

  // Step 1 (crash-safe): rewrite inbound wikilinks BEFORE writing dst or deleting src.
  const remaps: WikilinkRemap[] = [{ from: srcSlug, to: dstSlug }];
  const wikilinksRewritten = rewriteWikilinks(contextRoot, remaps);

  // Parse both files with gray-matter.
  const srcRaw = readFileSync(srcAbsPath, 'utf-8');
  const dstRaw = readFileSync(dstAbsPath, 'utf-8');

  const srcParsed = matter(srcRaw);
  const dstParsed = matter(dstRaw);

  // Union tags: keep dst order first, then append any new ones from src.
  const dstTags: string[] = Array.isArray(dstParsed.data.tags)
    ? (dstParsed.data.tags as string[])
    : [];
  const srcTags: string[] = Array.isArray(srcParsed.data.tags)
    ? (srcParsed.data.tags as string[])
    : [];

  const tagsAdded: string[] = [];
  for (const tag of srcTags) {
    if (!dstTags.includes(tag)) {
      tagsAdded.push(tag);
    }
  }
  const mergedTags = [...dstTags, ...tagsAdded];

  // Check idempotency: is the marker already in dst body?
  const marker = `<!-- merged-from: ${srcSlug} -->`;
  const dstBody = dstParsed.content;
  const contentMerged = !dstBody.includes(marker);

  let newDstBody: string;
  if (contentMerged) {
    // Append src body under the marker.
    const srcBody = srcParsed.content.trim();
    const dstBodyTrimmed = dstBody.trimEnd();
    newDstBody = `${dstBodyTrimmed}\n\n${marker}\n\n${srcBody}\n`;
  } else {
    newDstBody = dstBody;
  }

  // Build new dst frontmatter data (keep all dst fields, update tags).
  const newDstData = { ...dstParsed.data, tags: mergedTags };

  // Step 2: write merged dst atomically (tmp + rename).
  const newDstContent = matter.stringify(newDstBody, newDstData);
  const tmpPath = dstAbsPath + '.km-tmp';
  try {
    mkdirSync(dirname(tmpPath), { recursive: true });
    writeFileSync(tmpPath, newDstContent, 'utf-8');
    renameSync(tmpPath, dstAbsPath);
  } catch (e) {
    // Clean up tmp on failure.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch { /* ignore */ }
    throw e;
  }

  // Step 3: delete src.
  unlinkSync(srcAbsPath);

  return {
    ok: true,
    srcSlug,
    dstSlug,
    srcPath: `knowledge/${srcSlug}.md`,
    dstPath: `knowledge/${dstSlug}.md`,
    wikilinksRewritten,
    tagsAdded,
    contentMerged,
  };
}
