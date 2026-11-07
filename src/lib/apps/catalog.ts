/**
 * The project's app catalog (app-araclari plan r3 §2): `_dream_context/app-catalog.json`, in the
 * brain's git, so a teammate's agent learns "this project HAS app X, installable from Y". It
 * never carries a tool's path, inputs, data or an e-mail: only titles. The tool list an agent may
 * CALL comes from the apps installed on this Mac (`listApps` → `readManifest`), never from here.
 *
 * Written only by a successful publish; removed only by the owner's `apps catalog remove`. An
 * entry is never deleted because something else is missing (a-delete-is-never-inferred).
 * Read as untrusted (a teammate wrote it): no symlink, broken JSON = empty, a bad repo name
 * skips the entry, every text is one clean line.
 */

import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { APP_SLUG_RE } from './bundle.js';
import { cleanText, effectOf, type AppManifest, type ToolEffect } from './manifest.js';

export const CATALOG_FILE = 'app-catalog.json';
export const CATALOG_TOOLS_MAX = 12;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PERSON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CatalogTool { id: string; title: string; effect: ToolEffect }

export interface CatalogEntry {
  slug: string;
  name: string;
  does: string;
  repo: string;
  visibility: 'private' | 'public';
  publishedBy: string | null;
  tools: CatalogTool[];
  at: string;
}

/** The catalog path when it is a plain file inside the context root, else null. */
function catalogPath(contextRoot: string): string | null {
  const file = join(contextRoot, CATALOG_FILE);
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const r = relative(realpathSync(contextRoot), realpathSync(file));
    if (r !== CATALOG_FILE || isAbsolute(r)) return null;
    return file;
  } catch {
    return null;
  }
}

function parseEntry(v: unknown): CatalogEntry | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const slug = typeof o.slug === 'string' ? o.slug : '';
  const repo = typeof o.repo === 'string' ? o.repo : '';
  if (!APP_SLUG_RE.test(slug) || !REPO_RE.test(repo)) return null;
  const name = typeof o.name === 'string' ? cleanText(o.name, 60) : '';
  if (!name) return null;
  const tools: CatalogTool[] = [];
  if (Array.isArray(o.tools)) {
    for (const t of o.tools.slice(0, CATALOG_TOOLS_MAX)) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as Record<string, unknown>;
      const id = typeof tt.id === 'string' && APP_SLUG_RE.test(tt.id) ? tt.id : '';
      const title = typeof tt.title === 'string' ? cleanText(tt.title, 120) : '';
      if (!id || !title) continue;
      tools.push({ id, title, effect: tt.effect === 'read' ? 'read' : 'change' });
    }
  }
  const by = typeof o.publishedBy === 'string' && PERSON_RE.test(o.publishedBy) ? o.publishedBy : null;
  return {
    slug, name, repo, tools,
    does: typeof o.does === 'string' ? cleanText(o.does, 160) : '',
    visibility: o.visibility === 'public' ? 'public' : 'private',
    publishedBy: by,
    at: typeof o.at === 'string' ? cleanText(o.at, 40) : '',
  };
}

/** Every well-formed entry, by slug (the last one written for a slug wins). Never throws. */
export function readCatalog(contextRoot: string): CatalogEntry[] {
  const file = catalogPath(contextRoot);
  if (!file) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf-8')); } catch { return []; }
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { apps?: unknown }).apps) ? (raw as { apps: unknown[] }).apps : [];
  const bySlug = new Map<string, CatalogEntry>();
  for (const v of list.slice(0, 200)) {
    const e = parseEntry(v);
    if (e) bySlug.set(e.slug, e);
  }
  return [...bySlug.values()];
}

/** The catalog file's mtime, 0 when there is none (a cache key part). */
export function catalogMtime(contextRoot: string): number {
  const f = catalogPath(contextRoot);
  if (!f) return 0;
  try { return lstatSync(f).mtimeMs; } catch { return 0; }
}

/** What a publish writes for this manifest: titles only. */
export function catalogEntryFor(manifest: AppManifest, opts: { repo: string; visibility: 'private' | 'public'; publishedBy: string | null; does?: string }): CatalogEntry {
  return {
    slug: manifest.slug,
    name: manifest.name,
    does: cleanText(opts.does ?? '', 160),
    repo: opts.repo,
    visibility: opts.visibility,
    publishedBy: opts.publishedBy && PERSON_RE.test(opts.publishedBy) ? opts.publishedBy : null,
    tools: manifest.actions.slice(0, CATALOG_TOOLS_MAX).map((a) => ({ id: a.id, title: cleanText(a.title, 120), effect: effectOf(a) })),
    at: new Date().toISOString(),
  };
}

function writeCatalog(contextRoot: string, entries: CatalogEntry[]): void {
  const file = join(contextRoot, CATALOG_FILE);
  // A symlink or a folder at the name is never written through.
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${CATALOG_FILE} is not a plain file`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const tmp = join(contextRoot, `.${CATALOG_FILE}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, JSON.stringify({ apps: [...entries].sort((a, b) => a.slug.localeCompare(b.slug)) }, null, 2) + '\n');
  } finally {
    closeSync(fd);
  }
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

/** Add or replace one app's entry (a publish). */
export function upsertCatalogEntry(contextRoot: string, entry: CatalogEntry): void {
  const rest = readCatalog(contextRoot).filter((e) => e.slug !== entry.slug);
  writeCatalog(contextRoot, [...rest, entry]);
}

/** Remove one app's entry (the owner's verb). False when there was none. */
export function removeCatalogEntry(contextRoot: string, slug: string): boolean {
  const all = readCatalog(contextRoot);
  if (!all.some((e) => e.slug === slug)) return false;
  writeCatalog(contextRoot, all.filter((e) => e.slug !== slug));
  return true;
}
