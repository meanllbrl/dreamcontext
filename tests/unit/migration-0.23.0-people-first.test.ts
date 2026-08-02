import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * T6 — migration 0.23.0's people-first trio: seed-people-from-config,
 * split-user-file, retire-config-roster.
 *
 * `readGitIdentity` shells out to `git config`, which on a developer machine
 * falls through to the GLOBAL config — a real identity would leak into every
 * fixture and make "no git identity on this machine" untestable. Mocking the
 * module (rather than the binary) also covers `people-resolve`'s git-email rung,
 * since both import the same instance.
 */
const git = vi.hoisted(() => ({ name: null as string | null, email: null as string | null }));

vi.mock('../../src/lib/git-sync/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/git-sync/git.js')>();
  return { ...actual, readGitIdentity: () => ({ name: git.name, email: git.email }) };
});

const { migration0230 } = await import('../../src/migrations/0.23.0.js');
const { readPeople } = await import('../../src/lib/people-store.js');
const { readSetupConfig } = await import('../../src/lib/setup-config.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Step indices. The people-first trio runs AFTER the sleep-debt rescale (index 0). */
const SEED = 1;
const SPLIT = 2;
const RETIRE = 3;

const LEGACY_USER_MD = `---
name: user-preferences
type: user
updated: "2026-01-01"
---

## User Preferences

- Ship small, reviewable diffs.
- Prefer deletion over abstraction.

## Communication Style

- Terse. No preamble, no summary of the summary.

## Identity

- Founder; writes most of the code herself.

## People

- Ada Lovelace (\`person:ada-lovelace\`)
- Grace Hopper (\`person:grace-hopper\`)

## Project Details

- Monorepo, pnpm workspaces, deploys from main.

## Project Rules

- Never push to main.

## Workflow Notes

- Review cycles happen on Fridays.

## Brand Palette

- Ink #101010, paper #fafafa.
`;

/** Every H2 that must survive the split, mapped to a line that proves its body did. */
const BODY_PROBES: Record<string, string[]> = {
  'User Preferences': ['- Ship small, reviewable diffs.', '- Prefer deletion over abstraction.'],
  'Communication Style': ['- Terse. No preamble, no summary of the summary.'],
  Identity: ['- Founder; writes most of the code herself.'],
  'Project Details': ['- Monorepo, pnpm workspaces, deploys from main.'],
  'Project Rules': ['- Never push to main.'],
  'Workflow Notes': ['- Review cycles happen on Fridays.'],
  'Brand Palette': ['- Ink #101010, paper #fafafa.'],
};

interface Vault {
  project: string;
  root: string;
}

function makeVault(): Vault {
  const project = mkdtempSync(join(tmpdir(), 'dc-t6-'));
  const root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  return { project, root };
}

function writeConfig(v: Vault, config: Record<string, unknown>): void {
  writeFileSync(join(v.root, 'state', '.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function writeUserMd(v: Vault, content = LEGACY_USER_MD): void {
  writeFileSync(join(v.root, 'core', '1.user.md'), content, 'utf-8');
}

function read(v: Vault, rel: string): string {
  return readFileSync(join(v.root, rel), 'utf-8');
}

function has(v: Vault, rel: string): boolean {
  return existsSync(join(v.root, rel));
}

/** Run the people-first trio in registry order. */
function runPeopleFirst(root: string): Array<{ step: string; detected: boolean; filesTouched: string[]; summary: string; failedCount?: number }> {
  return [SEED, SPLIT, RETIRE].map((i) => migration0230.steps[i](root));
}

/** Recursive `relPath → bytes` snapshot, for byte-identical assertions. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) Object.assign(out, snapshot(full, base));
    else out[relative(base, full)] = readFileSync(full, 'utf-8');
  }
  return out;
}

function countHeading(text: string, title: string): number {
  return text.split('\n').filter((l) => l.trim().toLowerCase() === `## ${title}`.toLowerCase()).length;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('migration 0.23.0 — people-first', () => {
  let v: Vault;

  beforeEach(() => {
    v = makeVault();
    git.name = null;
    git.email = null;
    delete process.env.DREAMCONTEXT_PERSON;
  });
  afterEach(() => rmSync(v.project, { recursive: true, force: true }));

  it('runs the trio in the order the registry pins', () => {
    writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
    expect(migration0230.steps).toHaveLength(4);
    expect(runPeopleFirst(v.root).map((r) => r.step)).toEqual([
      'seed-people-from-config',
      'split-user-file',
      'retire-config-roster',
    ]);
  });

  // ─── seed-people-from-config ───────────────────────────────────────────────

  describe('seed-people-from-config', () => {
    it('seeds the roster from config.people[] and folds the git email in', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace', 'Grace Hopper'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'Ada@Example.COM';

      const r = migration0230.steps[SEED](v.root);

      expect(r.detected).toBe(false);
      const people = readPeople(v.root);
      expect(Object.keys(people).sort()).toEqual(['ada-lovelace', 'grace-hopper']);
      // Normalized (lowercased) onto the matching entry — and only that entry.
      expect(people['ada-lovelace'].emails).toEqual(['ada@example.com']);
      expect(people['grace-hopper'].emails).toEqual([]);
      expect(people['ada-lovelace'].name).toBe('Ada Lovelace');
    });

    it('adds the git identity as its own person when no config name matches', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Grace Hopper'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';

      migration0230.steps[SEED](v.root);

      const people = readPeople(v.root);
      expect(Object.keys(people).sort()).toEqual(['ada-lovelace', 'grace-hopper']);
      expect(people['ada-lovelace'].emails).toEqual(['ada@example.com']);
    });

    it('an existing people.json is a detected no-op — nothing is re-derived', () => {
      mkdirSync(join(v.root, 'people'), { recursive: true });
      const roster = JSON.stringify({ version: 1, people: { grace: { name: 'Grace', emails: [] } } }, null, 2) + '\n';
      writeFileSync(join(v.root, 'people', 'people.json'), roster, 'utf-8');
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';

      const r = migration0230.steps[SEED](v.root);

      expect(r.detected).toBe(true);
      expect(r.filesTouched).toEqual([]);
      expect(read(v, 'people/people.json')).toBe(roster);
    });

    it('empty roster + no git identity ⇒ one loud `owner` entry, never an empty roster', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });

      const r = migration0230.steps[SEED](v.root);

      const people = readPeople(v.root);
      // doctor errors on a roster that parses to zero people — this step must
      // never be the thing that produces one.
      expect(Object.keys(people)).toEqual(['owner']);
      expect(r.summary).toContain('owner');
      expect(r.summary).toMatch(/placeholder/i);
      expect(has(v, 'people/owner.md')).toBe(true);
    });

    it('every seeded person gets a constitution (doctor errors on a slug without one)', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace', 'Grace Hopper'], setupVersion: '0.22.0' });

      migration0230.steps[SEED](v.root);

      for (const slug of Object.keys(readPeople(v.root))) {
        expect(has(v, `people/${slug}.md`)).toBe(true);
      }
    });

    it('does NOT scaffold the legacy owner constitution — split-user-file authors it from real prose', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace', 'Grace Hopper'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);

      migration0230.steps[SEED](v.root);

      // A placeholder scaffold here would make the heading-idempotent append
      // skip `## Preferences` and silently drop the user's real prose.
      expect(has(v, 'people/ada-lovelace.md')).toBe(false);
      expect(has(v, 'people/grace-hopper.md')).toBe(true);
    });
  });

  // ─── split-user-file ───────────────────────────────────────────────────────

  describe('split-user-file', () => {
    function legacyVault(): void {
      writeConfig(v, {
        platforms: [],
        packs: [],
        people: ['Ada Lovelace'],
        peopleIdentity: { 'ada-lovelace': { clickupMemberId: '42' } },
        setupVersion: '0.22.0',
      });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);
    }

    it('routes known headings to the constitution and every other H2 to the residue', () => {
      legacyVault();
      runPeopleFirst(v.root);

      const constitution = read(v, 'people/ada-lovelace.md');
      const residue = read(v, 'inbox/1.user-residue.md');

      // Known → constitution, with `User Preferences` renamed. Assert the BODIES
      // too: the placeholder scaffold carries all three headings, so a
      // heading-only assertion would pass on a constitution that lost the prose.
      expect(constitution).toContain('## Preferences');
      expect(constitution).toContain('- Ship small, reviewable diffs.');
      expect(constitution).toContain('## Communication Style');
      expect(constitution).toContain('- Terse. No preamble, no summary of the summary.');
      expect(constitution).toContain('## Identity');
      expect(constitution).toContain('- Founder; writes most of the code herself.');
      expect(constitution).not.toContain('## User Preferences');
      expect(constitution).not.toContain('(Decision-making patterns'); // no placeholder prose
      // Unknown → residue, VERBATIM, never the constitution.
      for (const title of ['Project Details', 'Project Rules', 'Workflow Notes', 'Brand Palette']) {
        expect(residue).toContain(`## ${title}`);
        expect(constitution).not.toContain(`## ${title}`);
      }
      // …and nothing constitution-shaped leaks the other way.
      for (const title of ['Preferences', 'Identity', 'Communication Style']) {
        expect(residue).not.toContain(`## ${title}`);
      }
      expect(has(v, 'core/1.user.md')).toBe(false);
    });

    it('the residue carries its frontmatter and the routing header the agent needs', () => {
      legacyVault();
      runPeopleFirst(v.root);

      const residue = read(v, 'inbox/1.user-residue.md');
      expect(residue.startsWith('---\nname: user-md-residue\ntype: migration-residue\n')).toBe(true);
      expect(residue).toContain('core/4.tech_stack.md');
      expect(residue).toContain('core/0.soul.md');
      expect(residue).toContain('knowledge/patterns/');
      expect(residue).toContain('core/3.style_guide_and_branding.md');
      expect(residue).toContain('NOTHING IS DISCARDED');
    });

    it('residue ∪ constitution ⊇ every original H2 body — nothing is lost', () => {
      legacyVault();
      runPeopleFirst(v.root);

      const union = read(v, 'people/ada-lovelace.md') + '\n' + read(v, 'inbox/1.user-residue.md');
      for (const probes of Object.values(BODY_PROBES)) {
        for (const line of probes) expect(union).toContain(line);
      }
    });

    it('`## People` bullets are upserted into the roster, not copied as prose', () => {
      legacyVault();
      runPeopleFirst(v.root);

      const people = readPeople(v.root);
      expect(Object.keys(people).sort()).toEqual(['ada-lovelace', 'grace-hopper']);
      expect(has(v, 'people/grace-hopper.md')).toBe(true);
      // The block became structure; it is not left lying around as prose.
      const union = read(v, 'people/ada-lovelace.md') + read(v, 'inbox/1.user-residue.md');
      expect(union).not.toContain('## People');
    });

    it('an owner listed in `## People` still gets real prose, not the addPerson scaffold', () => {
      // Regression: `addPerson` scaffolds an absent constitution. Upserting the
      // roster before writing the constitution would leave a placeholder whose
      // headings then suppress every real section — silent prose loss.
      legacyVault();

      runPeopleFirst(v.root);

      const constitution = read(v, 'people/ada-lovelace.md');
      expect(constitution).toContain('- Prefer deletion over abstraction.');
      expect(constitution).not.toContain('(Decision-making patterns');
    });

    it('keeps a `## People` section that holds unparseable prose', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v, `## People\n\n- Grace Hopper (\`person:grace-hopper\`)\n\nGrace only works Tuesdays.\n`);

      runPeopleFirst(v.root);

      expect(readPeople(v.root)['grace-hopper']).toBeDefined();
      expect(read(v, 'inbox/1.user-residue.md')).toContain('Grace only works Tuesdays.');
    });

    it('a descriptive `## People` bullet goes to the residue — the step never fails', () => {
      // The real h-f_dreamcontext / memoryos block: bullets that DESCRIBE people
      // instead of naming them. Slugifying the whole line yields a 250-char
      // string PERSON_SLUG_RE rejects, which used to throw out of addPerson and
      // report failedCount — pinning setupVersion on every future `update`,
      // permanently, because the runner re-runs each step and this input is
      // deterministic. Both vaults sat on 0.21.0 with 0.23.0 assets installed.
      //
      // Which fragment is the NAME ("mehmet"? "Mehmet Nuraydın"?) is judgment,
      // so per D5 the step must route, not guess: section → residue → agentTask.
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(
        v,
        '## People\n\n'
        + '- **mehmet** — Mehmet Nuraydın, Technical Product Manager / App Owner. '
        + 'Primary brain operator; owns product, funnel, roadmap, ad-spend. '
        + 'Operates 360°; codes from wireframes, prefers building in-house.\n',
      );

      const [, split] = runPeopleFirst(v.root);

      // THE regression: a clean run is what lets setupVersion advance.
      expect(split.failedCount ?? 0).toBe(0);
      // Not guessed into the roster under some mangled slug.
      expect(Object.keys(readPeople(v.root))).toEqual(['ada-lovelace']);
      // Verbatim in the residue, with the agent told to place it.
      const residue = read(v, 'inbox/1.user-residue.md');
      expect(residue).toContain('## People');
      expect(residue).toContain('**mehmet** — Mehmet Nuraydın');
      expect(residue).toContain('dreamcontext people add');
      // And the source is retired: the split completed.
      expect(has(v, 'core/1.user.md')).toBe(false);
    });

    it('a descriptive bullet does not suppress a canonical one in the same block', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(
        v,
        '## People\n\n'
        + '- Grace Hopper (`person:grace-hopper`)\n'
        + '- **bektas** — Bektaş Çimen, in-house developer. Drives engineering '
        + 'implementation sessions and owns the deploy pipeline end to end.\n',
      );

      const [, split] = runPeopleFirst(v.root);

      expect(split.failedCount ?? 0).toBe(0);
      // The unambiguous row still becomes structure...
      expect(readPeople(v.root)['grace-hopper']).toBeDefined();
      // ...and the block still reaches the agent, because one bullet needs judgment.
      expect(read(v, 'inbox/1.user-residue.md')).toContain('Bektaş Çimen');
    });

    it('a 1.user.md with zero H2s sends everything to the residue', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v, `---\nname: user-preferences\ntype: user\n---\n\nJust some drifted prose.\nAnd a second line.\n`);

      const [, split] = runPeopleFirst(v.root);

      expect(split.detected).toBe(false);
      const residue = read(v, 'inbox/1.user-residue.md');
      expect(residue).toContain('## Preamble');
      expect(residue).toContain('Just some drifted prose.');
      expect(residue).toContain('And a second line.');
      // The owner still ends up with a usable constitution (doctor invariant).
      expect(has(v, 'people/ada-lovelace.md')).toBe(true);
      expect(has(v, 'core/1.user.md')).toBe(false);
    });

    it('no core/1.user.md ⇒ detected no-op, and no residue file is conjured', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      migration0230.steps[SEED](v.root);

      const r = migration0230.steps[SPLIT](v.root);

      expect(r.detected).toBe(true);
      expect(r.filesTouched).toEqual([]);
      expect(has(v, 'inbox/1.user-residue.md')).toBe(false);
    });

    it('refuses (failedCount) rather than guessing when there is no roster to own the prose', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
      writeUserMd(v);

      const r = migration0230.steps[SPLIT](v.root);

      expect(r.failedCount).toBe(1);
      expect(has(v, 'core/1.user.md')).toBe(true);
    });

    // ── crash resume ──
    it('CRASH-RESUME: a constitution that already holds the headings gains nothing, and the delete finishes', () => {
      legacyVault();
      migration0230.steps[SEED](v.root);
      mkdirSync(join(v.root, 'people'), { recursive: true });
      const already = `---\nname: ada-lovelace\ntype: person\nupdated: "2026-01-01"\n---\n\n`
        + `## Preferences\n\n- Ship small, reviewable diffs.\n- Prefer deletion over abstraction.\n\n`
        + `## Communication Style\n\n- Terse. No preamble, no summary of the summary.\n\n`
        + `## Identity\n\n- Founder; writes most of the code herself.\n`;
      writeFileSync(join(v.root, 'people', 'ada-lovelace.md'), already, 'utf-8');

      const r = migration0230.steps[SPLIT](v.root);

      expect(read(v, 'people/ada-lovelace.md')).toBe(already);
      expect(countHeading(read(v, 'people/ada-lovelace.md'), 'Preferences')).toBe(1);
      expect(has(v, 'core/1.user.md')).toBe(false);
      expect(r.filesTouched).toContain(join(v.root, 'core', '1.user.md'));
    });

    it('CRASH-RESUME is per-heading: a pre-existing `## Preferences` is skipped, the other two still land', () => {
      legacyVault();
      migration0230.steps[SEED](v.root);
      mkdirSync(join(v.root, 'people'), { recursive: true });
      writeFileSync(
        join(v.root, 'people', 'ada-lovelace.md'),
        `---\nname: ada-lovelace\ntype: person\n---\n\n## Preferences\n\n- Ship small, reviewable diffs.\n`,
        'utf-8',
      );

      migration0230.steps[SPLIT](v.root);

      const constitution = read(v, 'people/ada-lovelace.md');
      expect(countHeading(constitution, 'Preferences')).toBe(1);
      expect(countHeading(constitution, 'Identity')).toBe(1);
      expect(countHeading(constitution, 'Communication Style')).toBe(1);
    });

    it('CRASH-RESUME: a residue that already holds `## Project Rules` is not duplicated', () => {
      legacyVault();
      migration0230.steps[SEED](v.root);
      mkdirSync(join(v.root, 'inbox'), { recursive: true });
      writeFileSync(
        join(v.root, 'inbox', '1.user-residue.md'),
        `---\nname: user-md-residue\ntype: migration-residue\n---\n\n## Project Rules\n\n- Never push to main.\n`,
        'utf-8',
      );

      migration0230.steps[SPLIT](v.root);

      const residue = read(v, 'inbox/1.user-residue.md');
      expect(countHeading(residue, 'Project Rules')).toBe(1);
      expect(countHeading(residue, 'Workflow Notes')).toBe(1);
      expect(residue).toContain('- Never push to main.');
      expect(has(v, 'core/1.user.md')).toBe(false);
    });
  });

  // ─── retire-config-roster ──────────────────────────────────────────────────

  describe('retire-config-roster', () => {
    it('deletes .config.json.people while peopleIdentity survives', () => {
      writeConfig(v, {
        platforms: [],
        packs: [],
        people: ['Ada Lovelace'],
        peopleIdentity: { 'ada-lovelace': { clickupMemberId: '42', githubLogin: 'ada' } },
        setupVersion: '0.22.0',
      });

      const r = migration0230.steps[RETIRE](v.root);

      expect(r.detected).toBe(false);
      const raw = JSON.parse(read(v, 'state/.config.json'));
      expect(Object.prototype.hasOwnProperty.call(raw, 'people')).toBe(false);
      expect(raw.peopleIdentity).toEqual({ 'ada-lovelace': { clickupMemberId: '42', githubLogin: 'ada' } });
      expect(readSetupConfig(v.project)?.peopleIdentity?.['ada-lovelace'].clickupMemberId).toBe('42');
    });

    it('is a detected no-op when the key is already gone', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
      const before = read(v, 'state/.config.json');

      const r = migration0230.steps[RETIRE](v.root);

      expect(r.detected).toBe(true);
      expect(r.filesTouched).toEqual([]);
      expect(read(v, 'state/.config.json')).toBe(before);
    });

    it('leaves an unparseable config alone rather than rewriting it', () => {
      writeFileSync(join(v.root, 'state', '.config.json'), '{ not json', 'utf-8');

      const r = migration0230.steps[RETIRE](v.root);

      expect(r.failedCount).toBe(1);
      expect(read(v, 'state/.config.json')).toBe('{ not json');
    });
  });

  // ─── end to end ────────────────────────────────────────────────────────────

  describe('full run', () => {
    it('a second run is byte-identical: every step detected, zero files touched', () => {
      writeConfig(v, {
        platforms: [],
        packs: [],
        people: ['Ada Lovelace'],
        peopleIdentity: { 'ada-lovelace': { clickupMemberId: '42' } },
        setupVersion: '0.22.0',
      });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);

      runPeopleFirst(v.root);
      const after1 = snapshot(v.root);

      const second = runPeopleFirst(v.root);

      expect(second.every((r) => r.detected)).toBe(true);
      expect(second.flatMap((r) => r.filesTouched)).toEqual([]);
      expect(second.some((r) => r.failedCount)).toBe(false);
      expect(snapshot(v.root)).toEqual(after1);
    });

    it('leaves a vault doctor can accept: non-empty roster, a constitution per slug, no legacy file or key', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);

      const results = runPeopleFirst(v.root);

      expect(results.some((r) => r.failedCount)).toBe(false);
      const people = readPeople(v.root);
      expect(Object.keys(people).length).toBeGreaterThan(0);
      for (const slug of Object.keys(people)) expect(has(v, `people/${slug}.md`)).toBe(true);
      expect(has(v, 'core/1.user.md')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(read(v, 'state/.config.json')), 'people')).toBe(false);
    });
  });

  // ─── agentTask ─────────────────────────────────────────────────────────────

  describe('agentTask', () => {
    it('names the residue, the four routes, the no-discard rule and the record command', () => {
      const task = migration0230.agentTask;
      expect(task?.id).toBe('distribute-user-md-residue');
      const text = task!.instruction;
      expect(text).toContain('_dream_context/inbox/1.user-residue.md');
      expect(text).toContain('core/4.tech_stack.md');
      expect(text).toContain('core/0.soul.md');
      expect(text).toContain('knowledge/patterns/');
      expect(text).toContain('core/3.style_guide_and_branding.md');
      expect(text).toContain('NOTHING IS DISCARDED');
      expect(text).toContain(
        'dreamcontext migrations record --version 0.23.0 --step distribute-user-md-residue --executor agent',
      );
    });
  });
});
