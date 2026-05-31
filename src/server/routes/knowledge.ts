import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildKnowledgeIndex } from '../../lib/knowledge-index.js';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { safeChildPath } from '../safe-path.js';
import { recordDashboardChange, buildFieldSummary } from '../change-tracker.js';
import type { FieldChange } from '../change-tracker.js';

function getKnowledgeDir(contextRoot: string): string {
  return join(contextRoot, 'knowledge');
}

/**
 * GET /api/knowledge - List knowledge index
 */
export async function handleKnowledgeList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const entries = buildKnowledgeIndex(contextRoot);
  sendJson(res, 200, { entries });
}

/**
 * GET /api/knowledge/:slug - Get single knowledge file
 */
export async function handleKnowledgeGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = safeChildPath(getKnowledgeDir(contextRoot), `${slug}.md`);
  if (!filePath) { sendError(res, 400, 'invalid_path', `Invalid knowledge slug: ${slug}`); return; }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Knowledge file not found: ${slug}`);
    return;
  }

  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  sendJson(res, 200, {
    entry: {
      slug,
      name: data.name ?? slug,
      description: data.description ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      date: data.date ?? '',
      pinned: data.pinned === true,
      content,
    },
  });
}

/**
 * PATCH /api/knowledge/:slug - Update knowledge file (e.g., pin/unpin)
 */
export async function handleKnowledgeUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = safeChildPath(getKnowledgeDir(contextRoot), `${slug}.md`);
  if (!filePath) { sendError(res, 400, 'invalid_path', `Invalid knowledge slug: ${slug}`); return; }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Knowledge file not found: ${slug}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  // Read old values BEFORE mutation for change tracking
  const { data: oldData } = readFrontmatter<Record<string, unknown>>(filePath);

  const updates: Record<string, unknown> = {};
  const fieldChanges: FieldChange[] = [];

  if (typeof body.pinned === 'boolean') {
    const oldPinned = oldData.pinned === true;
    if (oldPinned !== body.pinned) {
      updates.pinned = body.pinned;
      fieldChanges.push({ field: 'pinned', from: oldPinned, to: body.pinned });
    }
  }

  if (fieldChanges.length === 0) {
    sendError(res, 400, 'no_changes', 'No valid fields to update.');
    return;
  }

  updateFrontmatterFields(filePath, updates);

  recordDashboardChange(contextRoot, {
    entity: 'knowledge',
    action: 'update',
    target: `knowledge/${slug}.md`,
    field: fieldChanges.map(f => f.field).join(', '),
    fields: fieldChanges,
    summary: buildFieldSummary('knowledge', `knowledge/${slug}.md`, fieldChanges),
  });

  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  sendJson(res, 200, {
    entry: {
      slug,
      name: data.name ?? slug,
      description: data.description ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      date: data.date ?? '',
      pinned: data.pinned === true,
      content,
    },
  });
}
