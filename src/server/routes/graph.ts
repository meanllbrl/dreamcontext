import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { buildGraph } from '../../lib/graph.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { sendJson, sendError } from '../middleware.js';
import { serveMedia } from '../media.js';

/**
 * GET /api/graph — return the full context graph (nodes + links).
 */
export async function handleGraphGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const graph = buildGraph(contextRoot);
    sendJson(res, 200, graph);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build graph';
    sendError(res, 500, 'graph_build_failed', message);
  }
}

/**
 * Vault files `?raw=1` will hand over as BYTES rather than as a JSON body.
 *
 * A knowledge document is prose, but the material it was distilled FROM is often not: a
 * contract, a spec, a paper, sitting next to the note that cites it. Read as UTF-8 into a
 * JSON string — which is all this route could do before — such a file comes back as mojibake,
 * so the one link in the note that points at the source was the one link that led nowhere.
 *
 * Deliberately a tiny allowlist, and PDF only for now: the ask was the document a knowledge
 * file links to, and every extension added here is a content type this server starts asserting
 * about a file it did not write. `nosniff` is set on the response, so the type below is the
 * only thing the engine may treat it as.
 */
/**
 * What `?raw=1` will hand back as BYTES rather than as text.
 *
 * `.svg` is deliberately ABSENT and must stay absent. This route is generic — the
 * Knowledge page hands its URL straight to the PDF viewer, which frames it SAME-ORIGIN
 * with no `sandbox` — and an SVG is a script-bearing document, so serving one here would
 * put attacker-authored script on the same origin as the local API. The images this arm
 * exists for are screenshots and plots, which are raster; excluding SVG costs nothing
 * real and removes the whole class. An `.svg` falls through to the text arm below and is
 * returned as source, which is inert.
 */
const GRAPH_RAW_CONTENT_TYPE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Ceiling for a raw vault read. Streamed, so this is not a memory bound — it is what stops a
 *  mistyped path at something enormous from tying up a socket. Same value the chat surface's
 *  file route uses, for the same reason. */
const GRAPH_RAW_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * GET /api/graph/content?path=<relative-path-inside-_dream_context>[&raw=1]
 * Returns markdown/json/text content for any node's file. Used by the
 * Brain drawer to show rendered content without cross-page navigation.
 *
 * With `raw=1` and a type in {@link GRAPH_RAW_CONTENT_TYPE}, answers the FILE ITSELF —
 * streamed with byte ranges — which is what lets the Knowledge page display a PDF a note
 * links to. This route, not the chat surface's `/api/agent/file`, because the Knowledge page
 * is not desktop-only: `/agent/file` is gated on the desktop app, so a browser dashboard would
 * have been told "desktop only" about a file sitting in its own vault. The containment rule is
 * the one already enforced below and is unchanged — nothing outside `_dream_context/` is
 * reachable through here, raw or otherwise.
 */
export async function handleGraphContentGet(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url || '', 'http://localhost');
  const rawPath = url.searchParams.get('path');
  if (!rawPath) {
    sendError(res, 400, 'missing_path', 'Query parameter "path" is required.');
    return;
  }

  // Prevent path traversal — resolved path must stay inside contextRoot.
  const absRoot = resolve(contextRoot);
  const absTarget = resolve(absRoot, normalize(rawPath));
  if (!absTarget.startsWith(absRoot + sep) && absTarget !== absRoot) {
    sendError(res, 400, 'invalid_path', 'Path escapes context root.');
    return;
  }

  if (!existsSync(absTarget)) {
    sendError(res, 404, 'not_found', `Path not found: ${rawPath}`);
    return;
  }

  // The check above is LEXICAL, so a symlink inside the vault that points out of it
  // passes it. Vault files are teammate-writable through brain sync, so that is a real
  // path for a hostile link to arrive by. Re-taken over REAL paths, which also catches a
  // symlinked directory above the leaf. An unreadable realpath refuses rather than serves.
  try {
    const realRoot = realpathSync.native(absRoot);
    const realTarget = realpathSync.native(absTarget);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      sendError(res, 400, 'invalid_path', 'Path escapes context root.');
      return;
    }
  } catch {
    sendError(res, 400, 'invalid_path', 'Path escapes context root.');
    return;
  }

  const rawType = GRAPH_RAW_CONTENT_TYPE[extname(absTarget).toLowerCase()];
  if (url.searchParams.get('raw') === '1' && rawType) {
    let st: ReturnType<typeof statSync>;
    try { st = statSync(absTarget); } catch { sendError(res, 404, 'not_found', `Path not found: ${rawPath}`); return; }
    if (!st.isFile()) { sendError(res, 404, 'not_found', `Not a file: ${rawPath}`); return; }
    if (st.size > GRAPH_RAW_MAX_BYTES) { sendError(res, 413, 'too_large', 'File is too large to stream.'); return; }
    // DISPLAYED, never downloaded: an engine with no viewer for the type otherwise falls back
    // to saving it, which from the user's side reads as "I clicked the link, nothing opened,
    // and now there's a file in Downloads".
    res.setHeader('Content-Disposition', 'inline');
    // SCOPED TO IMAGES ON PURPOSE, and the scope is the point rather than an oversight.
    // `sandbox` is a DOCUMENT directive: it forces an opaque origin and turns scripting
    // off for whatever is framed. This same arm serves the `.pdf` the Knowledge page
    // iframes through its viewer, and that viewer is script-backed — a blanket header
    // here would blank a shipped surface in order to harden a type that cannot carry
    // script anyway. Belt and braces for a future image type that can (the load-bearing
    // control is the allowlist above, not this line); nothing for the PDF, which keeps
    // exactly the headers it has always had.
    if (rawType.startsWith('image/')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    serveMedia(req, res, absTarget, st.size, rawType);
    return;
  }

  if (absTarget.endsWith('.md')) {
    try {
      const { data, content } = readFrontmatter(absTarget);
      sendJson(res, 200, {
        path: rawPath,
        type: 'markdown',
        frontmatter: data,
        content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read markdown';
      sendError(res, 500, 'read_failed', message);
    }
    return;
  }

  if (absTarget.endsWith('.json')) {
    try {
      const raw = readFileSync(absTarget, 'utf-8');
      try {
        sendJson(res, 200, { path: rawPath, type: 'json', data: JSON.parse(raw) });
      } catch {
        sendJson(res, 200, { path: rawPath, type: 'json', raw });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file';
      sendError(res, 500, 'read_failed', message);
    }
    return;
  }

  try {
    const content = readFileSync(absTarget, 'utf-8');
    sendJson(res, 200, { path: rawPath, type: 'text', content });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read file';
    sendError(res, 500, 'read_failed', message);
  }
}

