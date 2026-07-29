import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

/**
 * `dreamcontext people` — the five verbs, end-to-end through the built CLI.
 *
 * The fixture vault is its own git repo with a LOCAL `user.email`, so rung 3 of
 * the resolution ladder is deterministic here instead of picking up whatever the
 * machine running the suite happens to have configured globally.
 *
 * `init` SEEDS one person from that same git identity ("Nobody"), so the vault
 * is never born with an empty roster. Tests whose subject is the roster itself —
 * who is on it, or which rung resolves when the machine identity matches nobody
 * on it — call `clearSeededRoster()` first, so the roster they assert on is
 * exactly the one they built.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const OTHER_EMAIL = 'nobody@example.invalid';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-people-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string, env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execSync(`node ${CLI} ${cmd} 2>&1`, {
      cwd,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, ...env },
    });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

describe('people CLI (integration)', () => {
  let tmpDir: string;
  let contextRoot: string;

  const peopleJson = () => join(contextRoot, 'people', 'people.json');
  const personFile = (slug: string) => join(contextRoot, 'people', `${slug}.md`);
  const brainLocal = () => join(contextRoot, 'state', '.brain-local.json');

  function setGitEmail(email: string): void {
    execSync(`git config user.email "${email}"`, { cwd: tmpDir });
  }

  /**
   * Drop the person `init` seeded from the fixture's git identity, leaving a
   * genuinely empty roster (`people add` recreates `people/` on demand). Used by
   * the tests that assert on the WHOLE roster, or that need OTHER_EMAIL to match
   * no one so the resolution ladder falls past rung 3.
   */
  function clearSeededRoster(): void {
    rmSync(join(contextRoot, 'people'), { recursive: true, force: true });
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    execSync('git init -q', { cwd: tmpDir });
    execSync('git config user.name "Nobody"', { cwd: tmpDir });
    setGitEmail(OTHER_EMAIL);
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    contextRoot = join(tmpDir, '_dream_context');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('people add', () => {
    it('creates the roster entry, scaffolds the constitution, and normalizes the email', () => {
      const { out, code } = run('people add "Ada Lovelace" --email Ada@Test.DEV --role founder', tmpDir);
      expect(code).toBe(0);
      expect(out).toContain('Added Ada Lovelace (person:ada-lovelace).');
      expect(out).toContain('_dream_context/people/ada-lovelace.md');

      const roster = JSON.parse(readFileSync(peopleJson(), 'utf-8'));
      expect(roster.version).toBe(1);
      expect(roster.people['ada-lovelace']).toEqual({
        name: 'Ada Lovelace',
        emails: ['ada@test.dev'],
        role: 'founder',
      });
      expect(readFileSync(personFile('ada-lovelace'), 'utf-8')).toContain('## Identity');
    });

    it('takes repeated --email values and never clobbers an existing constitution', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      writeFileSync(personFile('ada-lovelace'), '# Ada\n\nHand-written prose.\n', 'utf-8');

      const { out } = run('people add "Ada Lovelace" --email ada@work.dev --email ada@alt.dev', tmpDir);
      expect(out).toContain('already on the roster');

      const roster = JSON.parse(readFileSync(peopleJson(), 'utf-8'));
      expect(roster.people['ada-lovelace'].emails).toEqual(['ada@test.dev', 'ada@work.dev', 'ada@alt.dev']);
      expect(readFileSync(personFile('ada-lovelace'), 'utf-8')).toBe('# Ada\n\nHand-written prose.\n');
    });

    it('warns when an email already belongs to a DIFFERENT person', () => {
      run('people add "Ada Lovelace" --email shared@test.dev', tmpDir);
      const { out, code } = run('people add "Bob Builder" --email shared@test.dev', tmpDir);
      expect(code).toBe(0);
      expect(out).toContain('shared@test.dev is already on Ada Lovelace (person:ada-lovelace)');
      expect(out).toContain('ambiguous');
      // The warning is advisory — the person is still added.
      expect(JSON.parse(readFileSync(peopleJson(), 'utf-8')).people['bob-builder']).toBeTruthy();
    });

    it('says so when no email was given (git-email resolution cannot work)', () => {
      const { out } = run('people add "Ada Lovelace"', tmpDir);
      expect(out).toContain('No email given');
      expect(JSON.parse(readFileSync(peopleJson(), 'utf-8')).people['ada-lovelace'].emails).toEqual([]);
    });
  });

  describe('people list', () => {
    it('reports an empty roster without inventing one', () => {
      // Remove init's seed, then prove `list` neither invents a person nor
      // writes a roster file to hold one.
      clearSeededRoster();
      const { out, code } = run('people list', tmpDir);
      expect(code).toBe(0);
      expect(out).toContain('No people yet.');
      expect(existsSync(peopleJson())).toBe(false);
    });

    it('marks the active person with "← you"', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);
      setGitEmail('bob@test.dev');

      const { out } = run('people list', tmpDir);
      expect(out).toMatch(/bob-builder.*← you/);
      expect(out).not.toMatch(/ada-lovelace.*← you/);
    });

    it('--json carries the roster, the active slug and its source', () => {
      clearSeededRoster(); // Ada must be the ONLY person for `solo` to be the source.
      run('people add "Ada Lovelace" --email ada@test.dev --role founder', tmpDir);
      const { out } = run('people list --json', tmpDir);
      const parsed = JSON.parse(out);
      expect(parsed.activeSlug).toBe('ada-lovelace');
      expect(parsed.source).toBe('solo');
      expect(parsed.people).toEqual([
        {
          slug: 'ada-lovelace',
          name: 'Ada Lovelace',
          emails: ['ada@test.dev'],
          role: 'founder',
          active: true,
        },
      ]);
    });
  });

  describe('people show', () => {
    it('defaults to the active person', () => {
      clearSeededRoster(); // Ada alone on the roster ⇒ rung 4 (solo) makes her active.
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      writeFileSync(personFile('ada-lovelace'), '# Ada\n\nShips things.\n', 'utf-8');
      const { out, code } = run('people show', tmpDir);
      expect(code).toBe(0);
      expect(out).toContain('Ships things.');
    });

    it('prints an explicitly named person', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);
      writeFileSync(personFile('bob-builder'), '# Bob\n\nBuilds things.\n', 'utf-8');
      const { out } = run('people show bob-builder', tmpDir);
      expect(out).toContain('Builds things.');
    });

    it('unresolved + no argument ⇒ the resolution reason and exit 1', () => {
      clearSeededRoster(); // …so OTHER_EMAIL matches nobody on the roster.
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);
      // Two people and a git email matching neither ⇒ rung 5, never a guess.
      const { out, code } = run('people show', tmpDir);
      expect(code).toBe(1);
      expect(out).toContain('No active person on this machine.');
      expect(out).toContain(OTHER_EMAIL);
      expect(out).toContain('matches no person in this vault');
      // It must NOT fall back to somebody else's constitution.
      expect(out).not.toContain('## Identity');
    });

    it('rejects a slug that is not on the roster', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      const { out, code } = run('people show ../core/0.soul', tmpDir);
      expect(code).toBe(1);
      expect(out).toContain(`No person "../core/0.soul" on this vault's roster.`);
      // Invariant P: a traversal payload never becomes a path join, so no soul
      // content can be echoed back through a person surface.
      expect(out).not.toContain('# Soul');
    });
  });

  describe('people whoami', () => {
    it('reports source=solo for the only person on the roster', () => {
      clearSeededRoster(); // "only person" has to be literally true.
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      const { out, code } = run('people whoami', tmpDir);
      expect(code).toBe(0);
      expect(out).toMatch(/Person:\s+ada-lovelace/);
      expect(out).toMatch(/Name:\s+Ada Lovelace/);
      expect(out).toMatch(/Source:\s+solo/);
    });

    it('reports source=git-email when the machine identity matches', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);
      setGitEmail('BOB@Test.dev'); // matched case-insensitively
      const { out } = run('people whoami', tmpDir);
      expect(out).toMatch(/Person:\s+bob-builder/);
      expect(out).toMatch(/Source:\s+git-email/);
    });

    it('reports source=env for DREAMCONTEXT_PERSON', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);
      const { out } = run('people whoami', tmpDir, { DREAMCONTEXT_PERSON: 'bob-builder' });
      expect(out).toMatch(/Person:\s+bob-builder/);
      expect(out).toMatch(/Source:\s+env/);
    });

    it('reports source=none, not a guess, when nothing resolves', () => {
      clearSeededRoster(); // …so OTHER_EMAIL matches nobody on the roster.
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);
      const { out, code } = run('people whoami', tmpDir);
      expect(code).toBe(0);
      expect(out).toContain('(unresolved)');
      expect(out).toMatch(/Source:\s+none/);
    });

    it('--set pins this machine, --clear unpins it', () => {
      clearSeededRoster(); // …so unpinning falls all the way to `none`, not back to a git-email match.
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);

      const set = run('people whoami --set bob-builder', tmpDir);
      expect(set.code).toBe(0);
      expect(set.out).toMatch(/Source:\s+pin/);
      expect(JSON.parse(readFileSync(brainLocal(), 'utf-8')).activePersonSlug).toBe('bob-builder');

      const cleared = run('people whoami --clear', tmpDir);
      expect(cleared.code).toBe(0);
      expect(JSON.parse(readFileSync(brainLocal(), 'utf-8')).activePersonSlug).toBeUndefined();
      expect(cleared.out).toMatch(/Source:\s+none/);
    });

    it('--set refuses a slug that is not on the roster, and writes nothing', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      const { out, code } = run('people whoami --set "../evil"', tmpDir);
      expect(code).toBe(1);
      expect(out).toContain('Invalid person slug');
      expect(existsSync(brainLocal()) && JSON.parse(readFileSync(brainLocal(), 'utf-8')).activePersonSlug).toBeFalsy();

      const unknown = run('people whoami --set ghost', tmpDir);
      expect(unknown.code).toBe(1);
      expect(unknown.out).toContain('No person "ghost" in this vault');
    });
  });

  describe('people rm', () => {
    it('removes the roster entry, keeps the constitution, and names the union-merge caveat', () => {
      clearSeededRoster(); // The roster after the removal is asserted whole.
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      run('people add "Bob Builder" --email bob@test.dev', tmpDir);

      const { out, code } = run('people rm bob-builder --yes', tmpDir);
      expect(code).toBe(0);
      expect(out).toContain('Removed Bob Builder (person:bob-builder) from the roster.');
      expect(out).toContain('Kept _dream_context/people/bob-builder.md');
      expect(out).toContain('resurrect them on the next brain sync');

      const roster = JSON.parse(readFileSync(peopleJson(), 'utf-8'));
      expect(Object.keys(roster.people)).toEqual(['ada-lovelace']);
      expect(existsSync(personFile('bob-builder'))).toBe(true);
    });

    it('refuses to remove without --yes when there is no TTY to confirm on', () => {
      clearSeededRoster(); // The untouched roster is asserted whole.
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      const { out, code } = run('people rm ada-lovelace', tmpDir);
      expect(code).toBe(1);
      expect(out).toContain('Refusing to remove a person without confirmation.');
      expect(Object.keys(JSON.parse(readFileSync(peopleJson(), 'utf-8')).people)).toEqual(['ada-lovelace']);
    });

    it('rejects an unknown slug', () => {
      run('people add "Ada Lovelace" --email ada@test.dev', tmpDir);
      const { out, code } = run('people rm ghost --yes', tmpDir);
      expect(code).toBe(1);
      expect(out).toContain(`No person "ghost" on this vault's roster.`);
    });
  });
});
