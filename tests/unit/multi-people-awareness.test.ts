import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readSetupConfig,
  writeSetupConfig,
  updateSetupConfig,
  isMultiPerson,
  type SetupConfig,
} from '../../src/lib/setup-config.js';
import {
  isMultiPersonVault,
  listPeople,
  writePeople,
  type PeopleMap,
} from '../../src/lib/people-store.js';
import { findUnreleasedChangelog } from '../../src/lib/release-discovery.js';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { registerConfigCommand } from '../../src/cli/commands/config.js';
import { registerCoreCommand } from '../../src/cli/commands/core.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { registerMemoryCommand } from '../../src/cli/commands/memory.js';
import { generateSnapshot } from '../../src/cli/commands/snapshot.js';

/**
 * SPEC — Multi-people awareness
 * GitHub: https://github.com/meanllbrl/dreamcontext/issues/8
 *
 * Problem: dreamcontext assumes a single human ("the user"). When more than one
 * person works in the same project, changelogs, tasks, and memory lose track of
 * WHO did WHAT. We want the agent to auto-detect multiple humans (NOT a
 * hard-coded toggle) and attribute work per person across every surface.
 *
 * The 15 deterministic facets below are converted to passing `it(...)`. The 6
 * AI-driven facets (detection + sleep consolidation) stay `it.todo` — they live
 * in the sleep-state/sleep-tasks agent prompts and are inspection-validated.
 *
 * Schema deltas the implementation makes (kept here so the test is the single
 * source of truth for the target shape):
 *
 *   1. .config.json  (src/lib/setup-config.ts, config.ts)
 *        + people?: string[]            // canonical roster, kebab-case display names
 *      multiPerson is DERIVED only: isMultiPerson(cfg) === people.length > 1.
 *      It is NEVER persisted.
 *
 *   2. ChangelogEntry (src/lib/release-discovery.ts) + `core changelog add`:
 *        + authors?: string[]           // who was involved (UNIFIED person carrier)
 *        + `--authors <a,b>` flag.
 *      Excluded from the fingerprint → adding/removing authors never changes
 *      dedup identity (no spurious "unreleased").
 *
 *   3. Task tags (src/cli/commands/tasks.ts):
 *        when multiPerson, `--person X` pushes `person:<slug>` into the tags
 *        array (no new frontmatter field; existing tag filters just work).
 *
 *   4. Memory entries (`memory remember --person`):
 *        attributed via the SAME `authors` carrier; recall indexes authors into
 *        the doc tags field so the person name is searchable.
 *
 *   5. The roster: since 0.23.0 it lives in `people/people.json` (the people
 *        store), NOT in a "## People" block in 1.user.md. `ensurePeopleSection`
 *        and `src/lib/people.ts` are deleted; the contract that survives is
 *        "a solo vault grows no roster surface at all".
 *
 *   6. Snapshot (src/cli/commands/snapshot.ts): when multiPerson, per-entry
 *        "— by <names>" attribution; single-person output is byte-identical.
 *
 * NOTE on the fixtures below: several cases seed BOTH the legacy
 * `.config.json.people` roster and `people/people.json`. The multi-person GATE
 * is moving from the former to the latter in this same wave (T3/T4), and both
 * readings must agree — seeding both is what makes these assertions true before
 * and after that switch, rather than a tripwire on lane ordering.
 */

// ── Tmp-context fixture (mirrors release-discovery.test.ts) ──────────────────
// projectRoot/_dream_context/{state,core,knowledge}. CLI commands resolve the
// context root from process.cwd(), so each test chdir's into the project root.

interface Fixture {
  projectRoot: string;       // dir holding _dream_context/
  contextRoot: string;       // the _dream_context/ dir
}

function makeFixture(): Fixture {
  const raw = join(tmpdir(), `ac-people-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const projectRoot = realpathSync(raw);
  const contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(contextRoot, 'core', 'features'), { recursive: true });
  mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
  writeFileSync(join(contextRoot, 'core', 'CHANGELOG.json'), '[]', 'utf-8');
  writeFileSync(join(contextRoot, 'core', 'RELEASES.json'), '[]', 'utf-8');
  return { projectRoot, contextRoot };
}

/** Build a fresh Command, register one command group, parse argv (from cwd). */
async function runCli(
  register: (program: Command) => void,
  argv: string[],
): Promise<void> {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on errors
  register(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

/** Capture everything written to console.log during `fn`. */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

function readChangelog(contextRoot: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(contextRoot, 'core', 'CHANGELOG.json'), 'utf-8'));
}

function baseConfig(overrides: Partial<SetupConfig> = {}): SetupConfig {
  return {
    platforms: [],
    packs: [],
    multiProduct: false,
    setupVersion: '0.6.0',
    disableNativeMemory: true,
    ...overrides,
  };
}

/**
 * Seed `people/people.json` — the 0.23.0 roster. The fixture slugs double as
 * display names so the legacy `.config.json.people` values and the store's
 * slugs line up while the multi-person gate moves between them.
 */
function seedPeople(contextRoot: string, slugs: string[], emails: Record<string, string[]> = {}): void {
  const map: PeopleMap = {};
  for (const slug of slugs) map[slug] = { name: slug, emails: emails[slug] ?? [] };
  writePeople(contextRoot, map);
}

/** Return the vault to "no people layout at all" — the un-migrated shape. */
function clearPeople(contextRoot: string): void {
  rmSync(join(contextRoot, 'people'), { recursive: true, force: true });
}

describe('multi-people awareness', () => {
  let fx: Fixture;
  let origCwd: string;

  beforeEach(() => {
    fx = makeFixture();
    origCwd = process.cwd();
    process.chdir(fx.projectRoot);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(fx.projectRoot, { recursive: true, force: true });
  });

  describe('detection (AI-driven, not hard-coded)', () => {
    it.todo('infers >1 distinct human from session signals (self-id, git authors, voice) and flips multiPerson on');
    it.todo('stays single-person (multiPerson=false) when only one human is observed — no false positives');
    it.todo('detection is additive: a newly observed person is appended to the roster, never overwrites it');
  });

  describe('.config.json roster', () => {
    it('supports people: string[] alongside multiProduct (kebab-case display names)', () => {
      writeSetupConfig(
        fx.projectRoot,
        baseConfig({ multiProduct: ['app', 'site'], people: ['kerem', 'ada'] }),
      );
      const cfg = readSetupConfig(fx.projectRoot);
      expect(cfg).not.toBeNull();
      expect(cfg!.people).toEqual(['kerem', 'ada']);
      expect(cfg!.multiProduct).toEqual(['app', 'site']);
    });

    it('multiPerson is derived true when people.length > 1, false otherwise', () => {
      // Derived only — never read from a persisted flag.
      expect(isMultiPerson(baseConfig({ people: ['kerem', 'ada'] }))).toBe(true);
      expect(isMultiPerson(baseConfig({ people: ['kerem'] }))).toBe(false);
      expect(isMultiPerson(baseConfig({ people: [] }))).toBe(false);
      expect(isMultiPerson(baseConfig())).toBe(false);
      expect(isMultiPerson(null)).toBe(false);

      // And it is NEVER persisted: writing then reading carries no multiPerson key.
      writeSetupConfig(fx.projectRoot, baseConfig({ people: ['kerem', 'ada'] }));
      const raw = JSON.parse(
        readFileSync(join(fx.contextRoot, 'state', '.config.json'), 'utf-8'),
      );
      expect(raw).not.toHaveProperty('multiPerson');

      // updateSetupConfig merges people additively (patch.people ?? existing).
      const merged = updateSetupConfig(fx.projectRoot, { platforms: [] });
      expect(merged.people).toEqual(['kerem', 'ada']);
    });

    it('config show prints the people roster from people.json (sorted by name)', async () => {
      // 0.23.0: the roster line reads the people STORE, not `.config.json.people`.
      writeSetupConfig(fx.projectRoot, baseConfig());
      seedPeople(fx.contextRoot, ['kerem', 'ada']);
      const out = await captureStdout(() =>
        runCli(registerConfigCommand, ['config', 'show']),
      );
      expect(out).toMatch(/People:\s+ada, kerem/);
    });

    it('a legacy config.people roster no longer feeds the config show line', async () => {
      // The key still PARSES (the 0.23.0 migration needs to read it), but nothing
      // renders it — one file owns "who exists", and it is people.json.
      writeSetupConfig(fx.projectRoot, baseConfig({ people: ['kerem', 'ada'] }));
      const out = await captureStdout(() =>
        runCli(registerConfigCommand, ['config', 'show']),
      );
      expect(out).not.toMatch(/People:/);
    });

    it('missing people/multiPerson is treated as single-person (backwards compatible)', async () => {
      // Legacy config without a `people` key.
      writeSetupConfig(fx.projectRoot, baseConfig());
      const cfg = readSetupConfig(fx.projectRoot);
      expect(cfg!.people).toBeUndefined();
      expect(isMultiPerson(cfg)).toBe(false);

      // config show prints NO People line for a single-person project.
      const out = await captureStdout(() =>
        runCli(registerConfigCommand, ['config', 'show']),
      );
      expect(out).not.toMatch(/People:/);
    });
  });

  describe('changelog attribution', () => {
    it('ChangelogEntry accepts optional authors?: string[]', () => {
      // The optional field round-trips through JSON on disk.
      writeFileSync(
        join(fx.contextRoot, 'core', 'CHANGELOG.json'),
        JSON.stringify([
          { date: '2026-06-09', type: 'feat', scope: 'x', description: 'd', breaking: false, authors: ['kerem', 'ada'] },
        ]),
        'utf-8',
      );
      const entries = readChangelog(fx.contextRoot);
      expect(entries[0].authors).toEqual(['kerem', 'ada']);
    });

    it('core changelog add --authors "kerem,ada" persists authors on the entry', async () => {
      await runCli(registerCoreCommand, [
        'core', 'changelog', 'add',
        '--type', 'feat', '--scope', 'people', '--description', 'multi-person',
        '--authors', 'kerem, ada',
      ]);
      const entries = readChangelog(fx.contextRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0].authors).toEqual(['kerem', 'ada']);
      expect(entries[0].description).toBe('multi-person');
    });

    it('entries without authors still parse and render (backwards compatible)', () => {
      // A legacy entry (no authors) and a new entry (with authors) coexist; the
      // fingerprint EXCLUDES authors, so adding authors to an otherwise-identical
      // entry does not change its dedup identity — no spurious "unreleased".
      const legacy = { date: '2026-06-09', type: 'fix', scope: 'auth', description: 'bug', breaking: false };
      const withAuthors = { ...legacy, authors: ['kerem'] };
      // Release already contains the legacy entry → it is "released".
      writeFileSync(
        join(fx.contextRoot, 'core', 'RELEASES.json'),
        JSON.stringify([
          { id: 'rel_1', version: '1.0.0', date: '2026-06-01', summary: 's', breaking: false, status: 'released', features: [], tasks: [], changelog: [legacy] },
        ]),
        'utf-8',
      );
      // The CHANGELOG carries the SAME entry but now with authors attached.
      writeFileSync(
        join(fx.contextRoot, 'core', 'CHANGELOG.json'),
        JSON.stringify([withAuthors]),
        'utf-8',
      );
      // Fingerprint excludes authors → the entry is recognised as already
      // released, so it is NOT reported as unreleased.
      const unreleased = findUnreleasedChangelog(fx.contextRoot);
      expect(unreleased).toHaveLength(0);
    });

    it('snapshot Recent Changelog shows author attribution when multiPerson', async () => {
      writeSetupConfig(fx.projectRoot, baseConfig({ people: ['kerem', 'ada'] }));
      seedPeople(fx.contextRoot, ['kerem', 'ada']);
      writeFileSync(
        join(fx.contextRoot, 'core', 'CHANGELOG.json'),
        JSON.stringify([
          { date: '2026-06-09', type: 'feat', scope: 'people', description: 'rostering', breaking: false, authors: ['kerem', 'ada'] },
        ]),
        'utf-8',
      );
      const snapshot = generateSnapshot();
      expect(snapshot).toContain('## Recent Changelog');
      expect(snapshot).toContain('— by kerem, ada');

      // Single-person output is byte-identical to today: same CHANGELOG, no
      // roster ⇒ no "— by" suffix anywhere.
      writeSetupConfig(fx.projectRoot, baseConfig());
      clearPeople(fx.contextRoot);
      const singlePerson = generateSnapshot();
      expect(singlePerson).toContain('## Recent Changelog');
      expect(singlePerson).not.toContain('— by');
    });
  });

  describe('task person tags', () => {
    it('when multiPerson, the responsible person is recorded as a person:<name> tag in task frontmatter', async () => {
      writeSetupConfig(fx.projectRoot, baseConfig({ people: ['kerem', 'ada'] }));
      seedPeople(fx.contextRoot, ['kerem', 'ada']);
      await runCli(registerTasksCommand, [
        'tasks', 'create', 'Ship rostering', '-w', 'test why', '--person', 'Ada',
      ]);
      const taskMd = readFileSync(join(fx.contextRoot, 'state', 'ship-rostering.md'), 'utf-8');
      expect(taskMd).toMatch(/tags:[^\n]*person:ada/);
    });

    it('tasks list can filter/group by person:<name> tag (reuses existing tag handling)', async () => {
      writeSetupConfig(fx.projectRoot, baseConfig({ people: ['kerem', 'ada'] }));
      seedPeople(fx.contextRoot, ['kerem', 'ada']);
      await runCli(registerTasksCommand, ['tasks', 'create', 'Task A', '-w', 'test why', '--person', 'Ada']);
      await runCli(registerTasksCommand, ['tasks', 'create', 'Task B', '-w', 'test why', '--person', 'Kerem']);

      // --tag person:ada filters via the EXISTING task-query tag handling (the
      // tag was injected into the generic tags array — task-query.ts unchanged).
      const filtered = await captureStdout(() =>
        runCli(registerTasksCommand, ['tasks', 'list', '--tag', 'person:ada', '--json']),
      );
      const parsed = JSON.parse(filtered);
      // TaskRecord.name is the file-basename slug (see task-query.ts).
      const slugs = parsed.map((t: { name: string }) => t.name);
      expect(slugs).toContain('task-a');
      expect(slugs).not.toContain('task-b');

      // --group-by tag also works over the same tags array.
      const grouped = await captureStdout(() =>
        runCli(registerTasksCommand, ['tasks', 'list', '--group-by', 'tag', '--all']),
      );
      expect(grouped).toContain('person:ada');
      expect(grouped).toContain('person:kerem');
    });

    it('single-person projects do not get person tags injected', async () => {
      writeSetupConfig(fx.projectRoot, baseConfig()); // no roster ⇒ single-person
      await runCli(registerTasksCommand, [
        'tasks', 'create', 'Solo task', '-w', 'test why', '--person', 'Ada',
      ]);
      const taskMd = readFileSync(join(fx.contextRoot, 'state', 'solo-task.md'), 'utf-8');
      expect(taskMd).not.toContain('person:');
      expect(taskMd).toMatch(/tags:\s*\[\]/);
    });
  });

  describe('memory person tags', () => {
    it('memory remember accepts and preserves a person:<name> tag', async () => {
      // Person attribution rides the UNIFIED `authors` carrier (NOT references).
      await runCli(registerMemoryCommand, [
        'memory', 'remember', 'decided', 'on', 'the', 'roster', 'shape',
        '--person', 'kerem,ada',
      ]);
      const entries = readChangelog(fx.contextRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0].authors).toEqual(['kerem', 'ada']);
      // It must NOT be folded into references.
      expect(entries[0].references).toBeUndefined();
    });

    it('recall surfaces person-tagged memory; person tag is searchable', async () => {
      await runCli(registerMemoryCommand, [
        'memory', 'remember', 'we', 'wired', 'the', 'snapshot', 'render',
        '--person', 'ada',
      ]);
      // recall indexes `authors` into the changelog doc's tags field → searching
      // the person name returns the entry as a BM25 hit.
      const corpus = buildCorpus(fx.contextRoot, { types: ['changelog'] });
      const hits = bm25Search('ada', corpus, 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.doc.tags.includes('ada'))).toBe(true);
    });
  });

  // The `## People` block in 1.user.md (and `ensurePeopleSection` with it) is
  // GONE — the roster is `people/people.json` and the prose is one constitution
  // per person. What survives from that contract is the shape of the gate: a
  // vault with ≤1 person grows no roster surface anywhere.
  describe('people roster (people/people.json)', () => {
    it('the roster enumerates each person, keyed by slug, sorted by name', () => {
      seedPeople(fx.contextRoot, ['kerem', 'ada']);
      const roster = listPeople(fx.contextRoot);
      expect(roster.map((p) => p.slug)).toEqual(['ada', 'kerem']);
      expect(roster.every((p) => Array.isArray(p.emails))).toBe(true);

      // Additive update: a third person joins without disturbing the first two.
      seedPeople(fx.contextRoot, ['kerem', 'ada', 'lina']);
      expect(listPeople(fx.contextRoot).map((p) => p.slug)).toEqual(['ada', 'kerem', 'lina']);
    });

    it('solo vault renders no roster section', () => {
      // The gate every roster surface hangs off: >1 person. A solo vault (and an
      // un-migrated one) is single-person, so nothing enumerates anybody.
      clearPeople(fx.contextRoot);
      expect(isMultiPersonVault(fx.contextRoot)).toBe(false);
      expect(listPeople(fx.contextRoot)).toEqual([]);

      seedPeople(fx.contextRoot, ['kerem']);
      expect(isMultiPersonVault(fx.contextRoot)).toBe(false);

      seedPeople(fx.contextRoot, ['kerem', 'ada']);
      expect(isMultiPersonVault(fx.contextRoot)).toBe(true);
    });
  });

  describe('sleep consolidation', () => {
    it.todo('sleep-state detects multiple humans and writes the roster to .config.json + user.md');
    it.todo('sleep-state attributes each changelog entry to the person(s) who drove the change');
    it.todo('sleep-tasks attributes task progress to the responsible person via person:<name> tag');
  });
});
