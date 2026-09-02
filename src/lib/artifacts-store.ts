import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter } from './frontmatter.js';
import { today } from './id.js';

/**
 * Saved blocks — `_dream_context/artifacts/<slug>.md`.
 *
 * WHY THIS ENTITY EXISTS (owner feature request, 2026-08-29). A `dream-html` block that
 * answered something well was trapped in the transcript: to find it three weeks later you
 * scrolled, and to share it you screenshotted. Six hand-written copies landed on one desktop
 * in a week, none of them searchable and none carrying the conversation they came from.
 *
 * WHY IT IS NOT A LAB REPORT ITEM, which is the obvious-looking home. A Lab report OWNS NO
 * DATA — `reports-store.ts` says so in its header and its item type is literally
 * `{ insight: <slug> }`, a reference resolved against a live cache at read time, with dated
 * snapshots and an honest "as of". A saved block is the exact opposite: frozen pixels-worth
 * of markup with no source to re-resolve and no date to navigate. Filing one as a report
 * item would mean either faking a sync path it does not have, or widening "report item"
 * until it means nothing. The owner's own wording for the report layer settles it too —
 * "birkaç kayıtlı blok + metin", blocks and prose, not blocks and live charts.
 *
 * What the two DO share is the look, and that is shared deliberately: the composed report
 * (`artifactReportToHtml`) reuses the Reports masthead and print rules, so an exported set
 * of blocks is recognisably the same family of document without pretending to be one.
 *
 * TWO REPRESENTATIONS IN ONE FILE, on purpose:
 *   • the fenced ```dream-html block is the artifact — byte-exact, re-openable, re-exportable;
 *   • the prose above it is its TEXT, extracted at save time, and that is what recall reads.
 * Indexing the markup instead would make every artifact match on "div", "span" and "dc-doc"
 * and match on none of the words a human would actually search for.
 */

export interface ArtifactMeta {
  slug: string;
  title: string;
  /** ISO date the block was saved. */
  created: string;
  /** The conversation it was drawn in — the provenance the request names explicitly. */
  sourceTitle: string | null;
  /** The session id, when the caller knows it: lets the UI offer "open that chat". */
  sourceSession: string | null;
  tags: string[];
  path: string;
}

export interface Artifact extends ArtifactMeta {
  /** The block's markup, exactly as it was on screen when it was saved. */
  html: string;
  /** The visible text, extracted at save time. What recall matches on. */
  text: string;
}

export class ArtifactError extends Error {}

export function artifactsDir(contextRoot: string): string {
  return join(contextRoot, 'artifacts');
}

export function artifactPath(contextRoot: string, slug: string): string {
  return join(artifactsDir(contextRoot), `${slug}.md`);
}

/**
 * A slug that cannot leave the artifacts directory.
 *
 * The name comes from a text field a user types, and it is turned into a path — so this is
 * a traversal gate, not a tidiness rule. Mirrors `isSafeInsightSlug` in the Lab store.
 */
export function isSafeArtifactSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) && !slug.includes('..');
}

/** Turkish before ASCII: these titles are mostly Turkish, and stripping the diacritics
 *  instead of mapping them turns "Pay el değiştiriyor" into a slug nobody can find. */
const TR_MAP: Record<string, string> = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o',
  ş: 's', Ş: 's', ü: 'u', Ü: 'u',
};

export function slugifyArtifact(title: string): string {
  const base = [...(title || '')]
    .map((ch) => TR_MAP[ch] ?? ch)
    .join('')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return base || 'block';
}

/** `<slug>`, or `<slug>-2`, `<slug>-3`… — saving twice under one name must not silently
 *  overwrite the first one. */
export function uniqueArtifactSlug(contextRoot: string, desired: string): string {
  let slug = desired;
  let n = 2;
  while (existsSync(artifactPath(contextRoot, slug))) {
    slug = `${desired}-${n}`.slice(0, 80).replace(/-+$/, '');
    n += 1;
  }
  return slug;
}

/**
 * The visible words of a block, for the recall body.
 *
 * Deliberately crude — drop script and style wholesale, drop every tag, unescape the five
 * entities that matter, collapse whitespace. A real parser is not available here (this is
 * the CLI, with no DOM) and would buy nothing: the goal is a bag of the words a human would
 * search for, not a faithful rendering.
 */
export function extractBlockText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const FENCE_RE = /```dream-html\r?\n([\s\S]*?)\r?\n```/;

function parseArtifact(file: string): Artifact | null {
  try {
    const { data, content } = readFrontmatter(file);
    const slug = basename(file, '.md');
    const m = content.match(FENCE_RE);
    // No fence = not an artifact. LENIENT, like every other store here: a stray file in
    // the folder is skipped, never a throw that takes the whole list down with it.
    if (!m) return null;
    const html = m[1];
    const text = content.slice(0, content.indexOf('```dream-html')).trim();
    return {
      slug,
      title: String(data.title ?? data.name ?? slug),
      created: String(data.created ?? ''),
      sourceTitle: data.source_title ? String(data.source_title) : null,
      sourceSession: data.source_session ? String(data.source_session) : null,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      path: file,
      html,
      text,
    };
  } catch {
    return null;
  }
}

export interface SaveArtifactInput {
  title: string;
  html: string;
  sourceTitle?: string | null;
  sourceSession?: string | null;
  tags?: string[];
  /** Overwrite this exact slug instead of allocating a fresh one (a re-save). */
  slug?: string;
}

/** Writes are STRICT — mirrors the Lab stores. A bad save must fail loudly. */
export function saveArtifact(contextRoot: string, input: SaveArtifactInput): Artifact {
  const title = input.title.trim();
  if (!title) throw new ArtifactError('An artifact needs a name.');
  const html = input.html;
  if (!html.trim()) throw new ArtifactError('There is nothing to save — the block is empty.');

  const dir = artifactsDir(contextRoot);
  mkdirSync(dir, { recursive: true });

  const slug = input.slug ?? uniqueArtifactSlug(contextRoot, slugifyArtifact(title));
  if (!isSafeArtifactSlug(slug)) throw new ArtifactError(`Unsafe artifact name: ${slug}`);

  const text = extractBlockText(html);
  const body = [
    text,
    '',
    '## Block',
    '',
    '```dream-html',
    html,
    '```',
    '',
  ].join('\n');

  writeFrontmatter(artifactPath(contextRoot, slug), {
    // `name` is what recall titles a doc by (see loadMarkdownDocs) — keep both so the
    // artifact reads correctly in the corpus AND in its own store.
    name: title,
    title,
    type: 'artifact',
    created: today(),
    ...(input.sourceTitle ? { source_title: input.sourceTitle } : {}),
    ...(input.sourceSession ? { source_session: input.sourceSession } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
  }, body);

  const saved = getArtifact(contextRoot, slug);
  if (!saved) throw new ArtifactError('The artifact did not read back after writing.');
  return saved;
}

export function getArtifact(contextRoot: string, slug: string): Artifact | null {
  if (!isSafeArtifactSlug(slug)) return null;
  const file = artifactPath(contextRoot, slug);
  return existsSync(file) ? parseArtifact(file) : null;
}

/** Newest first — a saved-blocks list is a recency list, that is how it gets used. */
export function listArtifacts(contextRoot: string): ArtifactMeta[] {
  const dir = artifactsDir(contextRoot);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true });
  const out: ArtifactMeta[] = [];
  for (const file of files) {
    const a = parseArtifact(file);
    if (a) {
      const { html: _html, text: _text, ...meta } = a;
      out.push(meta);
    }
  }
  return out.sort((a, b) => (b.created.localeCompare(a.created) || a.title.localeCompare(b.title)));
}

export function deleteArtifact(contextRoot: string, slug: string): boolean {
  if (!isSafeArtifactSlug(slug)) return false;
  const file = artifactPath(contextRoot, slug);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
