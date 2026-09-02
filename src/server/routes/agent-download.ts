import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';

/**
 * POST /api/agent/download — write bytes the page produced into the user's Downloads
 * folder and hand back the ABSOLUTE PATH it landed at.
 *
 * WHY THIS EXISTS (owner report, 2026-09-02). The `dream-html` export bar downloaded a
 * PNG/HTML through `<a download>`, and the webview then said nothing: no toast, no
 * filename, no folder. The file was there, but the person who asked for it had no way to
 * know that, and no way to reach it — a silent success is the same defect as a silent
 * failure, which is the defect the export bar was built to end.
 *
 * A webview download cannot be reported on, and that is not a UI oversight: the page never
 * learns the destination. WKWebView picks it (Downloads dir, with a ` (1)` suffix on
 * collision) inside the download delegate, and hands the page no path, no completion event,
 * and no error. So "tell the user where it went" is unbuildable on `<a download>` — the
 * write has to happen where the path is known, which is here.
 *
 * The path this returns is what makes the follow-up possible: the client shows the real
 * filename and offers `POST /api/agent/reveal` on it, which is how "open Finder with the
 * file selected" works without this route ever launching anything itself.
 *
 * The safety posture, given that this is the one route that writes OUTSIDE the project:
 *  - desktop-only, like every other privileged local route (the plain browser keeps its
 *    ordinary `<a download>`, which is correct there — the browser owns that UI);
 *  - the extension must be on {@link SAVE_EXT} — types a viewer DISPLAYS, never a type the
 *    OS EXECUTES. A `.command`/`.sh`/`.app` may not be written into the folder whose
 *    contents people double-click by habit;
 *  - basename-only sanitize, so the name can never climb out of the Downloads dir;
 *  - never overwrites: a collision gets ` (1)`, ` (2)`, … the way the platform's own
 *    downloader numbers them;
 *  - per-chunk size cap during streaming, so a large body can't OOM the process.
 */

/** 40 MB. A 2x raster of a tall block is a few MB; this is headroom, not a target. */
export const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

/**
 * What may be written into Downloads — inert-to-view types only.
 *
 * Deliberately narrower than the export bar needs today (`png`, `html`): the list is the
 * refusal, so it is worth having room in it for the next export format without having room
 * in it for a script. `.html` is safe for the reason the export itself is: the exported
 * document carries the sandbox CSP, and opening one is a render, not an execution grant.
 */
export const SAVE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.html', '.pdf', '.csv', '.json', '.md', '.txt',
]);

/**
 * The folder a download belongs in.
 *
 * `~/Downloads` is where every platform's own downloader puts things and therefore where
 * the user will look; when it does not exist (a stripped container, a CI box) the home dir
 * is a worse but honest fallback — the route still reports the exact path, so nothing is
 * lost in a place nobody can find.
 */
export function downloadsDir(home = homedir()): string {
  const preferred = join(home, 'Downloads');
  try {
    if (statSync(preferred).isDirectory()) return preferred;
  } catch { /* not there — fall through to creating it */ }
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    return home;
  }
}

/**
 * A hostile-proof basename with an allowed extension, or null to refuse.
 *
 * Refuses rather than coerces: the client builds this name itself (`exportFilename`), so an
 * unexpected one means a caller this route does not know about, and inventing an extension
 * for it would be inventing a file type.
 */
export function safeDownloadName(raw: string): string | null {
  let base = '';
  try { base = basename(String(raw ?? '').replace(/\\/g, '/').trim()); } catch { return null; }
  base = base.replace(/^\.+/, '');                     // no leading dots → no dotfiles, no '..'
  // Unicode letters and digits SURVIVE — `\w` is ASCII-only, and this route's whole
  // neighbourhood exists to keep Turkish names readable (`exportFilename` transliterates
  // for a reason). A defensive filter that turns "fırsat radarı" into "f_rsat radar_" is
  // destroying the thing it is protecting. The security property is unchanged: no path
  // separator, no traversal, no control character, and the extension allowlist below.
  base = base.replace(/[^\p{L}\p{N}._\-() ]/gu, '_');
  base = base.replace(/\s+/g, ' ').trim();
  if (!base || !/[\p{L}\p{N}]/u.test(base)) return null;
  const ext = extname(base).toLowerCase();
  if (!SAVE_EXT.has(ext)) return null;
  // A name long enough to break the filesystem is a bug somewhere upstream, not a request.
  return base.length > 120 ? base.slice(0, 120 - ext.length) + ext : base;
}

/**
 * The first free path for `name` in `dir`, numbered the way the platform's own downloader
 * numbers a collision. `exists` is injected so this is testable without touching a disk.
 */
export function uniqueDownloadPath(
  dir: string, name: string, exists: (p: string) => boolean = existsSync,
): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = join(dir, name);
  for (let n = 1; exists(candidate) && n < 1000; n += 1) {
    candidate = join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/** Read the URI-encoded filename header the client sends (kept ASCII-safe on the wire). */
function decodeFilenameHeader(h: string | string[] | undefined): string {
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return '';
  try { return decodeURIComponent(v); } catch { return v; }
}

/** Stream the body with a per-chunk cap. Null means the cap was hit (413 sent) or a read error. */
function readCappedBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DOWNLOAD_BYTES) {
        sendError(res, 413, 'too_large', 'The download exceeds the 40 MB limit.');
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

export async function handleAgentDownload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    // Not an error the user should ever see: in a browser the client keeps its own
    // `<a download>`, and this refusal is what tells it to.
    sendError(res, 403, 'desktop_only', 'Available only in the desktop app.');
    return;
  }

  const rawName = decodeFilenameHeader(req.headers['x-dreamcontext-filename']);
  const name = safeDownloadName(rawName);
  if (!name) {
    sendError(res, 400, 'unsupported_name', 'A filename with a supported, viewable extension is required.');
    return;
  }

  const buf = await readCappedBody(req, res);
  if (!buf) return; // 413 already sent, or a read error
  if (buf.length === 0) {
    sendError(res, 400, 'empty', 'No file data was received.');
    return;
  }

  const dir = downloadsDir();
  // `wx` so a file that appeared between the name check and the write is never clobbered
  // (two exports of the same block, one click apart, is the ordinary case) — a lost
  // EEXIST race just takes the next number.
  let target = '';
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3 && !target; attempt += 1) {
    const candidate = uniqueDownloadPath(dir, name);
    try {
      writeFileSync(candidate, buf, { flag: 'wx' });
      target = candidate;
    } catch (err) {
      lastErr = err;
      if ((err as { code?: string }).code !== 'EEXIST') break;
    }
  }
  if (!target) {
    console.error('[agent-download] could not write to the downloads folder', lastErr);
    sendError(res, 500, 'write_failed', 'Could not write into the Downloads folder.');
    return;
  }

  sendJson(res, 200, { path: target, filename: basename(target), dir });
}
