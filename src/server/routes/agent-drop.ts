import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { sniffImageType as sniffImage, EXT_BY_IMAGE_TYPE, type ImageMimeType } from '../../lib/image-sniff.js';

/**
 * POST /api/agent/drop — receive an image dropped onto the embedded agent terminal,
 * write it under the vault's `_dream_context/tmp/agent-drops/`, and return its absolute
 * path so the client can inject that path into the focused Claude Code session.
 *
 * Desktop-only (an interactive shell receives the path) and hardened end-to-end:
 *  - PER-CHUNK 25 MB cap during streaming — never buffers more than the limit (a naive
 *    buffer-then-check would let a hostile/huge upload OOM the Node process).
 *  - magic-byte content-type check (header content-type is advisory; bytes decide).
 *  - basename-only filename sanitize (no `../`, no separators, no leading dots) with a
 *    UUID fallback for an empty/fully-stripped name.
 *  - TTL prune of old drops so the temp dir doesn't grow unbounded.
 *
 * The injected path is single-quoted + control-char-stripped CLIENT-SIDE before it
 * reaches the PTY (see AgentSurface). The path returned here only ever lands inside the
 * vault temp dir, so it can't point outside the project.
 */

/** The interactive-shell features only exist inside the desktop app. */
function isDesktop(): boolean {
  return process.env.DREAMCONTEXT_DESKTOP === '1';
}

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

/**
 * Reduce an arbitrary, possibly-hostile filename to a safe basename written inside the
 * drop dir. Strips any path (separators / `../`), drops leading dots, keeps only
 * `[\w.\-]`, and falls back to a random name when nothing usable survives. Always
 * carries an extension (the magic-byte-derived `ext` when the original lacks one).
 */
export function sanitizeDropFilename(raw: string, ext: string): string {
  let base = '';
  try { base = basename(String(raw ?? '').replace(/\\/g, '/').trim()); } catch { base = ''; }
  base = base.replace(/^\.+/, '');            // no leading dots → no hidden/dotfiles, no '..'
  const safe = base.replace(/[^\w.\-]/g, '_'); // collapse anything outside the allow-list
  if (!safe || !/[A-Za-z0-9]/.test(safe)) return `${randomUUID()}${ext}`;
  // Guarantee a sensible extension so the written file is openable by type.
  return /\.[A-Za-z0-9]+$/.test(safe) ? safe : `${safe}${ext}`;
}

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
 * null if the cap was exceeded (413 already sent) or the stream errored.
 */
function readCappedBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DROP_BYTES) {
        sendError(res, 413, 'too_large', 'Dropped file exceeds the 25 MB limit.');
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

export async function handleAgentDrop(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
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

  const sniffed = sniffImageType(buf);
  if (!sniffed) {
    sendError(res, 415, 'unsupported_type', 'Only PNG, JPEG, GIF or WebP images can be dropped onto the agent.');
    return;
  }

  const rawName = decodeFilenameHeader(req.headers['x-dreamcontext-filename']);
  const safeName = sanitizeDropFilename(rawName, EXT_BY_TYPE[sniffed]);

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
