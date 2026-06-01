import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson } from '../middleware.js';
import { loadCatalog, isSkillInstalled } from '../../lib/catalog.js';

/**
 * GET /api/packs — Return available packs and standalone skills from the catalog,
 * each annotated with `installed` (true when its SKILL.md exists on disk for any
 * supported platform — the filesystem is the source of truth, NOT config.packs).
 *
 * Imports loadCatalog/isSkillInstalled from lib/catalog.ts — NOT from
 * install-skill.ts — to avoid pulling @inquirer/prompts into the server bundle.
 *
 * Returns { packs: [], standalone: [] } when catalog is unreadable (graceful degradation).
 */
export async function handlePacksGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const loaded = loadCatalog();
  if (!loaded) {
    sendJson(res, 200, { packs: [], standalone: [] });
    return;
  }
  // contextRoot is the _dream_context/ dir; the project root (where .claude/skills
  // and .agents/skills live) is its parent.
  const projectRoot = dirname(contextRoot);
  const packs = loaded.catalog.packs.map((p) => ({ ...p, installed: isSkillInstalled(projectRoot, p.name) }));
  const standalone = loaded.catalog.standalone.map((s) => ({ ...s, installed: isSkillInstalled(projectRoot, s.name) }));
  sendJson(res, 200, { packs, standalone });
}
