import { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import {
  ArtifactError, deleteArtifact, getArtifact, listArtifacts, saveArtifact,
} from '../../lib/artifacts-store.js';

/**
 * Saved `dream-html` blocks — the HTTP face of `lib/artifacts-store.ts`.
 *
 * Unlike the Lab's insight routes this store has WRITES, because the whole point is that a
 * block the agent drew in a conversation becomes a thing the user keeps. See the store's
 * header for why an artifact is its own entity and not a Lab report item.
 *
 * The size cap is the only interesting policy here. A block's markup is agent-authored and
 * therefore unbounded in principle, and this one gets written to disk and then indexed into
 * the recall corpus on every build — so an accidental megabyte is not just a big file, it is
 * a big file that slows down every future search. Refused loudly rather than truncated: a
 * silently half-saved diagram is worse than one that did not save.
 */
const MAX_HTML_BYTES = 512 * 1024;
const MAX_TITLE_CHARS = 120;

/** GET /api/artifacts — the saved-blocks list, newest first. Metadata only: the list view
 *  shows names and provenance, and shipping every block's markup would make opening the
 *  list cost as much as opening all of them. */
export async function handleArtifactsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { artifacts: listArtifacts(contextRoot) });
}

/** GET /api/artifacts/:slug — one artifact, markup included. */
export async function handleArtifactShow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const artifact = getArtifact(contextRoot, params.slug);
  if (!artifact) {
    sendError(res, 404, 'not_found', `No saved block: ${params.slug}`);
    return;
  }
  sendJson(res, 200, artifact);
}

/** POST /api/artifacts { title, html, sourceTitle?, sourceSession?, tags?, slug? } */
export async function handleArtifactSave(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const html = typeof body.html === 'string' ? body.html : '';
  if (!title) {
    sendError(res, 400, 'invalid_title', 'A saved block needs a name.');
    return;
  }
  if (title.length > MAX_TITLE_CHARS) {
    sendError(res, 400, 'invalid_title', `Name is too long (max ${MAX_TITLE_CHARS}).`);
    return;
  }
  if (!html.trim()) {
    sendError(res, 400, 'invalid_html', 'There is nothing to save — the block is empty.');
    return;
  }
  if (Buffer.byteLength(html, 'utf-8') > MAX_HTML_BYTES) {
    sendError(res, 413, 'too_large', `This block is over the ${MAX_HTML_BYTES / 1024}KB save limit.`);
    return;
  }

  try {
    const saved = saveArtifact(contextRoot, {
      title,
      html,
      sourceTitle: typeof body.sourceTitle === 'string' ? body.sourceTitle : null,
      sourceSession: typeof body.sourceSession === 'string' ? body.sourceSession : null,
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [],
      slug: typeof body.slug === 'string' ? body.slug : undefined,
    });
    sendJson(res, 201, saved);
  } catch (err) {
    if (err instanceof ArtifactError) {
      sendError(res, 400, 'invalid_artifact', err.message);
      return;
    }
    throw err;
  }
}

/** DELETE /api/artifacts/:slug */
export async function handleArtifactDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!deleteArtifact(contextRoot, params.slug)) {
    sendError(res, 404, 'not_found', `No saved block: ${params.slug}`);
    return;
  }
  sendJson(res, 200, { deleted: params.slug });
}
