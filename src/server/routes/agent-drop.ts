import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { sanitizeDropFilename } from '../../lib/filename.js';
import { sniffImageType as sniffImage, EXT_BY_IMAGE_TYPE, type ImageMimeType } from '../../lib/image-sniff.js';
import { randomBytes } from 'node:crypto';
import { isPhoneSocket } from '../phone-origin.js';
import { authFor, deviceIdHash } from '../handsfree-auth.js';
import {
  PHONE_DROPS_MAX_BYTES, PHONE_MAX_PHOTO_BYTES, PHONE_PHOTO_PREFIX, acquirePhonePhoto, releasePhonePhoto,
} from '../../lib/handsfree/mac/photo-limits.js';

/**
 * POST /api/agent/drop — receive ANY file dropped onto the embedded agent terminal,
 * write it under the vault's `_dream_context/tmp/agent-drops/`, and return its absolute
 * path so the client can inject that path into the Claude Code session under the cursor.
 * Images are magic-byte-verified (to give them a canonical extension); other files
 * (code, text, PDF, CSV, …) are saved verbatim so their PATH can be handed to Claude.
 *
 * Desktop-only (an interactive shell receives the path) and hardened end-to-end:
 *  - PER-CHUNK 25 MB cap during streaming — never buffers more than the limit (a naive
 *    buffer-then-check would let a hostile/huge upload OOM the Node process).
 *  - basename-only filename sanitize (no `../`, no separators, no leading dots) with a
 *    UUID fallback for an empty/fully-stripped name — so an arbitrary type only ever
 *    lands inside the gitignored vault temp dir, never outside the project.
 *  - TTL prune of old drops so the temp dir doesn't grow unbounded.
 *
 * The injected path is single-quoted + control-char-stripped CLIENT-SIDE before it
 * reaches the PTY (see AgentSurface). The path returned here only ever lands inside the
 * vault temp dir, so it can't point outside the project.
 */

export const MAX_DROP_BYTES = 25 * 1024 * 1024; // 25 MB
const DROP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // prune drops older than ~7 days

/** Re-exported for back-compat with callers/tests that import from this route. */
export type DropImageType = ImageMimeType;

const EXT_BY_TYPE = EXT_BY_IMAGE_TYPE;

/**
 * Identify an image by its MAGIC BYTES (not a trusted header). Returns the canonical
 * content-type, or null for anything outside the allow-list. Thin re-export of the
 * shared {@link sniffImage} so the drop route and the GitHub image bridge agree.
 */
export function sniffImageType(buf: Buffer): DropImageType | null {
  return sniffImage(buf);
}

/** Moved to `src/lib/filename.ts` (shared with task attachments); re-exported for callers/tests. */
export { sanitizeDropFilename };

/** Decode the URI-encoded filename header (the client encodes to keep it ASCII-safe). */
function decodeFilenameHeader(h: string | string[] | undefined): string {
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return '';
  try { return decodeURIComponent(v); } catch { return v; }
}

/**
 * Make the vault's `_dream_context/tmp/` directory git-ignored in EVERY project, so a
 * dropped image is never accidentally committed regardless of the project's own root
 * `.gitignore`. Writes a self-ignoring `tmp/.gitignore` containing `*` (which also
 * ignores the file itself). Idempotent (the content is constant) and best-effort — a
 * write failure must never abort a drop, so errors are swallowed.
 */
function ensureTmpGitignored(contextRoot: string): void {
  try {
    writeFileSync(join(contextRoot, 'tmp', '.gitignore'), '*\n');
  } catch { /* best-effort: a read-only/locked tmp dir just means drops aren't auto-ignored */ }
}

/** Delete drops older than the TTL (best-effort; never throws into the request path). */
function pruneDrops(dir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isFile() && now - st.mtimeMs > DROP_TTL_MS) unlinkSync(p);
      } catch { /* a single unstattable/locked entry shouldn't abort the prune */ }
    }
  } catch { /* dir missing/unreadable — nothing to prune */ }
}

/**
 * Stream the request body with a per-chunk size cap. Resolves the assembled buffer, or
 * null if the cap was exceeded (413 already sent), the stream errored, or the client went away
 * before the end (an aborted phone upload must free its gate slot, so `close` settles it too).
 */
function readCappedBody(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number = MAX_DROP_BYTES,
  tooLarge = 'Dropped file exceeds the 25 MB limit.',
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        sendError(res, 413, 'too_large', tooLarge);
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

/** Bytes of phone photos already in the drop folder (the per-project ceiling). */
function phoneDropBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(PHONE_PHOTO_PREFIX)) continue;
      try { total += statSync(join(dir, name)).size; } catch { /* gone meanwhile */ }
    }
  } catch { /* no folder yet */ }
  return total;
}

/**
 * The hands-free PHONE's photo (task hands-free-phone-shows-every-picture…, D5): the one remote
 * caller this route takes, decided per socket (the tunnel dials from 127.0.0.1, so never by
 * address), with caps of its own (lib/handsfree/mac/photo-limits.ts):
 *   • a declared size over the cap is refused before a byte is read; the stream is capped too;
 *   • the device's gate is taken BEFORE the body (2 in flight, 30 a minute) and always released;
 *   • images only, by their BYTES (PNG/JPEG/WebP/GIF) — the client's type and file name are
 *     ignored, the server names the file, and it lands only in this project's gitignored tmp;
 *   • the folder holds at most 500 MB of phone photos; the 7-day prune applies as for any drop.
 * The server never decodes the image. The answer is the absolute path the chat quotes into the
 * message, exactly as a desktop drop's.
 */
async function handlePhoneDrop(req: IncomingMessage, res: ServerResponse, contextRoot: string): Promise<void> {
  const device = authFor(req) ? deviceIdHash(req) : null;
  if (!device) { sendError(res, 401, 'unauthenticated', 'Sign in first.'); return; }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > PHONE_MAX_PHOTO_BYTES) {
    sendError(res, 413, 'too_large', 'A photo from the phone can be at most 10 MB.');
    req.destroy();
    return;
  }
  const verdict = acquirePhonePhoto(device);
  if (verdict !== 'ok') {
    sendJson(res, 429, {
      error: 'photo_busy',
      message: verdict === 'busy' ? 'Another photo is still uploading.' : 'Too many photos in the last minute.',
    });
    req.resume();
    return;
  }
  try {
    const buf = await readCappedBody(req, res, PHONE_MAX_PHOTO_BYTES, 'A photo from the phone can be at most 10 MB.');
    if (!buf) return;
    if (buf.length === 0) { sendError(res, 400, 'empty', 'No photo data was received.'); return; }
    const sniffed = sniffImageType(buf);
    if (!sniffed) { sendError(res, 415, 'not_an_image', 'Only a photo (PNG, JPEG, WebP or GIF) can be sent from the phone.'); return; }

    const dropDir = join(contextRoot, 'tmp', 'agent-drops');
    try {
      mkdirSync(dropDir, { recursive: true });
      ensureTmpGitignored(contextRoot);
      pruneDrops(dropDir);
    } catch (err) {
      console.error('[agent-drop] could not prepare drop dir', err);
      sendError(res, 500, 'mkdir_failed', 'Could not prepare the drop directory.');
      return;
    }
    if (phoneDropBytes(dropDir) + buf.length > PHONE_DROPS_MAX_BYTES) {
      sendError(res, 507, 'drops_full', 'Too many phone photos are waiting in this project; older ones are removed after a week.');
      return;
    }
    const finalPath = join(dropDir, `${PHONE_PHOTO_PREFIX}${Date.now()}-${randomBytes(4).toString('hex')}${EXT_BY_TYPE[sniffed]}`);
    try {
      writeFileSync(finalPath, buf, { flag: 'wx' });
    } catch (err) {
      console.error('[agent-drop] could not write phone photo', err);
      sendError(res, 500, 'write_failed', 'Could not save the photo.');
      return;
    }
    sendJson(res, 200, { path: finalPath, contentType: sniffed });
  } finally {
    releasePhonePhoto(device);
  }
}

export async function handleAgentDrop(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  // The phone first: `isDesktop()` is process-wide, so it says nothing about who is asking.
  if (isPhoneSocket(req)) { await handlePhoneDrop(req, res, contextRoot); return; }
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Agent file drop is only available in the desktop app.');
    return;
  }

  const buf = await readCappedBody(req, res);
  if (!buf) return; // 413 already sent, or read error (response left to the caller's 500 path)
  if (buf.length === 0) {
    sendError(res, 400, 'empty', 'No file data was received.');
    return;
  }

  // Any file type is accepted. An image is verified by magic bytes so we can give it a
  // canonical extension; a NON-image is saved verbatim and its PATH handed to Claude
  // (Claude reads code/text/PDF/… by path). The 25 MB cap, basename sanitize, and
  // gitignored temp dir all still apply, so accepting arbitrary types is not new surface.
  const sniffed = sniffImageType(buf);
  const rawName = decodeFilenameHeader(req.headers['x-dreamcontext-filename']);
  const safeName = sanitizeDropFilename(rawName, sniffed ? EXT_BY_TYPE[sniffed] : '');

  // contextRoot is ALREADY <vault>/_dream_context — write to its tmp dir, no re-nest.
  const dropDir = join(contextRoot, 'tmp', 'agent-drops');
  try {
    mkdirSync(dropDir, { recursive: true });
    ensureTmpGitignored(contextRoot);
    pruneDrops(dropDir);
  } catch (err) {
    console.error('[agent-drop] could not prepare drop dir', err);
    sendError(res, 500, 'mkdir_failed', 'Could not prepare the drop directory.');
    return;
  }

  const finalPath = join(dropDir, `${Date.now()}-${safeName}`);
  try {
    writeFileSync(finalPath, buf);
  } catch (err) {
    console.error('[agent-drop] could not write drop', err);
    sendError(res, 500, 'write_failed', 'Could not save the dropped file.');
    return;
  }

  sendJson(res, 200, { path: finalPath, contentType: sniffed });
}
