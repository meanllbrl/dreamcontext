import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERSON_ENV_VAR,
  resolveActivePerson,
  resolveAuthors,
  setActivePersonPin,
} from '../../src/lib/people-resolve.js';
import { PeopleStoreError, addPerson, peopleJsonPath } from '../../src/lib/people-store.js';
import { readBrainLocal, writeBrainLocal } from '../../src/lib/setup-config.js';

let projectRoot: string;
let contextRoot: string;
const envBackup: Record<string, string | undefined> = {};

/** Payloads that must never become a path segment or a rendered constitution. */
const HOSTILE = ['../core/0.soul.md', '../../../../etc/hosts', '..', 'people/x', '', 'a'.repeat(200)];

/** Sentinel prose that only a read OUTSIDE people/ could ever surface. */
const SOUL_SENTINEL = 'SOUL-SENTINEL-must-never-be-rendered-as-a-person';

function initGit(email?: string): void {
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
  if (email) {
    execFileSync('git', ['config', 'user.email', email], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectRoot, stdio: 'ignore' });
  }
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-resolve-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'core'), { recursive: true });
  writeFileSync(join(contextRoot, 'core', '0.soul.md'), `# Soul\n\n${SOUL_SENTINEL}\n`, 'utf-8');
  // Hermetic git: no global/system config can leak a real developer identity in.
  for (const key of [PERSON_ENV_VAR, 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) envBackup[key] = process.env[key];
  delete process.env[PERSON_ENV_VAR];
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(projectRoot, { recursive: true, force: true });
});

function seedTwoPeople(): void {
  addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@test.dev'] });
  addPerson(contextRoot, { name: 'Bob Builder', emails: ['bob@test.dev'] });
}

describe('people-resolve — the five rungs, in order', () => {
  it('rung 1: DREAMCONTEXT_PERSON wins over a pin and over git email', () => {
    seedTwoPeople();
    initGit('bob@test.dev');
    setActivePersonPin(projectRoot, 'bob-builder');
    process.env[PERSON_ENV_VAR] = 'ada-lovelace';

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBe('ada-lovelace');
    expect(active.name).toBe('Ada Lovelace');
    expect(active.source).toBe('env');
    // Rung 1 resolved, so no `git config` exec was needed to answer the question.
    expect(active.gitEmail).toBeNull();
  });

  it('rung 2: the machine-local pin wins over git email', () => {
    seedTwoPeople();
    initGit('bob@test.dev');
    setActivePersonPin(projectRoot, 'ada-lovelace');

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBe('ada-lovelace');
    expect(active.source).toBe('pin');
  });

  it('rung 3: git user.email matches the roster CASE-INSENSITIVELY', () => {
    seedTwoPeople();
    initGit('ADA@Test.DEV');

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBe('ada-lovelace');
    expect(active.source).toBe('git-email');
    expect(active.gitEmail).toBe('ada@test.dev');
  });

  it('rung 4: a solo vault trivially implies its only person, even with an unknown git email', () => {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@test.dev'] });
    initGit('nobody@test.dev');

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBe('ada-lovelace');
    expect(active.source).toBe('solo');
  });

  it('rung 5: a multi-person vault with no match resolves to NOTHING — it never guesses', () => {
    seedTwoPeople();
    initGit('nobody@test.dev');

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBeNull();
    expect(active.name).toBeNull();
    expect(active.source).toBe('none');
    expect(active.gitEmail).toBe('nobody@test.dev');
    expect(active.reason).toContain('nobody@test.dev');
  });

  it('no roster at all ⇒ source none, and no git identity is even consulted', () => {
    initGit('ada@test.dev');
    const active = resolveActivePerson(contextRoot);
    expect(active.source).toBe('none');
    expect(active.slug).toBeNull();
    expect(active.gitEmail).toBeNull();
    expect(active.reason).toContain('people/people.json');
  });

  it('a machine with NO git identity resolves to none rather than throwing', () => {
    seedTwoPeople();
    const active = resolveActivePerson(contextRoot);
    expect(active.source).toBe('none');
    expect(active.gitEmail).toBeNull();
  });
});

describe('people-resolve — a stale rung falls through instead of wedging the machine', () => {
  it('a pin naming a DELETED person falls through to git email, and says why', () => {
    seedTwoPeople();
    initGit('bob@test.dev');
    writeBrainLocal(projectRoot, { activePersonSlug: 'ghost-person' });

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBe('bob-builder');
    expect(active.source).toBe('git-email');
    expect(active.reason).toContain('ghost-person');
  });

  it('an INVALID env var still lets a valid pin resolve (rung 1 falls to rung 2, not past it)', () => {
    seedTwoPeople();
    initGit('bob@test.dev');
    setActivePersonPin(projectRoot, 'ada-lovelace');
    process.env[PERSON_ENV_VAR] = '../core/0.soul.md';

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBe('ada-lovelace');
    expect(active.source).toBe('pin');
    expect(active.reason).toContain('../core/0.soul.md');
  });
});

describe('people-resolve — Invariant P: no slug reaches a path join unvalidated', () => {
  it.each(HOSTILE)('rejects %j at the ENV rung, naming the value, leaking nothing', (payload) => {
    seedTwoPeople();
    initGit('nobody@test.dev');
    process.env[PERSON_ENV_VAR] = payload;

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBeNull();
    expect(active.source).toBe('none');
    // No content from outside people/ can reach the caller — the only path
    // builder (`personFilePath`) refuses these slugs outright.
    expect(JSON.stringify(active)).not.toContain(SOUL_SENTINEL);
    if (payload) expect(active.reason).toContain(payload);
  });

  it.each(HOSTILE)('rejects %j at the PIN rung too (a hand-edit or bad merge is not trusted)', (payload) => {
    seedTwoPeople();
    initGit('nobody@test.dev');
    writeBrainLocal(projectRoot, { activePersonSlug: payload });

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBeNull();
    expect(active.source).toBe('none');
    expect(JSON.stringify(active)).not.toContain(SOUL_SENTINEL);
    if (payload.trim()) expect(active.reason).toContain(payload);
  });

  it('a slug that is well-formed but NOT on the roster is rejected (membership, not just charset)', () => {
    seedTwoPeople();
    initGit('nobody@test.dev');
    process.env[PERSON_ENV_VAR] = 'carol-coder';

    const active = resolveActivePerson(contextRoot);
    expect(active.slug).toBeNull();
    expect(active.reason).toContain('carol-coder');
  });
});

describe('people-resolve — a corrupt roster degrades, it never crashes a session', () => {
  it('resolveActivePerson returns source none and does not throw', () => {
    seedTwoPeople();
    initGit('ada@test.dev');
    writeFileSync(peopleJsonPath(contextRoot), '{"version": 1, "people": {', 'utf-8');

    let active!: ReturnType<typeof resolveActivePerson>;
    expect(() => (active = resolveActivePerson(contextRoot))).not.toThrow();
    expect(active.source).toBe('none');
    expect(active.slug).toBeNull();
    expect(active.reason).toContain('people/people.json');
  });

  it('a corrupt roster with an env var set still resolves to nothing, without throwing', () => {
    seedTwoPeople();
    process.env[PERSON_ENV_VAR] = 'ada-lovelace';
    writeFileSync(peopleJsonPath(contextRoot), 'not json at all', 'utf-8');

    const active = resolveActivePerson(contextRoot);
    expect(active.source).toBe('none');
    expect(resolveAuthors(contextRoot)).toBeUndefined();
  });
});

describe('people-resolve — resolveAuthors (D18: a no-op on every un-migrated vault)', () => {
  it('returns undefined when people/people.json is ABSENT — the load-bearing invariant', () => {
    initGit('ada@test.dev');
    expect(resolveAuthors(contextRoot)).toBeUndefined();
  });

  it('returns an explicit list VERBATIM, even with no roster', () => {
    expect(resolveAuthors(contextRoot, ['someone-else', 'Bot'])).toEqual(['someone-else', 'Bot']);
    seedTwoPeople();
    initGit('ada@test.dev');
    expect(resolveAuthors(contextRoot, ['someone-else'])).toEqual(['someone-else']);
  });

  it('stamps the ACTIVE slug when one resolves, and nothing when it does not', () => {
    seedTwoPeople();
    initGit('ada@test.dev');
    expect(resolveAuthors(contextRoot)).toEqual(['ada-lovelace']);
    expect(resolveAuthors(contextRoot, [])).toEqual(['ada-lovelace']); // empty explicit ⇒ not explicit

    execFileSync('git', ['config', 'user.email', 'nobody@test.dev'], { cwd: projectRoot, stdio: 'ignore' });
    expect(resolveAuthors(contextRoot)).toBeUndefined();
  });
});

describe('people-resolve — setActivePersonPin validates BEFORE writing', () => {
  it('writes the pin for a real person and clears it with null', () => {
    seedTwoPeople();
    setActivePersonPin(projectRoot, 'ada-lovelace');
    expect(readBrainLocal(projectRoot).activePersonSlug).toBe('ada-lovelace');

    setActivePersonPin(projectRoot, null);
    expect(readBrainLocal(projectRoot).activePersonSlug).toBeUndefined();
    expect(readFileSync(join(contextRoot, 'state', '.brain-local.json'), 'utf-8')).not.toContain('activePersonSlug');
  });

  it.each([...HOSTILE, 'ghost-person'])('rejects %j with a typed error and leaves the pin untouched', (payload) => {
    seedTwoPeople();
    setActivePersonPin(projectRoot, 'ada-lovelace');
    const before = readFileSync(join(contextRoot, 'state', '.brain-local.json'), 'utf-8');

    expect(() => setActivePersonPin(projectRoot, payload)).toThrow(PeopleStoreError);
    expect(readFileSync(join(contextRoot, 'state', '.brain-local.json'), 'utf-8')).toBe(before);
  });

  it('preserves the rest of the machine-local state (it is a merge-write, not a replace)', () => {
    seedTwoPeople();
    writeBrainLocal(projectRoot, { codeRepoPath: '/tmp/some/repo', lastSyncedSha: 'abc123' });
    setActivePersonPin(projectRoot, 'bob-builder');

    const local = readBrainLocal(projectRoot);
    expect(local).toMatchObject({
      codeRepoPath: '/tmp/some/repo',
      lastSyncedSha: 'abc123',
      activePersonSlug: 'bob-builder',
    });
  });
});
