import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { listSections, readSection } from '../../lib/markdown.js';
import { sendJson, sendError } from '../middleware.js';
import { safeChildPath } from '../safe-path.js';

function getFeaturesDir(contextRoot: string): string {
  return join(contextRoot, 'core', 'features');
}

/**
 * GET /api/features - List all features
 */
export async function handleFeaturesList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const featuresDir = getFeaturesDir(contextRoot);
  if (!existsSync(featuresDir)) {
    sendJson(res, 200, { features: [] });
    return;
  }

  const files = fg.sync('*.md', { cwd: featuresDir, absolute: true });
  const features = files.map(file => {
    const slug = basename(file, '.md');
    const { data } = readFrontmatter<Record<string, unknown>>(file);
    return {
      slug,
      id: data.id ?? '',
      status: data.status ?? 'planning',
      created: data.created ?? '',
      updated: data.updated ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      related_tasks: Array.isArray(data.related_tasks) ? data.related_tasks : [],
    };
  });

  sendJson(res, 200, { features });
}

/**
 * GET /api/features/:slug - Get single feature with all sections
 */
export async function handleFeaturesGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = safeChildPath(getFeaturesDir(contextRoot), `${slug}.md`);
  if (!filePath) { sendError(res, 400, 'invalid_path', `Invalid feature slug: ${slug}`); return; }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Feature not found: ${slug}`);
    return;
  }

  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
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
    feature: {
      slug,
      ...data,
      content,
      sections,
      sectionContents,
    },
  });
}
