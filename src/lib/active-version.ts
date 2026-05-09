import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureContextRoot } from './context-path.js';
import { readJsonObject, writeJsonObject } from './json-file.js';
import { getExistingReleases } from './release-discovery.js';

interface ActiveVersionState {
  active_planning_version: string | null;
}

function statePath(): string {
  return join(ensureContextRoot(), 'state', '.active-version.json');
}

export function getActivePlanningVersion(): string | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  let stored: string | null;
  try {
    const data = readJsonObject<ActiveVersionState>(path);
    stored = data.active_planning_version ?? null;
  } catch {
    return null;
  }
  if (!stored) return null;
  // Re-validate: if the stored version no longer exists or is no longer in 'planning'
  // status (e.g. it was released), treat as unset to avoid silently attaching new tasks
  // to a released milestone.
  try {
    const releases = getExistingReleases(ensureContextRoot());
    const match = releases.find((r) => r.version === stored);
    if (!match || match.status !== 'planning') return null;
  } catch {
    return null;
  }
  return stored;
}

export function setActivePlanningVersion(version: string): void {
  const releases = getExistingReleases(ensureContextRoot());
  const match = releases.find((r) => r.version === version);
  if (!match) {
    throw new Error(`Version "${version}" not found in RELEASES.json. Create it first with: dreamcontext core releases add --ver ${version} --status planning --summary "..." --yes`);
  }
  if (match.status !== 'planning') {
    throw new Error(`Version "${version}" has status "${match.status}", not "planning". Only planning versions can be marked active.`);
  }
  writeJsonObject<ActiveVersionState>(statePath(), { active_planning_version: version });
}

export function clearActivePlanningVersion(): void {
  writeJsonObject<ActiveVersionState>(statePath(), { active_planning_version: null });
}
