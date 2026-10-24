import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { sendError, sendJson } from '../middleware.js';
import { serveMedia } from '../media.js';
import { recordDashboardChange } from '../change-tracker.js';
import { GRAPH_RAW_CONTENT_TYPE } from './graph.js';
import { sanitizeDropFilename } from '../../lib/filename.js';
import {
  TASK_ASSET_LIMITS,
  TaskAssetsError,
  assetsDirFor,
  capAssetName,
  listAssets,
  writeUploadStream,
} from '../../lib/task-assets.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { TASK_SLUG_RE } from '../../lib/task-slug.js';

/**
 * A task's attachments (`state/assets/<slug>/`, local, never synced):
 *
 *   GET  /api/tasks/:slug/assets              → { entries, total, truncated }
 *   GET  /api/tasks/:slug/assets/raw?path=    → the file, from a fixed type table, Range-served
 *   POST /api/tasks/:slug/assets?name=<file>  → 201 { name, size } (raw body, 100 MB cap)
 *
 * The raw route serves ONLY raster images, audio, video and PDF (the graph route's table).
 * Everything else, SVG and HTML included, is 415: the Media grid never fetches the bytes of a
 * file it cannot show, and nothing script-bearing is ever served from the API's origin.
 */

async function taskExists(contextRoot: string, slug: string): Promise<boolean> {
  return (await getTaskBackend(contextRoot).get(slug)) !== null;
}

function sendAssetsError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof TaskAssetsError) {
    sendError(res, err.status, err.code, err.message);
    return true;
  }
  return false;
}

/** GET /api/tasks/:slug/assets */
export async function handleTaskAssetsList(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!TASK_SLUG_RE.test(slug ?? '')) { sendError(res, 400, 'invalid_slug', `Invalid task slug: ${slug}`); return; }
  if (!(await taskExists(contextRoot, slug))) { sendError(res, 404, 'not_found', `Task not found: ${slug}`); return; }
  try {
    const { dir, exists } = assetsDirFor(contextRoot, slug);
    sendJson(res, 200, exists ? listAssets(dir) : { entries: [], total: 0, truncated: false });
  } catch (err) {
    if (!sendAssetsError(res, err)) throw err;
  }
}

/**
 * A relative path inside the assets folder, or null. Absolute paths, backslashes, NUL,
 * `.`/`..` segments and dot-named segments are refused, and so is anything that turns into
 * one of those after a SECOND decode (a double-encoded `%252e%252e`).
 */
function safeRelativeSegments(raw: string): string[] | null {
  const forms = [raw];
  // A name with a literal `%` (100%.png) does not decode a second time; it cannot hide a
  // traversal either, so only the form as given is checked.
  try { forms.push(decodeURIComponent(raw)); } catch { /* not double-encoded */ }
  for (const f of forms) {
    if (!f || f.startsWith('/') || f.includes('\\') || f.includes('\0') || /^[A-Za-z]:/.test(f)) return null;
    const segs = f.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  }
  return raw.split('/');
}

/** GET /api/tasks/:slug/assets/raw?path=<relative> */
export async function handleTaskAssetRaw(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  // First, so every exit (4xx included) carries it.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const { slug } = params;
  if (!TASK_SLUG_RE.test(slug ?? '')) { sendError(res, 400, 'invalid_slug', `Invalid task slug: ${slug}`); return; }
  const url = new URL(req.url || '', 'http://localhost');
  const rawPath = url.searchParams.get('path');
  if (!rawPath) { sendError(res, 400, 'missing_path', 'Query parameter "path" is required.'); return; }
  const segs = safeRelativeSegments(rawPath);
  if (!segs) { sendError(res, 400, 'invalid_path', 'Path escapes the task assets folder.'); return; }
  const contentType = GRAPH_RAW_CONTENT_TYPE[extname(segs[segs.length - 1]).toLowerCase()];
  if (!contentType) {
    sendError(res, 415, 'unsupported_type', 'Only images, audio, video and PDF are served.');
    return;
  }
  if (!(await taskExists(contextRoot, slug))) { sendError(res, 404, 'not_found', `Task not found: ${slug}`); return; }

  let base: string;
  try {
    const r = assetsDirFor(contextRoot, slug);
    if (!r.exists) { sendError(res, 404, 'not_found', `Not found: ${rawPath}`); return; }
    base = r.dir;
  } catch (err) {
    if (!sendAssetsError(res, err)) throw err;
    return;
  }

  // Every component is lstat'ed: a symlinked file OR folder anywhere under assets/<slug> is refused.
  let target = base;
  for (const seg of segs) {
    target = join(target, seg);
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(target); } catch { sendError(res, 404, 'not_found', `Not found: ${rawPath}`); return; }
    if (st.isSymbolicLink()) { sendError(res, 400, 'invalid_path', 'Refusing to follow a symlink.'); return; }
  }
  // Re-taken over real paths right before the read.
  try {
    const realBase = realpathSync.native(base);
    const realTarget = realpathSync.native(target);
    if (!realTarget.startsWith(realBase + sep)) { sendError(res, 400, 'invalid_path', 'Path escapes the task assets folder.'); return; }
  } catch {
    sendError(res, 400, 'invalid_path', 'Path escapes the task assets folder.');
    return;
  }
  let st: ReturnType<typeof statSync>;
  try { st = statSync(target); } catch { sendError(res, 404, 'not_found', `Not found: ${rawPath}`); return; }
  if (!st.isFile()) { sendError(res, 404, 'not_found', `Not a file: ${rawPath}`); return; }

  res.setHeader('Content-Disposition', 'inline');
  // Images only, exactly like the graph route: a PDF is framed by the script-backed PdfViewer,
  // and `sandbox` would blank it.
  if (contentType.startsWith('image/')) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  serveMedia(req, res, target, st.size, contentType);
}

/** Uploads in flight on this server (all vaults). */
let activeUploads = 0;

/** Answer an upload refusal, then drop the connection once the answer is out (the body is unread). */
function refuseUpload(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string): void {
  res.setHeader('Connection', 'close');
  res.once('finish', () => req.destroy());
  sendError(res, status, code, message);
}

/** POST /api/tasks/:slug/assets?name=<file> — the raw file body. */
export async function handleTaskAssetUpload(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!TASK_SLUG_RE.test(slug ?? '')) { refuseUpload(req, res, 400, 'invalid_slug', `Invalid task slug: ${slug}`); return; }
  const cap = TASK_ASSET_LIMITS.capBytes;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > cap) {
    refuseUpload(req, res, 413, 'too_large', `The file exceeds the ${Math.round(cap / (1024 * 1024))} MB limit.`);
    return;
  }
  const url = new URL(req.url || '', 'http://localhost');
  const rawName = url.searchParams.get('name') ?? '';
  if (!rawName.trim()) { refuseUpload(req, res, 400, 'missing_name', 'Query parameter "name" is required.'); return; }
  if (!(await taskExists(contextRoot, slug))) { refuseUpload(req, res, 404, 'not_found', `Task not found: ${slug}`); return; }
  if (activeUploads >= TASK_ASSET_LIMITS.maxConcurrent) {
    refuseUpload(req, res, 429, 'too_many_uploads', 'Too many uploads at once; try again in a moment.');
    return;
  }

  activeUploads++;
  try {
    let dir: string;
    try {
      dir = assetsDirFor(contextRoot, slug, { create: true }).dir;
    } catch (err) {
      if (err instanceof TaskAssetsError) { refuseUpload(req, res, err.status, err.code, err.message); return; }
      throw err;
    }
    const name = capAssetName(sanitizeDropFilename(rawName, ''));
    const result = await writeUploadStream(req, dir, name, cap);
    if (!result.ok) {
      if (!res.headersSent && !res.destroyed) refuseUpload(req, res, result.status, result.code, result.message);
      return;
    }
    recordDashboardChange(contextRoot, {
      entity: 'task',
      action: 'update',
      target: `state/${slug}.md`,
      field: 'attachments',
      summary: `Attached '${result.name}' to task '${slug}'`,
    });
    sendJson(res, 201, { name: result.name, size: result.size });
  } finally {
    activeUploads--;
  }
}

/** For tests: uploads currently holding a slot. */
export function activeTaskAssetUploads(): number {
  return activeUploads;
}
