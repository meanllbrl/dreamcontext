import { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isSameOriginAsHost } from '../remote-access.js';
import { acquireFileLockWithin, releaseFileLock } from '../../lib/file-lock.js';
import {
  boardName,
  createWhiteboard,
  DEFAULT_WHITEBOARD,
  ensureDefaultWhiteboard,
  listWhiteboards,
  mutateWhiteboard,
  readWhiteboard,
  resolveWhiteboardPath,
  whiteboardRev,
  whiteboardsDir,
} from '../../lib/whiteboards/store.js';
import { mergeElements } from '../../lib/whiteboards/merge.js';
import {
  WHITEBOARD_MAX_BODY_BYTES,
  WhiteboardError,
  WhiteboardLockError,
  WhiteboardTooLargeError,
  WhiteboardValidationError,
  validatePutBody,
} from '../../lib/whiteboards/validate.js';

// ─── Whiteboards (D1–D15, Lane C) ───────────────────────────────────────────
//
// Every read and write goes through `src/lib/whiteboards/store.ts`: the slug pattern, the
// symlink refusal and the realpath containment live there, and so does the one write path
// (`mutateWhiteboard`: lock, read, merge, validate, strip tombstones, write only on a byte
// change). This file maps HTTP onto it and adds the two things only a request knows: the
// body cap and the dashboard's own origin (D7).

const TRASH_DIR = '.trash';
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** Typed store errors carry their own status; anything else is a real 500. */
function sendWhiteboardError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof WhiteboardError)) throw err;
  const code = err.status === 404 ? 'not_found'
    : err.status === 413 ? 'too_large'
    : err.status === 422 ? 'corrupt'
    : err.status === 503 ? 'busy'
    : 'invalid';
  sendError(res, err.status, code, err.message);
}

/**
 * The origin this request's page is served from, so a web widget pointing back at the
 * dashboard is refused (D7). A same-origin browser write names it outright, scheme included:
 * that is the only way to see `https:` when a TLS proxy (`tailscale serve`) fronts this
 * plain-http server. Otherwise, the scheme this socket actually speaks plus the dialed Host.
 */
export function requestSelfOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (origin && isSameOriginAsHost(req)) {
    try { return new URL(origin).origin; } catch { /* fall through */ }
  }
  const host = req.headers.host;
  if (!host) return undefined;
  const scheme = (req.socket as TLSSocket | undefined)?.encrypted ? 'https' : 'http';
  return `${scheme}://${host}`;
}

/** How much of an oversized upload is read and discarded after the 413 before the socket is cut. */
const MAX_DRAIN_BYTES = 4 * WHITEBOARD_MAX_BODY_BYTES;

/**
 * Stream the body with a per-chunk cap (the `agent-drop.ts` shape): an oversized body is
 * refused before it is buffered, not after. A declared Content-Length over the cap is refused
 * without reading a byte. Resolves null once the 413 has been sent.
 *
 * After the 413 the rest of the upload is drained (discarded, bounded), not cut: a client still
 * writing would otherwise get EPIPE / a network error instead of the 413, and the page treats
 * 413 as a terminal "Not saved: too large" rather than a retryable failure (D11).
 */
function readCappedBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  const refuse = (bytes: number) => {
    sendWhiteboardError(res, new WhiteboardTooLargeError(`request body is over ${bytes} bytes (max ${WHITEBOARD_MAX_BODY_BYTES})`));
    let drained = 0;
    req.on('data', (chunk: Buffer) => {
      drained += chunk.length;
      if (drained > MAX_DRAIN_BYTES) req.destroy();
    });
    req.resume();
  };
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > WHITEBOARD_MAX_BODY_BYTES) {
    refuse(declared);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > WHITEBOARD_MAX_BODY_BYTES) {
        chunks.length = 0;
        refuse(size);
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

/** GET /api/whiteboards → `{ whiteboards: WhiteboardSummary[] }`. Symlinked folders are skipped by the store. */
export async function handleWhiteboardsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { whiteboards: listWhiteboards(contextRoot) });
}

/**
 * GET /api/whiteboards/default → `{slug}` (A15): the "Control Panel" board the rail opens,
 * created under the store lock the first time anyone asks. Registered before `:slug`.
 */
export async function handleWhiteboardDefault(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const { slug } = await ensureDefaultWhiteboard(contextRoot);
    sendJson(res, 200, { slug });
  } catch (err) {
    sendWhiteboardError(res, err);
  }
}

/** POST /api/whiteboards `{name, description?}` → 201 `{slug, name, description, rev}`. */
export async function handleWhiteboardsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const name = body?.name;
  const description = body?.description ?? '';
  if (typeof name !== 'string' || !name.trim() || name.length > 200) {
    sendError(res, 400, 'invalid', 'A whiteboard needs a name (1-200 characters).');
    return;
  }
  if (typeof description !== 'string' || description.length > 2000) {
    sendError(res, 400, 'invalid', 'description must be a string of at most 2000 characters.');
    return;
  }
  try {
    const { slug } = createWhiteboard(contextRoot, name, description);
    const { board, rev } = readWhiteboard(contextRoot, slug);
    sendJson(res, 201, { slug, name: boardName(board, slug), description: board.frontmatter.description ?? '', rev });
  } catch (err) {
    sendWhiteboardError(res, err);
  }
}

/** GET /api/whiteboards/:slug → `{slug, name, description, elements, rev}`; 422 when the file does not parse (D12). */
export async function handleWhiteboardGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const { slug, board, rev } = readWhiteboard(contextRoot, params.slug);
    const description = typeof board.frontmatter.description === 'string' ? board.frontmatter.description : '';
    // Tombstones included: the client needs them so a stale local copy cannot resurrect a delete.
    sendJson(res, 200, { slug, name: boardName(board, slug), description, elements: board.elements, rev });
  } catch (err) {
    sendWhiteboardError(res, err);
  }
}

/** GET /api/whiteboards/:slug/rev → `{rev}` — the D5 poll, cached by mtime + size in the store. */
export async function handleWhiteboardRev(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, { rev: whiteboardRev(contextRoot, params.slug) });
  } catch (err) {
    sendWhiteboardError(res, err);
  }
}

/**
 * PUT /api/whiteboards/:slug `{elements}` → `{rev, elements?}` (D11).
 *
 * The body is strict-picked by `validatePutBody` (a `files` key or an image element is a 400,
 * over 5MB a 413) and merged with disk per element under the board's lock. `elements` comes
 * back only when disk contributed something the browser did not have, so a CLI write landing
 * between a poll and this PUT is never hidden behind the new rev. A missing board is a 404
 * and is never re-created; a corrupt one is a 422 and is never written over.
 */
export async function handleWhiteboardPut(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const raw = await readCappedBody(req, res);
  if (!raw) {
    if (!res.headersSent) sendError(res, 400, 'invalid', 'Could not read the request body.');
    return;
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      throw new WhiteboardValidationError('body is not valid JSON');
    }
    const selfOrigin = requestSelfOrigin(req);
    const { elements } = validatePutBody(parsed, { byteLength: raw.length, selfOrigin });
    let diskContributed = false;
    const result = await mutateWhiteboard(contextRoot, params.slug, (board) => {
      const merged = mergeElements(board.elements, elements);
      diskContributed = merged.diskContributed;
      board.elements = merged.elements;
    }, { selfOrigin });
    sendJson(res, 200, diskContributed ? { rev: result.rev, elements: result.board.elements } : { rev: result.rev });
  } catch (err) {
    sendWhiteboardError(res, err);
  }
}

/**
 * DELETE /api/whiteboards/:slug → moves the board folder to `whiteboards/.trash/<slug>-<ts>/`.
 * Taken under the same lock `mutateWhiteboard` uses, so a PUT in flight either lands before the
 * move or finds the board gone (404), never a half-moved folder. The trash carries its own
 * `*` .gitignore: a deleted board must not travel to teammates through brain sync.
 */
export async function handleWhiteboardDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = params.slug;
  if (slug === DEFAULT_WHITEBOARD.slug) {
    sendError(res, 409, 'conflict', `"${DEFAULT_WHITEBOARD.name}" is the default board and cannot be deleted; clear it instead.`);
    return;
  }
  try {
    resolveWhiteboardPath(contextRoot, slug);
    const base = whiteboardsDir(contextRoot);
    // Same path as the store's per-board lock (store.ts `mutateWhiteboard`).
    const lockPath = join(base, '.locks', `${slug}.lock`);
    const held = await acquireFileLockWithin(lockPath, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
    if (!held) throw new WhiteboardLockError(`whiteboard '${slug}' is busy (another write holds its lock); try again`);
    try {
      const { dir } = resolveWhiteboardPath(contextRoot, slug);
      const trash = join(base, TRASH_DIR);
      if (isLink(trash) || (existsSync(trash) && !lstatSync(trash).isDirectory())) {
        throw new WhiteboardValidationError('whiteboards/.trash is not a plain folder; refusing to move a board into it');
      }
      if (!existsSync(trash)) mkdirSync(trash);
      const ignore = join(trash, '.gitignore');
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf-8');
      const trashed = `${slug}-${Date.now()}`;
      renameSync(dir, join(trash, trashed));
      sendJson(res, 200, { ok: true, slug, trashed: `${TRASH_DIR}/${trashed}` });
    } finally {
      releaseFileLock(lockPath);
    }
  } catch (err) {
    sendWhiteboardError(res, err);
  }
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
