import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireFileLock, releaseFileLock } from './file-lock.js';
import { slugify } from './id.js';

/**
 * The people store — the structural half of the people-first user model.
 *
 * `people/people.json` owns WHO EXISTS (`slug → {name, emails[], role?}`) and
 * nothing else: no prose fields, ever (D12). The prose half is one constitution
 * per person at `people/<slug>.md`, which this module only ever SCAFFOLDS (on
 * `addPerson`, when absent) and never rewrites or deletes — one writer per file
 * is what keeps the brain-repo merge for those files a rare, human-resolvable
 * prose conflict instead of a machine free-for-all.
 *
 * Every path here takes the CONTEXT root (`…/_dream_context`), never the
 * project root — see `people-resolve.ts` for the other half of that convention.
 */

export const PEOPLE_SCHEMA_VERSION = 1;

/** Context-root-relative location of the roster (also the semantic-merge key). */
export const PEOPLE_JSON_REL = 'people/people.json';

/**
 * A slug is a filesystem path segment AND a dashboard route segment, so the
 * charset is deliberately narrower than `slugify`'s output space: lowercase
 * alnum + dashes, must start alnum, 1–64 chars. Anything else is rejected at
 * every entry point rather than sanitized (a silently-rewritten identity is
 * worse than a loud failure).
 */
export const PERSON_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface Person {
  name: string;
  emails: string[];
  role?: string;
}

export type PeopleMap = Record<string, Person>;

export interface PeopleFile {
  version: number;
  people: PeopleMap;
}

/**
 * Thrown on a present-but-unparseable roster (D17) and on every rejected slug /
 * malformed write. Deliberately NOT thrown for an absent roster — "no people
 * yet" is a valid, common state (every un-migrated vault).
 */
export class PeopleStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PeopleStoreError';
  }
}

export function isSafePersonSlug(slug: string): boolean {
  return typeof slug === 'string' && PERSON_SLUG_RE.test(slug);
}

export function peopleDir(contextRoot: string): string {
  return join(contextRoot, 'people');
}

export function peopleJsonPath(contextRoot: string): string {
  return join(contextRoot, 'people', 'people.json');
}

/**
 * Absolute path of a person's constitution. THROWS on a slug that fails the
 * charset check — this function is the last gate before a caller-supplied
 * string becomes a filesystem path, so it refuses to build one it cannot vouch
 * for (defense in depth behind `people-resolve.validateSlug`).
 */
export function personFilePath(contextRoot: string, slug: string): string {
  if (!isSafePersonSlug(slug)) {
    throw new PeopleStoreError(`Invalid person slug "${slug}" — expected ${PERSON_SLUG_RE}.`);
  }
  return join(contextRoot, 'people', `${slug}.md`);
}

/** True once the vault has a roster file at all — the people-first layout marker. */
export function hasPeopleLayout(contextRoot: string): boolean {
  return existsSync(peopleJsonPath(contextRoot));
}

function sanitizePerson(raw: unknown): Person | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) return null;
  const person: Person = { name: o.name.trim(), emails: normalizeEmails(o.emails) };
  if (typeof o.role === 'string' && o.role.trim()) person.role = o.role.trim();
  return person;
}

/** `trim().toLowerCase()`, blanks dropped, order-preserving dedupe. */
export function normalizeEmails(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const email = entry.trim().toLowerCase();
    if (!email || out.includes(email)) continue;
    out.push(email);
  }
  return out;
}

/**
 * Read the roster. Absent file ⇒ `{}` (an un-migrated vault is not an error).
 * Present-but-unparseable ⇒ THROWS `PeopleStoreError` (D17): a silent `{}` would
 * make a migrated vault look un-migrated and invite the migration to re-run
 * destructively. Read paths that merely decorate output catch and degrade; write
 * paths and `doctor` surface it loudly.
 *
 * Entries whose shape is unusable (no name) or whose key fails the slug charset
 * are DROPPED, mirroring `readSetupConfig`'s sanitize-on-read: such an entry can
 * never be addressed (no legal file path, no legal route) and must never reach a
 * path join. A roster that sanitizes down to zero people is what `doctor` errors
 * on — the drop is surfaced there, not swallowed.
 */
export function readPeople(contextRoot: string): PeopleMap {
  const path = peopleJsonPath(contextRoot);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new PeopleStoreError(`${PEOPLE_JSON_REL} is not valid JSON: ${(err as Error).message}`, err);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PeopleStoreError(`${PEOPLE_JSON_REL} must be an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}.`);
  }
  const people = (parsed as Record<string, unknown>).people;
  if (people === undefined) {
    throw new PeopleStoreError(`${PEOPLE_JSON_REL} has no "people" key.`);
  }
  if (people === null || typeof people !== 'object' || Array.isArray(people)) {
    throw new PeopleStoreError(`${PEOPLE_JSON_REL} "people" must be an object of slug → person.`);
  }
  const out: PeopleMap = {};
  for (const [slug, raw] of Object.entries(people as Record<string, unknown>)) {
    if (!isSafePersonSlug(slug)) continue;
    const person = sanitizePerson(raw);
    if (person) out[slug] = person;
  }
  return out;
}

/** Roster as a list, sorted by display name (locale-insensitive, stable on ties by slug). */
export function listPeople(contextRoot: string): Array<Person & { slug: string }> {
  const people = readPeople(contextRoot);
  return Object.entries(people)
    .map(([slug, person]) => ({ slug, ...person }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

export function getPerson(contextRoot: string, slug: string): Person | undefined {
  return readPeople(contextRoot)[slug];
}

/** More than one human on the roster — the DERIVED multi-person gate (never persisted). */
export function isMultiPersonVault(contextRoot: string): boolean {
  return Object.keys(readPeople(contextRoot)).length > 1;
}

// ─── Writes (locked + atomic) ───────────────────────────────────────────────

const LOCK_STALE_MS = 10_000;
const LOCK_SPINS = 5;
const LOCK_SPIN_MS = 200;

function peopleLockPath(contextRoot: string): string {
  return join(contextRoot, 'people', '.people.lock');
}

/** Synchronous sleep — the whole store is sync, so the spin cannot be a promise. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` under the roster's cross-process lock. Bounded spin (5 × 200 ms),
 * then a typed throw — a write that cannot take the lock FAILS; it never
 * silently overwrites a concurrent writer's read-modify-write.
 */
function withPeopleLock<T>(contextRoot: string, fn: () => T): T {
  const lockPath = peopleLockPath(contextRoot);
  let held = false;
  for (let i = 0; i < LOCK_SPINS; i++) {
    if (acquireFileLock(lockPath, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true })) {
      held = true;
      break;
    }
    if (i < LOCK_SPINS - 1) sleepSync(LOCK_SPIN_MS);
  }
  if (!held) {
    throw new PeopleStoreError(
      `Could not lock ${PEOPLE_JSON_REL} after ${LOCK_SPINS} attempts — another dreamcontext process is writing the roster. Retry in a moment.`,
    );
  }
  try {
    return fn();
  } finally {
    releaseFileLock(lockPath);
  }
}

function assertWritablePeople(people: PeopleMap): void {
  for (const [slug, person] of Object.entries(people)) {
    if (!isSafePersonSlug(slug)) {
      throw new PeopleStoreError(`Invalid person slug "${slug}" — expected ${PERSON_SLUG_RE}.`);
    }
    if (!person || typeof person.name !== 'string' || !person.name.trim()) {
      throw new PeopleStoreError(`Person "${slug}" needs a non-empty name.`);
    }
  }
}

/** Serialize with slug keys SORTED so two machines produce byte-identical rosters (and so the semantic merge's output matches a local write). */
function serializePeople(people: PeopleMap): string {
  const sorted: PeopleMap = {};
  for (const slug of Object.keys(people).sort()) {
    const person = people[slug];
    sorted[slug] = {
      name: person.name.trim(),
      emails: normalizeEmails(person.emails),
      ...(person.role && person.role.trim() ? { role: person.role.trim() } : {}),
    };
  }
  const file: PeopleFile = { version: PEOPLE_SCHEMA_VERSION, people: sorted };
  return JSON.stringify(file, null, 2) + '\n';
}

function writePeopleUnlocked(contextRoot: string, people: PeopleMap): void {
  const path = peopleJsonPath(contextRoot);
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, serializePeople(people), 'utf-8');
  renameSync(tmp, path);
}

/** Replace the whole roster. Locked + atomic; rejects any malformed entry before touching disk. */
export function writePeople(contextRoot: string, people: PeopleMap): void {
  assertWritablePeople(people);
  withPeopleLock(contextRoot, () => writePeopleUnlocked(contextRoot, people));
}

/**
 * The person constitution scaffold. Kept byte-identical to
 * `src/templates/init/people/person.md` (T5 pins the equality) so a person
 * created by `people add` and one created by `init` are the same document.
 */
export function renderPersonConstitution(input: { name: string; slug: string; date: string }): string {
  return `---
name: ${input.slug}
type: person
updated: "${input.date}"
---

## Identity

- (Who this person is: role, focus, what they own in this project)

## Preferences

- (Decision-making patterns, priorities, review preferences)

## Communication Style

- (How the user prefers to interact: concise? detailed? technical?)
`;
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Upsert a person by name-derived slug. Idempotent: a second call with the same
 * name adds no roster entry and (crucially) never clobbers an existing
 * `people/<slug>.md` — the constitution is the person's own prose, and this
 * function's job stops at scaffolding an absent one. New emails/role on a repeat
 * call are folded into the existing entry; the display name is never rewritten.
 */
export function addPerson(
  contextRoot: string,
  input: { name: string; emails?: string[]; role?: string },
): { slug: string; created: boolean } {
  const name = (input.name ?? '').trim();
  if (!name) throw new PeopleStoreError('Person name is required.');
  const slug = slugify(name);
  if (!isSafePersonSlug(slug)) {
    throw new PeopleStoreError(`"${name}" does not yield a usable person slug (got "${slug}", expected ${PERSON_SLUG_RE}).`);
  }
  const emails = normalizeEmails(input.emails);
  const role = typeof input.role === 'string' && input.role.trim() ? input.role.trim() : undefined;

  const created = withPeopleLock(contextRoot, () => {
    const people = readPeople(contextRoot);
    const existing = people[slug];
    if (existing) {
      const mergedRole = existing.role ?? role;
      const next: Person = {
        name: existing.name,
        emails: normalizeEmails([...existing.emails, ...emails]),
        ...(mergedRole ? { role: mergedRole } : {}),
      };
      const changed = serializePeople({ ...people, [slug]: next }) !== serializePeople(people);
      if (changed) writePeopleUnlocked(contextRoot, { ...people, [slug]: next });
      return false;
    }
    writePeopleUnlocked(contextRoot, {
      ...people,
      [slug]: { name, emails, ...(role ? { role } : {}) },
    });
    return true;
  });

  // Scaffold the constitution ONLY when absent — never inside the lock's
  // read-modify-write, and never over existing prose.
  const filePath = personFilePath(contextRoot, slug);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, renderPersonConstitution({ name, slug, date: todayIso() }), 'utf-8');
  }
  return { slug, created };
}

/**
 * Remove a roster entry. ROSTER ONLY — `people/<slug>.md` is never deleted (a
 * person's prose outlives their roster membership; deleting it would make a
 * mis-typed slug an unrecoverable data loss). Returns false when the slug was
 * not on the roster.
 */
export function removePerson(contextRoot: string, slug: string): boolean {
  if (!isSafePersonSlug(slug)) {
    throw new PeopleStoreError(`Invalid person slug "${slug}" — expected ${PERSON_SLUG_RE}.`);
  }
  return withPeopleLock(contextRoot, () => {
    const people = readPeople(contextRoot);
    if (!people[slug]) return false;
    const next = { ...people };
    delete next[slug];
    writePeopleUnlocked(contextRoot, next);
    return true;
  });
}
