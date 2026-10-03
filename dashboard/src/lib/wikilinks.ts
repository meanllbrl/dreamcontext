/**
 * `[[target]]` and `[[target|label]]` — the brain's own link notation — found in markdown and
 * turned into something a reader can click.
 *
 * Pure: no React, no DOM. Root vitest imports this file.
 *
 * WHERE A WIKILINK IS NOT ONE. Inside a fenced code block (``` or ~~~) and inside an inline code
 * span (`…`) the brackets are literal text: a doc that shows the notation must not have its
 * example turned into a link. A backslash before the opening brackets (`\[[x]]`) escapes it the
 * same way, and markdown then renders the `\[` as a plain `[`.
 *
 * THE PIPE IN A TABLE. GFM splits a table row on `|`, so inside a table the label separator has
 * to be written `\|` (Obsidian's convention). Both spellings separate target from label.
 */

export interface Wikilink {
  /** What the link points at, trimmed: a knowledge slug, a file name, a title or a path. */
  target: string;
  /** What the reader sees: the label after the pipe, else the target itself. */
  label: string;
}

/** `[[`, then anything but brackets and newlines (non-greedy), then `]]`. */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Split the inside of `[[…]]` into target and label. Null when there is no target. */
export function parseWikilink(inner: string): Wikilink | null {
  const sep = inner.search(/\\?\|/);
  const rawTarget = sep === -1 ? inner : inner.slice(0, sep);
  const rawLabel = sep === -1 ? '' : inner.slice(sep + (inner[sep] === '\\' ? 2 : 1));
  const target = rawTarget.trim();
  if (!target) return null;
  const label = rawLabel.trim() || target;
  return { target, label };
}

/** Rewrite the wikilinks in ONE line of prose, leaving inline code spans and escapes alone. */
function replaceInLine(line: string, render: (link: Wikilink) => string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    // An inline code span: a run of N backticks up to the next run of exactly N. An unclosed
    // run is literal backticks (CommonMark), so only the run itself is skipped.
    if (line[i] === '`') {
      let n = 0;
      while (line[i + n] === '`') n += 1;
      const fence = '`'.repeat(n);
      let close = -1;
      let from = i + n;
      while (from <= line.length) {
        const at = line.indexOf(fence, from);
        if (at === -1) break;
        let len = 0;
        while (line[at + len] === '`') len += 1;
        if (len === n) { close = at; break; }
        from = at + len;
      }
      const end = close === -1 ? i + n : close + n;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    if (line[i] === '\\' && line.startsWith('[[', i + 1)) {
      out += line.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (line.startsWith('[[', i)) {
      WIKILINK_RE.lastIndex = i;
      const m = WIKILINK_RE.exec(line);
      if (m && m.index === i) {
        const link = parseWikilink(m[1]);
        if (link) {
          out += render(link);
          i += m[0].length;
          continue;
        }
      }
    }
    out += line[i];
    i += 1;
  }
  return out;
}

/**
 * Every wikilink in `markdown` outside code, replaced by `render(link)`. Text with no `[[` is
 * returned as the same string.
 */
export function replaceWikilinks(markdown: string, render: (link: Wikilink) => string): string {
  if (!markdown.includes('[[')) return markdown;
  const lines = markdown.split('\n');
  let fence: { char: string; len: number } | null = null;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const open = FENCE_RE.exec(line);
    if (fence) {
      // A closing fence: the same character, at least as long, and nothing after it.
      if (open && open[1][0] === fence.char && open[1].length >= fence.len && !line.slice(open[0].length).trim()) {
        fence = null;
      }
      continue;
    }
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      continue;
    }
    if (line.includes('[[')) lines[n] = replaceInLine(line, render);
  }
  return lines.join('\n');
}

/** Every wikilink in `markdown` outside code, in order. */
export function findWikilinks(markdown: string): Wikilink[] {
  const found: Wikilink[] = [];
  replaceWikilinks(markdown, (link) => { found.push(link); return ''; });
  return found;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The attribute a rendered wikilink carries its target on. */
export const WIKILINK_ATTR = 'data-wikilink';

/**
 * The markup a wikilink becomes inside markdown: an anchor WITHOUT an `href`, so nothing that
 * rewrites or intercepts `a[href]` (a viewer resolving document-relative links, the chat's
 * inline-media pass) ever sees it, and a click that nobody handles goes nowhere.
 */
export function wikilinkHtml(link: Wikilink): string {
  return `<a class="md-wikilink" ${WIKILINK_ATTR}="${escapeHtml(link.target)}">${escapeHtml(link.label)}</a>`;
}

/** Markdown with its wikilinks rendered as {@link wikilinkHtml} anchors. */
export function markdownWithWikilinks(markdown: string): string {
  return replaceWikilinks(markdown, wikilinkHtml);
}

/** What a wikilink can resolve against: a knowledge entry as the list route reports it. */
export interface WikilinkCandidate {
  /** Path under `_dream_context/knowledge/` without `.md`, e.g. `features/whiteboards`. */
  slug: string;
  /** The entry's title (frontmatter `name`). */
  name?: string;
}

/** The project-relative file a knowledge slug lives in. */
export function knowledgeSlugPath(slug: string): string {
  return `_dream_context/knowledge/${slug}.md`;
}

/** A target that names a file by path or extension, rather than a knowledge entry by name. */
function looksLikePath(target: string): boolean {
  return target.includes('/') || /\.[a-z0-9]{1,8}$/i.test(target);
}

/**
 * Resolve a wikilink target to a project-relative path, or null when nothing matches.
 *
 * Against the knowledge list first, case-insensitive, in order of how exact the match is: the
 * slug, the slug's file name, then the title. A `#heading` suffix and a trailing `.md` are
 * ignored for the match. Failing that, a target written as a path (`docs/spec.pdf`) is taken
 * as one, relative to the project; a leading `./` or `/` is dropped.
 */
export function resolveWikilinkTarget(target: string, candidates: readonly WikilinkCandidate[]): string | null {
  const bare = target.split('#')[0].trim();
  if (!bare) return null;
  const key = bare.replace(/\.md$/i, '').replace(/^\.?\//, '').toLowerCase();
  const knowledgeKey = key.replace(/^_dream_context\/knowledge\//, '');

  const bySlug = candidates.find((c) => c.slug.toLowerCase() === knowledgeKey);
  if (bySlug) return knowledgeSlugPath(bySlug.slug);
  const byFile = candidates.find((c) => (c.slug.split('/').pop() ?? '').toLowerCase() === knowledgeKey);
  if (byFile) return knowledgeSlugPath(byFile.slug);
  const byTitle = candidates.find((c) => (c.name ?? '').trim().toLowerCase() === bare.toLowerCase());
  if (byTitle) return knowledgeSlugPath(byTitle.slug);

  if (looksLikePath(bare)) {
    const path = bare.replace(/^\.?\/+/, '');
    if (path && !path.split('/').includes('..')) return path;
  }
  return null;
}
