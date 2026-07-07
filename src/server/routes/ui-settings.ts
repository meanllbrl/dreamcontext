import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';

// ─── Brain (graph) UI settings persistence ──────────────────────────────────────
//
// The Brain page's graph settings (text-fade threshold, node size, forces, color
// groups, …) live in localStorage on the client. That's fine for the web
// dashboard, but the desktop app picks a FRESH loopback port each launch → a new
// origin → localStorage is empty every launch (the documented "persistence
// gotcha"). To make those settings survive, we mirror them server-side, per
// project, at `_dream_context/state/.brain-settings.json`.
//
// The blob is OPAQUE to the server: the client owns its shape (GraphSettings).
// We only store/return whatever JSON object the client PUTs, with a size cap so a
// runaway client can't write an unbounded file. Read of a missing/corrupt file
// returns `{}` (never throws) so the client falls back to its own defaults.

/** Relative path inside a project's `_dream_context/` for the settings blob. */
const BRAIN_SETTINGS_REL_PATH = 'state/.brain-settings.json';

/** Hard cap on the serialized blob (generous for settings; blocks abuse). */
const MAX_BYTES = 256 * 1024;

function settingsPath(contextRoot: string): string {
  return join(contextRoot, BRAIN_SETTINGS_REL_PATH);
}

/**
 * GET /api/brain-settings — return the persisted brain settings blob for the
 * current vault, or `{}` when none/corrupt. Read-only; never throws.
 */
export async function handleBrainSettingsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const path = settingsPath(contextRoot);
  if (!existsSync(path)) {
    sendJson(res, 200, { settings: {} });
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    sendJson(res, 200, { settings });
  } catch {
    // Hand-edited / corrupt file — treat as empty, let the client use defaults.
    sendJson(res, 200, { settings: {} });
  }
}

/**
 * PUT /api/brain-settings — persist the brain settings blob for the current
 * vault. Mutation; behind the cross-site CSRF guard. STRICT-PICK: only the
 * `settings` object is read off the body (never spread). Rejects non-object
 * payloads and anything over the size cap.
 */
export async function handleBrainSettingsPut(
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
  const settings = body.settings;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    sendError(res, 400, 'invalid_settings', 'settings must be a JSON object.');
    return;
  }
  const serialized = JSON.stringify(settings, null, 2);
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_BYTES) {
    sendError(res, 400, 'too_large', 'settings payload is too large.');
    return;
  }
  try {
    const path = settingsPath(contextRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized + '\n', 'utf-8');
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[ui-settings] brain-settings write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to persist brain settings.');
  }
}

// ─── Generic per-machine settings blob (factory) ─────────────────────────────
//
// Same shape as the brain-settings pair above, parameterized by the target file.
// Used for surfaces whose preferences are PURELY personal (no team-sharing need),
// so they get one gitignored per-machine file instead of the shared/local split.
// The blob stays opaque to the server: the client owns its shape.

type SettingsHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
) => Promise<void>;

function makeSettingsHandlers(relPath: string, logTag: string): { get: SettingsHandler; put: SettingsHandler } {
  const pathFor = (contextRoot: string) => join(contextRoot, relPath);
  const get: SettingsHandler = async (_req, res, _params, contextRoot) => {
    const path = pathFor(contextRoot);
    if (!existsSync(path)) {
      sendJson(res, 200, { settings: {} });
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      sendJson(res, 200, { settings });
    } catch {
      sendJson(res, 200, { settings: {} });
    }
  };
  const put: SettingsHandler = async (req, res, _params, contextRoot) => {
    const body = await parseJsonBody(req);
    if (!body) {
      sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
      return;
    }
    const settings = body.settings;
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      sendError(res, 400, 'invalid_settings', 'settings must be a JSON object.');
      return;
    }
    const serialized = JSON.stringify(settings, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > MAX_BYTES) {
      sendError(res, 400, 'too_large', 'settings payload is too large.');
      return;
    }
    try {
      const path = pathFor(contextRoot);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serialized + '\n', 'utf-8');
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error(`[ui-settings] ${logTag} write failed:`, err);
      sendError(res, 500, 'write_failed', `Failed to persist ${logTag}.`);
    }
  };
  return { get, put };
}

// ─── Roadmap toolbar preferences (per-machine) ───────────────────────────────
// The Roadmap board's toolbar state (filters, sort, view-type, properties,
// search) is personal to this machine — mirror it to a gitignored file so it
// survives the desktop app's per-launch loopback-port change (localStorage reset).
const roadmapPrefsHandlers = makeSettingsHandlers('state/.roadmap-prefs.json', 'roadmap-prefs');
export const handleRoadmapPrefsGet = roadmapPrefsHandlers.get;
export const handleRoadmapPrefsPut = roadmapPrefsHandlers.put;

// ─── Lab (Insights) board preferences (per-machine) ──────────────────────────
// Per-group card order + collapsed groups on the Insights page — personal to
// this machine, mirrored server-side for the same loopback-port reason.
const labPrefsHandlers = makeSettingsHandlers('state/.lab-prefs.json', 'lab-prefs');
export const handleLabPrefsGet = labPrefsHandlers.get;
export const handleLabPrefsPut = labPrefsHandlers.put;
