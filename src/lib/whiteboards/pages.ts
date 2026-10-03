import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pageRefKind, type PageKind } from './widgets.js';

/**
 * The page search behind the board's page picker and wiki menu: knowledge entries (by slug)
 * plus project files a page can point at (`.md`, `.pdf`, `.html`, `.htm`, by project-relative
 * path). Every hit carries a `ref` that passes `isValidPageRef`, so the caller can drop it
 * straight into a widget or a wiki menu entry.
 *
 * Bounded on every axis: a depth cap, a visited-entry cap, a result cap. Symlinks are never
 * followed; `node_modules`, `.git`, `dist`, `build` and every dot-directory are skipped. The
 * walk is cached briefly per root, since the picker searches on every keystroke.
 */

export interface PageHit {
  /** What goes in a widget / wiki menu `ref`: a knowledge slug or a project-relative path. */
  ref: string;
  kind: PageKind;
  source: 'knowledge' | 'file';
  title: string;
  /** Project-relative path of the file, `/`-separated. */
  path: string;
}

export interface PageSearchResult {
  pages: PageHit[];
  /** True when more hits matched than were returned, or the walk hit its entry cap. */
  truncated: boolean;
}

export const PAGE_SEARCH_DEFAULT_LIMIT = 50;
export const PAGE_SEARCH_MAX_LIMIT = 200;
const MAX_DEPTH = 12;
const MAX_ENTRIES = 20_000;
const CACHE_MS = 10_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const CONTEXT_DIR = '_dream_context';

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** The `name:` from a markdown file's frontmatter, read from its first 4KB only. */
function frontmatterName(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString('utf-8');
    if (!head.startsWith('---')) return null;
    const end = head.indexOf('\n---', 3);
    const m = /^name:[ \t]*(.+)$/m.exec(end > 0 ? head.slice(0, end) : head);
    if (!m) return null;
    const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    return v && v !== '>-' && v !== '|' ? v : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface PageIndex {
  hits: PageHit[];
  capped: boolean;
}

const cache = new Map<string, { at: number; index: PageIndex }>();

function walk(dir: string, depth: number, visit: (file: string) => void, budget: { left: number }): void {
  if (depth > MAX_DEPTH || budget.left <= 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (budget.left-- <= 0) return;
    // Dirent types come from lstat: a symlink is neither a file nor a directory here.
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(full, depth + 1, visit, budget);
    } else if (e.isFile()) {
      visit(full);
    }
  }
}

/** Every page in the project: knowledge first (by slug), then files (by path). */
export function buildPageIndex(contextRoot: string): PageIndex {
  const projectRoot = dirname(contextRoot);
  const knowledgeRoot = join(contextRoot, 'knowledge');
  const hits: PageHit[] = [];
  const budget = { left: MAX_ENTRIES };

  walk(knowledgeRoot, 0, (file) => {
    if (!file.endsWith('.md')) return;
    const slug = toPosix(relative(knowledgeRoot, file)).slice(0, -3);
    const path = toPosix(relative(projectRoot, file));
    const ref = pageRefKind(slug) === 'knowledge' ? slug : path;
    if (!pageRefKind(ref)) return;
    hits.push({ ref, kind: 'md', source: 'knowledge', title: frontmatterName(file) ?? basename(slug), path });
  }, budget);

  const knowledgePrefix = `${toPosix(relative(projectRoot, knowledgeRoot))}/`;
  walk(projectRoot, 0, (file) => {
    const path = toPosix(relative(projectRoot, file));
    const kind = pageRefKind(path);
    if (kind !== 'md' && kind !== 'pdf' && kind !== 'html') return;
    // Knowledge markdown is already listed by slug; a whiteboard file is a board, not a page.
    if (kind === 'md' && path.startsWith(knowledgePrefix)) return;
    if (path.endsWith('.excalidraw.md')) return;
    hits.push({ ref: path, kind, source: 'file', title: basename(path), path });
  }, budget);

  return { hits, capped: budget.left <= 0 };
}

function cachedIndex(contextRoot: string, now: number): PageIndex {
  const hit = cache.get(contextRoot);
  if (hit && now - hit.at < CACHE_MS) return hit.index;
  const index = buildPageIndex(contextRoot);
  cache.set(contextRoot, { at: now, index });
  return index;
}

/** Drop the cached walk (tests; a caller that just wrote a file it wants found). */
export function clearPageIndexCache(): void {
  cache.clear();
}

/**
 * Search pages: every whitespace-separated term of `q` must appear (case-insensitive) in the
 * hit's title or ref. Ranked: title/basename starts with the query, then title contains it,
 * then the rest; knowledge before files; then by ref.
 */
export function searchPages(
  contextRoot: string,
  q: string,
  opts: { limit?: number; now?: number; kind?: PageKind } = {},
): PageSearchResult {
  const limit = Math.max(1, Math.min(PAGE_SEARCH_MAX_LIMIT, Math.floor(opts.limit ?? PAGE_SEARCH_DEFAULT_LIMIT)));
  const index = cachedIndex(contextRoot, opts.now ?? Date.now());
  const query = q.trim().toLowerCase().slice(0, 200);
  const terms = query.split(/\s+/).filter(Boolean);
  const scored: { hit: PageHit; score: number }[] = [];
  for (const hit of index.hits) {
    if (opts.kind && hit.kind !== opts.kind) continue;
    const title = hit.title.toLowerCase();
    const hay = `${title} ${hit.ref.toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    const base = basename(hit.ref).toLowerCase();
    const score = !query ? 0 : title.startsWith(query) || base.startsWith(query) ? 0 : title.includes(query) ? 1 : 2;
    scored.push({ hit, score: score * 2 + (hit.source === 'knowledge' ? 0 : 1) });
  }
  scored.sort((a, b) => a.score - b.score || (a.hit.ref < b.hit.ref ? -1 : a.hit.ref > b.hit.ref ? 1 : 0));
  return {
    pages: scored.slice(0, limit).map((s) => s.hit),
    truncated: scored.length > limit || index.capped,
  };
}
