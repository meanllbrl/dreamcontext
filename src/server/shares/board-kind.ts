/**
 * The `board` kind of a live link (tunel-paylasim C7, D5): a guest sees one whiteboard, live and
 * read-only. A CLOSED table, GET/HEAD only:
 *
 *   /                      the viewer page (the dashboard build's `share.html`), its own CSP
 *   /assets/*              only files the build manifest lists for the `share.html` entry
 *   /excalidraw-assets/*   Excalidraw's self-hosted fonts (the build copies them there)
 *   /__share/board         {name, rev, elements}: the projected scene (guest-view.ts)
 *   /__share/rev           {rev} only, never the owner route's board list
 *   /__share/files/:id     a picture a LIVE image element of THIS board draws, from its `files/`
 *                          folder or its scene `files`, typed by a fixed table, `nosniff`
 *
 * Every other path is a 404. A board read that 404s on two polls at least 5 s apart closes the
 * share (`board_gone`); the trash route closes it at once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVaults } from '../../lib/vaults.js';
import { realPath } from '../../lib/real-path.js';
import { boardName, readWhiteboard, resolveWhiteboardPath, whiteboardRev } from '../../lib/whiteboards/store.js';
import { readBoardFile, IMAGE_TYPES } from '../../lib/whiteboards/files.js';
import { WhiteboardNotFoundError } from '../../lib/whiteboards/errors.js';
import { guestElements, guestPictureIds } from '../../lib/whiteboards/guest-view.js';
import { closeShare, closeSharesFor, registerShareKind, shareDeps, ShareError, type Share } from './registry.js';

export const VIEWER_CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'";
/** Two 404 reads this far apart end the share (a single 404 may be a save in flight). */
export const BOARD_GONE_AFTER_MS = 5_000;

const ASSET_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};

// ─── the viewer's build ─────────────────────────────────────────────────────

let viewerDirOverride: string | null = null;
/** Tests point the viewer at a fixture build. */
export function setShareViewerDirForTests(dir: string | null): void {
  viewerDirOverride = dir;
  manifestCache = null;
}

/** The dashboard build that holds `share.html` (dist/dashboard in the package, dashboard/dist in a checkout). */
function viewerDir(): string | null {
  if (viewerDirOverride) return viewerDirOverride;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'dashboard'), resolve(here, '..', '..', '..', 'dist', 'dashboard'), resolve(here, '..', '..', '..', 'dashboard', 'dist')]) {
    if (existsSync(join(c, 'share.html'))) return c;
  }
  return null;
}

interface ManifestChunk { file?: string; css?: string[]; assets?: string[]; imports?: string[]; dynamicImports?: string[] }

let manifestCache: { dir: string; mtimeMs: number; files: Set<string> } | null = null;

/** Every file the `share.html` entry loads (its chunk, imports, dynamic imports, CSS and assets). */
export function viewerAssets(dir: string): Set<string> {
  const path = join(dir, '.vite', 'manifest.json');
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return new Set(); }
  if (manifestCache && manifestCache.dir === dir && manifestCache.mtimeMs === mtimeMs) return manifestCache.files;
  const files = new Set<string>();
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ManifestChunk>;
    const seen = new Set<string>();
    const walk = (key: string): void => {
      if (seen.has(key)) return;
      seen.add(key);
      const c = m[key];
      if (!c) return;
      if (c.file) files.add(c.file);
      for (const f of [...(c.css ?? []), ...(c.assets ?? [])]) files.add(f);
      for (const k of [...(c.imports ?? []), ...(c.dynamicImports ?? [])]) walk(k);
    };
    walk('share.html');
  } catch { /* an unreadable manifest serves nothing */ }
  manifestCache = { dir, mtimeMs, files };
  return files;
}

// ─── answers ────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown, head = false): void {
  if (res.headersSent) { res.destroy(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(head ? undefined : text);
}

/** A file under `root` (relative, no dot segment, no symlink, contained) with its type, or 404. */
function sendContained(res: ServerResponse, root: string, rel: string, head: boolean, cache: string): void {
  const notFound = () => sendJson(res, 404, { error: 'not_found' }, head);
  if (!rel || rel.split('/').some((s) => !s || s.startsWith('.'))) { notFound(); return; }
  const type = ASSET_MIME[extname(rel).toLowerCase()];
  if (!type) { notFound(); return; }
  const abs = join(root, ...rel.split('/'));
  try {
    if (lstatSync(abs).isSymbolicLink()) { notFound(); return; }
    const real = realPath(abs);
    const r = relative(realPath(root), real);
    if (!r || r.startsWith('..') || r.startsWith(sep)) { notFound(); return; }
    const st = statSync(real);
    if (!st.isFile()) { notFound(); return; }
    const bytes = readFileSync(real);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(bytes.length), 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(head ? undefined : bytes);
  } catch { notFound(); }
}

/** The board's context root, from the share's vault (null: the project is gone). */
function contextRootOf(vault: string): string | null {
  const v = listVaults(shareDeps().home).find((x) => x.name === vault);
  if (!v) return null;
  return basename(v.path) === '_dream_context' ? v.path : join(v.path, '_dream_context');
}

/** A missing board: the first 404 is remembered, a second one ≥ 5 s later ends the share. */
function boardMissing(share: Share, res: ServerResponse, head: boolean): void {
  const now = shareDeps().now();
  const first = typeof share.data.missAt === 'number' ? share.data.missAt : null;
  if (first === null) share.data.missAt = now;
  else if (now - first >= BOARD_GONE_AFTER_MS) void closeShare(share.id, 'board_gone');
  sendJson(res, 404, { error: 'board_gone' }, head);
}

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

function sendPicture(res: ServerResponse, bytes: Buffer, mimeType: string, head: boolean): void {
  res.writeHead(200, {
    'Content-Type': mimeType, 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable', 'Referrer-Policy': 'no-referrer',
  });
  res.end(head ? undefined : bytes);
}

export async function serveBoardGuest(share: Share, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  req.resume();
  const method = (req.method ?? 'GET').toUpperCase();
  const head = method === 'HEAD';
  if (method !== 'GET' && !head) { sendJson(res, 405, { error: 'read_only' }); return; }
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    const dir = viewerDir();
    let html: Buffer;
    try { if (!dir) throw new Error('no viewer'); html = readFileSync(join(dir, 'share.html')); } catch { sendJson(res, 503, { error: 'viewer_missing' }, head); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(html.length), 'Cache-Control': 'no-store', 'Content-Security-Policy': VIEWER_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    res.end(head ? undefined : html);
    return;
  }
  if (path.startsWith('/assets/')) {
    const dir = viewerDir();
    const rel = path.slice(1);
    if (!dir || !viewerAssets(dir).has(rel)) { sendJson(res, 404, { error: 'not_found' }, head); return; }
    sendContained(res, dir, rel, head, 'public, max-age=31536000, immutable');
    return;
  }
  if (path.startsWith('/excalidraw-assets/')) {
    const dir = viewerDir();
    if (!dir) { sendJson(res, 404, { error: 'not_found' }, head); return; }
    sendContained(res, join(dir, 'excalidraw-assets'), path.slice('/excalidraw-assets/'.length), head, 'public, max-age=86400');
    return;
  }

  if (path === '/__share/board' || path === '/__share/rev' || path.startsWith('/__share/files/')) {
    const root = contextRootOf(share.vault);
    if (!root) { boardMissing(share, res, head); return; }
    try {
      if (path === '/__share/rev') {
        const rev = whiteboardRev(root, share.slug);
        delete share.data.missAt;
        sendJson(res, 200, { rev }, head);
        return;
      }
      const { board, rev } = readWhiteboard(root, share.slug);
      delete share.data.missAt;
      if (path === '/__share/board') {
        sendJson(res, 200, { name: boardName(board, share.slug), rev, elements: guestElements(board.elements) }, head);
        return;
      }
      let id: string;
      try { id = decodeURIComponent(path.slice('/__share/files/'.length)); } catch { sendJson(res, 404, { error: 'not_found' }, head); return; }
      if (!guestPictureIds(guestElements(board.elements)).has(id)) { sendJson(res, 404, { error: 'not_found' }, head); return; }
      try {
        const f = readBoardFile(root, share.slug, id);
        sendPicture(res, f.bytes, f.mimeType, head);
        return;
      } catch { /* a hand-made board carries it in its scene */ }
      const entry = board.files[id] as { dataURL?: unknown } | undefined;
      const m = typeof entry?.dataURL === 'string' ? DATA_URL.exec(entry.dataURL) : null;
      if (!m || !(m[1] in IMAGE_TYPES)) { sendJson(res, 404, { error: 'not_found' }, head); return; }
      sendPicture(res, Buffer.from(m[2], 'base64'), m[1], head);
    } catch (e) {
      if (e instanceof WhiteboardNotFoundError) { boardMissing(share, res, head); return; }
      sendJson(res, 503, { error: 'board_unreadable' }, head);
    }
    return;
  }
  sendJson(res, 404, { error: 'not_found' }, head);
}

/** The one-live-share key of a board (D9). */
export function boardShareKey(contextRoot: string, slug: string): string {
  return `board:${contextRoot}:${slug}`;
}

/** The board was trashed or deleted: its live link closes at once (C5 `board_gone`). */
export function closeBoardShares(contextRoot: string, slug: string): void {
  let root = contextRoot;
  try { root = realPath(contextRoot); } catch { /* as given */ }
  void closeSharesFor(boardShareKey(root, slug), 'board_gone');
}

registerShareKind('board', {
  resolve({ vault, slug }) {
    const root = contextRootOf(vault);
    if (!root) throw new ShareError(404, 'vault_not_found', `No project named "${vault}".`);
    let name: string;
    try {
      resolveWhiteboardPath(root, slug);
      name = boardName(readWhiteboard(root, slug).board, slug);
    } catch (e) {
      if (e instanceof WhiteboardNotFoundError) throw new ShareError(404, 'board_not_found', `No board "${slug}" in this project.`);
      throw new ShareError(400, 'bad_board', 'This board cannot be shared (it does not open).');
    }
    return { name, key: boardShareKey(realPath(root), slug) };
  },
  serve: serveBoardGuest,
});
