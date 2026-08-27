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
      // A real two-vault block: bullets that DESCRIBE people
      // instead of naming them. Slugifying the whole line yields a 250-char
      // string PERSON_SLUG_RE rejects, which used to throw out of addPerson and
      // report failedCount — pinning setupVersion on every future `update`,
      // permanently, because the runner re-runs each step and this input is
      // deterministic. Both vaults sat on 0.21.0 with 0.23.0 assets installed.
      //
      // Which fragment is the NAME ("kerem"? "Kerem Yılmaz"?) is judgment,
      // so per D5 the step must route, not guess: section → residue → agentTask.
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(
        v,
        '## People\n\n'
        + '- **kerem** — Kerem Yılmaz, Technical Product Manager / App Owner. '
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
      expect(residue).toContain('**kerem** — Kerem Yılmaz');
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

    /**
     * Slug legality alone was never the right gate. `PERSON_SLUG_RE` caps at 64
     * characters, so the SAME class of descriptive prose passed or failed on how
     * verbose the sentence happened to be — a short description sailed through
     * and became a person. Found by running the real migration on a two-person
     * legacy vault, not by reading the regex.
     */
    it('a SHORT descriptive bullet is prose too — the gate is not sentence length', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Bektaş Çimen'], setupVersion: '0.22.0' });
      writeUserMd(
        v,
        '## People\n\n'
        // 63 chars once slugified: one under the limit, and pure description.
        + '- **bektas** — Bektaş Çimen, in-house developer. Owns the deploy pipeline.\n',
      );

      const [, split] = runPeopleFirst(v.root);

      expect(split.failedCount ?? 0).toBe(0);
      // No junk person, no duplicate of the real Bektaş, no junk constitution.
      expect(Object.keys(readPeople(v.root))).toEqual(['bektas-cimen']);
      expect(has(v, 'people/bektas-bektas-cimen-in-house-developer-owns-the-deploy-pipeline.md')).toBe(false);
      expect(read(v, 'inbox/1.user-residue.md')).toContain('Owns the deploy pipeline.');
    });

    /**
     * The marker is stronger evidence than any heuristic: the renderer wrote it,
     * and a name that slugifies back to the slug it claims cannot be prose. The
     * shape test must not get a vote on a row that still carries one, or a real
     * punctuated name is failed by a rule with no business judging it.
     */
    it('a marked row survives a name the shape test would have rejected', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v, '## People\n\n- Dr. Jane Smith (`person:dr-jane-smith`)\n');

      runPeopleFirst(v.root);

      expect(readPeople(v.root)['dr-jane-smith'].name).toBe('Dr. Jane Smith');
      expect(has(v, 'inbox/1.user-residue.md')).toBe(false);
    });

    it('a marker does NOT launder prose — the name must slugify back to it', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(
        v,
        '## People\n\n- **kerem** — Kerem Yılmaz, TPM. Owns roadmap (`person:kerem`)\n',
      );

      const [, split] = runPeopleFirst(v.root);

      expect(split.failedCount ?? 0).toBe(0);
      expect(Object.keys(readPeople(v.root))).toEqual(['ada-lovelace']);
      expect(read(v, 'inbox/1.user-residue.md')).toContain('Owns roadmap');
    });

    /**
     * The punctuation blacklist this replaced listed the em dash and en dash and
     * missed the plain `-` — the separator on every keyboard. `- Kerem -
     * Product Manager` became a person named "Kerem - Product Manager" with a
     * constitution file, silently, with no residue entry and no failure signal.
     */
    it.each([
      ['- Kerem - Product Manager', 'plain hyphen, the most common drift separator'],
      ['- Ada Lovelace -- Engineer', 'double hyphen'],
      ['- kerem – TPM', 'en dash'],
      ['- Ada & Grace', 'an ampersand is not part of a name'],
      ['- Owns the deploy pipeline end to end', 'a sentence with no punctuation at all'],
    ])('%s is prose, not a roster row (%s)', (bullet) => {
      writeConfig(v, { platforms: [], packs: [], people: ['Zed Zulu'], setupVersion: '0.22.0' });
      git.name = null;
      git.email = null;
      writeUserMd(v, `## People\n\n${bullet}\n`);

      const [, split] = runPeopleFirst(v.root);

      expect(split.failedCount ?? 0).toBe(0);
      expect(Object.keys(readPeople(v.root))).toEqual(['zed-zulu']);
      expect(read(v, 'inbox/1.user-residue.md')).toContain(bullet.replace('- ', ''));
    });

    it('an intra-word hyphen is part of the name, not a separator', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v, '## People\n\n- Jean-Luc Picard\n- Mary O’Brien\n- Bektaş Çimen\n');

      runPeopleFirst(v.root);

      // `slugify` renders the apostrophe as a separator — the point here is that
      // all three are ACCEPTED as names, not routed to the residue as prose.
      expect(Object.keys(readPeople(v.root)).sort()).toEqual([
        'ada-lovelace', 'bektas-cimen', 'jean-luc-picard', 'mary-o-brien',
      ]);
      expect(readPeople(v.root)['mary-o-brien'].name).toBe('Mary O’Brien');
      expect(has(v, 'inbox/1.user-residue.md')).toBe(false);
    });

    it('still reads the roster rows the renderer actually wrote', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(
        v,
        '## People\n\n'
        + '- Grace Hopper (`person:grace-hopper`)\n' // rendered, with marker
        + '- **Alan Turing**\n' // drifted: emphasis, marker lost
        + '- Katherine Johnson\n', // drifted: bare name
      );

      runPeopleFirst(v.root);

      const people = readPeople(v.root);
      expect(Object.keys(people).sort()).toEqual([
        'ada-lovelace', 'alan-turing', 'grace-hopper', 'katherine-johnson',
      ]);
      // The emphasis markers are not part of anyone's name.
      expect(people['alan-turing'].name).toBe('Alan Turing');
      // Nothing was homeless, so no residue was created for this block.
      expect(has(v, 'inbox/1.user-residue.md')).toBe(false);
    });

    /**
     * The defect that wrote one teammate's rules into the other's constitution.
     *
     * `resolveOwnerSlug` used to fall back to `Object.keys(readPeople()).sort()[0]`
     * when nothing on the machine identified the active person. In a two-person
     * vault that is a coin flip decided by the alphabet: `bektas` sorts before
     * `kerem`, so Kerem's Identity / Preferences / Communication Style were
     * appended to `people/bektas.md` while `people/kerem.md` stayed an empty
     * scaffold — and step 4 then deleted the only copy of the source.
     *
     * `resolveActivePerson` already refuses this exact guess ("an unresolvable
     * machine gets slug: null, NOT somebody else's constitution"); the migration
     * overrode it. WHOSE prose this is is judgment — it goes to the residue.
     */
    describe('an unresolvable owner is routed, never guessed', () => {
      /** Two people, no env var, no pin, no git email on the roster. */
      function twoPersonVaultNobodyResolves(): void {
        writeConfig(v, {
          platforms: [],
          packs: [],
          people: ['Bektaş Çimen', 'Kerem Yılmaz'],
          setupVersion: '0.22.0',
        });
        git.name = null;
        git.email = null;
        writeUserMd(v);
      }

      it('writes NOBODY a constitution when the machine cannot name the owner', () => {
        twoPersonVaultNobodyResolves();

        const [, split] = runPeopleFirst(v.root);

        // Not a failure — a pinned vault helps nobody, and the prose is safe.
        expect(split.failedCount ?? 0).toBe(0);
        expect(has(v, 'core/1.user.md')).toBe(false);

        // THE regression: the alphabetically-first person is not handed the prose.
        const bektas = read(v, 'people/bektas-cimen.md');
        expect(bektas).not.toContain('Ship small, reviewable diffs.');
        expect(bektas).not.toContain('Terse. No preamble');
        expect(bektas).not.toContain('Founder; writes most of the code herself.');
        // Nor is anyone else — including the person who probably owns it.
        expect(read(v, 'people/kerem-yilmaz.md')).not.toContain('Ship small, reviewable diffs.');
      });

      it('routes the three constitution sections to the residue VERBATIM', () => {
        twoPersonVaultNobodyResolves();

        runPeopleFirst(v.root);

        const residue = read(v, 'inbox/1.user-residue.md');
        for (const title of ['User Preferences', 'Communication Style', 'Identity']) {
          expect(countHeading(residue, title)).toBe(1);
          for (const probe of BODY_PROBES[title]) expect(residue).toContain(probe);
        }
        // And the handoff is real: the agent is told to settle WHO before moving.
        expect(residue).toContain('people whoami --set');
      });

      it('says out loud that no constitution was written, and how to fix it', () => {
        twoPersonVaultNobodyResolves();

        const [, split] = runPeopleFirst(v.root);

        expect(split.summary).toContain('NO constitution written');
        expect(split.summary).toContain('people whoami --set');
      });

      it('still resolves — and still writes the constitution — on a git-email match', () => {
        writeConfig(v, {
          platforms: [],
          packs: [],
          people: ['Bektaş Çimen', 'Kerem Yılmaz'],
          setupVersion: '0.22.0',
        });
        // The seed folds this machine's git identity onto the matching entry, so
        // rung 3 resolves even though the roster holds two people.
        git.name = 'Kerem Yılmaz';
        git.email = 'kerem@example.com';
        writeUserMd(v);

        const [, split] = runPeopleFirst(v.root);

        expect(split.failedCount ?? 0).toBe(0);
        const kerem = read(v, 'people/kerem-yilmaz.md');
        expect(kerem).toContain('Ship small, reviewable diffs.');
        expect(kerem).toContain('Founder; writes most of the code herself.');
        expect(read(v, 'people/bektas-cimen.md')).not.toContain('Ship small, reviewable diffs.');
        // The constitution sections did NOT also land in the residue.
        expect(countHeading(read(v, 'inbox/1.user-residue.md'), 'Identity')).toBe(0);
      });

      it('an explicit pin resolves what the alphabet cannot', () => {
        writeConfig(v, {
          platforms: [],
          packs: [],
          people: ['Bektaş Çimen', 'Kerem Yılmaz'],
          setupVersion: '0.22.0',
        });
        writeUserMd(v);
        // Seed the roster first, then pin — the pin must name a real entry.
        migration0230.steps[SEED](v.root);
        mkdirSync(join(v.root, 'state'), { recursive: true });
        writeFileSync(
          join(v.root, 'state', '.brain-local.json'),
          JSON.stringify({ activePersonSlug: 'kerem-yilmaz' }) + '\n',
          'utf-8',
        );

        const split = migration0230.steps[SPLIT](v.root);

        expect(split.failedCount ?? 0).toBe(0);
        expect(read(v, 'people/kerem-yilmaz.md')).toContain('Ship small, reviewable diffs.');
        expect(read(v, 'people/bektas-cimen.md')).not.toContain('Ship small, reviewable diffs.');
      });

      it('re-running after the owner is settled does not duplicate the prose', () => {
        twoPersonVaultNobodyResolves();
        runPeopleFirst(v.root);
        const residueAfterFirst = read(v, 'inbox/1.user-residue.md');

        // The user pins themselves and updates; `1.user.md` is already gone, so
        // the step is a detected no-op — it must not re-emit anything anywhere.
        writeFileSync(
          join(v.root, 'state', '.brain-local.json'),
          JSON.stringify({ activePersonSlug: 'kerem-yilmaz' }) + '\n',
          'utf-8',
        );
        const again = migration0230.steps[SPLIT](v.root);

        expect(again.detected).toBe(true);
        expect(again.filesTouched).toEqual([]);
        expect(read(v, 'inbox/1.user-residue.md')).toBe(residueAfterFirst);
        expect(read(v, 'people/kerem-yilmaz.md')).not.toContain('Ship small, reviewable diffs.');
      });
    });

    /**
     * The heading-idempotency gate skips any H2 already present in the target,
     * and `addPerson`'s scaffold carries all three constitution headings. The
     * step ordering is supposed to prevent the collision, but it only holds
     * while the seed and the split agree on who the owner is — they do not when
     * the seed could not name one, or when a mid-split crash is re-run after the
     * user pins themselves. Then the gate would skip every section and delete
     * `core/1.user.md` in the same breath. A placeholder slot is not content.
     */
    it('a scaffolded constitution does not swallow the real prose', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);
      // Pre-scaffold the owner's constitution, exactly as `addPerson` would.
      mkdirSync(join(v.root, 'people'), { recursive: true });
      writeFileSync(
        join(v.root, 'people', 'ada-lovelace.md'),
        '---\nname: ada-lovelace\ntype: person\nupdated: "2026-01-01"\n---\n\n'
        + '## Identity\n\n- (Who this person is: role, focus, what they own in this project)\n\n'
        + '## Preferences\n\n- (Decision-making patterns, priorities, review preferences)\n\n'
        + '## Communication Style\n\n- (How the user prefers to interact: concise? detailed? technical?)\n',
        'utf-8',
      );

      runPeopleFirst(v.root);

      const constitution = read(v, 'people/ada-lovelace.md');
      for (const title of ['Identity', 'Preferences', 'Communication Style']) {
        // Replaced, not appended-after and not skipped.
        expect(countHeading(constitution, title)).toBe(1);
      }
      expect(constitution).toContain('- Ship small, reviewable diffs.');
      expect(constitution).toContain('- Founder; writes most of the code herself.');
      expect(constitution).toContain('- Terse. No preamble, no summary of the summary.');
      expect(constitution).not.toContain('(Who this person is:');
      expect(constitution).not.toContain('(Decision-making patterns');
    });

    /**
     * "Every line is parenthesised" was the first version of the slot check, and
     * it would have deleted a real sentence that happens to wear parentheses.
     * The check recognises the TEMPLATE's own text, not a shape placeholders
     * happen to have — the same distinction the roster gate had to learn.
     */
    it('parenthesised prose a person actually wrote is not mistaken for a slot', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);
      mkdirSync(join(v.root, 'people'), { recursive: true });
      writeFileSync(
        join(v.root, 'people', 'ada-lovelace.md'),
        '---\nname: ada-lovelace\ntype: person\nupdated: "2026-01-01"\n---\n\n'
        + '## Preferences\n\n- (see the team handbook, section 4)\n',
        'utf-8',
      );

      runPeopleFirst(v.root);

      const constitution = read(v, 'people/ada-lovelace.md');
      expect(constitution).toContain('- (see the team handbook, section 4)');
      expect(constitution).not.toContain('- Ship small, reviewable diffs.');
    });

    /**
     * The idempotency gate declines any heading the target already has. That is
     * correct ONLY for the case it was written for — a previous run of this step
     * wrote that exact body and crashed before the unlink. For any OTHER
     * pre-existing content the gate was silently DROPPING the `1.user.md`
     * version and then deleting the only other copy, with nothing but a
     * one-lower count in the summary to show for it. Reachable with no crash at
     * all: `people add`, hand-write your Identity, then upgrade.
     */
    it('prose the idempotency gate declines goes to the residue, never to the floor', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);
      mkdirSync(join(v.root, 'people'), { recursive: true });
      writeFileSync(
        join(v.root, 'people', 'ada-lovelace.md'),
        '---\nname: ada-lovelace\ntype: person\nupdated: "2026-01-01"\n---\n\n'
        + '## Preferences\n\n- Hand-written before the upgrade.\n',
        'utf-8',
      );

      runPeopleFirst(v.root);

      // The hand-written constitution is not clobbered...
      const constitution = read(v, 'people/ada-lovelace.md');
      expect(countHeading(constitution, 'Preferences')).toBe(1);
      expect(constitution).toContain('- Hand-written before the upgrade.');
      expect(constitution).not.toContain('- Ship small, reviewable diffs.');
      // ...and the source prose it displaced is preserved for the agent, with
      // the heading `1.user.md` actually used.
      const residue = read(v, 'inbox/1.user-residue.md');
      expect(residue).toContain('## User Preferences');
      expect(residue).toContain('- Ship small, reviewable diffs.');
      expect(has(v, 'core/1.user.md')).toBe(false);
    });

    /**
     * The summary is the only place the user learns which of the two happened,
     * and it used to call both "skipped (resumed a partial run)" — telling
     * someone with two divergent versions to reconcile that nothing was owed.
     */
    it('the summary distinguishes a resumed skip from a routed conflict', () => {
      const conflicted = (existingBody: string) => {
        const w = makeVault();
        writeConfig(w, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
        writeUserMd(w);
        mkdirSync(join(w.root, 'people'), { recursive: true });
        writeFileSync(
          join(w.root, 'people', 'ada-lovelace.md'),
          '---\nname: ada-lovelace\ntype: person\nupdated: "2026-01-01"\n---\n\n'
          + `## Preferences\n\n${existingBody}\n`,
          'utf-8',
        );
        const [, split] = runPeopleFirst(w.root);
        rmSync(w.project, { recursive: true, force: true });
        return split.summary;
      };
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';

      // Byte-identical to the source ⇒ a genuine resume.
      const resumed = conflicted('- Ship small, reviewable diffs.\n- Prefer deletion over abstraction.');
      expect(resumed).toContain('resumed a partial run');
      expect(resumed).not.toContain('DIFFERENT content');

      // Divergent ⇒ the user has two versions and must be told so.
      const routed = conflicted('- Hand-written before the upgrade.');
      expect(routed).toContain('DIFFERENT content');
      expect(routed).toContain('must reconcile');
      expect(routed).not.toContain('resumed a partial run');
    });

    it('a resumed run drops the identical section silently — no residue noise', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v);
      mkdirSync(join(v.root, 'people'), { recursive: true });
      // Exactly what a previous run of this step wrote, before it crashed.
      writeFileSync(
        join(v.root, 'people', 'ada-lovelace.md'),
        '---\nname: ada-lovelace\ntype: person\nupdated: "2026-01-01"\n---\n\n'
        + '## Preferences\n\n- Ship small, reviewable diffs.\n- Prefer deletion over abstraction.\n',
        'utf-8',
      );

      runPeopleFirst(v.root);

      expect(countHeading(read(v, 'people/ada-lovelace.md'), 'Preferences')).toBe(1);
      // Already migrated ⇒ nothing owed. The residue exists for the OTHER
      // sections, but must not carry a duplicate of this one.
      expect(read(v, 'inbox/1.user-residue.md')).not.toContain('## User Preferences');
    });

    /**
     * The residue's own gate carried the identical defect one level down, and
     * `unlinkSync` follows it by three lines. Crash before the unlink, edit
     * `1.user.md`, re-run: the edited section was declined on the heading alone
     * and the source deleted. A duplicate heading in the residue is harmless —
     * the agent reads both. A dropped section is not.
     */
    it('an edited section is not declined by a stale residue heading', () => {
      writeConfig(v, { platforms: [], packs: [], people: ['Ada Lovelace'], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(v, '## Project Rules\n\n- Never push to main.\n- Also: rebase, never merge.\n');
      // A residue from an earlier run that crashed before the unlink, holding
      // the PRE-EDIT version of the same heading.
      mkdirSync(join(v.root, 'inbox'), { recursive: true });
      writeFileSync(
        join(v.root, 'inbox', '1.user-residue.md'),
        '# Residue\n\n## Project Rules\n\n- Never push to main.\n',
        'utf-8',
      );

      runPeopleFirst(v.root);

      const residue = read(v, 'inbox/1.user-residue.md');
      expect(residue).toContain('- Also: rebase, never merge.');
      expect(has(v, 'core/1.user.md')).toBe(false);
    });

    /**
     * `findH2Heads` has always skipped headings inside code fences;
     * `parsePeopleBullets` did not skip bullets inside them. A documented format
     * sample became a real person with a real constitution file.
     */
    it('a roster row inside a code fence is an EXAMPLE, not a person', () => {
      writeConfig(v, { platforms: [], packs: [], setupVersion: '0.22.0' });
      git.name = 'Ada Lovelace';
      git.email = 'ada@example.com';
      writeUserMd(
        v,
        '## People\n\n'
        + 'Format example:\n\n'
        + '```\n- Jane Doe (`person:jane-doe`)\n```\n\n'
        + '- Grace Hopper (`person:grace-hopper`)\n',
      );

      const [, split] = runPeopleFirst(v.root);

      expect(split.failedCount ?? 0).toBe(0);
      expect(readPeople(v.root)['jane-doe']).toBeUndefined();
      expect(has(v, 'people/jane-doe.md')).toBe(false);
      expect(readPeople(v.root)['grace-hopper']).toBeDefined();
      // The fence made the block un-mechanical, so it reaches the agent whole.
      expect(read(v, 'inbox/1.user-residue.md')).toContain('Jane Doe');
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

    it('tells the agent to SETTLE the owner before moving a constitution section', () => {
      const text = migration0230.agentTask!.instruction;
      expect(text).toContain('## Communication Style');
      expect(text).toContain('dreamcontext people whoami --set');
      // The two traps a well-meaning agent falls into on its own.
      expect(text).toContain('ASK the user rather than choosing');
      expect(text).toContain('copying the same prose into two people');
    });
  });

  /**
   * Source-level tripwire. The defect class is "a migration step picks a PERSON
   * by ranking the roster" — `Object.keys(readPeople(root)).sort()[0]` read as a
   * harmless completeness fallback and was in fact a coin flip that wrote one
   * teammate's constitution into another's file.
   *
   * Guard the SHAPE, not the one call site: any future migration that needs an
   * owner must go through `resolveActivePerson` and route the ambiguity to its
   * agentTask, exactly like every other judgment call in this system.
   */
  describe('person-selection discipline', () => {
    it('no migration derives a person by ranking the roster', () => {
      const dir = join(process.cwd(), 'src', 'migrations');
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.ts')) continue;
        const code = readFileSync(join(dir, entry), 'utf-8')
          .split('\n')
          .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
          .join('\n');
        // `readPeople(...)` piped into any ordering/first-element selection.
        expect(
          /readPeople\([^)]*\)[\s\S]{0,80}?(?:\.sort\(|\.at\(0\)|\[0\])/.test(code),
          `${entry} selects a person by roster order — see resolveOwner()`,
        ).toBe(false);
      }
    });
  });
});
