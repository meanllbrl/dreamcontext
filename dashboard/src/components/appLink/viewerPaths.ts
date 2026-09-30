/**
 * Pure path rules for the document viewer window: how a reference written INSIDE a document
 * (`![chart](chart.png)`, `[the data](../data.csv)`) becomes the project-relative path the file
 * route serves. Kept framework-free so the rules are tested on their own.
 */

/** A reference the viewer resolves itself, rather than an ordinary link or an inline asset. */
export function isDocumentRelativeRef(ref: string): boolean {
  if (!ref) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // http:, data:, blob:, mailto:, dreamcontext:
  if (ref.startsWith('#') || ref.startsWith('/') || ref.startsWith('~')) return false;
  return true;
}

/** The folder a project-relative file sits in (`''` for a file at the root). */
export function parentDir(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * Resolve `ref` (as written in the document at `docPath`) to a project-relative path, or null
 * when it is not document-relative or climbs out of the project. Percent-escapes are decoded
 * (`my%20chart.png` names `my chart.png`), and any `?query`/`#fragment` is dropped: the file
 * route takes a path, not a URL.
 */
export function resolveDocumentRef(docPath: string, ref: string): string | null {
  if (!isDocumentRelativeRef(ref)) return null;
  let clean = ref.split(/[?#]/)[0];
  try {
    clean = decodeURIComponent(clean);
  } catch { /* a stray `%` is just a character in a file name */ }
  if (!clean) return null;
  const out: string[] = [];
  for (const part of `${parentDir(docPath)}/${clean}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length ? out.join('/') : null;
}

/** The markdown without its leading YAML frontmatter block, which reads as noise when drawn. */
export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

/** The last segment of a path, for the window's drag bar. */
export function fileNameOf(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}
