import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  PEOPLE_SCHEMA_VERSION,
  PeopleStoreError,
  addPerson,
  getPerson,
  hasPeopleLayout,
  isMultiPersonVault,
  isSafePersonSlug,
  listPeople,
  peopleJsonPath,
  personFilePath,
  readPeople,
  removePerson,
  renderPersonConstitution,
  writePeople,
  type PeopleMap,
} from '../../src/lib/people-store.js';

const execFileAsync = promisify(execFile);

/** vite-node runs a child in a separate OS process against the REAL TypeScript store. */
const VITE_NODE = resolve('node_modules/.bin/vite-node');
const STORE_MODULE = resolve('src/lib/people-store.ts');

let root: string; // the CONTEXT root (…/_dream_context)

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'dc-people-')), '_dream_context');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

function writeRaw(content: string): void {
  mkdirSync(join(root, 'people'), { recursive: true });
  writeFileSync(peopleJsonPath(root), content, 'utf-8');
}

describe('people-store — read', () => {
  it('returns {} for a vault with no roster (an un-migrated vault is not an error)', () => {
    expect(readPeople(root)).toEqual({});
    expect(hasPeopleLayout(root)).toBe(false);
    expect(listPeople(root)).toEqual([]);
    expect(isMultiPersonVault(root)).toBe(false);
  });

  it('THROWS PeopleStoreError on a present-but-unparseable roster (D17)', () => {
    writeRaw('{"version": 1, "people": {'); // truncated
    expect(hasPeopleLayout(root)).toBe(true);
    expect(() => readPeople(root)).toThrow(PeopleStoreError);
  });

  it('THROWS on structurally wrong rosters (array, missing key, non-object people)', () => {
    writeRaw('[]');
    expect(() => readPeople(root)).toThrow(PeopleStoreError);
    writeRaw('{"version": 1}');
    expect(() => readPeople(root)).toThrow(PeopleStoreError);
    writeRaw('{"version": 1, "people": []}');
    expect(() => readPeople(root)).toThrow(PeopleStoreError);
  });

  it('drops entries that could never be addressed (bad slug key, no name) instead of leaking them into a path join', () => {
    writeRaw(
      JSON.stringify({
        version: 1,
        people: {
          '../core/0.soul': { name: 'Evil', emails: [] },
          'Ada Upper': { name: 'Ada', emails: [] },
          nameless: { emails: ['x@y.dev'] },
          ada: { name: 'Ada', emails: ['A@Y.dev'] },
        },
      }),
    );
    expect(Object.keys(readPeople(root))).toEqual(['ada']);
    // Normalization happens on read too, so a hand-edited roster still matches.
    expect(readPeople(root).ada.emails).toEqual(['a@y.dev']);
  });

  it('round-trips a roster through writePeople/readPeople and sorts listPeople by name', () => {
    const people: PeopleMap = {
      zoe: { name: 'Zoe Zeta', emails: ['ZOE@Test.dev ', 'zoe@test.dev'] },
      ada: { name: 'Ada Lovelace', emails: ['ada@test.dev'], role: 'eng' },
    };
    writePeople(root, people);
    expect(readPeople(root)).toEqual({
      zoe: { name: 'Zoe Zeta', emails: ['zoe@test.dev'] }, // trimmed, lowercased, deduped
      ada: { name: 'Ada Lovelace', emails: ['ada@test.dev'], role: 'eng' },
    });
    expect(listPeople(root).map((p) => p.slug)).toEqual(['ada', 'zoe']);
    expect(getPerson(root, 'ada')?.name).toBe('Ada Lovelace');
    expect(getPerson(root, 'nobody')).toBeUndefined();
    expect(isMultiPersonVault(root)).toBe(true);

    const onDisk = JSON.parse(readFileSync(peopleJsonPath(root), 'utf-8'));
    expect(onDisk.version).toBe(PEOPLE_SCHEMA_VERSION);
    // Keys are emitted sorted so two machines produce byte-identical rosters.
    expect(Object.keys(onDisk.people)).toEqual(['ada', 'zoe']);
  });
});

describe('people-store — slug validation (a slug becomes a path segment AND a route segment)', () => {
  const hostile = ['../core/0.soul.md', '../../../../etc/hosts', '..', 'people/x', '', 'Ada', 'a'.repeat(200), '-lead'];

  it('rejects every hostile candidate', () => {
    for (const slug of hostile) expect(isSafePersonSlug(slug), slug).toBe(false);
    expect(isSafePersonSlug('ada-lovelace')).toBe(true);
    expect(isSafePersonSlug('a')).toBe(true);
    expect(isSafePersonSlug('a'.repeat(64))).toBe(true);
    expect(isSafePersonSlug('a'.repeat(65))).toBe(false);
  });

  it('personFilePath refuses to BUILD a path for a hostile slug', () => {
    for (const slug of hostile) expect(() => personFilePath(root, slug), slug).toThrow(PeopleStoreError);
    expect(personFilePath(root, 'ada')).toBe(join(root, 'people', 'ada.md'));
  });

  it('writePeople / removePerson reject a hostile key with a typed error and write nothing', () => {
    expect(() => writePeople(root, { '../evil': { name: 'Evil', emails: [] } })).toThrow(PeopleStoreError);
    expect(existsSync(peopleJsonPath(root))).toBe(false);
    expect(() => removePerson(root, '../evil')).toThrow(PeopleStoreError);
  });

  it('addPerson rejects a name that yields no usable slug', () => {
    expect(() => addPerson(root, { name: '   ' })).toThrow(PeopleStoreError);
    expect(() => addPerson(root, { name: '///' })).toThrow(PeopleStoreError);
    expect(existsSync(peopleJsonPath(root))).toBe(false);
  });
});

describe('people-store — addPerson', () => {
  it('creates the roster entry AND scaffolds the constitution', () => {
    const { slug, created } = addPerson(root, { name: 'Ada Lovelace', emails: [' Ada@Test.dev '], role: 'eng' });
    expect({ slug, created }).toEqual({ slug: 'ada-lovelace', created: true });
    expect(readPeople(root)['ada-lovelace']).toEqual({
      name: 'Ada Lovelace',
      emails: ['ada@test.dev'],
      role: 'eng',
    });
    const filePath = personFilePath(root, 'ada-lovelace');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('## Communication Style');
  });

  it('is idempotent — a second call adds no entry and NEVER clobbers the constitution', () => {
    addPerson(root, { name: 'Ada Lovelace', emails: ['ada@test.dev'] });
    const filePath = personFilePath(root, 'ada-lovelace');
    writeFileSync(filePath, '---\nname: ada-lovelace\n---\n\n## Identity\n\n- Real prose.\n', 'utf-8');
    const before = readFileSync(filePath, 'utf-8');
    const rosterBefore = readFileSync(peopleJsonPath(root), 'utf-8');

    const second = addPerson(root, { name: 'Ada Lovelace', emails: ['ada@test.dev'] });
    expect(second).toEqual({ slug: 'ada-lovelace', created: false });
    expect(Object.keys(readPeople(root))).toEqual(['ada-lovelace']);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
    expect(readFileSync(peopleJsonPath(root), 'utf-8')).toBe(rosterBefore); // byte-identical no-op
  });

  it('folds a NEW email into an existing person without rewriting their display name', () => {
    addPerson(root, { name: 'Ada Lovelace', emails: ['ada@test.dev'] });
    const { created } = addPerson(root, { name: 'ada lovelace', emails: ['ADA@work.dev'], role: 'eng' });
    expect(created).toBe(false);
    expect(readPeople(root)['ada-lovelace']).toEqual({
      name: 'Ada Lovelace',
      emails: ['ada@test.dev', 'ada@work.dev'],
      role: 'eng',
    });
  });

  it('renderPersonConstitution is what gets scaffolded (same document from every entry point)', () => {
    const rendered = renderPersonConstitution({ name: 'Ada Lovelace', slug: 'ada-lovelace', date: '2026-07-29' });
    expect(rendered).toContain('name: ada-lovelace');
    expect(rendered).toContain('type: person');
    expect(rendered).toContain('updated: "2026-07-29"');
    expect(rendered.match(/^##.*$/gm)).toEqual(['## Identity', '## Preferences', '## Communication Style']);
  });
});

describe('people-store — removePerson', () => {
  it('removes the roster entry but KEEPS people/<slug>.md', () => {
    addPerson(root, { name: 'Ada Lovelace', emails: ['ada@test.dev'] });
    addPerson(root, { name: 'Bob Builder', emails: ['bob@test.dev'] });
    const filePath = personFilePath(root, 'bob-builder');

    expect(removePerson(root, 'bob-builder')).toBe(true);
    expect(Object.keys(readPeople(root))).toEqual(['ada-lovelace']);
    expect(existsSync(filePath)).toBe(true); // prose outlives roster membership
  });

  it('returns false for a slug that is not on the roster', () => {
    addPerson(root, { name: 'Ada Lovelace' });
    expect(removePerson(root, 'nobody')).toBe(false);
    expect(Object.keys(readPeople(root))).toEqual(['ada-lovelace']);
  });
});

describe('people-store — the roster lock', () => {
  it('a write that cannot take the lock FAILS loudly rather than clobbering the holder', () => {
    addPerson(root, { name: 'Ada Lovelace', emails: ['ada@test.dev'] });
    const before = readFileSync(peopleJsonPath(root), 'utf-8');
    // A live holder (this very process's pid, fresh timestamp) — never stale.
    writeFileSync(join(root, 'people', '.people.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf-8');

    expect(() => addPerson(root, { name: 'Bob Builder' })).toThrow(PeopleStoreError);
    expect(readFileSync(peopleJsonPath(root), 'utf-8')).toBe(before);
    rmSync(join(root, 'people', '.people.lock'), { force: true });
    expect(addPerson(root, { name: 'Bob Builder' }).created).toBe(true);
  });

  it(
    'four OS processes adding four distinct people at once → all four present, none lost',
    async () => {
      const names = ['Ada Lovelace', 'Bob Builder', 'Carol Coder', 'Dan Deploy'];
      const childPath = join(root, '..', 'child-add.ts');
      writeFileSync(
        childPath,
        [
          `import { addPerson } from ${JSON.stringify(STORE_MODULE)};`,
          'const [, , root, name] = process.argv;',
          'process.stdout.write(JSON.stringify(addPerson(root, { name, emails: [`${name}@test.dev`] })) + "\\n");',
        ].join('\n'),
        'utf-8',
      );

      await Promise.all(names.map((name) => execFileAsync(VITE_NODE, [childPath, root, name])));

      expect(Object.keys(readPeople(root)).sort()).toEqual(['ada-lovelace', 'bob-builder', 'carol-coder', 'dan-deploy']);
      for (const slug of Object.keys(readPeople(root))) {
        expect(existsSync(personFilePath(root, slug)), slug).toBe(true);
      }
    },
    60_000, // generous: vite-node startup per process
  );
});
