/**
 * Mağaza D1 (C3): the installed-plugin set for the dashboard.
 *
 *   GET  /api/plugins              → { version, plugins: [{ id, installed, source, hasData, pinned, automations, conflict?, file? }] }
 *   POST /api/plugins/:id/install  → install (team data, overrides/plugins/<id>.json); pins it on this Mac
 *   POST /api/plugins/:id/remove   → remove (hides; data untouched); unpins it on this Mac
 *   PUT  /api/plugins/pins         → { pinned: string[] } replaces this Mac's pins
 *
 * 404 for an unknown id; 409 `plugin_entry_conflict` (with `file`) while the entry holds a git
 * conflict. GET may write the first `pluginPins` value (machine-local, ignored by git).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { isPluginId } from '../../lib/plugins/registry.js';
import {
  installPlugin,
  pluginStatuses,
  readPins,
  removePlugin,
  setPins,
  PluginEntryConflictError,
} from '../../lib/plugins/store.js';
import { automationsUsingPlugin } from '../../lib/plugins/automations.js';

function view(contextRoot: string): unknown {
  const statuses = pluginStatuses(contextRoot);
  const pins = readPins(contextRoot, statuses.filter((s) => s.installed).map((s) => s.id));
  return {
    version: dreamcontextVersion(),
    plugins: statuses.map((s) => ({
      id: s.id,
      installed: s.installed,
      source: s.source,
      hasData: s.hasData,
      pinned: pins.includes(s.id),
      automations: automationsUsingPlugin(contextRoot, s.id),
      ...(s.conflict || s.error ? { conflict: true, file: s.file } : {}),
    })),
  };
}

export async function handlePluginsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, view(contextRoot));
  } catch (err) {
    console.error('[plugins] list failed:', err);
    sendError(res, 500, 'list_failed', 'Failed to read plugins.');
  }
}

async function change(
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
  op: 'install' | 'remove',
): Promise<void> {
  const id = params.id ?? '';
  if (!isPluginId(id)) {
    sendError(res, 404, 'unknown_plugin', `No plugin "${id}".`);
    return;
  }
  try {
    const r = op === 'install' ? installPlugin(contextRoot, id) : removePlugin(contextRoot, id);
    if (r.mirrorError) console.error(`[plugins] ${id}: learning.enabled mirror not written: ${r.mirrorError}`);
    sendJson(res, 200, view(contextRoot));
  } catch (err) {
    if (err instanceof PluginEntryConflictError) {
      sendJson(res, 409, { error: 'plugin_entry_conflict', plugin: err.plugin, file: err.file, message: err.message });
      return;
    }
    console.error(`[plugins] ${op} ${id} failed:`, err);
    sendError(res, 500, `${op}_failed`, `Failed to ${op} the plugin.`);
  }
}

export async function handlePluginInstall(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  await change(res, params, contextRoot, 'install');
}

export async function handlePluginRemove(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  await change(res, params, contextRoot, 'remove');
}

export async function handlePluginPins(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = (await parseJsonBody(req)) as { pinned?: unknown } | null;
  if (!body || !Array.isArray(body.pinned) || !body.pinned.every((x) => typeof x === 'string')) {
    sendError(res, 400, 'invalid_body', 'Body must be { "pinned": string[] }.');
    return;
  }
  try {
    setPins(contextRoot, body.pinned as string[]);
    sendJson(res, 200, view(contextRoot));
  } catch (err) {
    console.error('[plugins] pins failed:', err);
    sendError(res, 500, 'pins_failed', 'Failed to save the pins.');
  }
}
