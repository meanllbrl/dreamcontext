import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { EXT_BY_IMAGE_TYPE, type ImageMimeType } from '../image-sniff.js';

/**
 * GitHub task-image bridge.
 *
 * A task body authored locally can embed an image by a LOCAL path — most often
 * an agent-drop screenshot under `_dream_context/tmp/agent-drops/…`. Pushed
 * verbatim, that path is meaningless to GitHub and the issue shows a broken
 * image. To make it RESOLVE, the bytes are committed to a dedicated assets
 * branch (over the REST Contents API — never the local working tree) and the
 * reference is rewritten to GitHub's hosted URL on the wire.
 *
 * Like the dates/fields blocks, this is a wire-only transform: the mirror body
 * keeps the canonical LOCAL path, and pull maps the hosted URL back to that
 * local path before the 3-way merge — so an image reference never churns.
 *
 * This module holds the PURE pieces (markdown parsing, local-path detection /
 * resolution, the content-addressed remote path + URL scheme). The network I/O
 * (branch-ensure + Contents PUT) lives on the backend, which owns the adapter.
 */

/** The branch local task images are committed to (isolated from the default branch). */
export const ASSETS_BRANCH = 'dreamcontext-assets';

export interface ImageRef {
  /** The full matched markdown, e.g. `![alt](path "title")`. */
  match: string;
  /** 0-based index of `match` within the source body. */
  index: number;
  /** The destination as authored — no surrounding `<>`, no title. */
  dest: string;
}

// Inline markdown image: ![alt](inside). `inside` is captured whole and parsed
// by parseInside (dest + optional title). A `)` inside the destination would
// terminate early — local file paths and https URLs never contain one, so this
// stays simple and predictable rather than a full CommonMark parser.
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;

interface ParsedInside {
  /** Leading whitespace inside the parens (preserved on reconstruction). */
  leadWs: string;
  /** The bare destination (path or URL). */
  dest: string;
  /** Everything after the destination (whitespace + optional title), verbatim. */
  titleSuffix: string;
}

/** Split the inside-of-parens into its destination and the trailing title, preserving bytes. */
function parseInside(inside: string): ParsedInside | null {
  const leadWs = (inside.match(/^\s*/)?.[0]) ?? '';
  const rest = inside.slice(leadWs.length);
  if (rest.startsWith('<')) {
    const close = rest.indexOf('>');
    if (close === -1) return null;
    return { leadWs, dest: rest.slice(1, close), titleSuffix: rest.slice(close + 1) };
  }
  const m = rest.match(/^(\S+)([\s\S]*)$/);
  if (!m) return null;
  return { leadWs, dest: m[1], titleSuffix: m[2] };
}

/** Every inline image reference in a body, in source order. */
export function extractImageRefs(body: string): ImageRef[] {
  const out: ImageRef[] = [];
  for (const m of body.matchAll(IMAGE_RE)) {
    const parsed = parseInside(m[2]);
    if (!parsed) continue;
    out.push({ match: m[0], index: m.index ?? 0, dest: parsed.dest });
  }
  return out;
}

/**
 * Rewrite image destinations via `map` (dest → new dest). A `null`/missing entry
 * leaves the reference untouched. Alt text and any title are preserved verbatim;
 * a destination containing whitespace is wrapped in `<>` so it stays valid.
 */
export function rewriteImageRefs(body: string, map: (dest: string) => string | null): string {
  return body.replace(IMAGE_RE, (whole, alt: string, inside: string) => {
    const parsed = parseInside(inside);
    if (!parsed) return whole;
    const next = map(parsed.dest);
    if (next === null || next === parsed.dest) return whole;
    const destOut = /\s/.test(next) ? `<${next}>` : next;
    return `![${alt}](${parsed.leadWs}${destOut}${parsed.titleSuffix})`;
  });
}

/**
 * Is this image destination a LOCAL filesystem reference (vs something GitHub
 * can already fetch)? Anything with a URL scheme, a protocol-relative `//`, a
 * pure in-page `#anchor`, or a `{{template}}` placeholder is left alone.
 */
export function isLocalImageRef(dest: string): boolean {
  const d = dest.trim();
  if (!d) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(d)) return false; // http:, https:, data:, mailto:, file:, …
  if (d.startsWith('//')) return false;             // protocol-relative
  if (d.startsWith('#')) return false;              // in-page anchor
  if (d.startsWith('{{')) return false;             // unrendered template token
  return true;
}

/**
 * True when `candidate` resolves to a path inside `root` (lexical containment —
 * no symlink following, matching the codebase's {@link safeChildPath} threat
 * model). A local copy lives here so this lib stays free of any server import.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep);
}

/**
 * Resolve a local image destination to an absolute path that exists on disk.
 * Absolute paths are used as-is; relative paths are tried against each base in
 * order (first hit wins). Percent-encoding is decoded best-effort.
 *
 * When `root` is supplied, every candidate MUST resolve to a path inside it —
 * an absolute path escaping the root, or a `../` traversal, yields null. This is
 * the hard boundary that stops a remotely-pulled issue body from pointing the
 * uploader at an arbitrary file on the victim's machine. Returns null when
 * nothing resolves to a contained, regular file.
 */
export function resolveLocalImagePath(dest: string, bases: string[], root?: string): string | null {
  let d = dest.trim();
  try { d = decodeURIComponent(d); } catch { /* keep the raw form */ }
  if (!d || d.includes('\0')) return null;
  const candidates = isAbsolute(d) ? [d] : bases.map((b) => join(b, d));
  for (const c of candidates) {
    if (root && !isInsideRoot(root, c)) continue;
    try {
      if (existsSync(c) && statSync(c).isFile()) return resolve(c);
    } catch { /* unreadable candidate — try the next */ }
  }
  return null;
}

/**
 * Content-addressed repo path for an uploaded asset: `assets/<sha>.<ext>` (on the
 * dedicated assets branch). Keying on the byte hash dedupes identical images and
 * makes re-pushes idempotent — the same bytes always target the same path.
 */
export function assetRemotePath(contentSha: string, type: ImageMimeType): string {
  return `assets/${contentSha}${EXT_BY_IMAGE_TYPE[type]}`;
}

/**
 * The hosted URL that renders the committed asset inside a GitHub issue. The
 * `github.com/<owner>/<repo>/raw/<branch>/<path>` form is camo-proxied by GitHub,
 * so it renders for both public repos and authenticated viewers of private ones.
 */
export function assetRemoteUrl(owner: string, repo: string, remotePath: string): string {
  const encoded = remotePath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${owner}/${repo}/raw/${ASSETS_BRANCH}/${encoded}`;
}
