/**
 * Where a link written INSIDE a knowledge document actually points.
 *
 * A knowledge note is prose about material that often isn't: `[the contract](assets/msa.pdf)`
 * beside the note distilled from it. The href is a filesystem path relative to the note, which
 * no browser can load and which the app-wide link guard (`isContainedHref`) only knows how to
 * NEUTRALISE — it stops the click from rebooting the SPA, and deliberately leaves the click
 * propagating so a surface can give the link a meaning. This module is the Knowledge page's
 * half of that bargain: it says which vault file the href means, so the page can open it.
 *
 * Pure string work — no filesystem, no network — so it is safe on every click and testable
 * without a vault.
 */

/** Paths are answered relative to the vault root (`_dream_context/`), which is exactly what
 *  `GET /api/graph/content?path=` takes. */
export const KNOWLEDGE_DIR = 'knowledge';

/** The `_dream_context/` prefix, which an agent-written link sometimes carries in full. */
const VAULT_PREFIX_RE = /^_dream_context\//;

/**
 * Collapse `.` and `..` segments the way a path resolver would, WITHOUT letting the result
 * climb out of where it started. A `../../..` chain that would escape the vault resolves to
 * the vault root instead of to a parent — the server refuses such a path anyway, but a
 * resolver that can only produce contained paths means the refusal is never reached by
 * accident, and the containment story doesn't rest on one endpoint's check alone.
 */
function normalizeSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

/**
 * The vault-relative path a knowledge document's link points at, or `null` when the href is
 * not a vault file at all (an http(s) URL, a `#fragment`, a `mailto:`, an absolute filesystem
 * path — that last one belongs to the chat surface's file route, which knows about grants).
 *
 * `slug` is the open document's knowledge slug (`legal/contracts`, no extension), and links
 * resolve relative to the document's own FOLDER, which is what a reader writing
 * `assets/msa.pdf` in `legal/contracts.md` means. A slug's last segment is the file, never a
 * folder, so it is always dropped first.
 *
 * A link that already names the path from the vault root — `_dream_context/knowledge/x.pdf`,
 * which is how an agent tends to write one — is taken as written rather than re-anchored, or
 * it would resolve under the current folder and point at nothing.
 */
export function knowledgeLinkTarget(slug: string, href: string): string | null {
  const raw = (href ?? '').trim();
  if (!raw) return null;
  // Anything with a scheme, a fragment, or a root anchor is somebody else's business —
  // `externalLinks.ts` routes the first to the OS browser and the last to the app router.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('/')) return null;
  // Strip a query/fragment before resolving: `msa.pdf#page=4` names the same file.
  const clean = raw.split(/[?#]/)[0];
  if (!clean) return null;

  const fromVaultRoot = VAULT_PREFIX_RE.test(clean);
  const base = fromVaultRoot
    ? []
    // Drop the document's own filename: `legal/contracts` sits in `knowledge/legal/`.
    : [KNOWLEDGE_DIR, ...normalizeSegments(String(slug).split('/')).slice(0, -1)];

  const segments = normalizeSegments([...base, ...clean.replace(VAULT_PREFIX_RE, '').split('/')]);
  return segments.length ? segments.join('/') : null;
}

/** Is this href a PDF? Extension only, and only after any query/fragment is dropped, so
 *  `msa.pdf#page=4` (a real way to link a page) still reads as a PDF. */
export function isPdfHref(href: string): boolean {
  return /\.pdf$/i.test((href ?? '').trim().split(/[?#]/)[0]);
}
