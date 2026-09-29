import { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import {
  boardInsightSlugs,
  BoardStoreError,
  createBoard,
  dedupeSlugs,
  deleteBoard,
  getBoard,
  listBoards,
  putBoard,
  unplacedInsights,
  type Board,
  type BoardResponse,
} from '../../lib/lab/boards.js';
import { resolveBoardFrames } from '../../lib/lab/frames.js';
import {
  getLibraryBlock,
  listLibraryBlocks,
  parseLibraryInputs,
  saveLibraryBlock,
  validateLibraryBlock,
} from '../../lib/lab/block-library.js';
import { getInsight, isSafeInsightSlug, readCache } from '../../lib/lab/store.js';
import { LabError } from '../../lib/lab/types.js';
import { toSummary, withoutHistoryTrails } from './lab.js';

/**
 * Board + block-library HTTP API (Insights v2). Thin wrappers over the board
 * store (`src/lib/lab/boards.ts`) the CLI writes through too, so both take the
 * SAME board lock and the same rev check.
 *
 *   GET    /api/lab/boards              every board (derived, materialized, error boards) + unplaced
 *   POST   /api/lab/boards              { title, slug? } -> a new empty board
 *   GET    /api/lab/boards/:slug        BoardResponse: spec + frames + summaries + unplaced
 *   PUT    /api/lab/boards/:slug        { rev, spec } -> strict-validated, rev-checked write
 *   DELETE /api/lab/boards/:slug[?rev=] delete (materializes the others first when derived)
 *   GET    /api/lab/caches?slugs=a,b    summaries + caches (no history trails), <= 60 slugs
 *   GET    /api/lab/blocks[/:slug]      the vault's custom HTML block library
 *   PUT    /api/lab/blocks/:slug        { title, description?, inputs?, html, rev? }
 *
 * Status mapping: BoardStoreError carries its own (400 invalid with
 * diagnostics, 404, 409 rev conflict / exists, 423 error board, 503 the board
 * lock stayed busy past the wait: the client retries). Every `:slug` is
 * checked with `isSafeInsightSlug` AFTER the router decoded it, so `%2F` and
 * `..` never reach a path. All data reads go through the hardened readers
 * (symlinked or escaping files read as absent).
 *
 * The cross-site write guard is global (`isCrossSiteWrite` in the server
 * loop), so PUT/POST/DELETE here are refused from a foreign origin before any
 * handler runs.
 */

/** Most slugs one `GET /api/lab/caches` may ask for (the client chunks by this). */
export const MAX_CACHE_SLUGS = 60;

function badSlug(res: ServerResponse, what: string, slug: unknown): void {
  sendError(res, 400, 'invalid_slug', `Invalid ${what} slug ${JSON.stringify(slug)}: use kebab-case.`);
}

/** The route's `:slug`, already URL-decoded by the router, or null (400 sent). */
function slugParam(res: ServerResponse, params: Record<string, string>, what: string): string | null {
  const slug = params.slug;
  if (typeof slug !== 'string' || !isSafeInsightSlug(slug)) {
    badSlug(res, what, slug);
    return null;
  }
  return slug;
}

function sendStoreError(res: ServerResponse, err: unknown, action: string): void {
  if (err instanceof BoardStoreError) {
    sendJson(res, err.status, {
      error: err.code,
      message: err.message,
      ...(err.diagnostics.length > 0 ? { diagnostics: err.diagnostics } : {}),
    });
    return;
  }
  if (err instanceof LabError) {
    sendError(res, 400, 'invalid', err.message);
    return;
  }
  console.error(`[lab] ${action} failed:`, err);
  sendError(res, 500, 'board_failed', `Failed to ${action}.`);
}

/** Summaries for every insight a board shows (missing insights are simply absent). */
function boardSummaries(contextRoot: string, board: Pick<Board, 'cards'>): BoardResponse['summaries'] {
  const out: BoardResponse['summaries'] = {};
  for (const slug of boardInsightSlugs(board)) {
    const manifest = getInsight(contextRoot, slug);
    if (manifest) out[slug] = toSummary(contextRoot, manifest);
  }
  return out;
}

/** The whole board response for one board (what GET and a successful PUT return). */
export function buildBoardResponse(contextRoot: string, board: Board): BoardResponse {
  const { boards, derived } = listBoards(contextRoot);
  return {
    board,
    frames: resolveBoardFrames(contextRoot, board),
    summaries: boardSummaries(contextRoot, board),
    unplaced: derived ? [] : unplacedInsights(contextRoot, boards),
  };
}

/** GET /api/lab/boards — every board, derived or materialized, error boards included. */
export async function handleLabBoardsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const { boards, derived } = listBoards(contextRoot);
    sendJson(res, 200, { boards, derived, unplaced: derived ? [] : unplacedInsights(contextRoot, boards) });
  } catch (err) {
    sendStoreError(res, err, 'list the boards');
  }
}

/** GET /api/lab/boards/:slug — spec + resolved frames + per-insight summaries + unplaced. */
export async function handleLabBoardShow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = slugParam(res, params, 'board');
  if (!slug) return;
  try {
    const board = getBoard(contextRoot, slug);
    if (!board) {
      sendError(res, 404, 'not-found', `Board not found: ${slug}`);
      return;
    }
    sendJson(res, 200, buildBoardResponse(contextRoot, board));
  } catch (err) {
    sendStoreError(res, err, 'read the board');
  }
}

/**
 * PUT /api/lab/boards/:slug { rev, spec } — replace a board's spec.
 *
 * `rev` is REQUIRED: the rev the client last saw (a derived board's rev too:
 * the first write materializes every board). `null` = create a board that
 * must not exist yet. A mismatch is 409, never a silent overwrite. `spec` is
 * the file form or the normalized form; client-echoed board metadata (`slug`,
 * `rev`, `derived`, `error`, `warnings`) is ignored.
 */
export async function handleLabBoardPut(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = slugParam(res, params, 'board');
  if (!slug) return;
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON: { rev, spec }.');
    return;
  }
  if (!('rev' in body) || (body.rev !== null && typeof body.rev !== 'string')) {
    sendError(res, 400, 'missing_rev', '`rev` is required: the board rev you last read (null to create a new board).');
    return;
  }
  const spec = body.spec ?? body.board;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    sendError(res, 400, 'invalid_body', '`spec` must be the board spec: { title, order?, cards }.');
    return;
  }
  try {
    const board = await putBoard(contextRoot, slug, spec, { expectedRev: body.rev as string | null });
    if (!board) {
      sendError(res, 500, 'board_failed', 'The board was not written.');
      return;
    }
    sendJson(res, 200, buildBoardResponse(contextRoot, board));
  } catch (err) {
    sendStoreError(res, err, 'save the board');
  }
}

/** POST /api/lab/boards { title, slug? } — a new empty board after the last one. */
export async function handleLabBoardCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const title = body && typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    sendError(res, 400, 'invalid_body', 'Request body must be { title, slug? } with a non-empty title.');
    return;
  }
  let slug: string;
  if (body?.slug !== undefined) {
    if (typeof body.slug !== 'string' || !isSafeInsightSlug(body.slug)) {
      badSlug(res, 'board', body.slug);
      return;
    }
    slug = body.slug;
  } else {
    // Title -> ASCII kebab slug, deduped against the boards that exist now.
    const taken = new Set(listBoards(contextRoot).boards.map((b) => b.slug));
    const base = dedupeSlugs([title], 'board')[0];
    slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  }
  try {
    const board = await createBoard(contextRoot, slug, title);
    sendJson(res, 201, buildBoardResponse(contextRoot, board));
  } catch (err) {
    sendStoreError(res, err, 'create the board');
  }
}

/** DELETE /api/lab/boards/:slug[?rev=<rev>] — `rev`, when given, must match. */
export async function handleLabBoardDelete(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = slugParam(res, params, 'board');
  if (!slug) return;
  const rev = new URL(req.url || '/', 'http://localhost').searchParams.get('rev');
  try {
    await deleteBoard(contextRoot, slug, rev ? { expectedRev: rev } : {});
    sendJson(res, 200, { deleted: slug });
  } catch (err) {
    sendStoreError(res, err, 'delete the board');
  }
}

/**
 * GET /api/lab/caches?slugs=a,b,c — the bulk read legacy `insight` blocks draw
 * from: one request seeds every per-slug query (no 1+N). Caches come without
 * the history trails. At most MAX_CACHE_SLUGS slugs; an unsafe slug is a 400.
 */
export async function handleLabCaches(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const raw = new URL(req.url || '/', 'http://localhost').searchParams.get('slugs') ?? '';
  const slugs = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (slugs.length === 0) {
    sendError(res, 400, 'invalid_slugs', '`slugs` must name at least one insight: ?slugs=a,b.');
    return;
  }
  if (slugs.length > MAX_CACHE_SLUGS) {
    sendError(res, 400, 'too_many_slugs', `At most ${MAX_CACHE_SLUGS} slugs per request (got ${slugs.length}); split the request.`);
    return;
  }
  const unsafe = slugs.find((s) => !isSafeInsightSlug(s));
  if (unsafe !== undefined) {
    badSlug(res, 'insight', unsafe);
    return;
  }
  try {
    const summaries: BoardResponse['summaries'] = {};
    const caches: Record<string, unknown> = {};
    for (const slug of slugs) {
      const manifest = getInsight(contextRoot, slug);
      if (!manifest) continue;
      summaries[slug] = toSummary(contextRoot, manifest);
      const cache = withoutHistoryTrails(readCache(contextRoot, slug));
      if (cache) {
        const { history: _dropHistory, ...rest } = cache;
        caches[slug] = rest;
      } else {
        caches[slug] = null;
      }
    }
    sendJson(res, 200, { summaries, caches });
  } catch (err) {
    console.error('[lab] caches read failed:', err);
    sendError(res, 500, 'caches_failed', 'Failed to read the caches.');
  }
}

/** GET /api/lab/blocks — the vault library (custom HTML blocks). */
export async function handleLabBlocksList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, { blocks: listLibraryBlocks(contextRoot) });
  } catch (err) {
    console.error('[lab] block library read failed:', err);
    sendError(res, 500, 'blocks_failed', 'Failed to read the block library.');
  }
}

/** GET /api/lab/blocks/:slug — one library entry. */
export async function handleLabBlockShow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = slugParam(res, params, 'library block');
  if (!slug) return;
  const block = getLibraryBlock(contextRoot, slug);
  if (!block) {
    sendError(res, 404, 'not-found', `Library block not found: ${slug}`);
    return;
  }
  sendJson(res, 200, { block });
}

/**
 * PUT /api/lab/blocks/:slug { title, description?, inputs?, html, rev? } —
 * save a library entry. `rev` when present is checked (null = must not exist
 * yet): a mismatch is 409.
 */
export async function handleLabBlockPut(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = slugParam(res, params, 'library block');
  if (!slug) return;
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be { title, description?, inputs?, html, rev? }.');
    return;
  }
  const input = {
    title: typeof body.title === 'string' ? body.title : '',
    description: typeof body.description === 'string' ? body.description : null,
    inputs: parseLibraryInputs(body.inputs),
    html: typeof body.html === 'string' ? body.html : '',
  };
  const problems = validateLibraryBlock(slug, input);
  if (problems.length > 0) {
    sendJson(res, 400, { error: 'invalid', message: `Invalid library block:\n- ${problems.join('\n- ')}`, problems });
    return;
  }
  let expectedRev: string | null | undefined;
  if ('rev' in body) {
    if (body.rev !== null && typeof body.rev !== 'string') {
      sendError(res, 400, 'invalid_body', '`rev` must be the rev you last read, or null to create.');
      return;
    }
    expectedRev = body.rev as string | null;
    const currentRev = getLibraryBlock(contextRoot, slug)?.rev ?? null;
    if (currentRev !== expectedRev) {
      sendError(res, 409, 'rev-conflict', `Library block "${slug}" changed elsewhere (rev ${currentRev ?? 'none'}); reload and retry.`);
      return;
    }
  }
  try {
    const block = saveLibraryBlock(contextRoot, slug, input, expectedRev);
    sendJson(res, 200, { block });
  } catch (err) {
    if (err instanceof LabError) {
      const conflict = /changed elsewhere/.test(err.message);
      sendError(res, conflict ? 409 : 400, conflict ? 'rev-conflict' : 'invalid', err.message);
      return;
    }
    console.error('[lab] block save failed:', err);
    sendError(res, 500, 'blocks_failed', 'Failed to save the library block.');
  }
}
