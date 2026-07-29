import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '../id.js';
import type { SetupConfig } from '../setup-config.js';
import { resolveClickUpToken, type ResolvedToken } from './secrets.js';

/**
 * Identity layer — issue #11 P1.
 *
 * Multi-people awareness for remote backends: `.config.json.peopleIdentity`
 * holds per-person remote identity ({ role, clickupMemberId, tokenEnv,
 * githubLogin }), keyed by person slug. Assignment is STATIC config mapping;
 * live presence is explicitly out of scope — `updated_by` + `last_synced_at`
 * suffice.
 *
 * D19 (0.23.0): WHO EXISTS now lives in `people/people.json`, not
 * `.config.json.people` (retired). This module's roster source is therefore the
 * KEYS of `peopleIdentity` — the people who have a remote mapping at all, which
 * is the only population it can resolve anyway. A roster person with no
 * `peopleIdentity` entry has no ClickUp/GitHub identity to resolve, so their
 * absence here is not a loss; it keeps every signature unchanged.
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
 * Resolve the remote-identity roster: every slug that has a `peopleIdentity`
 * entry (D19), with its identity merged in. Roles missing from `peopleIdentity`
 * are seeded from `knowledge/team_owners.md` when the doc exists — that seeding
 * is keyed by SLUG, so it needs no display names and this signature is unchanged.
 */
export function resolvePeople(
  contextRoot: string,
  config: SetupConfig | null,
): ResolvedPerson[] {
  const identity = config?.peopleIdentity ?? {};
  const seededRoles = seedRolesFromTeamOwners(contextRoot);

  return Object.keys(identity).map((slug) => {
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
 * `DREAMCONTEXT_PERSON` env wins; otherwise a single-mapping roster names its
 * only member (D19: the keys of `peopleIdentity`); otherwise null (attribution
 * recorded as unknown).
 */
export function resolveActor(config: SetupConfig | null): string | null {
  const env = process.env.DREAMCONTEXT_PERSON;
  if (env && env.trim()) return slugify(env);
  const slugs = Object.keys(config?.peopleIdentity ?? {});
  if (slugs.length === 1) return slugs[0];
  return null;
}

/**
 * github-cloud-collaboration-brain-repo-sync (M3, C3): map a signed-in GitHub
 * login to the person slug it identifies via `peopleIdentity[<slug>].githubLogin`.
 * Case-insensitive (GitHub logins are case-insensitive). Returns null on a
 * blank login, no config, or no match — callers (sync-engine's `authorFor`)
 * fall through to the EXISTING M1 author tiering unchanged; this tier is
 * layered ON TOP, never a prerequisite for M1 to keep working.
 */
export function mapLoginToPerson(login: string | null | undefined, config: SetupConfig | null): string | null {
  if (!login || !login.trim()) return null;
  const target = login.trim().toLowerCase();
  const identity = config?.peopleIdentity ?? {};
  for (const [slug, id] of Object.entries(identity)) {
    if (id.githubLogin && id.githubLogin.trim().toLowerCase() === target) return slug;
  }
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
