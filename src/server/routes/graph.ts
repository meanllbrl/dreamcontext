import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { normalize, resolve, sep } from 'node:path';
import { buildGraph } from '../../lib/graph.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { sendJson, sendError } from '../middleware.js';

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
 * GET /api/graph/content?path=<relative-path-inside-_dream_context>
 * Returns markdown/json/text content for any node's file. Used by the
 * Brain drawer to show rendered content without cross-page navigation.
 */
export async function handleGraphContentGet(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
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

