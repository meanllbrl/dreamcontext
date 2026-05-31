import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFrontmatter, writeFrontmatter } from '../../lib/frontmatter.js';
import { listSections, readSection } from '../../lib/markdown.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { safeChildPath } from '../safe-path.js';
import { recordDashboardChange } from '../change-tracker.js';

function getCoreDir(contextRoot: string): string {
  return join(contextRoot, 'core');
}

/**
 * GET /api/core - List all core files
 */
export async function handleCoreList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const coreDir = getCoreDir(contextRoot);
  if (!existsSync(coreDir)) {
    sendJson(res, 200, { files: [] });
    return;
  }

  const entries = readdirSync(coreDir, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.sql') || e.name.endsWith('.json')))
    .map(e => {
      const filePath = join(coreDir, e.name);
      let frontmatter: Record<string, unknown> = {};
      if (e.name.endsWith('.md')) {
        try {
          const { data } = readFrontmatter(filePath);
          frontmatter = data;
        } catch { /* not a frontmatter file */ }
      }
      return {
        filename: e.name,
        name: frontmatter.name ?? e.name.replace(/^\d+\./, '').replace(/\.[^.]+$/, '').replace(/_/g, ' '),
        type: frontmatter.type ?? (e.name.endsWith('.json') ? 'json' : e.name.endsWith('.sql') ? 'sql' : 'markdown'),
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

  sendJson(res, 200, { files });
}

/**
 * GET /api/core/:filename - Read a single core file
 */
export async function handleCoreGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { filename } = params;
  const filePath = safeChildPath(getCoreDir(contextRoot), filename);
  if (!filePath) {
    sendError(res, 400, 'invalid_path', 'Invalid filename.');
    return;
  }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Core file not found: ${filename}`);
    return;
  }

  if (filename.endsWith('.json')) {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(filePath, 'utf-8');
    try {
      const data = JSON.parse(raw);
      sendJson(res, 200, { filename, type: 'json', data });
    } catch {
      sendJson(res, 200, { filename, type: 'json', data: null, raw });
    }
    return;
  }

  if (filename.endsWith('.md')) {
    const { data: frontmatter, content } = readFrontmatter(filePath);
    let sections: string[] = [];
    try {
      sections = listSections(filePath);
    } catch { /* no sections */ }

    const sectionContents: Record<string, string> = {};
    for (const section of sections) {
      try {
        const sectionContent = readSection(filePath, section);
        if (sectionContent) sectionContents[section] = sectionContent;
      } catch { /* skip */ }
    }

    sendJson(res, 200, {
      filename,
      type: 'markdown',
      frontmatter,
      content,
      sections,
      sectionContents,
    });
    return;
  }

  // Other file types (e.g., .sql)
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(filePath, 'utf-8');
  sendJson(res, 200, { filename, type: 'text', content: raw });
}

/**
 * PUT /api/core/:filename - Write a core file
 */
export async function handleCoreUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { filename } = params;
  const filePath = safeChildPath(getCoreDir(contextRoot), filename);
  if (!filePath) {
    sendError(res, 400, 'invalid_path', 'Invalid filename.');
    return;
  }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Core file not found: ${filename}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const changedParts: string[] = [];

  if (filename.endsWith('.md')) {
    const frontmatter = (body.frontmatter as Record<string, unknown>) ?? undefined;
    const content = body.content as string;

    if (content === undefined && !frontmatter) {
      sendError(res, 400, 'no_changes', 'Provide frontmatter and/or content to update.');
      return;
    }

    // Read existing file ONCE for both writing and change tracking
    const existing = readFrontmatter(filePath);

    if (frontmatter) {
      const changedKeys = Object.keys(frontmatter).filter(
        k => JSON.stringify(existing.data[k]) !== JSON.stringify(frontmatter[k]),
      );
      if (changedKeys.length > 0) changedParts.push(`frontmatter (${changedKeys.join(', ')})`);
    }
    if (content !== undefined && content !== existing.content) {
      changedParts.push('content');
    }

    if (frontmatter && content !== undefined) {
      writeFrontmatter(filePath, frontmatter, content);
    } else if (frontmatter) {
      writeFrontmatter(filePath, { ...existing.data, ...frontmatter }, existing.content);
    } else {
      writeFrontmatter(filePath, existing.data, content);
    }
  } else {
    // Non-markdown files: write raw content
    if (typeof body.content !== 'string') {
      sendError(res, 400, 'missing_content', 'Content string is required for non-markdown files.');
      return;
    }
    changedParts.push('content');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, body.content as string, 'utf-8');
  }

  const what = changedParts.length > 0 ? changedParts.join(' and ') : 'file';
  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'update',
    target: `core/${filename}`,
    summary: `core '${filename}': updated ${what}`,
  });

  sendJson(res, 200, { success: true });
}
