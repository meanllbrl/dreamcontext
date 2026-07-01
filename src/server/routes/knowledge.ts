import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { buildKnowledgeIndex } from '../../lib/knowledge-index.js';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { safeChildPath } from '../safe-path.js';
import { recordDashboardChange, buildFieldSummary } from '../change-tracker.js';
import type { FieldChange } from '../change-tracker.js';

function getKnowledgeDir(contextRoot: string): string {
  return join(contextRoot, 'knowledge');
}

// Image extensions Obsidian Excalidraw boards embed. Only these are served by
// the assets route — never arbitrary file types.
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

// Cap the total payload so a board with many large screenshots can't blow up
// the response. Localhost-only, so generous.
const MAX_ASSETS_BYTES = 64 * 1024 * 1024;

/**
 * Parse the Obsidian Excalidraw `## Embedded Files` map. Each line is
 * `<fileId-sha1>: [[vault/relative/path.png]]` (optional `|alias`/`#anchor`).
 * Scanning the whole body is safe: the `<hex>: [[…]]` shape never appears in the
 * scene JSON (which uses `"fileId":"…"`), so there are no false matches.
 */
function parseEmbeddedFiles(body: string): Array<{ fileId: string; path: string }> {
  const re = /([a-f0-9]{8,}):\s*\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/gi;
  const out: Array<{ fileId: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({ fileId: m[1], path: m[2].trim() });
  }
  return out;
}

// Downscale + recompress embedded images before inlining them into the exported
// SVG. A board full of full-res phone screenshots otherwise ships tens of MB of
// base64 — slow to fetch, slow for exportToSvg, and janky to pan. Cap the longest
// side and re-encode as WebP; cached by path+mtime+settings so re-opening a board
// is instant. sharp is optional: if it can't load (e.g. the app fell back to its
// bundled dist with no node_modules), serve the original bytes so images still
// render — just larger.
//
// Bounded LRU: the dashboard server is long-lived and a vault can hold many large
// boards, so an unbounded Map would grow without limit (each entry holds a
// multi-MB base64 string). Cap the entry count and evict the least-recently-used.
const ASSET_CACHE_MAX = 256;
const assetCache = new Map<string, { mimeType: string; dataURL: string; bytes: number }>();

function cacheGet(key: string): { mimeType: string; dataURL: string; bytes: number } | undefined {
  const hit = assetCache.get(key);
  if (hit) { assetCache.delete(key); assetCache.set(key, hit); } // bump recency
  return hit;
}

function cacheSet(key: string, value: { mimeType: string; dataURL: string; bytes: number }): void {
  assetCache.set(key, value);
  while (assetCache.size > ASSET_CACHE_MAX) {
    const oldest = assetCache.keys().next().value;
    if (oldest === undefined) break;
    assetCache.delete(oldest);
  }
}

/**
 * Compression strength scaled to how many images the board carries — gently, so
 * a sparse board stays crisp and a screenshot-heavy board doesn't balloon the
 * payload. Not aggressive: even the top tier keeps images readable. Phone
 * screenshots are ~1170px wide, so the cap mostly avoids downscaling — the size
 * win there is just PNG→WebP. Very heavy boards trim a touch.
 */
function compressionFor(imageCount: number): { maxDim: number; quality: number } {
  if (imageCount > 40) return { maxDim: 1800, quality: 90 };
  return { maxDim: 2400, quality: 93 };
}

async function loadAssetDataURL(
  abs: string,
  maxDim: number,
  quality: number,
): Promise<{ mimeType: string; dataURL: string; bytes: number } | null> {
  let mtimeMs: number;
  try { mtimeMs = statSync(abs).mtimeMs; } catch { return null; }
  const key = `${abs}:${mtimeMs}:${maxDim}:${quality}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const ext = extname(abs).toLowerCase();
  const origMime = IMAGE_MIME[ext] ?? 'application/octet-stream';

  // SVG is already vector — don't rasterize it.
  if (ext !== '.svg') {
    try {
      const { default: sharp } = await import('sharp');
      const buf = await sharp(abs)
        .rotate() // honour EXIF orientation
        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      const out = {
        mimeType: 'image/webp',
        dataURL: `data:image/webp;base64,${buf.toString('base64')}`,
        bytes: buf.length,
      };
      cacheSet(key, out);
      return out;
    } catch { /* sharp unavailable / unsupported format — fall back to original */ }
  }
  try {
    const raw = readFileSync(abs);
    const out = {
      mimeType: origMime,
      dataURL: `data:${origMime};base64,${raw.toString('base64')}`,
      bytes: raw.length,
    };
    assetCache.set(key, out);
    return out;
  } catch { return null; }
}

/**
 * GET /api/knowledge - List knowledge index
 */
export async function handleKnowledgeList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const entries = buildKnowledgeIndex(contextRoot);
  sendJson(res, 200, { entries });
}

/**
 * GET /api/knowledge/:slug - Get single knowledge file
 */
export async function handleKnowledgeGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = safeChildPath(getKnowledgeDir(contextRoot), `${slug}.md`);
  if (!filePath) { sendError(res, 400, 'invalid_path', `Invalid knowledge slug: ${slug}`); return; }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Knowledge file not found: ${slug}`);
    return;
  }

  // Invariant: detail route returns RAW body (frontmatter stripped, scene JSON
  // intact). The ExcalidrawPreview renderer (dashboard) needs the full Drawing
  // block to parse the scene. Memory extraction (extracted text, not JSON)
  // happens only in knowledge-index.ts (entry.content) and recall.ts (body).
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  sendJson(res, 200, {
    entry: {
      slug,
      name: data.name ?? slug,
      description: data.description ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      date: data.date ?? '',
      pinned: data.pinned === true,
      content,
      // mtime lets the dashboard compare the rendered version against the polled
      // list and live-refetch this doc only when its file actually changed.
      mtime: statSync(filePath).mtimeMs,
    },
  });
}

/**
 * GET /api/knowledge-assets/:slug - Resolve an Excalidraw board's embedded images.
 *
 * Obsidian boards reference images by an external wikilink (`## Embedded Files`)
 * rather than inlining base64 into the scene, so the dashboard renderer has no
 * pixels to draw. This returns `{ files: { <fileId>: { mimeType, dataURL } } }`
 * for every image the board references, which the renderer merges into the scene
 * `files` map before exporting. Security: only the board's OWN referenced paths
 * are served, each resolved with a containment guard (never escapes the vault),
 * and only image extensions are returned.
 */
export async function handleKnowledgeAssets(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = safeChildPath(getKnowledgeDir(contextRoot), `${slug}.md`);
  if (!filePath) { sendError(res, 400, 'invalid_path', `Invalid knowledge slug: ${slug}`); return; }
  if (!existsSync(filePath)) { sendError(res, 404, 'not_found', `Knowledge file not found: ${slug}`); return; }

  const { content } = readFrontmatter<Record<string, unknown>>(filePath);
  const embedded = parseEmbeddedFiles(content);

  // Wikilinks are vault-root-relative (the vault root is the parent of the
  // context root, e.g. `<project>/` for `<project>/_dream_context`). Try that
  // first, then context-root-relative, then the board's own folder — both the
  // bare path and an `assets/` or `Attachments/` subfolder — covering how
  // different Obsidian path settings store the link. The `assets/` case is the
  // self-contained board-folder convention (`<board>/assets/<img>.png`) where a
  // bare `[[img.png]]` wikilink only resolves via Obsidian's vault-wide index;
  // without it every embed in a co-located board folder renders blank (Bug B).
  const vaultRoot = dirname(contextRoot);
  const boardDir = dirname(filePath);

  // Scale compression to the board's image count.
  const imageCount = embedded.filter(e => IMAGE_MIME[extname(e.path).toLowerCase()]).length;
  const { maxDim, quality } = compressionFor(imageCount);

  const files: Record<string, { mimeType: string; dataURL: string }> = {};
  let total = 0;
  let dropped = 0;
  for (const { fileId, path } of embedded) {
    if (!IMAGE_MIME[extname(path).toLowerCase()]) continue; // images only
    const candidates = [
      safeChildPath(vaultRoot, path),
      safeChildPath(contextRoot, path),
      safeChildPath(boardDir, path), // path relative to the board (handles `assets/x.png` wikilinks)
      safeChildPath(boardDir, basename(path)),
      safeChildPath(boardDir, join('assets', basename(path))), // co-located self-contained board folder
      safeChildPath(boardDir, join('Attachments', basename(path))),
    ];
    const abs = candidates.find((c): c is string => c !== null && existsSync(c));
    if (!abs) continue;
    const loaded = await loadAssetDataURL(abs, maxDim, quality);
    if (!loaded) continue;
    if (total + loaded.bytes > MAX_ASSETS_BYTES) { dropped++; continue; }
    total += loaded.bytes;
    files[fileId] = { mimeType: loaded.mimeType, dataURL: loaded.dataURL };
  }
  if (dropped > 0) {
    // Don't fail silently: a screenshot-heavy board past the cap renders with
    // blank images, so make the truncation explainable in the server log.
    console.warn(
      `[knowledge-assets] ${slug}: payload cap (${MAX_ASSETS_BYTES} bytes) reached — ` +
      `${dropped} image(s) omitted; board will render with missing images.`,
    );
  }

  sendJson(res, 200, { files });
}

/**
 * PATCH /api/knowledge/:slug - Update knowledge file (e.g., pin/unpin)
 */
export async function handleKnowledgeUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = safeChildPath(getKnowledgeDir(contextRoot), `${slug}.md`);
  if (!filePath) { sendError(res, 400, 'invalid_path', `Invalid knowledge slug: ${slug}`); return; }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Knowledge file not found: ${slug}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  // Read old values BEFORE mutation for change tracking
  const { data: oldData } = readFrontmatter<Record<string, unknown>>(filePath);

  const updates: Record<string, unknown> = {};
  const fieldChanges: FieldChange[] = [];

  if (typeof body.pinned === 'boolean') {
    const oldPinned = oldData.pinned === true;
    if (oldPinned !== body.pinned) {
      updates.pinned = body.pinned;
      fieldChanges.push({ field: 'pinned', from: oldPinned, to: body.pinned });
    }
  }

  if (fieldChanges.length === 0) {
    sendError(res, 400, 'no_changes', 'No valid fields to update.');
    return;
  }

  updateFrontmatterFields(filePath, updates);

  recordDashboardChange(contextRoot, {
    entity: 'knowledge',
    action: 'update',
    target: `knowledge/${slug}.md`,
    field: fieldChanges.map(f => f.field).join(', '),
    fields: fieldChanges,
    summary: buildFieldSummary('knowledge', `knowledge/${slug}.md`, fieldChanges),
  });

  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  sendJson(res, 200, {
    entry: {
      slug,
      name: data.name ?? slug,
      description: data.description ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      date: data.date ?? '',
      pinned: data.pinned === true,
      content,
      mtime: statSync(filePath).mtimeMs,
    },
  });
}
