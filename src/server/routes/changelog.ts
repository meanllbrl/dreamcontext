import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonArray, insertToJsonArray } from '../../lib/json-file.js';
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
 * PATCH /api/releases/:version - Update a release (status, summary, date)
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
  if (idx === -1) {
    sendError(res, 404, 'not_found', `Release not found: ${params.version}`);
    return;
  }

  const release = entries[idx];

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

  const { writeJsonArray } = await import('../../lib/json-file.js');
  writeJsonArray(filePath, entries);

  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'update',
    target: `core/RELEASES.json#${release.version}`,
    summary: `Updated release ${release.version}`,
  });

  sendJson(res, 200, { release });
}
