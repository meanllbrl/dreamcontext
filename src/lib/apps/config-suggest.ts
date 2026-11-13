/**
 * Candidates for an app's settings from THIS project (app-ux-genel K9): one place, used by
 * `dreamcontext apps config --suggest` (Claude fills the settings) and by the self-fill form's
 * pickers (`GET /api/apps/:slug/config/suggest`), so both offer the same choices.
 *
 * Only names are read (file and folder names in the brain, the project's MCP server names);
 * no file body leaves here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigField } from './manifest.js';

const MAX = 200;

function names(dir: string, ext?: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && !d.isSymbolicLink() && (ext ? d.isFile() && d.name.endsWith(ext) : true))
      .map((d) => (ext ? d.name.slice(0, -ext.length) : d.name.replace(/\.md$/, '')))
      .sort()
      .slice(0, MAX);
  } catch {
    return [];
  }
}

/** The tags tasks carry in this brain (`tags:` lines of task files), most used first. */
function taskTags(ctx: string): string[] {
  const count = new Map<string, number>();
  let files: string[] = [];
  try { files = readdirSync(join(ctx, 'state')).filter((f) => f.endsWith('.md')).slice(0, 2000); } catch { return []; }
  for (const f of files) {
    let head = '';
    try { head = readFileSync(join(ctx, 'state', f), 'utf-8').slice(0, 4000); } catch { continue; }
    const block = /\ntags:\n((?:\s+- .*\n)+)/.exec(head)?.[1] ?? '';
    for (const m of block.matchAll(/- '?([^'\n]+?)'?\s*$/gm)) count.set(m[1]!, (count.get(m[1]!) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, MAX);
}

/** The project's MCP server names (`.mcp.json`). */
function mcpServers(projectRoot: string): string[] {
  try {
    const j = JSON.parse(readFileSync(join(projectRoot, '.mcp.json'), 'utf-8')) as { mcpServers?: Record<string, unknown> };
    return Object.keys(j.mcpServers ?? {}).sort().slice(0, MAX);
  } catch {
    return [];
  }
}

export function configSuggestions(projectRoot: string, field: Pick<ConfigField, 'type' | 'choices'>): string[] {
  const ctx = join(projectRoot, '_dream_context');
  switch (field.type) {
    case 'insight': return names(join(ctx, 'lab', 'insights'), '.md');
    case 'objective': return names(join(ctx, 'core', 'objectives'), '.md');
    case 'agent': return names(join(ctx, 'agents'));
    case 'task-tag': return taskTags(ctx);
    case 'mcp-tool': return mcpServers(projectRoot);
    case 'choice': return [...(field.choices ?? [])];
    default: return [];
  }
}
