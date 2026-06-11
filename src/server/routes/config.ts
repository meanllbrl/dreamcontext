import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { readSetupConfig, updateSetupConfig, type ClickUpConfig } from '../../lib/setup-config.js';
import { applyClaudeAutoMemory } from '../../lib/claude-settings.js';
import { parsePlatformList, PLATFORM_CATALOG } from '../../lib/platforms.js';
import { ensureRemoteBackendGitignore } from '../../lib/task-backend/paths.js';

/**
 * GET /api/config — Return the current project's setup config.
 * Always 200; returns null config when the config file does not exist.
 */
export async function handleConfigGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const config = readSetupConfig(dirname(contextRoot));
  sendJson(res, 200, { config });
}

/**
 * PATCH /api/config — Update platforms and/or packs via a strict allow-list.
 *
 * Security: the body is NEVER spread. Only 'platforms' and 'packs' are picked
 * explicitly so prototype-pollution and unexpected field injection are impossible.
 */
export async function handleConfigUpdate(
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

  // Build a FRESH patch from the explicit allow-list — never spread body.
  const patch: {
    platforms?: ReturnType<typeof parsePlatformList>['platforms'];
    packs?: string[];
    disableNativeMemory?: boolean;
    taskBackend?: 'local' | 'clickup';
    cloudTaskManagement?: boolean;
    clickup?: ClickUpConfig;
  } = {};

  if (body.platforms !== undefined) {
    // Validate: must be an array of strings, then pass through parsePlatformList.
    if (!Array.isArray(body.platforms) || !body.platforms.every((p) => typeof p === 'string')) {
      sendError(res, 400, 'invalid_platforms', `Platforms must be an array of platform IDs. Supported: ${PLATFORM_CATALOG.map(p => p.id).join(', ')}.`);
      return;
    }
    const { platforms: validPlatforms, invalid } = parsePlatformList(body.platforms.join(','));
    if (invalid.length > 0) {
      sendError(res, 400, 'invalid_platforms', `Unknown platform(s): ${invalid.join(', ')}. Supported: ${PLATFORM_CATALOG.map(p => p.id).join(', ')}.`);
      return;
    }
    patch.platforms = validPlatforms;
  }

  if (body.packs !== undefined) {
    if (
      !Array.isArray(body.packs) ||
      !body.packs.every((el) => typeof el === 'string' && el.length > 0)
    ) {
      sendError(res, 400, 'invalid_packs', 'Packs must be a non-empty array of non-empty strings.');
      return;
    }
    patch.packs = body.packs as string[];
  }

  if (body.disableNativeMemory !== undefined) {
    if (typeof body.disableNativeMemory !== 'boolean') {
      sendError(res, 400, 'invalid_disable_native_memory', 'disableNativeMemory must be a boolean.');
      return;
    }
    patch.disableNativeMemory = body.disableNativeMemory;
  }

  // Task backend (issue #11) — strict-pick, like everything else here.
  if (body.taskBackend !== undefined) {
    if (body.taskBackend !== 'local' && body.taskBackend !== 'clickup') {
      sendError(res, 400, 'invalid_task_backend', 'taskBackend must be "local" or "clickup".');
      return;
    }
    patch.taskBackend = body.taskBackend;
    patch.cloudTaskManagement = body.taskBackend === 'clickup';
  }

  if (body.cloudTaskManagement !== undefined) {
    if (typeof body.cloudTaskManagement !== 'boolean') {
      sendError(res, 400, 'invalid_cloud_task_management', 'cloudTaskManagement must be a boolean.');
      return;
    }
    patch.cloudTaskManagement = body.cloudTaskManagement;
    if (patch.taskBackend === undefined) {
      patch.taskBackend = body.cloudTaskManagement ? 'clickup' : 'local';
    }
  }

  if (body.clickup !== undefined) {
    if (body.clickup === null || typeof body.clickup !== 'object' || Array.isArray(body.clickup)) {
      sendError(res, 400, 'invalid_clickup', 'clickup must be an object.');
      return;
    }
    const raw = body.clickup as Record<string, unknown>;
    const picked: ClickUpConfig = {};
    for (const key of ['teamId', 'spaceId', 'listId'] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'string' || !(raw[key] as string).trim()) {
          sendError(res, 400, 'invalid_clickup', `clickup.${key} must be a non-empty string.`);
          return;
        }
        picked[key] = (raw[key] as string).trim();
      }
    }
    if (raw.changelogTarget !== undefined) {
      if (raw.changelogTarget !== 'comments') {
        sendError(res, 400, 'invalid_clickup', 'clickup.changelogTarget must be "comments".');
        return;
      }
      picked.changelogTarget = 'comments';
    }
    // Merge over the existing block so partial PATCHes don't drop ids.
    const existing = readSetupConfig(dirname(contextRoot))?.clickup ?? {};
    patch.clickup = { ...existing, ...picked };
  }

  if (
    patch.platforms === undefined &&
    patch.packs === undefined &&
    patch.disableNativeMemory === undefined &&
    patch.taskBackend === undefined &&
    patch.cloudTaskManagement === undefined &&
    patch.clickup === undefined
  ) {
    sendError(res, 400, 'no_changes', 'Provide at least one of: platforms, packs, disableNativeMemory, taskBackend, cloudTaskManagement, clickup.');
    return;
  }

  const projectRoot = dirname(contextRoot);

  // Flipping to a remote backend gitignores the derived files FIRST — the
  // mirror/sync state must never be committable.
  if (patch.taskBackend === 'clickup') {
    try {
      ensureRemoteBackendGitignore(projectRoot);
    } catch (err) {
      sendError(res, 500, 'gitignore_failed', `Could not update .gitignore: ${(err as Error).message}`);
      return;
    }
  }

  const next = updateSetupConfig(projectRoot, patch);
  // Reflect the toggle into Claude Code's .claude/settings.json immediately so the
  // change takes effect without re-running setup.
  if (patch.disableNativeMemory !== undefined) {
    applyClaudeAutoMemory(projectRoot, patch.disableNativeMemory);
  }
  sendJson(res, 200, { config: next });
}
