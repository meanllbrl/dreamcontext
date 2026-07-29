import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

/**
 * D7 — `dreamcontext config people` MOVED in 0.23.0.
 *
 * The old command was a full-roster REPLACE (`--clear` wrote `[]`). The new
 * roster lives in `people/people.json` and is grown one person at a time, so
 * forwarding would invert the command's semantics and `--clear` would have no
 * counterpart at all. It is therefore a REDIRECT, not an alias: it prints where
 * the roster went, exits 1, and — the part this file exists to lock — writes
 * NOTHING, under every flag combination including `--clear`.
 *
 * Also pinned here (D17's read-path asymmetry): a corrupt roster degrades the
 * `config show` People line to a named placeholder instead of taking the
 * command down with a JSON parse error.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-people-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): { out: string; code: number } {
  try {
    const out = execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 15000 });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

describe('config people — the 0.23.0 redirect (integration)', () => {
  let tmpDir: string;
  let configPath: string;
  let peopleJsonPath: string;

  /** Raw bytes of both files that a write path could plausibly touch. */
  function snapshotFiles(): { config: string; people: string | null } {
    return {
      config: readFileSync(configPath, 'utf-8'),
      people: existsSync(peopleJsonPath) ? readFileSync(peopleJsonPath, 'utf-8') : null,
    };
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    configPath = join(tmpDir, '_dream_context', 'state', '.config.json');
    peopleJsonPath = join(tmpDir, '_dream_context', 'people', 'people.json');
    // A real roster to protect: the redirect must not rewrite it either.
    mkdirSync(join(tmpDir, '_dream_context', 'people'), { recursive: true });
    writeFileSync(
      peopleJsonPath,
      JSON.stringify(
        { version: 1, people: { ada: { name: 'Ada Lovelace', emails: ['ada@test.dev'] } } },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Every flag combination the old command accepted — each must redirect, exit
  // 1, and leave both files byte-identical.
  const invocations: Array<[label: string, argv: string]> = [
    ['names', 'config people "Alice Smith" "Bob Jones"'],
    ['--clear', 'config people --clear'],
    ['no arguments', 'config people'],
    ['--clear with names', 'config people --clear "Alice Smith"'],
  ];

  for (const [label, argv] of invocations) {
    it(`redirects and exits 1 for ${label}`, () => {
      const { out, code } = run(argv, tmpDir);
      expect(out).toContain('`dreamcontext config people` moved in 0.23.0.');
      expect(out).toContain('The roster now lives in _dream_context/people/people.json.');
      expect(out).toContain('Use: dreamcontext people list | people add <name> --email <e> | people rm <slug>');
      expect(code).toBe(1);
    });

    it(`writes nothing for ${label}`, () => {
      const before = snapshotFiles();
      run(argv, tmpDir);
      expect(snapshotFiles()).toEqual(before);
    });
  }

  it('never reaches the store: no roster is created when people.json is absent', () => {
    rmSync(join(tmpDir, '_dream_context', 'people'), { recursive: true, force: true });
    const before = readFileSync(configPath, 'utf-8');
    run('config people "Alice Smith" "Bob Jones"', tmpDir);
    expect(existsSync(peopleJsonPath)).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('config show reads the People line from people.json', () => {
    const { out } = run('config show', tmpDir);
    expect(out).toMatch(/People:\s+Ada Lovelace/);
  });

  it('config show degrades a corrupt roster instead of crashing (D17 read path)', () => {
    writeFileSync(peopleJsonPath, '{ "version": 1, "people": {', 'utf-8');
    const { out, code } = run('config show', tmpDir);
    expect(out).toContain('People:');
    expect(out).toContain('<unreadable — run dreamcontext doctor>');
    // Degrade, don't die: no stack trace, and `config show` still succeeds.
    expect(out).not.toContain('PeopleStoreError:');
    expect(out).not.toMatch(/\n\s+at /);
    expect(code).toBe(0);
  });
});
