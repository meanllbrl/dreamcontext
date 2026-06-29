import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';

// ─── Tasks-board preferences persistence (saved views) ──────────────────────────
//
// The board's preferences — saved VIEWS (each carrying its own filter / sort /
// grouping combination), the managed VERSION list, and default card properties —
// must NOT be lost to a browser's localStorage or a fresh desktop-app loopback
// origin. They live in two project files instead, with a deliberate split:
//
//   SHARED ("save for all")  → `_dream_context/overrides/board.json`
//        Version-controlled (the `overrides/` folder is git-tracked and survives
//        `dreamcontext update`). This is the team's source of truth for what views
//        exist and how each one is filtered/sorted/grouped. Editing a view "for
//        everyone" writes here, so the combination is permanent and shared.
//
//   LOCAL ("save for yourself") → `_dream_context/state/board.local.json`
//        Per-machine and git-IGNORED (the whole `state/` dir is in .gitignore).
//        Holds this person's private view overrides, their personal/local-only
//        views, and inherently per-machine UI state (which view is active, theme,
//        collapsed columns). Editing a view "for yourself" writes here only.
//
// Both blobs are OPAQUE to the server: the client owns their shape. We only
// store/return whatever JSON object the client PUTs, with a size cap. A
// missing/corrupt file reads back as `{}` (never throws) so the client falls
// back to its own defaults.

const SHARED_REL_PATH = 'overrides/board.json';
const LOCAL_REL_PATH = 'state/board.local.json';

/** Hard cap on each serialized blob (generous for view configs; blocks abuse). */
const MAX_BYTES = 512 * 1024;

function sharedPath(contextRoot: string): string {
  return join(contextRoot, SHARED_REL_PATH);
}
function localPath(contextRoot: string): string {
  return join(contextRoot, LOCAL_REL_PATH);
}

/** Read a JSON object blob, or `{}` when missing / corrupt. Never throws. */
function readBlob(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    // Hand-edited / corrupt file — treat as empty, let the client use defaults.
    return {};
  }
}

/**
 * GET /api/board — return both preference blobs for the current vault:
 * `{ shared, local }`. The client merges them (local view-overrides win over the
 * shared definition, local-only views are appended). Read-only; never throws.
 */
export async function handleBoardGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, {
    shared: readBlob(sharedPath(contextRoot)),
    local: readBlob(localPath(contextRoot)),
  });
}

type PickResult =
  | { ok: true; board: Record<string, unknown> }
  | { ok: false; error: string };

/** STRICT-PICK + size-cap validation of the `board` object off a request body. */
function pickBoard(body: Record<string, unknown> | null): PickResult {
  if (!body) return { ok: false, error: 'Request body must be valid JSON.' };
  const board = body.board;
  if (board === null || typeof board !== 'object' || Array.isArray(board)) {
    return { ok: false, error: 'board must be a JSON object.' };
  }
  return { ok: true, board: board as Record<string, unknown> };
}

function writeBlob(path: string, board: Record<string, unknown>): string | null {
  const serialized = JSON.stringify(board, null, 2);
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_BYTES) {
    return 'board payload is too large.';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialized + '\n', 'utf-8');
  return null;
}

/**
 * PUT /api/board/shared — persist the SHARED ("save for all") board blob to the
 * version-controlled `overrides/board.json`. Mutation; behind the CSRF guard.
 */
export async function handleBoardSharedPut(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const result = pickBoard(await parseJsonBody(req));
  if (!result.ok) {
    sendError(res, 400, 'invalid_board', result.error);
    return;
  }
  try {
    const tooLarge = writeBlob(sharedPath(contextRoot), result.board);
    if (tooLarge) {
      sendError(res, 400, 'too_large', tooLarge);
      return;
    }
    sendJson(res, 200, { ok: true, scope: 'shared' });
  } catch (err) {
    console.error('[board] shared write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to persist shared board preferences.');
  }
}

/**
 * PUT /api/board/local — persist the LOCAL ("save for yourself") board blob to
 * the git-ignored, per-machine `state/board.local.json`. Mutation; behind the
 * CSRF guard.
 */
export async function handleBoardLocalPut(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const result = pickBoard(await parseJsonBody(req));
  if (!result.ok) {
    sendError(res, 400, 'invalid_board', result.error);
    return;
  }
  try {
    const tooLarge = writeBlob(localPath(contextRoot), result.board);
    if (tooLarge) {
      sendError(res, 400, 'too_large', tooLarge);
      return;
    }
    sendJson(res, 200, { ok: true, scope: 'local' });
  } catch (err) {
    console.error('[board] local write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to persist local board preferences.');
  }
}
