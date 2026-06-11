import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '../id.js';
import type { SetupConfig } from '../setup-config.js';
import { resolveClickUpToken, type ResolvedToken } from './secrets.js';

/**
 * Identity layer — issue #11 P1.
 *
 * Multi-people awareness for remote backends: the `.config.json` people
 * roster gains per-person remote identity ({ role, clickupMemberId, tokenEnv }
 * in `peopleIdentity`, keyed by person slug). Assignment is STATIC config
 * mapping; live presence is explicitly out of scope — `updated_by` +
 * `last_synced_at` suffice.
 */

export interface ResolvedPerson {
  /** Person slug (kebab-case, as in the people roster). */
  slug: string;
  role?: string;
  clickupMemberId?: string;
  tokenEnv?: string;
}

/**
 * Parse `knowledge/team_owners.md` (role → person doc) when present.
 * Tolerant line formats: `- <role>: <person>`, `* <role>: <person>`,
 * `| role | person |` table rows. Returns person-slug → role.
 */
export function seedRolesFromTeamOwners(contextRoot: string): Record<string, string> {
  const path = join(contextRoot, 'knowledge', 'team_owners.md');
  if (!existsSync(path)) return {};
  const roles: Record<string, string> = {};
  try {
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s*([^:|]+):\s*(.+)\s*$/);
      if (bullet) {
        const role = bullet[1].trim();
        const person = slugify(bullet[2].trim());
        if (role && person && !roles[person]) roles[person] = role;
        continue;
      }
      const row = line.match(/^\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*$/);
      if (row) {
        const role = row[1].trim();
        const person = slugify(row[2].trim());
        // Skip the header/divider rows of a markdown table.
        if (!role || !person || /^-+$/.test(person) || role.toLowerCase() === 'role') continue;
        if (!roles[person]) roles[person] = role;
      }
    }
  } catch {
    return {};
  }
  return roles;
}

/**
 * Resolve the full roster with remote identities merged in. Roles missing
 * from `peopleIdentity` are seeded from `knowledge/team_owners.md` when the
 * doc exists.
 */
export function resolvePeople(
  contextRoot: string,
  config: SetupConfig | null,
): ResolvedPerson[] {
  const people = config?.people ?? [];
  const identity = config?.peopleIdentity ?? {};
  const seededRoles = seedRolesFromTeamOwners(contextRoot);

  return people.map((name) => {
    const slug = slugify(name);
    const id = identity[slug] ?? {};
    return {
      slug,
      role: id.role ?? seededRoles[slug],
      clickupMemberId: id.clickupMemberId,
      tokenEnv: id.tokenEnv,
    };
  });
}

/** Person-slug → ClickUp member id map (for assignee round-tripping). */
export function clickupMemberMap(contextRoot: string, config: SetupConfig | null): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of resolvePeople(contextRoot, config)) {
    if (p.clickupMemberId) map[p.slug] = p.clickupMemberId;
  }
  return map;
}

/**
 * Who is acting right now (for created_by / updated_by attribution).
 * `DREAMCONTEXT_PERSON` env wins; otherwise a single-person roster names its
 * only member; otherwise null (attribution recorded as unknown).
 */
export function resolveActor(config: SetupConfig | null): string | null {
  const env = process.env.DREAMCONTEXT_PERSON;
  if (env && env.trim()) return slugify(env);
  const people = config?.people ?? [];
  if (people.length === 1) return slugify(people[0]);
  return null;
}

/**
 * Resolve the acting person's ClickUp token: their `tokenEnv` env var first,
 * then the shared env vars, then the secrets file (per-user slot, then
 * default). Pure delegation to the secrets resolution order (env → secrets).
 */
export function resolveActorToken(
  projectRoot: string,
  contextRoot: string,
  config: SetupConfig | null,
): ResolvedToken | null {
  const actor = resolveActor(config);
  const person = actor
    ? resolvePeople(contextRoot, config).find((p) => p.slug === actor)
    : undefined;
  return resolveClickUpToken(projectRoot, {
    envVar: person?.tokenEnv,
    user: actor ?? undefined,
  });
}
