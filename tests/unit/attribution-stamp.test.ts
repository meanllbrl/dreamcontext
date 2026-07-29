import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

import { registerCoreCommand } from '../../src/cli/commands/core.js';
import { registerMemoryCommand } from '../../src/cli/commands/memory.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { addPerson } from '../../src/lib/people-store.js';
import { PERSON_ENV_VAR } from '../../src/lib/people-resolve.js';
import { deriveContributors } from '../../src/lib/attribution.js';

/**
 * T4 — automatic author stamping and release contributors (people-first, 0.23.0).
 *
 * The load-bearing invariant here is **D18**: with no `people/people.json`, the
 * `authors` key is OMITTED entirely — not written as `[]`. That single fact is
 * what keeps every pre-people-first fixture, release-discovery fingerprint and
 * recall index byte-identical, so these tests assert the ABSENCE of the key, not
 * just an empty value.
 *
 * The vaults below are deliberately built WITHOUT a git repo. Resolution then
 * walks env → pin → git-email → solo: a one-person roster resolves via the solo
 * rung regardless of whatever `git config` the machine has, and a two-person
 * roster with no env var resolves to nobody — which is exactly the "never
 * guesses" case one of these tests pins.
 */

let projectRoot: string;
let contextRoot: string;
let origCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function corePath(file: string): string {
  return join(contextRoot, 'core', file);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function changelogEntries(): Array<Record<string, unknown>> {
  return readJson<Array<Record<string, unknown>>>(corePath('CHANGELOG.json'));
}

function releaseEntries(): Array<Record<string, unknown>> {
  return readJson<Array<Record<string, unknown>>>(corePath('RELEASES.json'));
}

/** A completed task file — `releases add` sweeps these by frontmatter id. */
function writeCompletedTask(slug: string, id: string, tags: string[]): void {
  const tagLines = tags.length > 0
    ? tags.map((t) => `  - '${t}'`).join('\n')
    : '  []';
  writeFileSync(
    join(contextRoot, 'state', `${slug}.md`),
    `---\nid: ${id}\nname: ${slug}\ndescription: ${slug}\nstatus: completed\ncreated_at: '2026-01-01'\nupdated_at: '2026-01-02'\ntags:\n${tagLines}\n---\n\n## Why\n\n- reasons\n`,
    'utf-8',
  );
}

async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCoreCommand(program);
  registerMemoryCommand(program);
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

function taskFile(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-attr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'core'), { recursive: true });
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(corePath('CHANGELOG.json'), '[]\n', 'utf-8');
  writeFileSync(corePath('RELEASES.json'), '[]\n', 'utf-8');
  delete process.env[PERSON_ENV_VAR];
  origCwd = process.cwd();
  process.chdir(projectRoot);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(origCwd);
  logSpy.mockRestore();
  delete process.env[PERSON_ENV_VAR];
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('core changelog add — author stamping', () => {
  it('stamps the active person when --authors is omitted', async () => {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@example.test'] });
    await runCli(['core', 'changelog', 'add', '--type', 'fix', '--scope', 'recall', '--description', 'tighter scoring']);
    expect(changelogEntries()[0].authors).toEqual(['ada-lovelace']);
  });

  it('uses an explicit --authors VERBATIM, never the active person', async () => {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@example.test'] });
    await runCli([
      'core', 'changelog', 'add', '--type', 'feat', '--scope', 'ui', '--description', 'new pane',
      '--authors', 'bob, carol',
    ]);
    expect(changelogEntries()[0].authors).toEqual(['bob', 'carol']);
  });

  it('omits the authors key ENTIRELY when the vault has no people/people.json (D18)', async () => {
    await runCli(['core', 'changelog', 'add', '--type', 'chore', '--scope', 'deps', '--description', 'bump']);
    const entry = changelogEntries()[0];
    expect('authors' in entry).toBe(false);
    // The whole entry must be shaped exactly as it was pre-0.23.0.
    expect(Object.keys(entry)).toEqual(['date', 'type', 'scope', 'description', 'breaking']);
  });

  it('omits the authors key when a multi-person vault cannot resolve this machine (never guesses)', async () => {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@example.test'] });
    addPerson(contextRoot, { name: 'Bob Builder', emails: ['bob@example.test'] });
    await runCli(['core', 'changelog', 'add', '--type', 'fix', '--scope', 'sync', '--description', 'retry']);
    expect('authors' in changelogEntries()[0]).toBe(false);
  });

  it('stamps the person named by DREAMCONTEXT_PERSON on a multi-person vault', async () => {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@example.test'] });
    addPerson(contextRoot, { name: 'Bob Builder', emails: ['bob@example.test'] });
    process.env[PERSON_ENV_VAR] = 'bob-builder';
    await runCli(['core', 'changelog', 'add', '--type', 'fix', '--scope', 'sync', '--description', 'retry']);
    expect(changelogEntries()[0].authors).toEqual(['bob-builder']);
  });
});

describe('memory remember — author stamping', () => {
  it('auto-stamps the active person, and --person still wins verbatim', async () => {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@example.test'] });

    await runCli(['memory', 'remember', 'the', 'BM25 tie-break', 'is', 'recency']);
    expect(changelogEntries()[0].authors).toEqual(['ada-lovelace']);

    await runCli(['memory', 'remember', 'pairing note', '--person', 'bob,carol']);
    expect(changelogEntries()[0].authors).toEqual(['bob', 'carol']);
  });

  it('omits the authors key entirely with no people/people.json (D18)', async () => {
    await runCli(['memory', 'remember', 'a', 'rosterless', 'note']);
    expect('authors' in changelogEntries()[0]).toBe(false);
  });
});

describe('deriveContributors', () => {
  it('unions changelog authors with the swept tasks person: tags, deduped and sorted', () => {
    writeCompletedTask('ship-it', 'task_A', ['person:bob-builder', 'topic:recall']);
    writeCompletedTask('fix-it', 'task_B', ['person:ada-lovelace']);
    const contributors = deriveContributors(contextRoot, {
      changelogEntries: [
        { authors: ['ada-lovelace'] },
        { authors: ['carol-danvers', 'ada-lovelace'] },
        {},
      ],
      taskIds: ['task_A', 'task_B'],
    });
    expect(contributors).toEqual(['ada-lovelace', 'bob-builder', 'carol-danvers']);
  });

  it('ignores tasks the release did not sweep', () => {
    writeCompletedTask('ship-it', 'task_A', ['person:bob-builder']);
    writeCompletedTask('elsewhere', 'task_Z', ['person:zoe-zed']);
    expect(deriveContributors(contextRoot, { changelogEntries: [], taskIds: ['task_A'] }))
      .toEqual(['bob-builder']);
  });

  it('drops bot authors from both carriers', () => {
    writeCompletedTask('bot-work', 'task_A', ['person:dependabot']);
    const contributors = deriveContributors(contextRoot, {
      changelogEntries: [{ authors: ['github-actions[bot]', 'ada-lovelace'] }],
      taskIds: ['task_A'],
    });
    expect(contributors).toEqual(['ada-lovelace']);
  });

  it('returns [] when there is nothing to attribute', () => {
    expect(deriveContributors(contextRoot, { changelogEntries: [{}], taskIds: [] })).toEqual([]);
  });
});

describe('tasks create — person tags on a multi-person vault', () => {
  function seedTwoPeople(): void {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@example.test'] });
    addPerson(contextRoot, { name: 'Bob Builder', emails: ['bob@example.test'] });
  }

  it('defaults to the ACTIVE person when --person is omitted', async () => {
    seedTwoPeople();
    process.env[PERSON_ENV_VAR] = 'bob-builder';
    await runCli(['tasks', 'create', 'Ship rostering', '-w', 'because']);
    expect(taskFile('ship-rostering')).toMatch(/person:bob-builder/);
  });

  it('records nobody when this machine resolves to no one (never guesses)', async () => {
    seedTwoPeople();
    await runCli(['tasks', 'create', 'Ship rostering', '-w', 'because']);
    expect(taskFile('ship-rostering')).not.toContain('person:');
  });

  it('canonicalizes an explicit --person against the roster (display name → slug)', async () => {
    seedTwoPeople();
    await runCli(['tasks', 'create', 'Ship rostering', '-w', 'because', '--person', 'Ada Lovelace']);
    expect(taskFile('ship-rostering')).toMatch(/person:ada-lovelace/);
  });

  it('never overrides a person tag the caller passed through --tags', async () => {
    seedTwoPeople();
    process.env[PERSON_ENV_VAR] = 'bob-builder';
    await runCli(['tasks', 'create', 'Ship rostering', '-w', 'because', '-t', 'person:ada-lovelace']);
    const md = taskFile('ship-rostering');
    expect(md).toMatch(/person:ada-lovelace/);
    expect(md).not.toContain('person:bob-builder');
  });

  it('degrades to no person tag (with a warning) when people.json is corrupt — D17', async () => {
    seedTwoPeople();
    process.env[PERSON_ENV_VAR] = 'bob-builder';
    writeFileSync(join(contextRoot, 'people', 'people.json'), '{ not json', 'utf-8');
    await runCli(['tasks', 'create', 'Ship rostering', '-w', 'because']);
    expect(taskFile('ship-rostering')).not.toContain('person:');
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/Could not read people\/people\.json/);
  });
});

describe('core releases add — contributors', () => {
  it('records the derived contributors on the release entry', async () => {
    addPerson(contextRoot, { name: 'Ada Lovelace', emails: ['ada@example.test'] });
    writeCompletedTask('ship-it', 'task_A', ['person:bob-builder']);
    await runCli(['core', 'changelog', 'add', '--type', 'feat', '--scope', 'ui', '--description', 'new pane']);
    await runCli(['core', 'releases', 'add', '-V', '0.1.0', '-s', 'First light', '-y']);

    const release = releaseEntries()[0];
    expect(release.version).toBe('0.1.0');
    expect(release.contributors).toEqual(['ada-lovelace', 'bob-builder']);
  });

  it('omits the contributors key when nothing is attributable (rosterless vault)', async () => {
    writeCompletedTask('ship-it', 'task_A', ['topic:recall']);
    await runCli(['core', 'changelog', 'add', '--type', 'feat', '--scope', 'ui', '--description', 'new pane']);
    await runCli(['core', 'releases', 'add', '-V', '0.1.0', '-s', 'First light', '-y']);

    const release = releaseEntries()[0];
    expect('contributors' in release).toBe(false);
  });
});
