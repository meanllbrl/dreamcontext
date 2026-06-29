import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonArray, insertToJsonArray, writeJsonArray } from '../../lib/json-file.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { generateId, today } from '../../lib/id.js';
import {
  getExistingReleases,
  findUnreleasedTasks,
  findUnreleasedFeatures,
  findUnreleasedChangelog,
} from '../../lib/release-discovery.js';
import type { ReleaseEntry } from '../../lib/release-discovery.js';
import { backPopulateFeatures } from '../../lib/release-backpopulate.js';
import { recordDashboardChange } from '../change-tracker.js';
import {
  getActivePlanningVersion,
  setActivePlanningVersion,
  clearActivePlanningVersion,
} from '../../lib/active-version.js';

/**
 * GET /api/changelog - Get changelog entries
 */
export async function handleChangelogGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const filePath = join(contextRoot, 'core', 'CHANGELOG.json');
  if (!existsSync(filePath)) {
    sendJson(res, 200, { entries: [] });
    return;
  }

  try {
    const entries = readJsonArray(filePath);
    sendJson(res, 200, { entries });
  } catch {
    sendJson(res, 200, { entries: [] });
  }
}

/**
 * GET /api/releases - Get all release entries
 */
export async function handleReleasesGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const filePath = join(contextRoot, 'core', 'RELEASES.json');
  if (!existsSync(filePath)) {
    sendJson(res, 200, { entries: [] });
    return;
  }

  try {
    const entries = readJsonArray(filePath);
    sendJson(res, 200, { entries });
  } catch {
    sendJson(res, 200, { entries: [] });
  }
}

/**
 * GET /api/releases/unreleased - Get auto-discovered unreleased items
 */
export async function handleUnreleasedGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const tasks = findUnreleasedTasks(contextRoot);
  const features = findUnreleasedFeatures(contextRoot);
  const changelog = findUnreleasedChangelog(contextRoot);
  sendJson(res, 200, { tasks, features, changelog });
}

/**
 * GET /api/releases/active - Get the active planning version ("current sprint").
 * Returns { active: string | null }. MUST be registered before /api/releases/:version
 * so the `:version` segment matcher does not capture the literal "active".
 */
export async function handleActiveVersionGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { active: getActivePlanningVersion(contextRoot) });
}

/**
 * PUT /api/releases/active - Set or clear the active planning version.
 * Body: { version: string | null }.
 *  - null / "" → clear the active planning version.
 *  - a version that has no RELEASES.json entry yet → lazily create a planning
 *    entry for it, then mark it active (lets a sprint that only ever existed as a
 *    task `version:` string become "current" in one tap).
 *  - a version that is already `released` → 409 (a shipped sprint can't be current).
 */
export async function handleActiveVersionSet(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const raw = body.version;

  // Clear
  if (raw === null || raw === undefined || raw === '') {
    clearActivePlanningVersion(contextRoot);
    recordDashboardChange(contextRoot, {
      entity: 'core',
      action: 'update',
      target: 'state/.active-version.json',
      summary: 'Cleared active planning version',
    });
    sendJson(res, 200, { active: null });
    return;
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    sendError(res, 400, 'invalid_version', 'Version must be a non-empty string or null.');
    return;
  }
  const version = raw.trim();

  const existing = getExistingReleases(contextRoot);
  const match = existing.find(r => r.version === version);
  if (match && match.status === 'released') {
    sendError(res, 409, 'already_released', `Version ${version} is already released; it cannot be the current sprint.`);
    return;
  }

  // Lazily materialize a planning entry for an unregistered sprint name.
  if (!match) {
    const entry: ReleaseEntry = {
      id: generateId('rel'),
      version,
      date: '',
      summary: '',
      breaking: false,
      status: 'planning',
      features: [],
      tasks: [],
      changelog: [],
    };
    insertToJsonArray(join(contextRoot, 'core', 'RELEASES.json'), entry);
  }

  setActivePlanningVersion(version, contextRoot);
  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'update',
    target: 'state/.active-version.json',
    summary: `Set active planning version to ${version}`,
  });

  sendJson(res, 200, { active: version });
}

/**
 * GET /api/releases/:version - Get a single release
 */
export async function handleReleaseGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const entries = getExistingReleases(contextRoot);
  const release = entries.find(r => r.version === params.version);
  if (!release) {
    sendError(res, 404, 'not_found', `Release not found: ${params.version}`);
    return;
  }
  sendJson(res, 200, { release });
}

/**
 * POST /api/releases - Create a new release
 */
export async function handleReleasesCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const version = body.version as string;
  if (!version || typeof version !== 'string' || !version.trim()) {
    sendError(res, 400, 'missing_version', 'Version is required.');
    return;
  }

  // Check duplicate
  const existing = getExistingReleases(contextRoot);
  if (existing.some(r => r.version === version.trim())) {
    sendError(res, 409, 'already_exists', `Release ${version} already exists.`);
    return;
  }

  const status = body.status === 'planning' ? 'planning' : 'released' as const;

  const release: ReleaseEntry = {
    id: generateId('rel'),
    version: version.trim(),
    date: status === 'planning' ? '' : today(),
    summary: ((body.summary as string) ?? '').trim(),
    breaking: body.breaking === true,
    status,
    features: Array.isArray(body.features) ? body.features : [],
    tasks: Array.isArray(body.tasks) ? body.tasks : [],
    changelog: Array.isArray(body.changelog) ? body.changelog : [],
  };

  const filePath = join(contextRoot, 'core', 'RELEASES.json');
  insertToJsonArray(filePath, release);

  // Back-populate features
  if (release.features.length > 0) {
    backPopulateFeatures(contextRoot, release.features, release.version);
  }

  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'create',
    target: 'core/RELEASES.json',
    summary: `Created release ${release.version}`,
  });

  sendJson(res, 201, { release });
}

/**
 * Reassign or clear the `version` field on every task currently pointing at
 * `from`. `to === null` clears it (delete flow); a string re-points it (rename
 * flow). Goes through the configured task backend so the edit is journaled and
 * syncs like any other task change. Returns the number of tasks touched.
 */
async function repointTasksVersion(
  contextRoot: string,
  from: string,
  to: string | null,
): Promise<number> {
  const backend = getTaskBackend(contextRoot);
  const summaries = await backend.list();
  const affected = summaries.filter((t) => t.version === from);
  for (const t of affected) {
    await backend.updateFields(t.name, { version: to, updated_at: today() });
  }
  return affected.length;
}

/**
 * PATCH /api/releases/:version - Update a release (status, summary, date) and/or
 * rename it. A rename (`body.version` differs from the path version) rewrites
 * the RELEASES.json entry, re-points every task carrying the old version string,
 * and moves the active-planning pointer if it tracked the old name. An
 * unregistered "ghost" (a version string present only on tasks, with no
 * RELEASES.json entry) supports rename only — there is no entry to mutate, just
 * the tasks.
 */
export async function handleReleasesUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const filePath = join(contextRoot, 'core', 'RELEASES.json');
  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Release not found: ${params.version}`);
    return;
  }

  const entries = readJsonArray<ReleaseEntry>(filePath);
  // Backward compat
  for (const entry of entries) {
    if (!entry.status) entry.status = 'released';
  }

  const idx = entries.findIndex(r => r.version === params.version);

  const renameTo = typeof body.version === 'string' ? (body.version as string).trim() : undefined;
  const isRename = renameTo !== undefined && renameTo !== params.version;

  // Validate a requested rename target up front (applies to ghosts too).
  if (isRename) {
    if (!renameTo) {
      sendError(res, 400, 'invalid_version', 'New version name must not be empty.');
      return;
    }
    if (entries.some((r, i) => i !== idx && r.version === renameTo)) {
      sendError(res, 409, 'already_exists', `A release named ${renameTo} already exists.`);
      return;
    }
  }

  // Ghost (no RELEASES.json entry): the only meaningful PATCH is a rename, which
  // simply re-points the tasks carrying that version string. A ghost can never
  // be the active-planning version, so the pointer needs no update.
  if (idx === -1) {
    if (isRename) {
      const moved = await repointTasksVersion(contextRoot, params.version, renameTo!);
      recordDashboardChange(contextRoot, {
        entity: 'task',
        action: 'update',
        target: 'state/* (version)',
        summary: `Renamed unregistered version ${params.version} → ${renameTo} (${moved} task${moved === 1 ? '' : 's'})`,
      });
      sendJson(res, 200, { release: null, renamed: { from: params.version, to: renameTo }, tasksRepointed: moved });
      return;
    }
    sendError(res, 404, 'not_found', `Release not found: ${params.version}`);
    return;
  }

  const release = entries[idx];
  // Capture before any mutation: the active pointer re-validates against the
  // on-disk entry, which still carries the old name at this point.
  const wasActive = isRename && getActivePlanningVersion(contextRoot) === params.version;

  if (body.status !== undefined) {
    const s = body.status as string;
    if (s !== 'planning' && s !== 'released') {
      sendError(res, 400, 'invalid_status', 'Status must be "planning" or "released".');
      return;
    }
    release.status = s;
    if (s === 'released' && !release.date) {
      release.date = today();
    }
  }

  if (typeof body.summary === 'string') {
    release.summary = (body.summary as string).trim();
  }

  if (typeof body.date === 'string') {
    release.date = (body.date as string).trim();
  }

  if (isRename) {
    release.version = renameTo!;
  }

  writeJsonArray(filePath, entries);

  let tasksRepointed = 0;
  if (isRename) {
    tasksRepointed = await repointTasksVersion(contextRoot, params.version, release.version);
    if (wasActive) {
      // The active-planning pointer tracked the old name; move it to the new
      // one (only planning versions can be active; setActive re-validates).
      if (release.status === 'planning') setActivePlanningVersion(release.version, contextRoot);
      else clearActivePlanningVersion(contextRoot);
    }
  }

  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'update',
    target: `core/RELEASES.json#${release.version}`,
    summary: isRename
      ? `Renamed release ${params.version} → ${release.version} (${tasksRepointed} task${tasksRepointed === 1 ? '' : 's'})`
      : `Updated release ${release.version}`,
  });

  sendJson(res, 200, {
    release,
    ...(isRename ? { renamed: { from: params.version, to: release.version }, tasksRepointed } : {}),
  });
}

/**
 * DELETE /api/releases/:version - Remove a release. The RELEASES.json entry (if
 * any) is dropped and every task pointing at the version has its `version` field
 * cleared to null (warn+clear policy — tasks are kept, never deleted). Also
 * works on an unregistered "ghost" (version string only present on tasks): there
 * is no entry to drop, so it just clears the tasks. The active-planning pointer
 * is cleared if it tracked the deleted version.
 */
export async function handleReleasesDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const filePath = join(contextRoot, 'core', 'RELEASES.json');

  // Capture before mutating: the active pointer re-validates against the
  // on-disk entry, which still exists at this point.
  const wasActive = getActivePlanningVersion(contextRoot) === params.version;

  let wasRegistered = false;
  if (existsSync(filePath)) {
    const entries = readJsonArray<ReleaseEntry>(filePath);
    for (const entry of entries) {
      if (!entry.status) entry.status = 'released';
    }
    const idx = entries.findIndex(r => r.version === params.version);
    if (idx !== -1) {
      entries.splice(idx, 1);
      writeJsonArray(filePath, entries);
      wasRegistered = true;
    }
  }

  const tasksCleared = await repointTasksVersion(contextRoot, params.version, null);

  if (wasActive) clearActivePlanningVersion(contextRoot);

  if (!wasRegistered && tasksCleared === 0) {
    sendError(res, 404, 'not_found', `Version not found: ${params.version}`);
    return;
  }

  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'delete',
    target: `core/RELEASES.json#${params.version}`,
    summary: `Deleted version ${params.version}${wasRegistered ? '' : ' (unregistered)'}; cleared ${tasksCleared} task${tasksCleared === 1 ? '' : 's'}`,
  });

  sendJson(res, 200, { deleted: true, version: params.version, wasRegistered, tasksCleared });
}
