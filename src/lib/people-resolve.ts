import { dirname, join } from 'node:path';
import { readBrainLocal, writeBrainLocal } from './setup-config.js';
import { readGitIdentity } from './git-sync/git.js';
import {
  PEOPLE_JSON_REL,
  PERSON_SLUG_RE,
  PeopleStoreError,
  hasPeopleLayout,
  isSafePersonSlug,
  readPeople,
  type PeopleMap,
} from './people-store.js';

/**
 * Active-person resolution — WHO is at the keyboard on THIS machine.
 *
 * The ladder is explicit → pinned → inferred → trivially-implied → nothing, and
 * it NEVER guesses: an unresolvable machine gets `slug: null`, not somebody
 * else's constitution.
 *
 * Root convention (a bug factory if you get it wrong):
 *   - `resolveActivePerson` / `resolveAuthors` take the CONTEXT root
 *     (`…/_dream_context`) and `dirname()` it internally for the project-rooted
 *     readers (`readBrainLocal`, git).
 *   - `setActivePersonPin` takes the PROJECT root (it writes
 *     `_dream_context/state/.brain-local.json` via `writeBrainLocal`).
 *
 * Invariant P: no slug reaches `personFilePath()`, the snapshot, or
 * `resolveAuthors()` unless it matches the slug charset AND is a key in
 * `readPeople(contextRoot)`. Every rung goes through `validateSlug`, including
 * the machine-local pin — `.brain-local.json` is a plain JSON file that a
 * hand-edit or a bad merge can corrupt, and its value hits the same path join.
 */

export const PERSON_ENV_VAR = 'DREAMCONTEXT_PERSON';

export type PersonResolutionSource = 'env' | 'pin' | 'git-email' | 'solo' | 'none';

export interface ActivePerson {
  slug: string | null;
  name: string | null;
  source: PersonResolutionSource;
  /**
   * The git `user.email` this machine reports, when the ladder got far enough to
   * ask (rung 3). Null when an earlier rung resolved first — resolution never
   * pays for a `git config` exec it does not need.
   */
  gitEmail: string | null;
  /** Human-facing "why this identity" — including every rejected rung, verbatim. */
  reason: string;
}

/**
 * Roster read that cannot throw. `readPeople` throws on a corrupt roster (D17);
 * this is the read path, and a corrupt roster must never crash a session — it
 * degrades to "unresolved" and lets `doctor` be the one to shout.
 */
function safeReadPeople(contextRoot: string): { people: PeopleMap | null; error: string | null } {
  try {
    return { people: readPeople(contextRoot), error: null };
  } catch (err) {
    if (err instanceof PeopleStoreError) return { people: null, error: err.message };
    throw err;
  }
}

/**
 * The single gate every rung passes through: a candidate is accepted iff it
 * matches the slug charset AND names a real roster entry. Swallows
 * `PeopleStoreError` into `null` — this is what keeps `resolveActivePerson`'s
 * never-throws contract true rather than aspirational.
 */
function validateSlug(contextRoot: string, candidate: string | undefined | null): string | null {
  if (typeof candidate !== 'string' || !candidate) return null;
  if (!isSafePersonSlug(candidate)) return null;
  const { people } = safeReadPeople(contextRoot);
  if (!people) return null;
  return people[candidate] ? candidate : null;
}

function rejection(label: string, value: string): string {
  return `${label}="${value}" rejected: not a valid person slug`;
}

/**
 * Resolve the active person. NEVER throws — every failure mode (absent roster,
 * corrupt roster, hostile env var, stale pin, no git identity) resolves to a
 * described `source: 'none'`.
 */
export function resolveActivePerson(contextRoot: string): ActivePerson {
  const notes: string[] = [];
  const unresolved = (reason: string, gitEmail: string | null = null): ActivePerson => ({
    slug: null,
    name: null,
    source: 'none',
    gitEmail,
    reason: [...notes, reason].join('; '),
  });

  const { people, error } = safeReadPeople(contextRoot);
  if (!people) {
    return unresolved(`${PEOPLE_JSON_REL} could not be read — ${error}`);
  }
  if (Object.keys(people).length === 0) {
    // No roster ⇒ nothing to resolve against, and no reason to shell out to git.
    return unresolved(
      hasPeopleLayout(contextRoot)
        ? `${PEOPLE_JSON_REL} lists no people`
        : `no ${PEOPLE_JSON_REL} in this vault`,
    );
  }

  const resolved = (slug: string, source: PersonResolutionSource, reason: string, gitEmail: string | null = null): ActivePerson => ({
    slug,
    name: people[slug].name,
    source,
    gitEmail,
    reason: [...notes, reason].join('; '),
  });

  // Rung 1 — explicit env var (headless/CI, and the one documented override).
  const envRaw = process.env[PERSON_ENV_VAR];
  if (typeof envRaw === 'string' && envRaw.trim()) {
    const envSlug = validateSlug(contextRoot, envRaw.trim());
    if (envSlug) return resolved(envSlug, 'env', `${PERSON_ENV_VAR}="${envSlug}"`);
    // Deliberate: fall through to the NEXT rung, not straight past the pin — an
    // invalid env var must not also void a legitimate machine pin.
    notes.push(rejection(PERSON_ENV_VAR, envRaw.trim()));
  }

  const projectRoot = dirname(contextRoot);

  // Rung 2 — machine-local pin (`people whoami --set`), gitignored, never synced.
  const pinRaw = readBrainLocal(projectRoot).activePersonSlug;
  if (typeof pinRaw === 'string' && pinRaw.trim()) {
    const pinSlug = validateSlug(contextRoot, pinRaw.trim());
    if (pinSlug) return resolved(pinSlug, 'pin', `pinned on this machine (people whoami --set ${pinSlug})`);
    notes.push(rejection('.brain-local.json activePersonSlug', pinRaw.trim()));
  }

  // Rung 3 — git identity, matched case-insensitively against the roster emails.
  const gitEmail = (readGitIdentity(projectRoot).email ?? '').trim().toLowerCase() || null;
  if (gitEmail) {
    for (const [slug, person] of Object.entries(people)) {
      if (person.emails.includes(gitEmail)) {
        return resolved(slug, 'git-email', `git user.email ${gitEmail} matched ${slug}`, gitEmail);
      }
    }
  }

  // Rung 4 — a solo vault trivially implies its only person.
  const slugs = Object.keys(people);
  if (slugs.length === 1) {
    return resolved(slugs[0], 'solo', 'the only person in this vault', gitEmail);
  }

  // Rung 5 — nothing. Never guess.
  return unresolved(
    gitEmail
      ? `git user.email ${gitEmail} matches no person in this vault`
      : 'no git user.email on this machine and no pin',
    gitEmail,
  );
}

/**
 * The author list to stamp on a changelog entry / memory note.
 *
 * D18 (load-bearing): `undefined` whenever `people/people.json` is ABSENT. That
 * single invariant makes the whole people-first feature a no-op on every
 * un-migrated vault and every existing test fixture — omitting the key entirely
 * rather than writing an empty array is what keeps release-discovery
 * fingerprints and recall indexing byte-identical.
 *
 * An explicit non-empty list always wins and is returned VERBATIM (today's
 * `--authors` behavior, unchanged).
 */
export function resolveAuthors(contextRoot: string, explicit?: string[]): string[] | undefined {
  if (explicit && explicit.length > 0) return explicit;
  if (!hasPeopleLayout(contextRoot)) return undefined;
  const active = resolveActivePerson(contextRoot);
  return active.slug ? [active.slug] : undefined;
}

/**
 * Write (or clear) this machine's person pin. Takes the PROJECT root. Validates
 * BEFORE writing — a pin that cannot resolve is worse than no pin, and the
 * value hits a path join on every later read.
 */
export function setActivePersonPin(projectRoot: string, slug: string | null): void {
  if (slug === null) {
    writeBrainLocal(projectRoot, { activePersonSlug: undefined });
    return;
  }
  const candidate = slug.trim();
  if (!isSafePersonSlug(candidate)) {
    throw new PeopleStoreError(`Invalid person slug "${slug}" — expected ${PERSON_SLUG_RE}.`);
  }
  const contextRoot = join(projectRoot, '_dream_context');
  const people = readPeople(contextRoot); // write path — a corrupt roster throws, loudly.
  if (!people[candidate]) {
    throw new PeopleStoreError(
      `No person "${candidate}" in this vault — run \`dreamcontext people list\` to see the roster.`,
    );
  }
  writeBrainLocal(projectRoot, { activePersonSlug: candidate });
}
